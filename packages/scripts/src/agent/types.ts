/** JSON-only contracts shared by the userscript and browser agents. */
export type PlatformStatus = 'unknown' | 'pending' | 'confirmed';
export type RunnerState =
	| 'idle'
	| 'starting'
	| 'running'
	| 'paused'
	| 'waiting_for_user'
	| 'awaiting_confirmation'
	| 'completed'
	| 'stopped'
	| 'error';

export interface CourseIdentity {
	courseId: string;
	clazzId: string;
	title: string;
}

export interface VideoTask {
	id: string;
	chapterId: string;
	jobId: string;
	mid: string;
	title: string;
	order: number;
	platformStatus: PlatformStatus;
	observedAt: number;
	availability: 'executable' | 'locked' | 'unknown';
}

export interface ChapterObservation {
	id: string;
	title: string;
	order: number;
	remaining: number | null;
}

export interface PageObservation {
	course: CourseIdentity | null;
	url: string;
	tasks: VideoTask[];
	chapters: ChapterObservation[];
	catalogStatus: 'unknown' | 'partial' | 'complete';
	blockedReason: string | null;
}

export interface MediaSnapshot {
	currentTime: number;
	duration: number | null;
	paused: boolean;
	ended: boolean;
	readyState: number;
}

export interface RunnerSnapshot {
	state: RunnerState;
	taskId: string | null;
	media: MediaSnapshot | null;
	platformStatus: PlatformStatus;
	heartbeatAt: number;
	lastProgressAt: number | null;
	blockedReason: string | null;
	error: string | null;
}

export interface PlatformAdapter {
	inspect(): PageObservation;
	resolveMedia(taskId: string): HTMLMediaElement | undefined;
	openTask(taskId: string): void;
	openChapter?(chapterId: string): void;
}

export interface AgentEvent {
	contextId: string;
	seq: number;
	at: number;
	kind: string;
	taskId: string | null;
	state: RunnerState;
}

export interface MemoryStorage {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
}
