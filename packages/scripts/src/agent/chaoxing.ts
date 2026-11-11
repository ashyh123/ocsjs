import type { ChapterObservation, CourseIdentity, PageObservation, PlatformAdapter, VideoTask } from './types';

type JsonRecord = Record<string, unknown>;
interface AccessiblePage {
	win: Window;
	doc: Document;
}
interface LocatedTask {
	task: VideoTask;
	media: HTMLMediaElement[];
}

function record(value: unknown): JsonRecord | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function id(value: unknown): string {
	return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? String(value).trim() : '';
}

function ancestors(win: Window): AccessiblePage[] {
	const result: AccessiblePage[] = [];
	const seen = new Set<Window>();
	let current = win;
	while (!seen.has(current)) {
		seen.add(current);
		try {
			result.push({ win: current, doc: current.document });
			if (current.parent === current) break;
			current = current.parent;
		} catch {
			break;
		}
	}
	return result;
}

function pages(win: Window): AccessiblePage[] {
	const result: AccessiblePage[] = [];
	const seen = new Set<Window>();
	const visit = (current: Window) => {
		if (seen.has(current)) return;
		seen.add(current);
		try {
			const doc = current.document;
			result.push({ win: current, doc });
			for (const frame of Array.from(doc.querySelectorAll('iframe'))) {
				try {
					if (frame.contentWindow) visit(frame.contentWindow);
				} catch {
					// A cross-origin or detached frame cannot establish a task identity here.
				}
			}
		} catch {
			// Other frames can still be inspected when this one is inaccessible.
		}
	};
	visit(ancestors(win).slice(-1)[0]?.win || win);
	return result;
}

function parameter(page: AccessiblePage, names: string[], selectors: string): string {
	try {
		const params = new URL(page.win.location.href).searchParams;
		for (const name of names) {
			const value = id(params.get(name));
			if (value) return value;
		}
	} catch {}
	for (const el of Array.from(page.doc.querySelectorAll<HTMLInputElement>(selectors))) {
		const value = id(el.value);
		if (value) return value;
	}
	return '';
}

function identityParts(page: AccessiblePage) {
	return {
		courseId: parameter(page, ['courseId', 'courseid'], '#curCourseId, #courseId, input[name="courseId"]'),
		clazzId: parameter(
			page,
			['clazzId', 'clazzid', 'classId', 'classid'],
			'#curClazzId, #clazzId, input[name="clazzId"]'
		),
		chapterId: parameter(
			page,
			['chapterId', 'chapterid', 'knowledgeId', 'knowledgeid'],
			'#curChapterId, #chapterId, input[name="knowledgeId"]'
		)
	};
}

function identity(win: Window, provided: CourseIdentity | null): CourseIdentity | null {
	const chain = ancestors(win);
	const courseIds = new Set<string>();
	const clazzIds = new Set<string>();
	for (const page of chain) {
		const parts = identityParts(page);
		if (parts.courseId) courseIds.add(parts.courseId);
		if (parts.clazzId) clazzIds.add(parts.clazzId);
	}
	if (provided) {
		if (id(provided.courseId)) courseIds.add(id(provided.courseId));
		if (id(provided.clazzId)) clazzIds.add(id(provided.clazzId));
	}
	if (courseIds.size !== 1 || clazzIds.size !== 1) return null;
	const titlePage = chain
		.slice()
		.reverse()
		.find((page) => page.doc.title);
	const title = titlePage?.doc.querySelector('.course-name, .courseName, .course-title')?.textContent?.trim();
	return {
		courseId: Array.from(courseIds)[0],
		clazzId: Array.from(clazzIds)[0],
		title: title || provided?.title || titlePage?.doc.title || ''
	};
}

function frameJobId(win: Window): string {
	for (const page of ancestors(win)) {
		try {
			const raw = page.win.frameElement?.getAttribute('data');
			if (!raw) continue;
			const value = record(JSON.parse(raw));
			const jobId = id(value?.jobid) || id(value?._jobid);
			if (jobId) return jobId;
		} catch {
			// Ignore malformed data and continue looking for the owning task frame.
		}
	}
	return '';
}

