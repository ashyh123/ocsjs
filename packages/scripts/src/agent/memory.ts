import type { ChapterObservation, CourseIdentity, MemoryStorage, PageObservation, VideoTask } from './types';

/** Stored observations are history; executable targets must be rediscovered in the current document. */
export interface CourseMemory {
	schemaVersion: 1;
	revision: number;
	updatedAt: number;
	course: CourseIdentity;
	catalog: {
		status: PageObservation['catalogStatus'];
		observedAt: number;
		observedTaskIds: string[];
		chapters: ChapterObservation[];
	};
	tasks: VideoTask[];
	navigation: {
		version: 1;
		strategy: 'chapter_id_click_then_inspect';
		targets: { taskId: string; chapterId: string; jobId: string; observedAt: number }[];
	};
	checkpoint: { taskId: string | null; phase: string; updatedAt: number };
	summary: {
		videoScopeStatus: 'unknown' | 'pending' | 'completed';
		confirmedTaskIds: string[];
		unconfirmedTaskIds: string[];
		courseAllTasksStatus: 'not_assessed';
	};
}

function invalid(message: string): never {
	throw new Error(`Invalid course memory: ${message}`);
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(name);
	return value as Record<string, unknown>;
}

function text(value: unknown, name: string, required = false): string {
	if (typeof value !== 'string' || (required && (!value.trim() || value !== value.trim()))) invalid(name);
	return value;
}

function number(value: unknown, name: string, integer = false): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
		invalid(name);
	}
	return value;
}

function array(value: unknown, name: string): unknown[] {
	if (!Array.isArray(value)) invalid(name);
	return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], name: string): T {
	if (!values.includes(value as T)) invalid(name);
	return value as T;
}

function identity(value: unknown): CourseIdentity {
	const source = record(value, 'course');
	return {
		courseId: text(source.courseId, 'course.courseId', true),
		clazzId: text(source.clazzId, 'course.clazzId', true),
		title: text(source.title, 'course.title')
	};
}

function courseKey(course: CourseIdentity) {
	return `${course.courseId}:${course.clazzId}`;
}

function storageKey(course: CourseIdentity) {
	return `ocs.agent.memory.v1:${encodeURIComponent(course.courseId)}:${encodeURIComponent(course.clazzId)}`;
}

/** Whitelist JSON fields rather than persisting page URLs, DOM nodes or caller-added properties. */
function taskRecord(value: unknown, course: CourseIdentity): VideoTask {
	const source = record(value, 'task');
	const jobId = text(source.jobId, 'task.jobId', true);
	const id = text(source.id, 'task.id', true);
	if (id !== `${courseKey(course)}:${jobId}`) invalid('task belongs to another course or has an invalid identity');
	return {
		id,
		chapterId: text(source.chapterId, 'task.chapterId'),
		jobId,
		mid: text(source.mid, 'task.mid'),
		title: text(source.title, 'task.title'),
		order: number(source.order, 'task.order'),
		platformStatus: oneOf(source.platformStatus, ['unknown', 'pending', 'confirmed'], 'task.platformStatus'),
		observedAt: number(source.observedAt, 'task.observedAt'),
		availability: oneOf(source.availability, ['executable', 'locked', 'unknown'], 'task.availability')
	};
}

function chapterRecord(value: unknown): ChapterObservation {
	const source = record(value, 'chapter');
	return {
		id: text(source.id, 'chapter.id', true),
		title: text(source.title, 'chapter.title'),
		order: number(source.order, 'chapter.order'),
		remaining: source.remaining === null ? null : number(source.remaining, 'chapter.remaining', true)
	};
}

