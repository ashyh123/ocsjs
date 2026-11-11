import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChaoxingAdapter } from '../packages/scripts/src/agent/chaoxing';

const browserEnv = require('browser-env');

function fixture(url = 'https://mooc1.chaoxing.com/knowledge/cards?courseid=c1&clazzid=k1&knowledgeid=h1'): Window {
	return browserEnv([], { url }) as Window;
}

function videoFrame(parent: Window, jobId: string, markup = '<div id="video"><video></video></div>') {
	const frame = parent.document.createElement('iframe');
	frame.setAttribute('data', JSON.stringify({ jobid: jobId }));
	parent.document.body.appendChild(frame);
	frame.contentWindow!.document.body.innerHTML = markup;
	return frame;
}

function attachments(win: Window, values: unknown[]) {
	(win as Window & { attachments: unknown }).attachments = values;
}

function attachment(jobId = 'j1', extra: Record<string, unknown> = {}) {
	return {
		job: true,
		property: { _jobid: jobId, mid: `m-${jobId}`, name: '同名视频', module: 'insertvideo' },
		...extra
	};
}

test('uses course/class identity from URL and binds media to the matching attachment', () => {
	const win = fixture();
	const frame = videoFrame(win, 'j1');
	attachments(win, [attachment('wrong'), attachment()]);
	const adapter = createChaoxingAdapter(win);
	const observation = adapter.inspect();
	assert.equal(observation.course?.courseId, 'c1');
	assert.equal(observation.course?.clazzId, 'k1');
	assert.equal(observation.tasks.length, 1);
	assert.equal(observation.tasks[0].id, 'c1:k1:j1');
	assert.equal(observation.tasks[0].chapterId, 'h1');
	assert.equal(adapter.resolveMedia('c1:k1:j1'), frame.contentDocument!.querySelector('video'));
	assert.equal(observation.url, 'https://mooc1.chaoxing.com/knowledge/cards?courseid=c1&clazzid=k1&knowledgeid=h1');
	assert.doesNotThrow(() => adapter.openTask('c1:k1:j1'));
	assert.throws(() => adapter.openTask('c1:k1:wrong'));
});

test('finds identity in accessible ancestor hidden fields and supports a supplied cross-frame identity', () => {
	const win = fixture('https://mooc1.chaoxing.com/course/study');
	win.document.body.innerHTML = '<input id="curCourseId" value="c2"><input id="curClazzId" value="k2">';
	const card = win.document.createElement('iframe');
	win.document.body.appendChild(card);
	videoFrame(card.contentWindow!, 'j1');
	attachments(card.contentWindow!, [attachment()]);
	assert.equal(createChaoxingAdapter(card.contentWindow!).inspect().tasks[0].id, 'c2:k2:j1');
	const isolated = fixture('https://mooc1.chaoxing.com/knowledge/cards');
	videoFrame(isolated, 'j1');
	attachments(isolated, [attachment()]);
	const provider = () => ({ courseId: 'c3', clazzId: 'k3', title: '课程' });
	assert.equal(createChaoxingAdapter(isolated, undefined, provider).inspect().tasks[0].id, 'c3:k3:j1');
	const conflict = createChaoxingAdapter(win, undefined, provider);
	assert.equal(conflict.inspect().course, null);
	assert.equal(conflict.resolveMedia('c2:k2:j1'), undefined);
});

test('does not execute unidentified or ambiguously mapped videos', () => {
	const win = fixture('https://mooc1.chaoxing.com/knowledge/cards?courseid=c1');
	videoFrame(win, 'j1');
	attachments(win, [attachment()]);
	const adapter = createChaoxingAdapter(win);
	assert.equal(adapter.inspect().tasks[0].availability, 'unknown');
	assert.equal(adapter.resolveMedia('unknown:unknown:j1'), undefined);
	assert.throws(() => adapter.openTask('unknown:unknown:j1'));
	const duplicate = fixture();
	videoFrame(duplicate, 'j1');
	videoFrame(duplicate, 'j1');
	attachments(duplicate, [attachment()]);
	const duplicateAdapter = createChaoxingAdapter(duplicate);
	assert.equal(duplicateAdapter.inspect().tasks.length, 1);
	assert.equal(duplicateAdapter.inspect().tasks[0].availability, 'unknown');
	assert.equal(duplicateAdapter.resolveMedia('c1:k1:j1'), undefined);
	assert.throws(() => duplicateAdapter.openTask('c1:k1:j1'));
});

