import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, defineDoc, defineExtension, defineTask, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

const context = BACKGROUND_CONTEXT;
const pollMs = 4000;
const attentionMs = 10000;
const confirmationMs = 20000;
const stallMs = 60000;
const maxAttempts = 3;
const missingTask = '无法在当前页面唯一识别绑定的视频任务点。';
const activeRunnerStates = ['starting', 'running', 'paused', 'waiting_for_user', 'awaiting_confirmation'];
const navigationPreflightWaits = new Set([
	'network_offline',
	'space_unavailable',
	'course_page_unavailable',
	'course_page_loading',
	'course_frames_unavailable',
	'course_page_changed'
]);

const Job = defineDoc({
	kind: 'ocs.single-video',
	version: 1,
	scope: 'conversation',
	history: 'latest',
	fork: 'initial',
	initial: () => ({ taskId: null, target: null, result: null }),
	checkpointWhen: () => true
});

function sameCourse(observation, target) {
	return observation.course?.courseId === target.courseId && observation.course?.clazzId === target.clazzId;
}

function selectedTask(value, target) {
	return value.observation.tasks.find((item) => item.id === target.taskId && item.chapterId === target.chapterId);
}

export function bindVideo(result, selection) {
	if (result.kind !== 'observed') throw new Error(result.reason);
	const { observation } = result.value;
	const task = observation.tasks.find((item) => item.id === selection.taskId);
	if (observation.blockedReason) throw new Error(observation.blockedReason);
	if (
		!observation.course ||
		!task?.chapterId ||
		!task.jobId ||
		task.availability !== 'executable' ||
		!result.profileId
	) {
		throw new Error('请在已登录的浏览器中打开目标课节，并选择一个可唯一定位的视频任务点。');
	}
	return {
		...selection,
		profileId: result.profileId,
		...(result.enrollmentKey ? { enrollmentKey: result.enrollmentKey } : {}),
		courseId: observation.course.courseId,
		clazzId: observation.course.clazzId,
		chapterId: task.chapterId,
		chapterTitle: observation.chapters?.find((chapter) => chapter.id === task.chapterId)?.title ?? '',
		title: task.title
	};
}

