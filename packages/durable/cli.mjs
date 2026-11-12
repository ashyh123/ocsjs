import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { createEgoBrowser } from './browser.mjs';
import { createDiagnosis } from './diagnosis.mjs';
import { bindVideo, openWorkflow } from './workflow.mjs';

const usage = `用法
  node cli.mjs inspect <space-id> <page>
  node cli.mjs --db <file> start <space-id> <page> <task-id>
  node cli.mjs --db <file> resume
  node cli.mjs --db <file> status`;

function browserSelection(space, page) {
	if (!/^\d+$/.test(space ?? '') || !Number.isSafeInteger(Number(space)) || !/^p[1-9]\d*$/.test(page ?? '')) {
		throw new Error('请输入 Ego Lite Space ID 和页面标签，例如 28 p1。');
	}
	return { spaceId: Number(space), page };
}

function print(value) {
	console.log(JSON.stringify(value));
}

// A separate SQLite lock lets readers inspect the job while one scheduler drives the browser.
function acquireScheduler(path) {
	const lock = new DatabaseSync(`${path}.scheduler.sqlite`);
	try {
		lock.exec('BEGIN IMMEDIATE');
	} catch (error) {
		lock.close();
		if (error.errcode === 5) throw new Error('此任务已有运行器，使用 status 查询。');
		throw error;
	}
	return () => lock.close();
}

async function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: { db: { type: 'string' }, help: { type: 'boolean' } }
	});
	const [action, ...args] = positionals;
	if (values.help || !action) {
		console.log(usage);
		return;
	}
	const browser = createEgoBrowser({ executable: process.env.OCS_EGO_BROWSER || 'ego-browser' });
	if (action === 'inspect' && args.length === 2) {
		const result = await browser.inspect(browserSelection(...args));
		if (result.kind !== 'observed') throw new Error(result.reason);
		const { course, blockedReason, tasks } = result.value.observation;
		print({ profileId: result.profileId, course, blockedReason, tasks });
		return;
	}
	if (
		!values.db ||
		!((action === 'start' && args.length === 3) || (['resume', 'status'].includes(action) && args.length === 0))
	) {
		throw new Error(usage);
	}
	const path = resolve(values.db);
	const readOnly = action === 'status';
	if (action !== 'start' && !existsSync(path)) throw new Error('尚无任务数据库。');
	mkdirSync(dirname(path), { recursive: true });
	const release = readOnly ? () => {} : acquireScheduler(path);
	let workflow;
	let interrupted = false;
	const signal = new AbortController();
	const stop = () => {
		interrupted = true;
		signal.abort();
		if (workflow) void workflow.close().catch(() => {});
	};
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
	try {
		workflow = await openWorkflow(path, { browser, diagnose: createDiagnosis(), onStatus: print, readOnly });
		if (interrupted) return;
		if (readOnly) {
			print(await workflow.status());
			return;
		}
		if (action === 'start') {
			const [space, page, taskId] = args;
			const selection = { ...browserSelection(space, page), taskId };
			const current = await browser.inspect(selection, signal.signal);
			await workflow.submit(bindVideo(current, selection));
		}
		const job = await workflow.status();
		if (!job) throw new Error('此数据库尚未绑定视频。');
		if (job.result) return print(job.result);
		print({ state: 'running', workflowId: job.taskId, taskId: job.target.taskId, title: job.target.title });
		const outcome = await workflow.wait(job.taskId);
		print(outcome);
		if (outcome.state?.outcome?.status !== 'completed') process.exitCode = 1;
	} catch (error) {
		if (!interrupted) throw error;
	} finally {
		process.removeListener('SIGINT', stop);
		process.removeListener('SIGTERM', stop);
		try {
			await workflow?.close();
		} finally {
			release();
		}
	}
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