test('discovers nested frames, ignores inaccessible and malformed frames, and separates same-title tasks', () => {
	const win = fixture();
	const wrapper = win.document.createElement('iframe');
	win.document.body.appendChild(wrapper);
	videoFrame(wrapper.contentWindow!, 'j1');
	videoFrame(win, 'j2');
	const malformed = videoFrame(win, 'broken');
	malformed.setAttribute('data', 'not json');
	const inaccessible = win.document.createElement('iframe');
	win.document.body.appendChild(inaccessible);
	Object.defineProperty(inaccessible, 'contentWindow', {
		get: () => {
			throw new Error('SecurityError');
		}
	});
	attachments(win, [attachment('j1'), attachment('j2'), attachment('broken')]);
	const observation = createChaoxingAdapter(win).inspect();
	assert.deepEqual(
		observation.tasks.map((task) => task.id),
		['c1:k1:j1', 'c1:k1:j2']
	);
});

test('confirms only fresh boolean task-level platform evidence', () => {
	const win = fixture();
	const frame = videoFrame(win, 'j1');
	Object.defineProperty(frame.contentDocument!.querySelector('video'), 'ended', { value: true });
	let evidence: unknown[] = [attachment('j1', { job: undefined, isPassed: 'true' })];
	const adapter = createChaoxingAdapter(win, () => evidence);
	assert.equal(adapter.inspect().tasks[0].platformStatus, 'unknown');
	evidence = [attachment()];
	assert.equal(adapter.inspect().tasks[0].platformStatus, 'pending');
	evidence = [attachment('j1', { isPassed: true })];
	assert.equal(adapter.inspect().tasks[0].platformStatus, 'confirmed');
	evidence = [attachment('j1', { job: undefined })];
	assert.equal(adapter.inspect().tasks[0].platformStatus, 'unknown');
});

test('keeps directory counts conservative and navigates only verified chapter DOM', () => {
	const win = fixture();
	const adapter = createChaoxingAdapter(win);
	assert.equal(adapter.inspect().catalogStatus, 'unknown');
	win.document.body.innerHTML = `
		<div><a onclick="getTeacherAjax('c1','k1','h1')">第一章</a><input class="jobUnfinishCount" value="0"></div>
		<div><a onclick="getTeacherAjax('c1','k1','h2')">第二章</a></div>
		<div><a onclick="getTeacherAjax('c1','k1','h3')">第三章</a><input class="jobUnfinishCount" value="bad"></div>`;
	const chapters = adapter.inspect();
	assert.equal(chapters.catalogStatus, 'partial');
	assert.deepEqual(
		chapters.chapters.map((chapter) => chapter.remaining),
		[0, null, null]
	);
	let clicked = 0;
	win.document.querySelectorAll('a')[1].addEventListener('click', () => clicked++);
	adapter.openChapter!('h2');
	assert.equal(clicked, 1);
	assert.throws(() => adapter.openChapter!('unseen'));
});

test('reports visible verification overlays but ignores hidden or empty QR elements', () => {
	const win = fixture();
	win.document.body.innerHTML = '<img id="fcqrimg"><div hidden><div class="chapterVideoFaceMaskDiv"></div></div>';
	const adapter = createChaoxingAdapter(win);
	assert.equal(adapter.inspect().blockedReason, null);
	win.document.body.innerHTML = '<div class="chapterVideoFaceMaskDiv"></div>';
	assert.equal(adapter.inspect().blockedReason, 'face_verification_required');
	assert.equal(
		createChaoxingAdapter(fixture('https://passport2.chaoxing.com/login')).inspect().blockedReason,
		'login_required'
	);
});

test('rejects cross-course chapter bindings and retains only stable routing parameters', () => {
	const win = fixture('https://mooc1.chaoxing.com/knowledge/cards?courseid=c1&clazzid=k1&enc=secret&token=secret');
	win.document.body.innerHTML = `
		<a onclick="getTeacherAjax('another','k1','foreign')">其他课程</a>
		<a data-chapterid="wrong" onclick="getTeacherAjax('c1','k1','different')">身份矛盾</a>
		<a onclick=" getTeacherAjax('c1','k1','h1')">当前课程</a>`;
	const adapter = createChaoxingAdapter(win);
	const observation = adapter.inspect();
	assert.deepEqual(
		observation.chapters.map((chapter) => chapter.id),
		['h1']
	);
	assert.equal(observation.url, 'https://mooc1.chaoxing.com/knowledge/cards?courseid=c1&clazzid=k1');
	assert.throws(() => adapter.openChapter!('foreign'));
	assert.throws(() => adapter.openChapter!('wrong'));
});
