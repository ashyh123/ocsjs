import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVideoRunner } from '../packages/scripts/src/agent/runner';
import type { PageObservation, PlatformAdapter, VideoTask } from '../packages/scripts/src/agent/types';

class FakeMedia extends EventTarget {
	currentTime = 42;
	duration = 120;
	paused = true;
	ended = false;
	readyState = 4;
	isConnected = true;
	error: { message: string } | null = null;
	playCount = 0;
	deferred = false;
	private pending: Array<{ resolve: () => void; reject: (cause: unknown) => void }> = [];

	play() {
		this.playCount++;
		return new Promise<void>((resolve, reject) => {
			const finish = () => {
				this.paused = false;
				this.dispatchEvent(new Event('playing'));
				resolve();
			};
			if (this.deferred) this.pending.push({ resolve: finish, reject });
			else finish();
		});
	}

	pause() {
		this.paused = true;
		this.dispatchEvent(new Event('pause'));
	}

	finishPlay() {
		this.pending.shift()?.resolve();
	}

	rejectPlay(cause: unknown) {
		this.pending.shift()?.reject(cause);
	}
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
	let media = new FakeMedia();
	const task: VideoTask = {
		id: 'course:class:job',
		chapterId: 'chapter',
		jobId: 'job',
		mid: 'video',
		title: 'Video',
		order: 0,
		platformStatus: 'pending',
		observedAt: Date.now(),
		availability: 'executable'
	};
	const page: PageObservation = {
		course: { courseId: 'course', clazzId: 'class', title: 'Course' },
		url: 'https://mooc1.chaoxing.com/knowledge/cards',
		tasks: [task],
		chapters: [],
		catalogStatus: 'partial',
		blockedReason: null
	};
	const events: string[] = [];
	const adapter: PlatformAdapter = {
		inspect: () => page,
		resolveMedia: (id) => (id === task.id ? (media as unknown as HTMLMediaElement) : undefined),
		openTask: () => undefined
	};
	const runner = createVideoRunner(adapter, (kind) => events.push(kind));
	return {
		page,
		task,
		runner,
		events,
		get media() {
			return media;
		},
		replaceMedia: () => (media = new FakeMedia())
	};
}

test('start returns immediately, preserves progress and distinguishes heartbeat from actual progress', async (t) => {
	const f = fixture();
	t.after(() => f.runner.dispose());
	assert.equal(f.runner.start(f.task.id).state, 'starting');
	assert.equal(f.media.currentTime, 42);
	await tick();
	assert.equal(f.runner.snapshot().state, 'running');
	assert.equal(f.runner.snapshot().lastProgressAt, null);
	f.media.currentTime = 43;
	f.media.dispatchEvent(new Event('timeupdate'));
	const progressedAt = f.runner.snapshot().lastProgressAt;
	assert.equal(typeof progressedAt, 'number');
	await tick();
	assert.equal(f.runner.snapshot().lastProgressAt, progressedAt);
	assert.equal(f.runner.start(f.task.id).state, 'running');
	assert.equal(f.media.playCount, 1);
	assert.doesNotThrow(() => JSON.stringify(f.runner.snapshot()));
});

test('pause and resume control the same video, while stop removes media listeners', async (t) => {
	const f = fixture();
	t.after(() => f.runner.dispose());
	f.runner.start(f.task.id);
	await tick();
	assert.equal(f.runner.pause().state, 'paused');
	assert.equal(f.media.paused, true);
	assert.equal(f.runner.resume().state, 'starting');
	await tick();
	assert.equal(f.runner.snapshot().state, 'running');
	assert.equal(f.runner.stop().state, 'stopped');
	f.media.ended = true;
	f.media.dispatchEvent(new Event('ended'));
	assert.equal(f.runner.snapshot().state, 'stopped');
});

test('late play resolution cannot undo stop or pause', async (t) => {
	for (const action of ['stop', 'pause'] as const) {
		const f = fixture();
		t.after(() => f.runner.dispose());
		f.media.deferred = true;
		f.runner.start(f.task.id);
		f.runner[action]();
		f.media.finishPlay();
		await tick();
		assert.equal(f.media.paused, true);
		assert.equal(f.runner.snapshot().state, action === 'stop' ? 'stopped' : 'paused');
	}
});