function createVideoTask({ browser, selectRecovery, onStatus }) {
	async function park(runtime, ctx, checkpoint, state, reason, changes = {}, delay = pollMs) {
		await runtime.sleepUntil(
			runtime.now() + delay,
			{ ...checkpoint, phase: 'observe', ...changes, state, reason },
			ctx
		);
		if (state !== checkpoint.state || reason !== checkpoint.reason) onStatus({ state, reason });
	}

	function transition(runtime, ctx, checkpoint, changes) {
		return runtime.commit(() => ({ status: 'running', checkpoint: { ...checkpoint, ...changes } }), ctx);
	}

	function parkFailure(runtime, ctx, checkpoint, result, changes = {}) {
		const state = { wait: 'waiting_for_browser', user: 'waiting_for_user' }[result.kind] ?? 'needs_attention';
		return park(runtime, ctx, checkpoint, state, result.reason, changes, attentionMs);
	}

	return defineTask({
		name: 'ocs.chaoxing.video',
		version: 1,
		initial: () => ({
			phase: 'observe',
			state: 'queued',
			reason: null,
			attempts: 0,
			pendingSince: null,
			refreshed: false,
			startedAt: null,
			observation: null
		}),
		phases: {
			observe: async ({ input: target, state: { checkpoint } }, runtime, ctx) => {
				const now = runtime.now();
				const wait = (state, reason, changes, delay) => park(runtime, ctx, checkpoint, state, reason, changes, delay);
				const count = (reason) => (checkpoint.reason === reason ? Math.min(checkpoint.attempts + 1, maxAttempts) : 1);
				const unexpected = (reason, observation = checkpoint.observation) => {
					const attempts = count(reason);
					if (attempts < maxAttempts) return wait('retrying', reason, { attempts, observation });
					return wait('needs_attention', reason, { attempts, observation }, attentionMs);
				};
				const handleFailure = (result) => {
					if (result.kind === 'wait' || result.kind === 'user')
						return parkFailure(runtime, ctx, checkpoint, result, { attempts: 0 });
					return unexpected(result.reason);
				};
				const current = await browser.inspect(target, runtime.signal);
				if (current.kind !== 'observed') return handleFailure(current);
				const value = current.value;
				if (value.observation.blockedReason)
					return wait('waiting_for_user', value.observation.blockedReason, { attempts: 0 }, attentionMs);
				const inCourse = sameCourse(value.observation, target);
				if (value.observation.course && !inCourse) {
					return wait('waiting_for_user', '请在绑定的浏览器中返回原课程。', { attempts: 0 }, attentionMs);
				}
				const item = inCourse ? selectedTask(value, target) : undefined;
				if (item?.platformStatus === 'confirmed') {
					const result = { state: 'completed', taskId: target.taskId, title: target.title, verifiedAt: now };
					await runtime.commit(async (tx) => {
						(await tx.doc(Job, runtime.conversationId)).result = result;
						return { status: 'terminal', outcome: { status: 'completed', result } };
					}, ctx);
					return;
				}
				const runners = value.frames.map((frame) => frame.status);
				const activeRunners = runners.filter((runner) => activeRunnerStates.includes(runner.state));
				if (activeRunners.some((runner) => runner.taskId !== target.taskId)) {
					return wait('waiting_for_user', '该页面正在处理另一个任务点。', { attempts: 0 }, attentionMs);
				}
				const runner = runners.find((status) => status.taskId === target.taskId);
				const observation = {
					runnerState: runner?.state ?? 'idle',
					platformStatus: item?.platformStatus ?? 'unknown',
					lastProgressAt: runner?.lastProgressAt ?? null,
					visibleTaskCount: value.observation.tasks.length,
					unavailableFrameCount: value.unavailableFrames?.length ?? 0,
					media: runner?.media ?? null
				};
				if (!item && inCourse && activeRunners.length === 0) {
					const attempts = count(missingTask);
					const changes = { reason: missingTask, observation, state: 'recovering' };
					if (
						!checkpoint.catalogTried &&
						!checkpoint.recoveryAttempted &&
						value.activeChapterId !== target.chapterId &&
						value.observation.chapters?.some((chapter) => chapter.id === target.chapterId)
					) {
						return transition(runtime, ctx, checkpoint, {
							...changes,
							phase: 'navigate',
							navigation: { kind: 'chapter' }
						});
					}
					if (checkpoint.recoveryAttempted) {
						if (checkpoint.state === 'recovering' && attempts < maxAttempts) {
							return wait('recovering', missingTask, { attempts, observation });
						}
						return wait(
							'needs_attention',
							checkpoint.recoveryFailure ?? missingTask,
							{ attempts, observation },
							attentionMs
						);
					}
					if (target.enrollmentKey && attempts === maxAttempts) {
						return transition(runtime, ctx, checkpoint, { ...changes, phase: 'diagnose', attempts });
					}
				}
				if (!item || item.availability !== 'executable') return unexpected(missingTask, observation);
				const recovered = { recoveryAttempted: false, recoveryFailure: null, catalogTried: false };
				if (runner?.state === 'waiting_for_user' || runner?.state === 'stopped') {
					return wait(
						'waiting_for_user',
						runner.blockedReason ?? '请在 OCS 面板继续该视频。',
						{ attempts: 0, observation },
						attentionMs
					);
				}

				if (runner?.state === 'awaiting_confirmation' || runner?.media?.ended || checkpoint.pendingSince !== null) {
					const pendingSince = checkpoint.pendingSince ?? now;
					if (now - pendingSince < confirmationMs)
						return wait('awaiting_confirmation', null, { pendingSince, observation, attempts: 0 });
					if (!checkpoint.refreshed) {
						const refreshed = await browser.refresh(target, runtime.signal);
						if (refreshed.kind !== 'observed') return handleFailure(refreshed);
						return wait('awaiting_confirmation', null, { refreshed: true, pendingSince, observation, attempts: 0 });
					}
					if (runner?.media?.ended || runner?.state === 'awaiting_confirmation' || item.platformStatus !== 'pending') {
						return unexpected('播放器结束后仍无法确认平台登记。', observation);
					}
				}

				if (runner?.state === 'starting' || runner?.state === 'running') {
					const startedAt = checkpoint.startedAt ?? now;
					if (now - (runner.lastProgressAt ?? startedAt) < stallMs)
						return wait('playing', null, { ...recovered, startedAt, observation, pendingSince: null, attempts: 0 });
					return unexpected('播放器持续没有进展。', observation);
				}
				if (runner?.state === 'error') return unexpected('OCS 播放器报告错误。', observation);
				if (item.platformStatus !== 'pending') return unexpected('平台没有提供可核实的待完成或完成状态。', observation);

				const started = await (runner?.state === 'paused'
					? browser.resume(target, runtime.signal)
					: browser.start(target, runtime.signal));
				if (started.kind !== 'observed') return handleFailure(started);
				return wait('playing', null, { ...recovered, pendingSince: null, startedAt: now, observation, attempts: 0 });
			},
			diagnose: async ({ input: target, state: { checkpoint } }, runtime, ctx) => {
				// Version 1 databases may resume a generic diagnostic phase from older releases.
				if (!target.enrollmentKey || checkpoint.reason !== missingTask || checkpoint.recoveryAttempted) {
					return park(runtime, ctx, checkpoint, 'needs_attention', checkpoint.reason, {}, attentionMs);
				}
				const discovered = await browser.discoverRecovery(target, runtime.signal);
				if (discovered.kind !== 'candidates') {
					const changes =
						discovered.kind === 'unexpected'
							? { recoveryAttempted: true, recoveryFailure: discovered.reason }
							: { attempts: 0 };
					return parkFailure(runtime, ctx, checkpoint, discovered, changes);
				}
				const exact = discovered.candidates.filter((candidate) => candidate.chapterId === target.chapterId);
				const candidates = discovered.candidates.filter((candidate) => candidate.chapterId === null);
				if (exact.length === 1) {
					return transition(runtime, ctx, checkpoint, {
						phase: 'navigate',
						navigation: { kind: 'candidate', id: exact[0].id }
					});
				}
				if (candidates.length === 0) {
					const reason = '当前页面没有可供判断的同课程课节入口。';
					return park(
						runtime,
						ctx,
						checkpoint,
						'needs_attention',
						reason,
						{ recoveryAttempted: true, recoveryFailure: reason },
						attentionMs
					);
				}
				// Admit the request before contacting the model so an interrupted request is not repeated.
				const admitted = { recoveryAttempted: true, phase: 'attention', state: 'needs_attention' };
				await transition(runtime, ctx, checkpoint, admitted);
				const result = await selectRecovery(
					{ title: target.title, chapterTitle: target.chapterTitle, candidates },
					runtime.signal
				);
				if (result.kind === 'selected' && candidates.some((candidate) => candidate.id === result.id)) {
					return transition(runtime, ctx, checkpoint, {
						...admitted,
						phase: 'navigate',
						state: 'recovering',
						navigation: { kind: 'candidate', id: result.id }
					});
				}
				const reason = result.reason ?? '模型未返回可验证的课节候选。';
				return park(
					runtime,
					ctx,
					checkpoint,
					'needs_attention',
					reason,
					{ recoveryAttempted: true, recoveryFailure: reason },
					attentionMs
				);
			},
			navigate: async ({ input: target, state: { checkpoint } }, runtime, ctx) => {
				const navigation = checkpoint.navigation;
				const chapter = navigation.kind === 'chapter';
				const changes = chapter ? { catalogTried: true } : { recoveryAttempted: true };
				await transition(runtime, ctx, checkpoint, { ...changes, navigation: null, phase: 'attention' });
				const result = await (chapter
					? browser.openChapter(target, runtime.signal)
					: browser.followRecovery(target, navigation.id, runtime.signal));
				if (result.kind !== 'navigated') {
					if (result.kind === 'wait' && navigationPreflightWaits.has(result.reason)) {
						return parkFailure(runtime, ctx, checkpoint, result, { ...changes, phase: 'navigate', navigation });
					}
					return parkFailure(runtime, ctx, checkpoint, result, {
						...changes,
						navigation: null,
						recoveryFailure: result.reason
					});
				}
				return park(runtime, ctx, checkpoint, 'recovering', missingTask, {
					...changes,
					navigation: null,
					attempts: 0,
					recoveryFailure: null
				});
			},
			attention: ({ state: { checkpoint } }, runtime, ctx) =>
				runtime.sleepUntil(runtime.now() + attentionMs, { ...checkpoint, phase: 'observe' }, ctx)
		},
		abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
	});
}

