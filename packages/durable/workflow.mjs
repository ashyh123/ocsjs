import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, defineDoc, defineExtension, defineTask, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

const context = BACKGROUND_CONTEXT;
const pollMs = 4000;
const confirmationMs = 20000;
const stallMs = 60000;
const maxAttempts = 3;

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
		title: task.title
	};
}

function createVideoTask({ browser, diagnose, onStatus }) {
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
				const wait = async (state, reason, changes = {}, delay = pollMs) => {
					await runtime.sleepUntil(
						runtime.now() + delay,
						{ ...checkpoint, ...changes, phase: 'observe', state, reason },
						ctx
					);
					if (state !== checkpoint.state || reason !== checkpoint.reason) onStatus({ state, reason });
				};
				const unexpected = async (reason, observation = checkpoint.observation) => {
					const attempts = checkpoint.reason === reason ? checkpoint.attempts + 1 : 1;
					if (attempts < maxAttempts) return wait('retrying', reason, { attempts, observation });
					await runtime.commit(
						() => ({
							status: 'running',
							checkpoint: { ...checkpoint, phase: 'diagnose', state: 'diagnosing', reason, attempts, observation }
						}),
						ctx
					);
				};
				const handleFailure = (result) => {
					if (result.kind === 'wait') return wait('waiting_for_browser', result.reason, { attempts: 0 }, 10000);
					if (result.kind === 'user') return wait('waiting_for_user', result.reason, { attempts: 0 }, 10000);
					if (checkpoint.diagnosedReason) return wait('needs_attention', checkpoint.diagnosedReason, {}, 10000);
					return unexpected(result.reason);
				};
				const current = await browser.inspect(target, runtime.signal);
				if (current.kind !== 'observed') return handleFailure(current);
				const value = current.value;
				if (value.observation.blockedReason)
					return wait('waiting_for_user', value.observation.blockedReason, { attempts: 0 }, 10000);
				if (value.observation.course && !sameCourse(value.observation, target)) {
					return wait('waiting_for_user', '请在绑定的浏览器中返回原课程。', { attempts: 0 }, 10000);
				}
				const item = sameCourse(value.observation, target) ? selectedTask(value, target) : undefined;
				if (item?.platformStatus === 'confirmed') {
					const result = { state: 'completed', taskId: target.taskId, title: target.title, verifiedAt: now };
					await runtime.commit(async (tx) => {
						(await tx.doc(Job, runtime.conversationId)).result = result;
						return { status: 'terminal', outcome: { status: 'completed', result } };
					}, ctx);
					return;
				}
				if (checkpoint.diagnosedReason) {
					return wait('needs_attention', checkpoint.diagnosedReason, {}, 10000);
				}
				const runners = value.frames.map((frame) => frame.status);
				if (
					runners.some(
						(runner) =>
							runner.taskId &&
							runner.taskId !== target.taskId &&
							['starting', 'running', 'paused', 'waiting_for_user', 'awaiting_confirmation'].includes(runner.state)
					)
				) {
					return wait('waiting_for_user', '该页面正在处理另一个任务点。', { attempts: 0 }, 10000);
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
				if (!item || item.availability !== 'executable')
					return unexpected('无法在当前页面唯一识别绑定的视频任务点。', observation);
				if (runner?.state === 'waiting_for_user' || runner?.state === 'stopped') {
					return wait(
						'waiting_for_user',
						runner.blockedReason ?? '请在 OCS 面板继续该视频。',
						{ attempts: 0, observation },
						10000
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
						return wait('playing', null, { startedAt, observation, pendingSince: null, attempts: 0 });
					return unexpected('播放器持续没有进展。', observation);
				}
				if (runner?.state === 'error') return unexpected('OCS 播放器报告错误。', observation);
				if (item.platformStatus !== 'pending') return unexpected('平台没有提供可核实的待完成或完成状态。', observation);

				const started = await (runner?.state === 'paused'
					? browser.resume(target, runtime.signal)
					: browser.start(target, runtime.signal));
				if (started.kind !== 'observed') return handleFailure(started);
				return wait('playing', null, { pendingSince: null, startedAt: now, observation, attempts: 0 });
			},
			diagnose: async ({ input: target, state: { checkpoint } }, runtime, ctx) => {
				// Record admission before contacting a model. A process crash must not repeat the request.
				const admitted = {
					...checkpoint,
					phase: 'attention',
					state: 'needs_attention',
					diagnosedReason: checkpoint.reason
				};
				await runtime.commit(() => ({ status: 'running', checkpoint: admitted }), ctx);
				const result = await diagnose(
					{
						taskId: target.taskId,
						courseId: target.courseId,
						chapterId: target.chapterId,
						reason: checkpoint.reason,
						phase: checkpoint.phase,
						observation: checkpoint.observation,
						attempts: checkpoint.attempts
					},
					runtime.signal
				);
				const diagnosis = result.kind === 'diagnosed' ? result.summary : result.reason;
				await runtime.sleepUntil(runtime.now() + 10000, { ...admitted, phase: 'observe', diagnosis }, ctx);
				onStatus({ state: 'needs_attention', reason: checkpoint.reason, diagnosis });
			},
			attention: ({ state: { checkpoint } }, runtime, ctx) =>
				runtime.sleepUntil(runtime.now() + 10000, { ...checkpoint, phase: 'observe' }, ctx)
		},
		abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
	});
}

export async function openWorkflow(path, { browser, diagnose, onStatus = () => {}, readOnly = false }) {
	const task = createVideoTask({ browser, diagnose, onStatus });
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
