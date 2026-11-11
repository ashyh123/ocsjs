import type { PlatformAdapter, RunnerSnapshot, RunnerState, VideoTask } from './types';

/** A single-video lifecycle. Playback never implies platform completion. */
export function createVideoRunner(
	adapter: PlatformAdapter,
	onEvent?: (kind: string, snapshot: RunnerSnapshot) => void
) {
	let state: RunnerState = 'idle';
	let taskId: string | null = null;
	let media: HTMLMediaElement | undefined;
	let courseKey = '';
	let platformStatus: RunnerSnapshot['platformStatus'] = 'unknown';
	let blockedReason: string | null = null;
	let error: string | null = null;
	let lastProgressAt: number | null = null;
	let previousTime = 0;
	let generation = 0;
	let wantsPlayback = false;
	let playPending = false;
	let validSession = false;
	let disposed = false;
	let refreshing = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let removeListeners: (() => void) | undefined;

	const pauseMedia = (target: HTMLMediaElement | undefined) => {
		try {
			target?.pause();
		} catch {
			// A detached or already-closed document can reject media operations.
		}
	};

	const serialize = (): RunnerSnapshot => ({
		state,
		taskId,
		media: media
			? {
					currentTime: Number.isFinite(media.currentTime) ? media.currentTime : 0,
					duration: Number.isFinite(media.duration) ? media.duration : null,
					paused: media.paused,
					ended: media.ended,
					readyState: media.readyState
			  }
			: null,
		platformStatus,
		heartbeatAt: Date.now(),
		lastProgressAt,
		blockedReason,
		error
	});

	const emit = (kind: string) => {
		try {
			onEvent?.(kind, serialize());
		} catch {
			// Observation consumers cannot break playback or cleanup.
		}
	};

	const transition = (next: RunnerState) => {
		if (state !== next) {
			state = next;
			emit('state_changed');
		}
	};

	const clearObservers = () => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
		removeListeners?.();
		removeListeners = undefined;
	};

	const cancelPendingPlay = () => {
		generation++;
		playPending = false;
		wantsPlayback = false;
	};

	const invalidate = (reason: string) => {
		validSession = false;
		cancelPendingPlay();
		clearObservers();
		pauseMedia(media);
		platformStatus = 'unknown';
		blockedReason = reason;
		transition('stopped');
	};

	const fail = (cause: unknown) => {
		validSession = false;
		cancelPendingPlay();
		clearObservers();
		error = cause instanceof Error ? cause.message : String(cause);
		pauseMedia(media);
		transition('error');
	};

	const refresh = () => {
		if (!validSession || !taskId || refreshing || disposed) return;
		refreshing = true;
		try {
			const page = adapter.inspect();
			const observedCourse = page.course ? `${page.course.courseId}:${page.course.clazzId}` : '';
			const task = page.tasks.find((item) => item.id === taskId);
			if (!task || !observedCourse || observedCourse !== courseKey) {
				invalidate('task_context_changed');
				return;
			}
			if (media && (media.isConnected === false || adapter.resolveMedia(taskId) !== media)) {
				invalidate('media_context_changed');
				return;
			}
			platformStatus = task.platformStatus;
			if (media) {
				const currentTime = media.currentTime;
				if (Number.isFinite(currentTime)) {
					if (currentTime > previousTime + 0.001) lastProgressAt = Date.now();
					previousTime = currentTime;
				}
			}
			if (page.blockedReason) {
				blockedReason = page.blockedReason;
				cancelPendingPlay();
				transition('waiting_for_user');
				pauseMedia(media);
				return;
			}
			if (blockedReason !== 'autoplay_blocked') blockedReason = null;
			if (platformStatus === 'confirmed') {
				cancelPendingPlay();
				clearObservers();
				transition('completed');
				pauseMedia(media);
			} else if (media?.ended) {
				cancelPendingPlay();
				transition('awaiting_confirmation');
			} else if (media && !media.paused && wantsPlayback && !playPending) {
				transition('running');
			} else if ((state === 'running' || (state === 'starting' && !playPending)) && media?.paused) {
				cancelPendingPlay();
				transition('paused');
			} else if ((state === 'paused' || state === 'waiting_for_user') && media && !wantsPlayback && !media.paused) {
				pauseMedia(media);
			} else if (state === 'completed') {
				transition('awaiting_confirmation');
			} else if (state === 'waiting_for_user' && !page.blockedReason && !blockedReason) {
				transition('paused');
			}
		} catch (cause) {
			fail(cause);
		} finally {
			refreshing = false;
		}
	};

	const snapshot = () => {
		refresh();
		return serialize();
	};

	const observe = () => {
		if (!media || timer !== undefined) return;
		const target = media;
		const handleMediaError = () => fail(target.error?.message || 'Video playback failed');
		const events = ['timeupdate', 'ended', 'pause', 'playing', 'waiting', 'loadedmetadata'];
		for (const event of events) target.addEventListener(event, refresh);
		target.addEventListener('error', handleMediaError);
		removeListeners = () => {
			for (const event of events) target.removeEventListener(event, refresh);
			target.removeEventListener('error', handleMediaError);
		};
		timer = setInterval(refresh, 1000);
		// Node fixture tests should not outlive their runner because of this timer.
		(timer as unknown as { unref?: () => void }).unref?.();
	};

	const beginPlayback = () => {
		if (!media || !validSession) return;
		const target = media;
		const token = ++generation;
		wantsPlayback = true;
		playPending = true;
		blockedReason = null;
		error = null;
		transition('starting');
		const handleFailure = (cause: unknown) => {
			if (token !== generation || disposed || !validSession) return;
			playPending = false;
			wantsPlayback = false;
			if (cause instanceof Error && cause.name === 'NotAllowedError') {
				blockedReason = 'autoplay_blocked';
				error = cause.message;
				transition('waiting_for_user');
				pauseMedia(target);
			} else {
				fail(cause);
			}
		};
		try {
			Promise.resolve(target.play()).then(() => {
				if (token !== generation || disposed || !validSession) {
					// A late play completion must not undo stop/pause or revive an old video.
					if (target !== media || !wantsPlayback || disposed) pauseMedia(target);
					return;
				}
				playPending = false;
				refresh();
			}, handleFailure);
		} catch (cause) {
			handleFailure(cause);
		}
	};

	const assertUsable = () => {
		if (disposed) throw new Error('Video runner has been disposed');
	};

	const start = (id: string) => {
		assertUsable();
		if (typeof id !== 'string' || !id.trim()) throw new Error('A video task id is required');
		refresh();
		if (validSession && !['completed', 'stopped', 'error'].includes(state)) {
			if (taskId === id) return serialize();
			throw new Error('Another video task is active; stop it before starting a different video');
		}
		const page = adapter.inspect();
		const task: VideoTask | undefined = page.tasks.find((item) => item.id === id);
		if (!page.course || !task) throw new Error('Video task identity is unavailable on the current page');
		if (task.availability !== 'executable' && task.platformStatus !== 'confirmed') {
			throw new Error('Video task is not currently executable');
		}
		const target = adapter.resolveMedia(id);
		if (!target && task.platformStatus !== 'confirmed') throw new Error('The target video is not loaded');
		cancelPendingPlay();
		clearObservers();
		pauseMedia(media);
		taskId = id;
		media = target;
		courseKey = `${page.course.courseId}:${page.course.clazzId}`;
		platformStatus = task.platformStatus;
		blockedReason = page.blockedReason;
		error = null;
		lastProgressAt = null;
		previousTime = target?.currentTime || 0;
		validSession = true;
		if (platformStatus === 'confirmed') {
			transition('completed');
		} else {
			observe();
			if (blockedReason) {
				transition('waiting_for_user');
				pauseMedia(media);
			} else beginPlayback();
		}
		emit('start');
		return serialize();
	};

	const pause = () => {
		assertUsable();
		refresh();
		if (!validSession || !media) throw new Error('No active video task to pause');
		cancelPendingPlay();
		if (!['completed', 'awaiting_confirmation', 'waiting_for_user'].includes(state)) transition('paused');
		pauseMedia(media);
		emit('pause');
		return serialize();
	};

	const resume = () => {
		assertUsable();
		refresh();
		if (!validSession || !media) throw new Error('No active video task to resume');
		if (state === 'completed' || state === 'awaiting_confirmation') return serialize();
		if (adapter.inspect().blockedReason) return serialize();
		if (state === 'running' || state === 'starting') return serialize();
		observe();
		beginPlayback();
		emit('resume');
		return serialize();
	};

	const stop = () => {
		validSession = false;
		cancelPendingPlay();
		clearObservers();
		blockedReason = null;
		pauseMedia(media);
		transition('stopped');
		emit('stop');
		return serialize();
	};

	return {
		start,
		pause,
		resume,
		stop,
		snapshot,
		dispose() {
			if (disposed) return;
			stop();
			disposed = true;
		}
	};
}
