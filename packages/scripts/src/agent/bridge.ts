import { createChaoxingAdapter } from './chaoxing';
import { createCourseMemory } from './memory';
import { createVideoRunner } from './runner';
import { AgentEvent, CourseIdentity, MemoryStorage, PageObservation, RunnerSnapshot } from './types';

const PROTOCOL = 'ocs-agent-v1';
const VERSION = '1.0';
const ACTIONS = [
	'inspect',
	'start',
	'pause',
	'resume',
	'stop',
	'events',
	'openTask',
	'openChapter',
	'setCourse',
	'dispose'
];

interface FrameSnapshot {
	contextId: string;
	observation: PageObservation;
	status: RunnerSnapshot;
}

interface FrameConnection {
	source: Window;
	origin: string;
	contextId: string;
}

export interface BridgeOptions {
	window: Window;
	storage: MemoryStorage;
	attachmentsProvider?: () => unknown;
	/** Additional exact origins, useful for local browser fixtures. */
	allowedOrigins?: string[];
	showPanel?: boolean;
}

/** Install in every matched frame; the top page coordinates short, JSON-only calls. */
export function installChaoxingAgentBridge(options: BridgeOptions) {
	const win = options.window;
	const contextId = `ocs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	const isTop = win === win.top;
	let inheritedCourse: CourseIdentity | null = null;
	const adapter = createChaoxingAdapter(win, options.attachmentsProvider, () => inheritedCourse);
	const memory = createCourseMemory(options.storage);
	let seq = 0;
	let disposed = false;
	let queue: Promise<unknown> = Promise.resolve();
	const events: AgentEvent[] = [];
	const frames = new Map<string, FrameConnection>();
	const pending = new Map<
		string,
		{
			frame: FrameConnection;
			resolve: (value: any) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	const runner = createVideoRunner(adapter, (kind, snapshot) => {
		events.push({ contextId, seq: ++seq, at: Date.now(), kind, taskId: snapshot.taskId, state: snapshot.state });
		if (events.length > 200) events.shift();
	});

	function allowed(origin: string) {
		if (origin === 'null') return false;
		if (origin === win.location.origin || options.allowedOrigins?.includes(origin)) return true;
		try {
			const url = new URL(origin);
			return (
				url.protocol === 'https:' &&
				['chaoxing.com', 'xuexi365.com'].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
			);
		} catch {
			return false;
		}
	}

	function descendant(source: Window) {
		const visited = new Set<Window>();
		const search: Window[] = [win];
		while (search.length && visited.size < 128) {
			const parent = search.shift()!;
			if (visited.has(parent)) continue;
			visited.add(parent);
			try {
				for (let i = 0; i < parent.frames.length; i++) {
					const child = parent.frames[i];
					if (child === source) return true;
					search.push(child);
				}
			} catch {
				/* A detached or inaccessible subtree is not a trusted sender. */
			}
		}
		return false;
	}

	function local(action: string, argument?: any): any {
		if (disposed) throw new Error('Agent bridge disposed');
		switch (action) {
			case 'inspect':
				return { contextId, observation: adapter.inspect(), status: runner.snapshot() };
			case 'start':
				return runner.start(requireId(argument));
			case 'pause':
				return runner.pause();
			case 'resume':
				return runner.resume();
			case 'stop':
				return runner.stop();
			case 'dispose':
				cleanup();
				return true;
			case 'events':
				return { contextId, latestSeq: seq, events: events.filter((event) => event.seq > (Number(argument) || 0)) };
			case 'openTask':
				return adapter.openTask(requireId(argument));
			case 'openChapter': {
				if (!adapter.openChapter) throw new Error('Chapter navigation unavailable in this frame');
				return adapter.openChapter(requireId(argument));
			}
			case 'setCourse': {
				if (!argument || typeof argument.courseId !== 'string' || typeof argument.clazzId !== 'string') {
					throw new Error('Invalid course identity');
				}
				inheritedCourse = {
					courseId: argument.courseId,
					clazzId: argument.clazzId,
					title: String(argument.title || '')
				};
				return true;
			}
			default:
				throw new Error('Unsupported agent action');
		}
	}

	function requireId(value: unknown): string {
		if (typeof value !== 'string' || !value || value.length > 512)
			throw new Error('A stable task or chapter ID is required');
		return value;
	}

	function request(frame: FrameConnection, action: string, argument?: unknown): Promise<any> {
		const requestId = `${contextId}:${++seq}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(requestId);
				reject(new Error(`Frame unavailable: ${frame.contextId}`));
			}, 3000);
			pending.set(requestId, { frame, resolve, reject, timer });
			frame.source.postMessage(
				{ protocol: PROTOCOL, type: 'request', requestId, contextId: frame.contextId, action, argument },
				frame.origin
			);
		});
	}

	function onMessage(event: MessageEvent) {
		const data = event.data;
		if (disposed || !data || data.protocol !== PROTOCOL || !allowed(event.origin) || !event.source) return;
		if (isTop && data.type === 'hello' && typeof data.contextId === 'string' && descendant(event.source as Window)) {
			for (const [id, frame] of frames) if (frame.source === event.source) frames.delete(id);
			frames.set(data.contextId, { source: event.source as Window, origin: event.origin, contextId: data.contextId });
		} else if (!isTop && event.source === win.top && data.type === 'discover') {
			hello();
		} else if (isTop && data.type === 'response') {
			const operation = pending.get(data.requestId);
			if (
				!operation ||
				event.source !== operation.frame.source ||
				event.origin !== operation.frame.origin ||
				data.contextId !== operation.frame.contextId
			)
				return;
			clearTimeout(operation.timer);
			pending.delete(data.requestId);
			if (data.error) operation.reject(new Error(String(data.error)));
			else operation.resolve(data.value);
		} else if (
			!isTop &&
			event.source === win.top &&
			data.type === 'request' &&
			data.contextId === contextId &&
			ACTIONS.includes(data.action)
		) {
			try {
				const value = local(data.action, data.argument);
				(event.source as Window).postMessage(
					{ protocol: PROTOCOL, type: 'response', requestId: data.requestId, contextId, value },
					event.origin
				);
			} catch (error) {
				(event.source as Window).postMessage(
					{ protocol: PROTOCOL, type: 'response', requestId: data.requestId, contextId, error: String(error) },
					event.origin
				);
			}
		}
	}

	function pruneFrames() {
		for (const [id, frame] of frames) if (!descendant(frame.source)) frames.delete(id);
	}

	async function inspect() {
		pruneFrames();
		const own = local('inspect') as FrameSnapshot;
		const snapshots: FrameSnapshot[] = [own];
		const unavailableFrames: string[] = [];
		await Promise.all(
			Array.from(frames.values()).map(async (frame) => {
				try {
					if (own.observation.course) await request(frame, 'setCourse', own.observation.course);
					snapshots.push(await request(frame, 'inspect'));
				} catch {
					unavailableFrames.push(frame.contextId);
				}
			})
		);
		const course =
			own.observation.course || snapshots.find((frame) => frame.observation.course)?.observation.course || null;
		const sameCourse = snapshots.filter(
			(frame) =>
				!course ||
				(frame.observation.course?.courseId === course.courseId && frame.observation.course?.clazzId === course.clazzId)
		);
		const tasks = Array.from(
			new Map(sameCourse.flatMap((frame) => frame.observation.tasks).map((task) => [task.id, task])).values()
		);
		const observation: PageObservation = {
			...own.observation,
			course,
			tasks,
			chapters: sameCourse.reduce(
				(best, frame) => (frame.observation.chapters.length > best.length ? frame.observation.chapters : best),
				own.observation.chapters
			),
			catalogStatus:
				own.observation.catalogStatus === 'complete' && !unavailableFrames.length
					? 'complete'
					: tasks.length || own.observation.chapters.length
					? 'partial'
					: 'unknown'
		};
		let courseMemory = memory.reconcile(observation);
		if (course && courseMemory?.checkpoint.taskId) {
			const matching = snapshots.filter((frame) => frame.status.taskId === courseMemory?.checkpoint.taskId);
			const current =
				matching.find((frame) => !['idle', 'stopped', 'error'].includes(frame.status.state)) || matching[0];
			if (current && current.status.state !== courseMemory.checkpoint.phase) {
				courseMemory = memory.checkpoint(course, current.status.taskId, current.status.state);
			}
		}
		return {
			version: VERSION,
			contextId,
			observedAt: Date.now(),
			observation,
			frames: snapshots,
			unavailableFrames,
			memory: courseMemory
		};
	}

	function serial<T>(action: () => Promise<T>): Promise<T> {
		const result = queue.then(action);
		queue = result.catch(() => undefined);
		return result;
	}

	function call(frameId: string, action: string, argument?: unknown): Promise<any> {
		if (frameId === contextId) return Promise.resolve(local(action, argument));
		const frame = frames.get(frameId);
		return frame ? request(frame, action, argument) : Promise.reject(new Error('Frame changed; inspect again'));
	}

	async function stopAll() {
		pruneFrames();
		local('stop');
		await Promise.all(Array.from(frames.values()).map((frame) => request(frame, 'stop')));
	}

	const api = Object.freeze({
		version: VERSION,
		describe: () => ({
			platform: 'chaoxing',
			scope: 'video_tasks',
			navigationOwner: 'agent',
			methods: [
				'inspect',
				'getStatus',
				'start',
				'pause',
				'resume',
				'stop',
				'openTask',
				'openChapter',
				'readEvents',
				'getMemory',
				'nextTask'
			]
		}),
		inspect,
		getStatus: inspect,
		start: (taskId: string) =>
			serial(async () => {
				requireId(taskId);
				const state = await inspect();
				if (!state.observation.tasks.some((task) => task.id === taskId))
					throw new Error('Task belongs to another course');
				const frame = state.frames.find((item) =>
					item.observation.tasks.some((task) => task.id === taskId && task.availability === 'executable')
				);
				if (!frame) throw new Error('Task is not executable in the current documents; inspect again');
				if (state.unavailableFrames.length)
					throw new Error('A frame is unavailable; cannot safely start another runner');
				const alreadyRunning = state.frames.find(
					(item) =>
						item.status.taskId === taskId &&
						['starting', 'running', 'paused', 'waiting_for_user', 'awaiting_confirmation'].includes(item.status.state)
				);
				if (alreadyRunning) return alreadyRunning.status;
				await stopAll();
				if (state.observation.course) memory.checkpoint(state.observation.course, taskId, 'starting');
				return call(frame.contextId, 'start', taskId);
			}),
		pause: () =>
			serial(async () => {
				const state = await inspect();
				const active = state.frames.filter((frame) =>
					['starting', 'running', 'paused', 'waiting_for_user', 'awaiting_confirmation'].includes(frame.status.state)
				);
				if (active.length !== 1) throw new Error('Exactly one active runner is required');
				await call(active[0].contextId, 'pause');
				return inspect();
			}),
		resume: () =>
			serial(async () => {
				const state = await inspect();
				const active = state.frames.filter(
					(frame) => frame.status.state === 'paused' || frame.status.state === 'waiting_for_user'
				);
				if (active.length !== 1) throw new Error('Exactly one paused runner is required');
				return call(active[0].contextId, 'resume');
			}),
		stop: () =>
			serial(async () => {
				await stopAll();
				return inspect();
			}),
		openTask: (taskId: string) =>
			serial(async () => {
				const state = await inspect();
				const frame = state.frames.find((item) => item.observation.tasks.some((task) => task.id === requireId(taskId)));
				if (!frame) throw new Error('Unknown task; inspect the target chapter first');
				await stopAll();
				return call(frame.contextId, 'openTask', taskId);
			}),
		openChapter: (chapterId: string) =>
			serial(async () => {
				const state = await inspect();
				const frame = state.frames.find((item) =>
					item.observation.chapters.some((chapter) => chapter.id === requireId(chapterId))
				);
				if (!frame) throw new Error('Unknown chapter; inspect the course directory first');
				await stopAll();
				return call(frame.contextId, 'openChapter', chapterId);
			}),
		readEvents: async (cursors: Record<string, number> = {}) => {
			const result = [local('events', cursors[contextId])];
			await Promise.all(
				Array.from(frames.values()).map(async (frame) =>
					result.push(await request(frame, 'events', cursors[frame.contextId]))
				)
			);
			return result;
		},
		getMemory: async () => (await inspect()).memory,
		nextTask: async () => {
			const state = await inspect();
			return state.observation.course ? memory.next(state.observation.course) : null;
		},
		dispose: () =>
			serial(async () => {
				if (disposed) return;
				await stopAll();
				await inspect();
				await Promise.all(Array.from(frames.values()).map((frame) => request(frame, 'dispose')));
				cleanup();
			})
	});

	function cleanup() {
		if (disposed) return;
		disposed = true;
		runner.dispose();
		clearInterval(helloTimer);
		clearInterval(panelTimer);
		win.removeEventListener('message', onMessage);
		win.removeEventListener('pagehide', onPageHide);
		win.removeEventListener('pageshow', onPageShow);
		win.document.removeEventListener('load', onFrameLoad, true);
		for (const operation of pending.values()) {
			clearTimeout(operation.timer);
			operation.reject(new Error('Agent bridge disposed'));
		}
		pending.clear();
		panel?.remove();
	}

	function onPageHide(event: PageTransitionEvent) {
		pruneFrames();
		for (const frame of frames.values()) {
			frame.source.postMessage(
				{ protocol: PROTOCOL, type: 'request', requestId: 'pagehide', contextId: frame.contextId, action: 'stop' },
				frame.origin
			);
		}
		if (event.persisted) {
			runner.stop();
			frames.clear();
			for (const operation of pending.values()) {
				clearTimeout(operation.timer);
				operation.reject(new Error('Page suspended; inspect after pageshow'));
			}
			pending.clear();
		} else cleanup();
	}

	function onPageShow(event: PageTransitionEvent) {
		if (event.persisted && !disposed) hello();
	}

	function onFrameLoad(event: Event) {
		const element = event.target as HTMLIFrameElement | null;
		if (!element || element.tagName !== 'IFRAME' || !element.contentWindow) return;
		for (const [id, frame] of frames) if (frame.source === element.contentWindow) frames.delete(id);
		pruneFrames();
		// document-start may announce before iframe load, so request a fresh handshake.
		element.contentWindow.postMessage({ protocol: PROTOCOL, type: 'discover' }, '*');
	}

	win.addEventListener('message', onMessage);
	win.addEventListener('pagehide', onPageHide);
	win.addEventListener('pageshow', onPageShow);
	win.document.addEventListener('load', onFrameLoad, true);
	const hello = () => {
		if (!isTop) win.top?.postMessage({ protocol: PROTOCOL, type: 'hello', contextId }, '*');
	};
	const helloTimer = setInterval(hello, 2000);
	hello();
	Object.defineProperty(win, 'OCSAgent', { configurable: true, value: api });
	let panel: HTMLElement | undefined;
	let panelTimer: ReturnType<typeof setInterval> | undefined;
	if (isTop && options.showPanel !== false) {
		const mount = () => {
			if (disposed || panel || !win.document.body) return;
			panel = win.document.createElement('aside');
			panel.setAttribute('data-ocs-agent', '');
			panel.style.cssText =
				'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:white;color:#222;border:1px solid #ccc;padding:12px;border-radius:8px;font:13px sans-serif;max-width:320px;box-shadow:0 2px 10px #0002';
			const title = win.document.createElement('strong');
			title.textContent = 'OCS Agent · 超星视频';
			const status = win.document.createElement('div');
			status.textContent = '正在识别课程…';
			const select = win.document.createElement('select');
			select.style.cssText = 'display:block;width:100%;margin:8px 0';
			panel.append(title, status, select);
			const refresh = async () => {
				try {
					const state = await inspect();
					const selected = select.value;
					select.replaceChildren();
					for (const task of state.observation.tasks) {
						const option = win.document.createElement('option');
						option.value = task.id;
						option.textContent = task.title;
						select.append(option);
					}
					if (Array.from(select.options).some((option) => option.value === selected)) select.value = selected;
					const active = state.frames.find((frame) => frame.status.taskId);
					status.textContent =
						state.observation.blockedReason ||
						`${state.observation.course?.title || '请进入课程视频页'} · ${active?.status.state || '等待启动'}`;
				} catch (error) {
					status.textContent = String(error);
				}
			};
			for (const [label, action] of [
				['刷新', refresh],
				['开始', () => api.start(select.value)],
				['暂停', api.pause],
				['继续', api.resume],
				['停止', api.stop]
			] as Array<[string, () => unknown]>) {
				const button = win.document.createElement('button');
				button.textContent = label;
				button.style.marginRight = '4px';
				button.onclick = () => {
					Promise.resolve()
						.then(action)
						.then(refresh)
						.catch((error) => {
							status.textContent = String(error);
						});
				};
				panel.append(button);
			}
			win.document.body.append(panel);
			panelTimer = setInterval(refresh, 5000);
			refresh();
		};
		if (win.document.readyState === 'loading') win.document.addEventListener('DOMContentLoaded', mount, { once: true });
		else mount();
	}
	return api;
}