function unique<T>(items: T[], key: (item: T) => string, name: string): T[] {
	if (new Set(items.map(key)).size !== items.length) invalid(`duplicate ${name}`);
	return items;
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

function summarize(memory: Pick<CourseMemory, 'tasks' | 'catalog'>): CourseMemory['summary'] {
	const confirmedTaskIds = memory.tasks.filter((task) => task.platformStatus === 'confirmed').map((task) => task.id);
	const unconfirmedTaskIds = memory.tasks.filter((task) => task.platformStatus !== 'confirmed').map((task) => task.id);
	const currentlyObserved = new Set(memory.catalog.observedTaskIds);
	const allObserved = memory.tasks.length > 0 && memory.tasks.every((task) => currentlyObserved.has(task.id));
	return {
		videoScopeStatus:
			memory.catalog.status !== 'complete' || !allObserved
				? 'unknown'
				: unconfirmedTaskIds.length === 0
				? 'completed'
				: 'pending',
		confirmedTaskIds,
		unconfirmedTaskIds,
		courseAllTasksStatus: 'not_assessed'
	};
}

function readStored(raw: unknown, expectedCourse: CourseIdentity): CourseMemory | null {
	if (raw === null || raw === undefined) return null;
	const source = record(raw, 'stored value');
	if (source.schemaVersion !== 1) invalid('unsupported schemaVersion');
	const course = identity(source.course);
	if (course.courseId !== expectedCourse.courseId || course.clazzId !== expectedCourse.clazzId) {
		invalid('stored course identity does not match its key');
	}
	const tasks = unique(
		array(source.tasks, 'tasks').map((task) => taskRecord(task, course)),
		(task) => task.id,
		'tasks'
	);
	const catalog = record(source.catalog, 'catalog');
	const observedTaskIds = unique(
		array(catalog.observedTaskIds, 'catalog.observedTaskIds').map((id) => text(id, 'observed task id', true)),
		(id) => id,
		'observed tasks'
	);
	if (observedTaskIds.some((id) => !tasks.some((task) => task.id === id))) invalid('unknown observed task id');
	const checkpoint = record(source.checkpoint, 'checkpoint');
	const taskId = checkpoint.taskId === null ? null : text(checkpoint.taskId, 'checkpoint.taskId', true);
	if (taskId !== null && !tasks.some((task) => task.id === taskId)) invalid('unknown checkpoint task');
	const navigation = record(source.navigation, 'navigation');
	if (navigation.version !== 1 || navigation.strategy !== 'chapter_id_click_then_inspect') {
		invalid('unsupported navigation strategy');
	}
	const targets = unique(
		array(navigation.targets, 'navigation.targets').map((value) => {
			const target = record(value, 'navigation target');
			const targetTaskId = text(target.taskId, 'navigation target taskId', true);
			const chapterId = text(target.chapterId, 'navigation target chapterId');
			const jobId = text(target.jobId, 'navigation target jobId', true);
			if (!tasks.some((task) => task.id === targetTaskId && task.jobId === jobId && task.chapterId === chapterId)) {
				invalid('navigation target does not match a stored task');
			}
			return {
				taskId: targetTaskId,
				chapterId,
				jobId,
				observedAt: number(target.observedAt, 'navigation target observedAt')
			};
		}),
		(target) => target.taskId,
		'navigation targets'
	);
	const memory: CourseMemory = {
		schemaVersion: 1,
		revision: number(source.revision, 'revision', true),
		updatedAt: number(source.updatedAt, 'updatedAt'),
		course,
		catalog: {
			status: oneOf(catalog.status, ['unknown', 'partial', 'complete'], 'catalog.status'),
			observedAt: number(catalog.observedAt, 'catalog.observedAt'),
			observedTaskIds,
			chapters: unique(
				array(catalog.chapters, 'catalog.chapters').map(chapterRecord),
				(chapter) => chapter.id,
				'chapters'
			)
		},
		tasks,
		navigation: { version: 1, strategy: 'chapter_id_click_then_inspect', targets },
		checkpoint: {
			taskId,
			phase: text(checkpoint.phase, 'checkpoint.phase', true),
			updatedAt: number(checkpoint.updatedAt, 'checkpoint.updatedAt')
		},
		summary: {
			videoScopeStatus: 'unknown',
			confirmedTaskIds: [],
			unconfirmedTaskIds: [],
			courseAllTasksStatus: 'not_assessed'
		}
	};
	memory.summary = summarize(memory);
	const summary = record(source.summary, 'summary');
	if (
		summary.videoScopeStatus !== memory.summary.videoScopeStatus ||
		summary.courseAllTasksStatus !== 'not_assessed' ||
		JSON.stringify(summary.confirmedTaskIds) !== JSON.stringify(memory.summary.confirmedTaskIds) ||
		JSON.stringify(summary.unconfirmedTaskIds) !== JSON.stringify(memory.summary.unconfirmedTaskIds)
	) {
		invalid('summary contradicts stored observations');
	}
	return memory;
}

export function createCourseMemory(storage: MemoryStorage) {
	// Deliberately not persisted: a previous browser session cannot grant current executability.
	const currentObservations = new Map<string, { blocked: boolean; tasks: VideoTask[] }>();

	function get(courseInput: CourseIdentity): CourseMemory | null {
		const course = identity(courseInput);
		return clone(readStored(storage.get(storageKey(course)), course));
	}

	function save(memory: CourseMemory): CourseMemory {
		memory.revision++;
		memory.updatedAt = Date.now();
		memory.summary = summarize(memory);
		storage.set(storageKey(memory.course), clone(memory));
		return clone(memory);
	}

	function reconcile(observation: PageObservation): CourseMemory | null {
		// A failed observation must not leave targets from the previous document executable.
		currentObservations.clear();
		if (observation.course === null) {
			return null;
		}
		const course = identity(observation.course);
		const observedTasks = unique(
			array(observation.tasks, 'observation.tasks').map((task) => taskRecord(task, course)),
			(task) => task.id,
			'observation tasks'
		);
		const observedChapters = unique(
			array(observation.chapters, 'observation.chapters').map(chapterRecord),
			(chapter) => chapter.id,
			'observation chapters'
		);
		const status = oneOf(observation.catalogStatus, ['unknown', 'partial', 'complete'], 'observation.catalogStatus');
		const previous = get(course);
		const now = Date.now();
		const tasks = new Map((previous?.tasks || []).map((task) => [task.id, task]));
		const freshTaskIds = observedTasks
			.filter((task) => !tasks.has(task.id) || task.observedAt >= tasks.get(task.id)!.observedAt)
			.map((task) => task.id);
		for (const task of observedTasks) {
			const saved = tasks.get(task.id);
			if (!saved || task.observedAt >= saved.observedAt) tasks.set(task.id, task);
		}
		const chapters = new Map((previous?.catalog.chapters || []).map((chapter) => [chapter.id, chapter]));
		for (const chapter of observedChapters) chapters.set(chapter.id, chapter);
		const targets = new Map((previous?.navigation.targets || []).map((target) => [target.taskId, target]));
		for (const task of observedTasks) {
			if (freshTaskIds.includes(task.id)) {
				targets.set(task.id, {
					taskId: task.id,
					chapterId: task.chapterId,
					jobId: task.jobId,
					observedAt: task.observedAt
				});
			}
		}
		const memory: CourseMemory = {
			schemaVersion: 1,
			revision: previous?.revision || 0,
			updatedAt: now,
			course,
			catalog: {
				status,
				observedAt: now,
				observedTaskIds: freshTaskIds,
				chapters: [...chapters.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
			},
			tasks: [...tasks.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
			navigation: { version: 1, strategy: 'chapter_id_click_then_inspect', targets: [...targets.values()] },
			checkpoint: previous?.checkpoint || { taskId: null, phase: 'not_started', updatedAt: now },
			summary: {
				videoScopeStatus: 'unknown',
				confirmedTaskIds: [],
				unconfirmedTaskIds: [],
				courseAllTasksStatus: 'not_assessed'
			}
		};
		const result = save(memory);
		currentObservations.set(storageKey(course), { blocked: !!observation.blockedReason, tasks: clone(observedTasks) });
		return result;
	}

	function checkpoint(course: CourseIdentity, taskId: string | null, phase: string): CourseMemory {
		const memory = get(course);
		if (!memory) invalid('course must be observed before creating a checkpoint');
		if (taskId !== null && !memory.tasks.some((task) => task.id === taskId))
			invalid('checkpoint task belongs to another course');
		memory.checkpoint = { taskId, phase: text(phase, 'checkpoint phase', true), updatedAt: Date.now() };
		return save(memory);
	}

	function next(course: CourseIdentity): VideoTask | null {
		const memory = get(course);
		const current = currentObservations.get(storageKey(identity(course)));
		if (!memory || !current || current.blocked) return null;
		const liveTasks = new Map(current.tasks.map((task) => [task.id, task]));
		const selected = memory.tasks.find((task) => {
			const live = liveTasks.get(task.id);
			return (
				live &&
				live.observedAt >= task.observedAt &&
				live.availability === 'executable' &&
				live.platformStatus !== 'confirmed' &&
				task.platformStatus !== 'confirmed'
			);
		});
		return selected ? clone(selected) : null;
	}

	return { reconcile, get, checkpoint, next };
}
