import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(__dirname, '..');
const requireCore = createRequire(path.join(root, 'packages/core/package.json'));
const requireScripts = createRequire(path.join(root, 'packages/scripts/package.json'));
const { chromium } = requireCore('playwright-core');
const { build } = requireScripts('vite');

function wave() {
	const rate = 8000;
	const samples = rate * 3;
	const result = Buffer.alloc(44 + samples * 2);
	result.write('RIFF', 0);
	result.writeUInt32LE(result.length - 8, 4);
	result.write('WAVEfmt ', 8);
	result.writeUInt32LE(16, 16);
	result.writeUInt16LE(1, 20);
	result.writeUInt16LE(1, 22);
	result.writeUInt32LE(rate, 24);
	result.writeUInt32LE(rate * 2, 28);
	result.writeUInt16LE(2, 32);
	result.writeUInt16LE(16, 34);
	result.write('data', 36);
	result.writeUInt32LE(samples * 2, 40);
	return result;
}

async function main() {
	const temporary = await mkdtemp(path.join(os.tmpdir(), 'ocs-agent-browser-'));
	await build({
		configFile: false,
		root,
		logLevel: 'error',
		build: {
			outDir: temporary,
			minify: false,
			lib: {
				entry: path.join(root, 'tests/agent-browser-entry.ts'),
				name: 'AgentFixture',
				formats: ['iife'],
				fileName: () => 'fixture.js'
			}
		}
	});
	const userscript = await readFile(path.join(root, 'dist/ocs.agent.user.js'));
	assert.ok(
		userscript.toString().startsWith('// ==UserScript==\n'),
		'the installable artifact must retain its userscript metadata'
	);
	assert.ok(userscript.toString().includes('// @grant        GM_getValue'));
	assert.ok(userscript.toString().includes('Copyright (c) 2022 enncy'));
	const fixtureScript = await readFile(path.join(temporary, 'fixture.js'));
	const audio = wave();
	let port = 0;
	const server = createServer((req, res) => {
		const url = new URL(req.url || '/', 'http://localhost');
		if (url.pathname === '/script.js') {
			res.setHeader('Content-Type', 'application/javascript');
			res.end(url.searchParams.has('cross') ? fixtureScript : userscript);
			return;
		}
		if (url.pathname === '/media.wav') {
			res.setHeader('Content-Type', 'audio/wav');
			res.end(audio);
			return;
		}
		const cross = url.searchParams.has('cross');
		const chapter = url.searchParams.get('chapterId') || 'ch1';
		const job = chapter === 'ch1' ? 'job1' : 'job2';
		const shim = `<script>window.unsafeWindow=window;window.GM_getValue=k=>JSON.parse(localStorage.getItem(k)||'null');window.GM_setValue=(k,v)=>localStorage.setItem(k,JSON.stringify(v));</script>`;
		const script = `<script src="/script.js${cross ? '?cross=1' : ''}"></script>`;
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		if (url.pathname === '/cards') {
			res.end(
				`<!doctype html><title>视频 ${chapter}</title>${shim}<script>window.attachments=[{job:true,jobid:'${job}',property:{mid:'mid-${job}',_jobid:'${job}',module:'insertvideo',name:'视频 ${chapter}'}}];</script><iframe id="player" data='{"jobid":"${job}"}' src="/player"></iframe>${script}`
			);
		} else if (url.pathname === '/player') {
			res.end('<!doctype html><div id="video"><video muted src="/media.wav" preload="auto"></video></div>');
		} else {
			const childHost = cross ? 'localhost' : '127.0.0.1';
			res.end(
				`<!doctype html><title>测试课程</title>${shim}<input id="curCourseId" value="course"><input id="curClazzId" value="class"><input id="curChapterId" value="ch1"><div class="posCatalog_select"><button onclick="getTeacherAjax('course','class','ch1')">第一章</button><input class="jobUnfinishCount" value="1"></div><div class="posCatalog_select"><button onclick="getTeacherAjax('course','class','ch2')">第二章</button><input class="jobUnfinishCount" value="1"></div><script>window.getTeacherAjax=(course,clazz,chapter)=>{document.querySelector('#curChapterId').value=chapter;document.querySelector('#cards').src='http://${childHost}:${port}/cards?courseId=course&clazzid=class&chapterId='+chapter+'${
					cross ? '&cross=1' : ''
				}';}</script><iframe id="cards" src="http://${childHost}:${port}/cards?courseId=course&clazzid=class&chapterId=ch1${
					cross ? '&cross=1' : ''
				}"></iframe>${script}`
			);
		}
	});
	await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
	port = (server.address() as any).port;
	let browser: any;
	try {
		browser = await chromium.launch({
			executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
			headless: true,
			args: ['--no-sandbox']
		});
		for (const cross of [false, true]) {
			const page = await browser.newPage();
			const errors: string[] = [];
			page.on('pageerror', (error: Error) => errors.push(error.message));
			await page.goto(`http://127.0.0.1:${port}/?courseId=course&clazzid=class${cross ? '&cross=1' : ''}`);
			await page.waitForFunction(
				async () => (await (window as any).OCSAgent?.inspect())?.observation.tasks.length === 1
			);
			assert.equal(await page.locator('[data-ocs-agent]').count(), 1);
			assert.equal(await page.evaluate(() => (window as any).OCSAgent.describe().scope), 'video_tasks');
			for (const [chapterId, taskId] of [
				['ch1', 'course:class:job1'],
				['ch2', 'course:class:job2']
			]) {
				if (chapterId === 'ch2') {
					await page.evaluate((id: string) => (window as any).OCSAgent.openChapter(id), chapterId);
					await page.waitForFunction(
						async (id: string) =>
							(await (window as any).OCSAgent.inspect()).observation.tasks.some((task: any) => task.id === id),
						taskId
					);
				}
				assert.equal((await page.evaluate((id: string) => (window as any).OCSAgent.start(id), taskId)).taskId, taskId);
				await page.waitForFunction(async () =>
					(
						await (window as any).OCSAgent.getStatus()
					).frames.some((frame: any) => frame.status.state === 'running' && frame.status.media.currentTime > 0)
				);
				await page.evaluate(() => (window as any).OCSAgent.pause());
				assert.equal((await page.evaluate(() => (window as any).OCSAgent.getMemory())).checkpoint.phase, 'paused');
				assert.ok(
					(await page.evaluate(() => (window as any).OCSAgent.getStatus())).frames.some(
						(frame: any) => frame.status.state === 'paused'
					)
				);
				await page.evaluate(() => (window as any).OCSAgent.resume());
				await page.waitForFunction(
					async () =>
						(
							await (window as any).OCSAgent.getStatus()
						).frames.some((frame: any) => frame.status.state === 'awaiting_confirmation'),
					undefined,
					{ timeout: 10000 }
				);
				const cards = page.frames().find((frame: any) => frame.url().includes('/cards'));
				await cards.evaluate(() => {
					(window as any).attachments[0].isPassed = true;
				});
				await page.waitForFunction(async () =>
					(await (window as any).OCSAgent.getStatus()).frames.some((frame: any) => frame.status.state === 'completed')
				);
			}
			const memory = await page.evaluate(() => (window as any).OCSAgent.getMemory());
			assert.equal(memory.tasks.length, 2);
			assert.equal(memory.summary.confirmedTaskIds.length, 2);
			assert.equal(memory.checkpoint.phase, 'completed');
			assert.notEqual(memory.summary.videoScopeStatus, 'completed');
			await page.reload();
			await page.waitForFunction(() => !!(window as any).OCSAgent);
			const restored = await page.evaluate(() => (window as any).OCSAgent.getMemory());
			assert.equal(restored.tasks.length, 2);
			await page.evaluate(() => {
				window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
				window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
			});
			assert.ok(await page.evaluate(() => (window as any).OCSAgent.inspect()));
			await page.evaluate(
				() =>
					new Promise<void>((resolve) => {
						const frame = document.querySelector<HTMLIFrameElement>('#cards')!;
						frame.addEventListener('load', () => resolve(), { once: true });
						frame.src = '/player';
					})
			);
			assert.equal((await page.evaluate(() => (window as any).OCSAgent.inspect())).unavailableFrames.length, 0);
			await page.reload();
			await page.waitForFunction(async () =>
				(
					await (window as any).OCSAgent.inspect()
				).observation.tasks.some((task: any) => task.id === 'course:class:job1')
			);
			await page.evaluate(() => (window as any).OCSAgent.start('course:class:job1'));
			await page.waitForFunction(async () =>
				(await (window as any).OCSAgent.inspect()).frames.some((frame: any) => frame.status.state === 'running')
			);
			if (cross) {
				await page.evaluate(() => (window as any).OCSAgent.dispose());
				const player = page.frames().find((frame: any) => frame.url().includes('/player'));
				assert.equal(await player.evaluate(() => document.querySelector('video')!.paused), true);
				assert.equal(await page.locator('[data-ocs-agent]').count(), 0);
			} else {
				await page.evaluate(() => document.querySelector('#cards')!.remove());
				await page.evaluate(() => (window as any).OCSAgent.stop());
				assert.equal((await page.evaluate(() => (window as any).OCSAgent.inspect())).unavailableFrames.length, 0);
			}
			assert.equal(errors.length, 0, errors.join('\n'));
			console.log(
				`PASS ${
					cross ? 'cross-origin frame coordinator' : 'built userscript'
				}: two videos, control, platform confirmation, chapter switching and memory restore`
			);
			await page.close();
		}
	} finally {
		await browser?.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(temporary, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
