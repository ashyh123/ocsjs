import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEgoBrowser } from './browser.mjs';

const origin = 'https://mooc1.chaoxing.com';
const route = `${origin}/mycourse/studentstudy?courseid=c1&clazzid=k1&cpi=private-enrollment`;
const currentUrl = `${route}&chapterId=stale`;
const exactUrl = `${route}&chapterId=target&enc=private-token`;
const opaqueUrl = `${route}&tab=directory`;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const candidateId = (href, title) => sha256(JSON.stringify([href, title]));
const target = {
	spaceId: 28,
	page: 'p1',
	profileId: 'fixture-profile',
	taskId: 'fixture-video',
	courseId: 'c1',
	clazzId: 'k1',
	chapterId: 'target',
	enrollmentKey: sha256('private-enrollment')
};

function runFixture(browserEnvPath) {
	const { appendFileSync, readFileSync } = require('node:fs');
	const { join } = require('node:path');
	const { runInNewContext } = require('node:vm');
	const { webcrypto } = require('node:crypto');
	const fixture = JSON.parse(readFileSync(join(__dirname, 'fixture.json'), 'utf8'));
	const record = (action) => appendFileSync(join(__dirname, 'actions.log'), JSON.stringify(action) + '\n');
	const win = require(browserEnvPath)([], { url: fixture.url });
	win.document.body.innerHTML = fixture.markup;
	Object.defineProperty(win.HTMLElement.prototype, 'checkVisibility', {
		value() {
			return this.style.display !== 'none';
		}
	});
	Object.defineProperty(win.HTMLElement.prototype, 'innerText', {
		get() {
			return this.textContent;
		}
	});
	let inspections = 0;
	win.OCSAgent = {
		describe: () => ({ platform: 'chaoxing' }),
		inspect: async () => ({
			observation: {
				course: { courseId: 'c1', clazzId: 'k1' },
				tasks:
					inspections + 1 >= fixture.targetOnInspection
						? [{ id: 'fixture-video', chapterId: 'target', availability: 'executable' }]
						: [],
				chapters: [{ id: 'target' }]
			},
			frames:
				++inspections >= fixture.activeOnInspection
					? [{ status: { state: 'running', taskId: 'another-task' }, observation: {} }]
					: [],
			unavailableFrames: []
		}),
		openChapter: async (chapterId) => record({ chapterId })
	};
	const page = {
		url: async () => fixture.url,
		evaluate: async (evaluate, input) => evaluate(input),
		goto: async (url) => {
			record({ url });
			if (fixture.gotoTimeout) throw new Error('timeout');
		}
	};
	const script = readFileSync(0, 'utf8');
	return runInNewContext('(async () => {\n' + script + '\n})()', {
		console,
		window: win,
		location: win.location,
		document: win.document,
		navigator: win.navigator,
		URL,
		TextEncoder,
		crypto: webcrypto,
		listTaskSpaces: async () => [{ id: 28, ownership: 'agent', profileId: fixture.profileId }],
		taskSpace: async () => ({
			ownership: 'agent',
			tabs: async () => [{ label: 'p1', url: fixture.url }],
			page: () => page
		})
	});
}

