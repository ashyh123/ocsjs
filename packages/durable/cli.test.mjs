import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));

const browserFixture = String.raw`#!/usr/bin/env node
const assert = require('node:assert/strict');
const { appendFileSync, existsSync, readFileSync } = require('node:fs');

assert.deepEqual(process.argv.slice(2), ['nodejs']);
const firstLine = readFileSync(0, 'utf8').split('\n', 1)[0];
const input = /^const input = (.+);$/.exec(firstLine);
assert.ok(input);
const { operation, target } = JSON.parse(input[1]);
const expected = JSON.parse(process.env.OCS_FIXTURE_TARGET);
const log = process.env.OCS_FIXTURE_BROWSER_LOG;
const previous = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
const { spaceId, page, profileId, taskId, courseId, clazzId, chapterId, enrollmentKey } = expected;
assert.deepEqual(target, previous.length === 0 ? { spaceId, page, taskId } : expected);
assert.ok(['inspect', 'start'].includes(operation));
if (operation === 'start') assert.ok(!previous.includes('start'));
appendFileSync(log, operation + '\n');

const platformStatus = previous.includes('start') ? 'confirmed' : 'pending';
process.stderr.write('OCS_DURABLE_BROWSER_RESULT ' + JSON.stringify({
  kind: 'observed',
  profileId,
  enrollmentKey,
  value: {
    observation: {
      course: { courseId, clazzId },
      tasks: [{ id: taskId, jobId: 'fixture-job', chapterId, title: 'Fixture video', availability: 'executable', platformStatus }]
    },
    frames: []
  }
}) + '\n');
`;

test('CLI start, resume, and status preserve completion without replaying playback', { timeout: 25_000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'ocs-cli-test-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const executable = join(directory, 'ego-browser.cjs');
	const browserLog = join(directory, 'browser.log');
	const database = join(directory, 'session.sqlite');
	await writeFile(executable, browserFixture, { mode: 0o700 });

	let modelRequests = 0;
	const model = createServer((_request, response) => {
		modelRequests += 1;
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ choices: [{ message: { content: 'Unexpected fixture diagnosis' } }] }));
	});
	model.listen(0, '127.0.0.1');
	await once(model, 'listening');
	t.after(() => model[Symbol.asyncDispose]());
	const target = {
		spaceId: 28,
		page: 'p1',
		profileId: 'fixture-profile',
		taskId: 'fixture-video',
		courseId: 'fixture-course',
		clazzId: 'fixture-class',
		chapterId: 'fixture-chapter',
		enrollmentKey: 'a'.repeat(64)
	};
	const env = {
		...process.env,
		OCS_EGO_BROWSER: executable,
		OCS_FIXTURE_TARGET: JSON.stringify(target),
		OCS_FIXTURE_BROWSER_LOG: browserLog,
		OCS_AGENT_MODEL_URL: `http://127.0.0.1:${model.address().port}/v1`,
		OCS_AGENT_MODEL: 'fixture-model',
		OCS_AGENT_MODEL_KEY: ''
	};
	const run = async (...args) => {
		const { stdout } = await execute(process.execPath, [cli, '--db', database, ...args], { env, timeout: 15_000 });
		return stdout.trim().split('\n').map(JSON.parse).at(-1);
	};

	const finished = await run('start', String(target.spaceId), target.page, target.taskId);
	assert.equal(finished.state.outcome.status, 'completed');
	const result = finished.state.outcome.result;
	assert.equal(result.taskId, target.taskId);
	assert.deepEqual(await run('resume'), result);
	const status = await run('status');
	assert.equal(status.taskId, finished.id);
	assert.equal(status.target.enrollmentKey, target.enrollmentKey);
	assert.deepEqual(status.result, result);
	assert.equal(await readFile(browserLog, 'utf8'), 'inspect\ninspect\nstart\ninspect\n');
	assert.equal(modelRequests, 0);
});
