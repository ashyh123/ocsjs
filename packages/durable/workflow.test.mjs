import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRecovery } from './recovery.mjs';
import { openWorkflow } from './workflow.mjs';

const target = {
	spaceId: 1,
	page: 'p1',
	profileId: 'fixture-profile',
	courseId: 'course-1',
	clazzId: 'class-1',
	chapterId: 'chapter-1',
	chapterTitle: '第一章 开始使用实验仪器',
	taskId: 'video-1',
	title: '仪器启动与归零',
	enrollmentKey: 'fixture-enrollment-key'
};

function observed(platformStatus) {
	return {
		kind: 'observed',
		profileId: target.profileId,
		enrollmentKey: target.enrollmentKey,
		value: {
			activeChapterId: target.chapterId,
			observation: {
				course: { courseId: target.courseId, clazzId: target.clazzId },
				tasks: [{ id: target.taskId, chapterId: target.chapterId, availability: 'executable', platformStatus }]
			},
			frames: []
		}
	};
}

const candidates = [
	{ id: 'route-a', title: '实验设备操作入门', chapterId: null },
	{ id: 'route-b', title: '实验设备维护', chapterId: null }
];

function courseNavigation({ chapterInCatalog = false } = {}) {
	const calls = [];
	let chapterId = 'chapter-2';
	let started = false;
	const browser = {
		async inspect() {
			calls.push(`inspect:${chapterId}`);
			const result = observed(started ? 'confirmed' : 'pending');
			result.value.activeChapterId = chapterId;
			if (chapterId !== target.chapterId) {
				// A neighboring chapter can expose a receipt with the same task ID. The chapter must match too.
				result.value.observation.tasks[0] = {
					...result.value.observation.tasks[0],
					chapterId,
					platformStatus: 'confirmed'
				};
			}
			result.value.observation.chapters = chapterInCatalog
				? [{ id: target.chapterId, title: target.chapterTitle }]
				: [];
			return result;
		},
		async openChapter(requested) {
			calls.push(`chapter:${requested.chapterId}`);
			assert.equal(requested.chapterId, target.chapterId);
			chapterId = target.chapterId;
			return { kind: 'navigated' };
		},
		async discoverRecovery() {
			calls.push('discover');
			return { kind: 'candidates', candidates };
		},
		async followRecovery(requested, id) {
			calls.push(`candidate:${id}`);
			assert.equal(requested.taskId, target.taskId);
			chapterId = id === candidates[0].id ? target.chapterId : 'chapter-3';
			return { kind: 'navigated' };
		},
		async start(requested) {
			assert.equal(chapterId, target.chapterId);
			assert.equal(requested.taskId, target.taskId);
			calls.push('start');
			started = true;
			return observed('pending');
		}
	};
	return { browser, calls };
}

async function fixtureModel(t, candidateId) {
	const requests = [];
	const server = createServer(async (request, response) => {
		let body = '';
		for await (const chunk of request) body += chunk;
		const input = JSON.parse(body);
		requests.push({ path: request.url, evidence: JSON.parse(input.messages[1].content) });
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidateId }) } }] }));
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => new Promise((resolve) => server.close(resolve)));
	return {
		requests,
		selectRecovery: createRecovery({
			OCS_AGENT_MODEL_URL: `http://127.0.0.1:${server.address().port}/v1`,
			OCS_AGENT_MODEL: 'fixture-model'
		})
	};
}