async function setup(t) {
	const directory = await mkdtemp(join(tmpdir(), 'ocs-durable-browser-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const executable = join(directory, 'ego-browser.cjs');
	const browserEnvPath = createRequire(import.meta.url).resolve('browser-env');
	await writeFile(executable, `#!/usr/bin/env node\n(${runFixture.toString()})(${JSON.stringify(browserEnvPath)});\n`, {
		mode: 0o700
	});
	await writeFile(join(directory, 'actions.log'), '');
	return {
		browser: createEgoBrowser({ executable }),
		arrange: (markup, overrides = {}) =>
			writeFile(
				join(directory, 'fixture.json'),
				JSON.stringify({
					markup,
					url: currentUrl,
					profileId: target.profileId,
					...overrides
				})
			),
		actions: async () =>
			(await readFile(join(directory, 'actions.log'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
	};
}

test('recovery discovery exposes only opaque IDs for visible, safe chapter links', async (t) => {
	const { browser, arrange, actions } = await setup(t);
	await arrange(`
		<div class="posCatalog_active" id="curcurrent"></div>
		<a href="${opaqueUrl}">目录</a>
		<a href="${exactUrl}" aria-label="原视频 enc=private-token"></a>
		<a href="${exactUrl}">Duplicate</a>
		<a href="${exactUrl}&courseId=elsewhere">Duplicate identity</a>
		<a href="${exactUrl.replace('cpi=private-enrollment', 'cpi=other')}">Other enrollment</a>
		<a href="${exactUrl.replace('cpi=private-enrollment&', '')}">Missing enrollment</a>
		<a href="${exactUrl.replace('clazzid=k1', 'clazzid=other')}">Other class</a>
		<a href="${exactUrl.replace('courseid=c1', 'courseid=other')}">Other course</a>
		<a href="${exactUrl.replace('chapterId=target', 'chapterId=other')}">Other chapter</a>
		<a href="${exactUrl.replace('/mycourse/studentstudy', '/exam')}">Exam</a>
		<a href="${exactUrl.replace('mooc1.chaoxing.com', 'other.chaoxing.com')}">Other host</a>
		<a href="${exactUrl.replace('https:', 'http:')}">Unencrypted</a>
		<a href="${exactUrl}&hidden=1" style="display: none">Hidden</a>
		<a href="${exactUrl}&handled=1" onclick="return false">Custom handler</a>
		<a href="http://[">Malformed URL</a>
	`);
	assert.equal((await browser.inspect(target)).value.activeChapterId, 'current');
	assert.deepEqual(await browser.discoverRecovery(target), {
		kind: 'candidates',
		candidates: [
			{ id: candidateId(exactUrl, '原视频'), title: '原视频', chapterId: 'target' },
			{ id: candidateId(opaqueUrl, '目录'), title: '目录', chapterId: null }
		]
	});
	assert.deepEqual(await browser.discoverRecovery({ ...target, enrollmentKey: undefined }), {
		kind: 'unexpected',
		reason: 'course_recovery_route_unverified'
	});
	assert.deepEqual(await actions(), []);
});

test('follow rechecks the observed link and active runners before navigating', async (t) => {
	const { browser, arrange, actions } = await setup(t);
	await arrange(`<a href="${exactUrl}">原视频</a>`);
	const {
		candidates: [{ id }]
	} = await browser.discoverRecovery(target);
	await arrange(`<a href="${opaqueUrl}">目录</a>`);
	assert.deepEqual(await browser.followRecovery(target, id), {
		kind: 'unexpected',
		reason: 'recovery_candidate_unavailable'
	});
	await arrange(`<a href="${exactUrl}">Renamed</a>`);
	assert.deepEqual(await browser.followRecovery(target, id), {
		kind: 'unexpected',
		reason: 'recovery_candidate_unavailable'
	});
	await arrange(`<a href="${exactUrl}">原视频</a>`, { activeOnInspection: 2 });
	assert.deepEqual(await browser.followRecovery(target, id), { kind: 'user', reason: 'another_course_task_active' });
	await arrange(`<a href="${exactUrl}">原视频</a>`, { targetOnInspection: 2 });
	assert.deepEqual(await browser.followRecovery(target, id), { kind: 'wait', reason: 'target_task_reappeared' });
	assert.deepEqual(await actions(), []);
	await arrange(`<a href="${exactUrl}">原视频</a>`, { gotoTimeout: true });
	assert.deepEqual(await browser.followRecovery(target, id), { kind: 'navigated' });
	assert.deepEqual(await actions(), [{ url: exactUrl }]);
});

test('exact chapter opening requires the bound profile and an idle player', async (t) => {
	const { browser, arrange, actions } = await setup(t);
	await arrange('', { profileId: 'different-profile' });
	assert.deepEqual(await browser.openChapter(target), { kind: 'user', reason: 'space_profile_changed' });
	await arrange('', { activeOnInspection: 1 });
	assert.deepEqual(await browser.openChapter(target), { kind: 'user', reason: 'another_course_task_active' });
	await arrange('<div class="posCatalog_active" id="curtarget"></div>');
	assert.deepEqual(await browser.openChapter(target), { kind: 'unexpected', reason: 'target_chapter_already_open' });
	await arrange('');
	assert.deepEqual(await browser.openChapter(target), { kind: 'navigated' });
	assert.deepEqual(await actions(), [{ chapterId: 'target' }]);
});
