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
import { createDiagnosis } from './diagnosis.mjs';
import { openWorkflow } from './workflow.mjs';

const target = {
	spaceId: 1,
	page: 'p1',
	profileId: 'fixture-profile',
	courseId: 'course-1',
	clazzId: 'class-1',
	chapterId: 'chapter-1',
	taskId: 'video-1',
	title: 'Fixture video'
};

function observed(platformStatus) {
	return {
		kind: 'observed',
		profileId: target.profileId,
		value: {
			observation: {
				course: { courseId: target.courseId, clazzId: target.clazzId },
				tasks: [{ id: target.taskId, chapterId: target.chapterId, availability: 'executable', platformStatus }]
			},
			frames: []
		}
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
			delay(18_000, null, { signal: timeout.signal, ref: false }).then(() => assert.fail(message))
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
		diagnose: () => assert.fail('Recovery fixture must not call the model')
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
		diagnose: async () => (modelCalls += 1),
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
					diagnose: async () => (modelCalls += 1)
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
					diagnose: async () => (modelCalls += 1)
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
			suite.test('three consecutive unknown observations trigger one diagnosis', async (t) => {
				const directory = await temporaryDirectory(t);
				const diagnoses = [];
				const model = createServer(async (request, response) => {
					let body = '';
					for await (const chunk of request) body += chunk;
					const input = JSON.parse(body);
					diagnoses.push({ path: request.url, context: JSON.parse(input.messages[1].content) });
					response.writeHead(200, { 'content-type': 'application/json' });
					response.end(JSON.stringify({ choices: [{ message: { content: 'Review the platform status.' } }] }));
				});
				model.listen(0, '127.0.0.1');
				await once(model, 'listening');
				t.after(() => model.close());
				const statuses = [];
				const attention = Promise.withResolvers();
				const workflow = await openWorkflow(join(directory, 'session.sqlite'), {
					browser: { inspect: async () => observed('unknown') },
					diagnose: createDiagnosis({
						OCS_AGENT_MODEL_URL: `http://127.0.0.1:${model.address().port}/v1`,
						OCS_AGENT_MODEL: 'fixture-model'
					}),
					onStatus: (status) => {
						statuses.push(status.state);
						if (status.state === 'needs_attention') attention.resolve(status);
					}
				});
				try {
					const id = await workflow.submit(target);
					const prematureEnd = workflow
						.wait(id)
						.then(() => assert.fail('Workflow completed without platform evidence'));
					const status = await beforeTimeout(
						Promise.race([attention.promise, prematureEnd]),
						'Diagnosis never completed'
					);
					assert.deepEqual(statuses, ['retrying', 'needs_attention']);
					assert.equal(diagnoses.length, 1);
					assert.equal(diagnoses[0].path, '/v1/chat/completions');
					assert.equal(diagnoses[0].context.taskId, target.taskId);
					assert.equal(diagnoses[0].context.attempts, 3);
					assert.equal(diagnoses[0].context.observation.platformStatus, 'unknown');
					assert.equal(status.diagnosis, 'Review the platform status.');
					const job = await workflow.status();
					assert.equal(job.result, null);
					assert.equal(job.record.state.checkpoint.state, 'needs_attention');
				} finally {
					await workflow.close();
				}
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
