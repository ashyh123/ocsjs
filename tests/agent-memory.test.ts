import assert from 'node:assert/strict';
import test from 'node:test';
import { createCourseMemory } from '../packages/scripts/src/agent/memory';
import type { CourseIdentity, MemoryStorage, PageObservation, VideoTask } from '../packages/scripts/src/agent/types';

const course: CourseIdentity = { courseId: 'course-1', clazzId: 'class-1', title: '示例课程' };

function task(jobId: string, order = 0, overrides: Partial<VideoTask> = {}): VideoTask {
	return {
		id: `${course.courseId}:${course.clazzId}:${jobId}`,
		chapterId: `chapter-${jobId}`,
		jobId,
		mid: `media-${jobId}`,
		title: `视频 ${jobId}`,
		order,
		platformStatus: 'pending',
		observedAt: 10,
		availability: 'executable',
		...overrides
	};
}

function observation(tasks: VideoTask[] = [], overrides: Partial<PageObservation> = {}): PageObservation {
	return {
		course,
		url: 'https://mooc1.chaoxing.com/knowledge/cards?token=private-example',
		tasks,
		chapters: [],
		catalogStatus: 'partial',
		blockedReason: null,
		...overrides
	};
}

function storage(): MemoryStorage & { values: Map<string, unknown> } {
	const values = new Map<string, unknown>();
	return { values, get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
}

test('empty or unrecognized pages never become a completed course', () => {
	const memory = createCourseMemory(storage());
	assert.equal(memory.get(course), null);
	assert.equal(memory.reconcile(observation([], { course: null })), null);
	assert.equal(memory.reconcile(observation([], { catalogStatus: 'complete' }))?.summary.videoScopeStatus, 'unknown');
	assert.equal(memory.next(course), null);
});

test('partial catalog merges history but only currently visible tasks are executable', () => {
	const memory = createCourseMemory(storage());
	memory.reconcile(observation([task('a'), task('b', 1)]));
	const merged = memory.reconcile(observation([task('b', 1, { observedAt: 20 })]));
	assert.equal(merged?.tasks.length, 2);
	assert.equal(merged?.summary.videoScopeStatus, 'unknown');
	assert.equal(memory.next(course)?.jobId, 'b');
});

test('fresh platform evidence can regress a previously confirmed task', () => {
	const memory = createCourseMemory(storage());
	memory.reconcile(observation([task('a', 0, { platformStatus: 'confirmed' })], { catalogStatus: 'complete' }));
	assert.equal(memory.get(course)?.summary.videoScopeStatus, 'completed');
	const regressed = memory.reconcile(observation([task('a', 0, { platformStatus: 'pending', observedAt: 20 })]));
	assert.equal(regressed?.tasks[0].platformStatus, 'pending');
	assert.equal(memory.next(course)?.jobId, 'a');
	const unknown = memory.reconcile(observation([task('a', 0, { platformStatus: 'unknown', observedAt: 30 })]));
	assert.equal(unknown?.summary.confirmedTaskIds.length, 0);
});

test('older observations cannot overwrite newer confirmation or authorize a stale target', () => {
	const memory = createCourseMemory(storage());
	memory.reconcile(observation([task('a', 0, { platformStatus: 'confirmed', observedAt: 20 })]));
	memory.reconcile(
		observation([task('a', 0, { platformStatus: 'pending', observedAt: 10 })], { catalogStatus: 'complete' })
	);
	assert.equal(memory.get(course)?.tasks[0].platformStatus, 'confirmed');
	assert.equal(memory.get(course)?.summary.videoScopeStatus, 'unknown');
	assert.equal(memory.next(course), null);
});

test('video completion requires a complete, nonempty and fully observed map', () => {
	const memory = createCourseMemory(storage());
	const confirmed = task('a', 0, { platformStatus: 'confirmed' });
	assert.equal(memory.reconcile(observation([confirmed]))?.summary.videoScopeStatus, 'unknown');
	assert.equal(
		memory.reconcile(observation([confirmed], { catalogStatus: 'complete' }))?.summary.videoScopeStatus,
		'completed'
	);
	assert.equal(memory.get(course)?.summary.courseAllTasksStatus, 'not_assessed');
	assert.equal(memory.reconcile(observation([], { catalogStatus: 'complete' }))?.summary.videoScopeStatus, 'unknown');
});

test('course and class identities isolate memory, even with separators in identifiers', () => {
	const backing = storage();
	const memory = createCourseMemory(backing);
	memory.reconcile(observation([task('a')]));
	const other = { ...course, clazzId: 'class-2' };
	assert.equal(memory.get(other), null);
	memory.reconcile(observation([], { course: other }));
	assert.equal(backing.values.size, 2);
	assert.equal(memory.get(course)?.tasks.length, 1);
	assert.equal(memory.next(course), null);
	const first = { courseId: 'a:b', clazzId: 'c', title: 'first' };
	const second = { courseId: 'a', clazzId: 'b:c', title: 'second' };
	const sharedIdTask = task('job', 0, { id: 'a:b:c:job' });
	memory.reconcile(observation([sharedIdTask], { course: first }));
	memory.reconcile(observation([sharedIdTask], { course: second }));
	assert.equal(memory.get(first)?.course.title, 'first');
	assert.equal(memory.get(second)?.course.title, 'second');
	assert.equal(memory.next(first), null);
});

test('navigation recipes retain stable chapter and job targets across partial observations', () => {
	const backing = storage();
	const memory = createCourseMemory(backing);
	memory.reconcile(observation([task('a'), task('b', 1)]));
	const updated = memory.reconcile(observation([task('b', 1, { observedAt: 20 })]))!;
	assert.equal(updated.navigation.strategy, 'chapter_id_click_then_inspect');
	assert.deepEqual(
		updated.navigation.targets.map((target) => target.taskId),
		[task('a').id, task('b').id]
	);
	assert.equal(updated.navigation.targets[1].observedAt, 20);
	assert.equal(createCourseMemory(backing).get(course)?.navigation.targets[0].chapterId, 'chapter-a');
});

test('restarting does not restore stale executable capability or auto-start a checkpoint', () => {
	const backing = storage();
	const first = createCourseMemory(backing);
	first.reconcile(observation([task('a')]));
	first.checkpoint(course, task('a').id, 'running');
	const restarted = createCourseMemory(backing);
	assert.equal(restarted.get(course)?.checkpoint.phase, 'running');
	assert.equal(restarted.next(course), null);
	restarted.reconcile(observation([task('a', 0, { observedAt: 20 })]));
	assert.equal(restarted.next(course)?.jobId, 'a');
});

test('blocked pages suppress execution, and selection scans the whole course in stable order', () => {
	const memory = createCourseMemory(storage());
	memory.reconcile(observation([task('later', 3), task('locked', 0, { availability: 'locked' }), task('earlier', 1)]));
	assert.equal(memory.next(course)?.jobId, 'earlier');
	memory.reconcile(observation([task('earlier')], { blockedReason: 'face_verification_required' }));
	assert.equal(memory.next(course), null);
	memory.reconcile(observation([], { course: null }));
	assert.equal(memory.next(course), null);
});

test('checkpoint rejects cross-course task IDs and requires observed memory', () => {
	const memory = createCourseMemory(storage());
	assert.throws(() => memory.checkpoint(course, null, 'idle'), /must be observed/);
	memory.reconcile(observation([task('a')]));
	assert.throws(() => memory.checkpoint(course, 'other:class:job', 'running'), /another course/);
	assert.equal(memory.checkpoint(course, task('a').id, 'paused').checkpoint.phase, 'paused');
});

test('an invalid new observation invalidates old executable capabilities without discarding memory', () => {
	const memory = createCourseMemory(storage());
	memory.reconcile(observation([task('a')]));
	assert.equal(memory.next(course)?.jobId, 'a');
	assert.throws(() => memory.reconcile(observation([task('a', 0, { observedAt: NaN })])), /observedAt/);
	assert.equal(memory.next(course), null);
	assert.equal(memory.get(course)?.tasks.length, 1);
});

test('corrupt or unsupported stored memory is reported without being overwritten', () => {
	const backing = storage();
	const memory = createCourseMemory(backing);
	memory.reconcile(observation([task('a')]));
	const key = [...backing.values.keys()][0];
	const corrupt = { schemaVersion: 42, tasks: [] };
	backing.values.set(key, corrupt);
	assert.throws(() => memory.get(course), /unsupported schemaVersion/);
	assert.throws(() => memory.reconcile(observation([task('a')])), /unsupported schemaVersion/);
	assert.equal(backing.values.get(key), corrupt);
	backing.values.set(key, 'not an object');
	assert.throws(() => memory.get(course), /Invalid course memory/);
});

test('contradictory stored summary and wrong-course observations are rejected', () => {
	const backing = storage();
	const memory = createCourseMemory(backing);
	memory.reconcile(observation([task('a')]));
	const key = [...backing.values.keys()][0];
	const raw = backing.values.get(key) as any;
	raw.summary.videoScopeStatus = 'completed';
	assert.throws(() => memory.get(course), /summary contradicts/);
	assert.throws(
		() => createCourseMemory(storage()).reconcile(observation([task('a', 0, { id: 'other:class:a' })])),
		/identity/
	);
});

test('persistence whitelists data and callers cannot mutate stored memory through returned values', () => {
	const backing = storage();
	const memory = createCourseMemory(backing);
	const source = task('a') as VideoTask & { cookie?: string; element?: unknown };
	source.cookie = 'private-cookie';
	source.element = { nodeType: 1 };
	const result = memory.reconcile(observation([source]))!;
	result.tasks[0].title = 'caller mutation';
	assert.equal(memory.get(course)?.tasks[0].title, '视频 a');
	const serialized = JSON.stringify([...backing.values.values()]);
	assert.equal(serialized.includes('private-cookie'), false);
	assert.equal(serialized.includes('private-example'), false);
	assert.equal(serialized.includes('nodeType'), false);
});