async function temporaryDirectory(t) {
	const directory = await mkdtemp(join(tmpdir(), 'ocs-workflow-test-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

async function beforeTimeout(promise, message) {
	const timeout = new AbortController();
	try {
		return await Promise.race([
			promise,
			delay(35_000, null, { signal: timeout.signal, ref: false }).then(() => assert.fail(message))
		]);
	} finally {
		timeout.abort();
	}
}

async function completed(workflow, id) {
	const record = await beforeTimeout(workflow.wait(id), 'Workflow did not settle');
	assert.equal(record.state.outcome.status, 'completed');
	assert.equal(record.state.outcome.result.state, 'completed');
	assert.equal(record.state.outcome.result.taskId, target.taskId);
	const job = await workflow.status();
	assert.equal(job.taskId, id);
	assert.deepEqual(job.result, record.state.outcome.result);
}

async function crashFixture(directory) {
	let playing = false;
	const workflow = await openWorkflow(join(directory, 'session.sqlite'), {
		browser: {
			async inspect() {
				if (!playing) return observed('pending');
				// Write the platform's receipt independently of the local workflow database.
				await writeFile(join(directory, 'platform-status'), 'confirmed');
				process.send({ event: 'platform-confirmed', taskId: id });
				return new Promise(() => {});
			},
			async start() {
				await appendFile(join(directory, 'platform-actions'), 'start\n');
				playing = true;
				return observed('pending');
			}
		},
		selectRecovery: () => assert.fail('Recovery fixture must not call the model')
	});
	const id = await workflow.submit(target);
	process.on('disconnect', () => process.exit(1));
	await workflow.wait(id);
	throw new Error('Expected interruption before the local completion commit');
}

async function killAfterPlatformConfirmation(directory) {
	const child = fork(fileURLToPath(import.meta.url), ['crash-fixture', directory], {
		execArgv: [],
		stdio: ['ignore', 'ignore', 'pipe', 'ipc']
	});
	let stderr = '';
	child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
	const exited = once(child, 'exit');
	try {
		const [message] = await beforeTimeout(
			Promise.race([
				once(child, 'message'),
				exited.then(([code, signal]) => assert.fail(`Fixture exited early (${code ?? signal}): ${stderr}`))
			]),
			'Fixture never reached the external completion boundary'
		);
		assert.equal(message.event, 'platform-confirmed');
		assert.equal(child.kill('SIGKILL'), true);
		assert.deepEqual(await exited, [null, 'SIGKILL']);
		return message.taskId;
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGKILL');
			await exited.catch(() => {});
		}
	}
}

async function knownInterruption(t, response, expectedState) {
	const directory = await temporaryDirectory(t);
	const statuses = [];
	let inspections = 0;
	let modelCalls = 0;
	const workflow = await openWorkflow(join(directory, 'session.sqlite'), {
		browser: { inspect: async () => (++inspections === 1 ? response : observed('confirmed')) },
		selectRecovery: async () => (modelCalls += 1),
		onStatus: (status) => statuses.push(status)
	});
	try {
		await completed(workflow, await workflow.submit(target));
		assert.deepEqual(statuses, [{ state: expectedState, reason: response.reason }]);
		assert.equal(inspections, 2);
		assert.equal(modelCalls, 0);
	} finally {
		await workflow.close();
	}
}

async function unresolved(t, options, reason) {
	const directory = await temporaryDirectory(t);
	const attention = Promise.withResolvers();
	const workflow = await openWorkflow(join(directory, 'session.sqlite'), {
		...options,
		onStatus: (status) => {
			if (status.state === 'needs_attention') attention.resolve(status);
		}
	});
	try {
		const id = await workflow.submit(target);
		const prematureEnd = workflow.wait(id).then(() => assert.fail('Workflow completed without platform evidence'));
		const status = await beforeTimeout(
			Promise.race([attention.promise, prematureEnd]),
			'Workflow never requested attention'
		);
		if (reason) assert.equal(status.reason, reason);
		const job = await workflow.status();
		assert.equal(job.result, null);
		assert.equal(job.record.state.checkpoint.state, 'needs_attention');
	} finally {
		await workflow.close();
	}
}

if (process.argv[2] === 'crash-fixture') {
	await crashFixture(process.argv[3]);
} else {
	await test('durable OCS video workflow', { concurrency: true }, async (suite) => {
		await Promise.all([
			suite.test('normal playback records the platform result with zero model calls', async (t) => {
				const directory = await temporaryDirectory(t);
				const browserCalls = [];
				let modelCalls = 0;
				const workflow = await openWorkflow(join(directory, 'session.sqlite'), {
					browser: {
						async inspect() {
							browserCalls.push('inspect');
							return observed(browserCalls.includes('start') ? 'confirmed' : 'pending');
						},
						async start() {
							browserCalls.push('start');
							return observed('pending');
						}
					},
					selectRecovery: async () => (modelCalls += 1)
				});
				try {
					await completed(workflow, await workflow.submit(target));
					assert.deepEqual(browserCalls, ['inspect', 'start', 'inspect']);
					assert.equal(modelCalls, 0);
				} finally {
					await workflow.close();
				}
			}),
			suite.test('SIGKILL after platform confirmation resumes the same task without replay', async (t) => {
				const directory = await temporaryDirectory(t);
				const id = await killAfterPlatformConfirmation(directory);
				let modelCalls = 0;
				let replays = 0;
				const workflow = await openWorkflow(join(directory, 'session.sqlite'), {
					browser: {
						async inspect() {
							return observed(await readFile(join(directory, 'platform-status'), 'utf8'));
						},
						async start() {
							replays += 1;
							return observed('pending');
						}
					},
					selectRecovery: async () => (modelCalls += 1)
				});
				try {
					const before = await workflow.status();
					assert.equal(before.taskId, id);
					assert.equal(before.result, null);
					assert.equal(before.record.state.checkpoint.state, 'playing');
					await completed(workflow, id);
					assert.equal(await readFile(join(directory, 'platform-actions'), 'utf8'), 'start\n');
					assert.equal(replays, 0);
					assert.equal(modelCalls, 0);
				} finally {
					await workflow.close();
				}
			}),
			suite.test('an exact chapter in the catalog reopens with zero model calls', async (t) => {
				const directory = await temporaryDirectory(t);
				const { browser, calls } = courseNavigation({ chapterInCatalog: true });
				const workflow = await openWorkflow(join(directory, 'session.sqlite'), {
					browser,
					selectRecovery: () => assert.fail('An exact chapter must not call the model')
				});
				try {
					await completed(workflow, await workflow.submit(target));
					assert.deepEqual(calls, [
						'inspect:chapter-2',
						'chapter:chapter-1',
						'inspect:chapter-1',
						'start',
						'inspect:chapter-1'
					]);
				} finally {
					await workflow.close();
				}
			}),
			suite.test('a renamed entry needs attention when the model is unconfigured', async (t) => {
				const { browser, calls } = courseNavigation();
				await unresolved(
					t,
					{
						browser,
						selectRecovery: createRecovery({}, () => assert.fail('An unconfigured model must not send a request'))
					},
					'未配置有效的模型地址或模型名称。'
				);
				assert.deepEqual(calls, ['inspect:chapter-2', 'inspect:chapter-2', 'inspect:chapter-2', 'discover']);
			}),
			suite.test('one model selection opens a renamed entry and resumes the original video', async (t) => {
				const directory = await temporaryDirectory(t);
				const { browser, calls } = courseNavigation();
				const { requests, selectRecovery } = await fixtureModel(t, candidates[0].id);
				const workflow = await openWorkflow(join(directory, 'session.sqlite'), { browser, selectRecovery });
				try {
					await completed(workflow, await workflow.submit(target));
					assert.deepEqual(calls, [
						'inspect:chapter-2',
						'inspect:chapter-2',
						'inspect:chapter-2',
						'discover',
						'candidate:route-a',
						'inspect:chapter-1',
						'start',
						'inspect:chapter-1'
					]);
					assert.equal(requests.length, 1);
					const [request] = requests;
					assert.equal(request.path, '/v1/chat/completions');
					assert.equal(request.evidence.target.title, target.title);
					assert.equal(request.evidence.target.chapterTitle, target.chapterTitle);
					assert.deepEqual(
						request.evidence.candidates.map(({ id, title }) => ({ id, title })),
						candidates.map(({ id, title }) => ({ id, title }))
					);
				} finally {
					await workflow.close();
				}
			}),
			suite.test('a selected entry landing on another chapter never starts or completes playback', async (t) => {
				const { browser, calls } = courseNavigation();
				const { requests, selectRecovery } = await fixtureModel(t, candidates[1].id);
				await unresolved(t, { browser, selectRecovery });
				assert.deepEqual(calls.slice(0, 5), [
					'inspect:chapter-2',
					'inspect:chapter-2',
					'inspect:chapter-2',
					'discover',
					'candidate:route-b'
				]);
				assert.ok(calls.length > 5);
				assert.ok(calls.slice(5).every((call) => call === 'inspect:chapter-3'));
				assert.equal(requests.length, 1);
			}),
			suite.test('network loss preserves the selected entry across scheduler restart', async (t) => {
				const path = join(await temporaryDirectory(t), 'session.sqlite');
				const { browser, calls } = courseNavigation();
				const { requests, selectRecovery } = await fixtureModel(t, candidates[0].id);
				const offline = Promise.withResolvers();
				const first = await openWorkflow(path, {
					browser: {
						...browser,
						followRecovery: async () => ({ kind: 'wait', reason: 'network_offline' })
					},
					selectRecovery,
					onStatus: ({ state }) => {
						if (state === 'waiting_for_browser') offline.resolve();
					}
				});
				let id;
				try {
					id = await first.submit(target);
					const prematureEnd = first.wait(id).then(() => assert.fail('Workflow ended before the network recovered'));
					await beforeTimeout(Promise.race([offline.promise, prematureEnd]), 'Workflow did not wait for the network');
					const { record } = await first.status();
					assert.deepEqual(record.state.checkpoint.navigation, { kind: 'candidate', id: candidates[0].id });
				} finally {
					await first.close();
				}
				const resumed = await openWorkflow(path, { browser, selectRecovery });
				try {
					await completed(resumed, id);
					assert.deepEqual(
						calls.filter((call) => call !== 'inspect:chapter-2'),
						['discover', 'candidate:route-a', 'inspect:chapter-1', 'start', 'inspect:chapter-1']
					);
					assert.equal(requests.length, 1);
				} finally {
					await resumed.close();
				}
			}),
			suite.test('an unknown platform status requests attention without consulting the model', async (t) => {
				await unresolved(
					t,
					{
						browser: { inspect: async () => observed('unknown') },
						selectRecovery: () => assert.fail('A known chapter with unknown progress must not call the model')
					},
					'平台没有提供可核实的待完成或完成状态。'
				);
			}),
			suite.test('known network interruption waits and resumes with zero model calls', (t) =>
				knownInterruption(t, { kind: 'wait', reason: 'course_page_unavailable' }, 'waiting_for_browser')
			),
			suite.test('known login expiry waits for the user and resumes with zero model calls', (t) =>
				knownInterruption(t, { kind: 'user', reason: 'login_required' }, 'waiting_for_user')
			)
		]);
	});
}