function attachmentJobId(value: JsonRecord): string {
	return id(value.jobid) || id(record(value.property)?._jobid);
}

function readAttachments(page: AccessiblePage): unknown {
	try {
		return (page.win as Window & { attachments?: unknown }).attachments;
	} catch {
		return undefined;
	}
}

function visible(el: HTMLElement): boolean {
	let current: HTMLElement | null = el;
	while (current) {
		if (current.hidden || current.style.display === 'none' || current.style.visibility === 'hidden') return false;
		try {
			const style = current.ownerDocument.defaultView?.getComputedStyle(current);
			if (style?.display === 'none' || style?.visibility === 'hidden') return false;
		} catch {}
		current = current.parentElement;
	}
	return true;
}

function blocker(allPages: AccessiblePage[]): string | null {
	for (const page of allPages) {
		try {
			const url = new URL(page.win.location.href);
			if (/^passport\d*\.chaoxing\.com$/.test(url.hostname) && /\/login(?:[/.]|$)/.test(url.pathname)) {
				return 'login_required';
			}
		} catch {}
		for (const mask of Array.from(page.doc.querySelectorAll<HTMLElement>('.chapterVideoFaceMaskDiv, #fcqrimg'))) {
			if (mask.id === 'fcqrimg' && !mask.getAttribute('src')) continue;
			if (visible(mask)) return 'face_verification_required';
		}
	}
	return null;
}