export async function openWorkflow(path, { browser, selectRecovery, onStatus = () => {}, readOnly = false }) {
	const task = createVideoTask({ browser, selectRecovery, onStatus });
	const registry = createRegistry();
	registry.install(defineExtension({ name: 'ocs-video', tasks: [task] }));
	const harness = await Harness.open(
		await openNodeSqliteStorage(path),
		{ models: createModels(), registry, readOnly },
		context
	);
	const root = await harness.root(context);
	return {
		async submit(target) {
			return root.commit(async (tx) => {
				const job = await tx.doc(Job, root.id);
				if (job.taskId) {
					if (
						job.target.taskId === target.taskId &&
						job.target.profileId === target.profileId &&
						job.target.enrollmentKey === target.enrollmentKey
					)
						return job.taskId;
					throw new Error('此数据库已绑定一个视频，请为新任务指定另一个数据库。');
				}
				job.taskId = await tx.createTask(task, target, { ownership: { kind: 'conversation' } });
				job.target = target;
				return job.taskId;
			}, context);
		},
		async status() {
			const job = await harness.snapshot(Job, root.id, context);
			if (!job?.taskId) return null;
			const record = await harness.getTask(job.taskId, context);
			return { ...job, record };
		},
		wait: (id) => harness.waitForTask(id, context),
		close: () => harness.close(context)
	};
}