test('old pending play cannot revive an old video after a new video has started', async (t) => {
	const f = fixture();
	t.after(() => f.runner.dispose());
	const old = f.media;
	old.deferred = true;
	f.runner.start(f.task.id);
	f.runner.stop();
	f.replaceMedia();
	f.runner.start(f.task.id);
	await tick();
	old.finishPlay();
	await tick();
	assert.equal(old.paused, true);
	assert.equal(f.media.paused, false);
	assert.equal(f.runner.snapshot().state, 'running');
});

test('ended waits for fresh platform confirmation and rejects stale context', async (t) => {
	const f = fixture();
	t.after(() => f.runner.dispose());
	f.runner.start(f.task.id);
	await tick();
	f.media.ended = true;
	f.media.dispatchEvent(new Event('ended'));
	assert.equal(f.runner.snapshot().state, 'awaiting_confirmation');
	assert.equal(f.runner.snapshot().platformStatus, 'pending');
	f.task.platformStatus = 'confirmed';
	assert.equal(f.runner.snapshot().state, 'completed');
	f.page.course = { courseId: 'other', clazzId: 'class', title: 'Other' };
	assert.equal(f.runner.snapshot().state, 'stopped');
	assert.equal(f.runner.snapshot().platformStatus, 'unknown');
});

test('replaced or removed media invalidates its run', async (t) => {
	const f = fixture();
	t.after(() => f.runner.dispose());
	const old = f.media;
	f.runner.start(f.task.id);
	await tick();
	f.replaceMedia();
	assert.equal(f.runner.snapshot().state, 'stopped');
	assert.equal(f.runner.snapshot().blockedReason, 'media_context_changed');
	assert.equal(old.paused, true);
});

test('verification pauses playback and clearing it allows an explicit resume', async (t) => {
	const f = fixture();
	t.after(() => f.runner.dispose());
	f.runner.start(f.task.id);
	await tick();
	f.page.blockedReason = 'face_verification';
	assert.equal(f.runner.snapshot().state, 'waiting_for_user');
	assert.equal(f.media.paused, true);
	f.runner.resume();
	assert.equal(f.media.playCount, 1);
	f.page.blockedReason = null;
	assert.equal(f.runner.snapshot().state, 'paused');
	f.runner.resume();
	await tick();
	assert.equal(f.runner.snapshot().state, 'running');
});

test('autoplay rejection is actionable and late rejection after cancellation is ignored', async (t) => {
	const f = fixture();
	t.after(() => f.runner.dispose());
	f.media.deferred = true;
	f.runner.start(f.task.id);
	const denied = new Error('A trusted browser interaction is required');
	denied.name = 'NotAllowedError';
	f.media.rejectPlay(denied);
	await tick();
	assert.equal(f.runner.snapshot().state, 'waiting_for_user');
	assert.equal(f.runner.snapshot().blockedReason, 'autoplay_blocked');
	f.runner.resume();
	f.runner.stop();
	f.media.rejectPlay(new Error('Old play failed'));
	await tick();
	assert.equal(f.runner.snapshot().state, 'stopped');
	assert.equal(f.runner.snapshot().error, null);
});

test('pause intent remains effective when another script attempts to restart media', async (t) => {
	const f = fixture();
	t.after(() => f.runner.dispose());
	f.runner.start(f.task.id);
	await tick();
	f.runner.pause();
	f.media.paused = false;
	f.media.dispatchEvent(new Event('playing'));
	assert.equal(f.media.paused, true);
	assert.equal(f.runner.snapshot().state, 'paused');
});

test('an initial verification blocker pauses media already playing on the page', (t) => {
	const f = fixture();
	t.after(() => f.runner.dispose());
	f.page.blockedReason = 'face_verification';
	f.media.paused = false;
	assert.equal(f.runner.start(f.task.id).state, 'waiting_for_user');
	assert.equal(f.media.paused, true);
	assert.equal(f.media.playCount, 0);
});

test('another task is rejected while active and dispose stops pending playback', async () => {
	const f = fixture();
	f.media.deferred = true;
	f.runner.start(f.task.id);
	assert.throws(() => f.runner.start('another-task'), /Another video task is active/);
	f.runner.dispose();
	f.media.finishPlay();
	await tick();
	assert.equal(f.media.paused, true);
	assert.equal(f.runner.snapshot().state, 'stopped');
	assert.throws(() => f.runner.start(f.task.id), /disposed/);
});