function chapterId(el: HTMLElement, course: CourseIdentity | null): string {
	const explicit = id(el.getAttribute('data-chapterid')) || id(el.getAttribute('data-knowledgeid'));
	const handler = el.getAttribute('onclick') || '';
	if (!/^\s*getTeacherAjax\s*\(/.test(handler)) return explicit;
	const args = Array.from(handler.matchAll(/'([^']*)'|"([^"]*)"/g)).map((match) => match[1] || match[2] || '');
	if (course && (args[0] !== course.courseId || args[1] !== course.clazzId)) return '';
	if (explicit && explicit !== id(args[2])) return '';
	return id(args[2]);
}

/** Observe Chaoxing's rendered UI and attachment metadata without issuing platform requests. */
export function createChaoxingAdapter(
	win: Window,
	attachmentsProvider?: () => unknown,
	courseProvider?: () => CourseIdentity | null
): PlatformAdapter {
	let currentTasks = new Map<string, LocatedTask>();
	let chapterElements = new Map<string, HTMLElement>();
	let course: CourseIdentity | null = null;
	const rememberedTasks = new Map<string, VideoTask>();

	const inspect = (): PageObservation => {
		const allPages = pages(win);
		let suppliedCourse: CourseIdentity | null = null;
		try {
			suppliedCourse = courseProvider?.() || null;
		} catch {}
		course = identity(win, suppliedCourse);
		currentTasks = new Map();
		chapterElements = new Map();
		const chapters: ChapterObservation[] = [];
		const observedAt = Date.now();
		let suppliedAttachments: unknown;
		try {
			suppliedAttachments = attachmentsProvider?.();
		} catch {}
		for (const page of allPages) {
			const ownIdentity = identity(page.win, course);
			if (course && !ownIdentity) continue;
			for (const el of Array.from(
				page.doc.querySelectorAll<HTMLElement>('[onclick*="getTeacherAjax"], [data-chapterid], [data-knowledgeid]')
			)) {
				const key = chapterId(el, course);
				if (!key || chapterElements.has(key)) continue;
				const count = el.parentElement?.querySelector<HTMLInputElement>('.jobUnfinishCount');
				const text = count?.value?.trim() || '';
				chapters.push({
					id: key,
					title: el.getAttribute('title') || el.textContent?.trim() || '',
					order: chapters.length,
					remaining: /^\d+$/.test(text) ? Number(text) : null
				});
				chapterElements.set(key, el);
			}
			const jobId = frameJobId(page.win);
			if (!jobId) continue;
			const mediaElements = Array.from(
				page.doc.querySelectorAll<HTMLMediaElement>(
					'#video video, #video audio, #audio video, #audio audio, video#video, audio#audio'
				)
			);
			if (mediaElements.length === 0) continue;
			const sources = [suppliedAttachments, ...ancestors(page.win).map(readAttachments)];
			let attachment: JsonRecord | undefined;
			for (const source of sources) {
				if (!Array.isArray(source)) continue;
				attachment = source.map(record).find((value) => value && attachmentJobId(value) === jobId);
				if (attachment) break;
			}
			if (!attachment) continue;
			const property = record(attachment.property);
			const mid = id(property?.mid);
			const module = id(property?.module);
			if (module && module !== 'insertvideo' && module !== 'insertaudio') continue;
			const chapter =
				ancestors(page.win)
					.map(identityParts)
					.find((parts) => parts.chapterId)?.chapterId || '';
			const taskId = `${course?.courseId || 'unknown'}:${course?.clazzId || 'unknown'}:${jobId}`;
			const task: VideoTask = {
				id: taskId,
				chapterId: chapter,
				jobId,
				mid,
				title: id(property?.name) || id(property?.title) || '未命名视频',
				order: currentTasks.size,
				platformStatus: attachment.isPassed === true ? 'confirmed' : attachment.job === true ? 'pending' : 'unknown',
				observedAt,
				availability: course && mid && mediaElements.length === 1 ? 'executable' : 'unknown'
			};
			const existing = currentTasks.get(taskId);
			if (existing) {
				existing.media.push(...mediaElements);
				existing.task.availability = 'unknown';
			} else {
				currentTasks.set(taskId, { task, media: mediaElements });
			}
		}
		for (const located of currentTasks.values()) rememberedTasks.set(located.task.id, located.task);
		let url = '';
		try {
			const currentUrl = new URL(win.location.href);
			// Keep stable routing identities, excluding authorization and temporary query values.
			const stableParams = new URLSearchParams();
			currentUrl.searchParams.forEach((value, name) => {
				if (/^(courseid|clazzid|classid|chapterid|knowledgeid)$/i.test(name)) stableParams.append(name, value);
			});
			const route = currentUrl.origin === 'null' ? currentUrl.pathname : `${currentUrl.origin}${currentUrl.pathname}`;
			url = route + (stableParams.toString() ? `?${stableParams}` : '');
		} catch {}
		return {
			course,
			url,
			tasks: Array.from(currentTasks.values()).map((located) => ({ ...located.task })),
			chapters,
			catalogStatus: chapters.length ? 'partial' : 'unknown',
			blockedReason: blocker(allPages)
		};
	};

	const openChapter = (key: string) => {
		inspect();
		const el = chapterElements.get(key);
		if (!course || !el?.isConnected) throw new Error('无法核实目标章节，请重新读取课程目录。');
		el.click();
	};

	return {
		inspect,
		resolveMedia(taskId) {
			inspect();
			const located = currentTasks.get(taskId);
			return located?.task.availability === 'executable' && located.media[0]?.isConnected
				? located.media[0]
				: undefined;
		},
		openTask(taskId) {
			inspect();
			if (!course) throw new Error('课程身份未知，无法打开任务。');
			const current = currentTasks.get(taskId);
			if (current?.task.availability === 'executable' && current.media[0]?.isConnected) return;
			const known = rememberedTasks.get(taskId);
			if (!known || !taskId.startsWith(`${course.courseId}:${course.clazzId}:`)) {
				throw new Error('任务未经观察或不属于当前课程。');
			}
			if (current) throw new Error('无法唯一定位目标视频，请重新读取页面。');
			openChapter(known.chapterId);
		},
		openChapter
	};
}
