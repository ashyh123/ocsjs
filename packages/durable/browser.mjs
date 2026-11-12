import { spawn } from 'node:child_process';

const RESULT_PREFIX = 'OCS_DURABLE_BROWSER_RESULT ';
const OPERATION_TIMEOUT_MS = 25_000;
const KILL_GRACE_MS = 750;
const MAX_OUTPUT = 512 * 1024;
const MAX_RECOVERY_CANDIDATES = 20;
const RECOVERY_CANDIDATE_ID = /^[a-f0-9]{64}$/;
const CHAPTER_ID = /^[a-zA-Z0-9_-]{1,128}$/;

const BROWSER_PROGRAM = String.raw`
function addressState(url) {
  if (url === 'about:blank' || url.startsWith('chrome-error:')) {
    return { kind: 'wait', reason: 'course_page_unavailable' };
  }
  const address = new URL(url);
  if (address.protocol !== 'https:') return { kind: 'user', reason: 'wrong_course_page' };
  if (/^passport\d*\.chaoxing\.com$/.test(address.hostname) ||
      ((address.hostname === 'chaoxing.com' || address.hostname.endsWith('.chaoxing.com')) && /^\/login(?:[/.]|$)/.test(address.pathname))) {
    return { kind: 'user', reason: 'login_required' };
  }
  const courseDomain = ['chaoxing.com', 'xuexi365.com'].some(
    (domain) => address.hostname === domain || address.hostname.endsWith('.' + domain)
  );
  return courseDomain ? null : { kind: 'user', reason: 'wrong_course_page' };
}

async function observeCourse({ operation, target, candidateId, maxRecoveryCandidates }) {
  const observedUrl = location.href;
  const hostname = location.hostname;
  if (/^passport\d*\.chaoxing\.com$/.test(hostname) ||
      ((hostname === 'chaoxing.com' || hostname.endsWith('.chaoxing.com')) && /^\/login(?:[/.]|$)/.test(location.pathname))) {
    return { kind: 'user', reason: 'login_required' };
  }
  if (location.protocol !== 'https:' || !['chaoxing.com', 'xuexi365.com'].some(
    (domain) => hostname === domain || hostname.endsWith('.' + domain)
  )) {
    return { kind: 'user', reason: 'wrong_course_page' };
  }
  if (!navigator.onLine) return { kind: 'wait', reason: 'network_offline' };

  const readEnrollment = () => {
    const routeEnrollment = new URL(observedUrl).searchParams.get('cpi');
    if (routeEnrollment) return routeEnrollment;
    const courseLink = [...document.querySelectorAll('a')].find((link) => link.textContent.includes('返回课程'));
    const href = courseLink?.getAttribute('href');
    if (href && URL.canParse(href, courseLink.ownerDocument.baseURI)) {
      return new URL(href, courseLink.ownerDocument.baseURI).searchParams.get('cpi');
    }
    return undefined;
  };
  const enrollment = readEnrollment();
  const digest = async (text) => Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
    (value) => value.toString(16).padStart(2, '0')
  ).join('');
  const enrollmentKey = enrollment ? await digest(enrollment) : undefined;
  if (target.enrollmentKey && target.enrollmentKey !== enrollmentKey) {
    return { kind: 'user', reason: 'course_enrollment_changed' };
  }

  const agent = window.OCSAgent;
  if (agent?.describe?.().platform !== 'chaoxing' || typeof agent.inspect !== 'function') {
    return document.readyState !== 'complete' || operation === 'afterRefresh'
      ? { kind: 'wait', reason: 'course_page_loading' }
      : { kind: 'user', reason: 'ocs_agent_unavailable' };
  }

  const activeStates = ['starting', 'running', 'paused', 'waiting_for_user', 'awaiting_confirmation'];
  const readParam = (url, ...names) => {
    const matches = [...url.searchParams].filter(([key]) => names.includes(key.toLowerCase()));
    if (matches.length > 1) return undefined;
    return matches[0]?.[1] ?? null;
  };
  const chapterPattern = /^[a-zA-Z0-9_-]{1,128}$/;
  const activeChapter = () => {
    const ids = new Set([...document.querySelectorAll('.posCatalog_active[id^="cur"]')]
      .map((element) => element.id.slice(3)).filter((id) => chapterPattern.test(id)));
    if (ids.size) return ids.size === 1 ? [...ids][0] : null;
    const chapterId = readParam(new URL(observedUrl), 'chapterid', 'knowledgeid');
    return chapterId && chapterPattern.test(chapterId) ? chapterId : null;
  };
  const playerRoute = (url) => url.protocol === 'https:' && !url.port && !url.username && !url.password &&
    ['mooc1.chaoxing.com', 'mooc1-1.chaoxing.com', 'mooc2-ans.chaoxing.com'].includes(url.hostname) &&
    /^\/(?:mooc(?:2)?-ans\/)?mycourse\/studentstudy\/?$/.test(url.pathname);
  const visible = (element) => element.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ??
    (element.getClientRects().length > 0 && element.ownerDocument.defaultView?.getComputedStyle(element).visibility === 'visible');
  const recoveryLink = (link) => {
    const href = link.getAttribute('href')?.trim();
    const destination = link.getAttribute('target')?.toLowerCase() ?? '';
    if (!href || !visible(link) || !['', '_self', '_top'].includes(destination) ||
        !URL.canParse(href, link.ownerDocument.baseURI)) return null;
    const url = new URL(href, link.ownerDocument.baseURI);
    if (!playerRoute(url) || url.hash || url.href === observedUrl ||
        readParam(url, 'courseid') !== target.courseId || readParam(url, 'clazzid', 'classid') !== target.clazzId ||
        readParam(url, 'cpi') !== enrollment) return null;
    const chapterId = readParam(url, 'chapterid', 'knowledgeid');
    if (chapterId !== null && (chapterId !== target.chapterId || !chapterPattern.test(chapterId))) return null;
    const title = [link.innerText, link.getAttribute('aria-label'), link.getAttribute('title')].find((value) => value?.trim())
      ?.replace(/(?:https?:\/\/|www\.)\S+|\S*[?&][a-z0-9_%.-]+=\S*|\b[a-z][a-z0-9_%.-]*=\S*/gi, '')
      .replace(/\s+/g, ' ').trim().slice(0, 160);
    return title ? { href: url.href, title, chapterId } : null;
  };
  const recoveryLinks = () => {
    const links = new Map();
    const visit = (doc) => {
      for (const link of doc.querySelectorAll('a[href]:not([onclick]):not([download]):not([aria-disabled="true"])')) {
        const candidate = recoveryLink(link);
        if (candidate && !links.has(candidate.href)) links.set(candidate.href, candidate);
      }
      for (const frame of doc.querySelectorAll('iframe')) {
        const child = frame.contentDocument;
        if (child?.location?.origin === location.origin && visible(frame)) visit(child);
      }
    };
    visit(document);
    return [...links.values()].sort((a, b) =>
      Number(b.chapterId === target.chapterId) - Number(a.chapterId === target.chapterId));
  };
  const verify = (view) => {
    const observation = view?.observation;
    if (!observation || !Array.isArray(observation.tasks) || !Array.isArray(view.frames) ||
        !Array.isArray(view.unavailableFrames)) {
      return { kind: 'unexpected', reason: 'invalid_ocs_observation' };
    }
    if (observation.blockedReason === 'login_required' || observation.blockedReason === 'face_verification_required') {
      return { kind: 'user', reason: observation.blockedReason };
    }
    if (target.courseId && observation.course && (
      observation.course.courseId !== target.courseId || observation.course.clazzId !== target.clazzId
    )) {
      return { kind: 'user', reason: 'course_identity_changed' };
    }
    return null;
  };
  const verifyNavigation = (view) => {
    if (target.enrollmentKey && readEnrollment() !== enrollment) {
      return { kind: 'user', reason: 'course_enrollment_changed' };
    }
    if (!view.observation.course || view.unavailableFrames.length > 0) {
      return { kind: 'wait', reason: 'course_frames_unavailable' };
    }
    if (view.frames.some(({ status }) => activeStates.includes(status.state))) {
      return { kind: 'user', reason: 'another_course_task_active' };
    }
    if (view.observation.blockedReason) return { kind: 'user', reason: 'course_navigation_blocked' };
    if (view.observation.tasks.some((task) => task.id === target.taskId && task.chapterId === target.chapterId &&
        (task.availability === 'executable' || task.platformStatus === 'confirmed'))) {
      return { kind: 'wait', reason: 'target_task_reappeared' };
    }
    return null;
  };

  const safeObservation = ({ course, tasks, chapters, catalogStatus, blockedReason }) => ({
    course, tasks, chapters, catalogStatus, blockedReason, url: ''
  });
  const observed = (view) => {
    const issue = verify(view);
    if (issue) return issue;
    return {
      kind: 'observed',
      enrollmentKey,
      value: {
        version: view.version,
        contextId: view.contextId,
        observedAt: view.observedAt,
        activeChapterId: activeChapter(),
        observation: safeObservation(view.observation),
        frames: view.frames.map(({ contextId, observation, status }) => ({
          contextId,
          observation: safeObservation(observation),
          status: { ...status, error: status.error ? 'ocs_playback_error' : null }
        })),
        unavailableFrames: view.unavailableFrames,
        memory: null
      }
    };
  };

  const before = await agent.inspect();
  if (location.href !== observedUrl) return { kind: 'wait', reason: 'course_page_changed' };
  const issue = verify(before);
  if (issue) return issue;
  if (operation === 'inspect' || operation === 'afterRefresh') return observed(before);

  if (operation === 'openChapter' || operation === 'discoverRecovery' || operation === 'followRecovery') {
    const navigationIssue = verifyNavigation(before);
    if (navigationIssue) return navigationIssue;
    if (operation === 'openChapter') {
      if (activeChapter() === target.chapterId) return { kind: 'unexpected', reason: 'target_chapter_already_open' };
      if (typeof agent.openChapter !== 'function' ||
          !before.observation.chapters?.some((chapter) => chapter.id === target.chapterId)) {
        return { kind: 'unexpected', reason: 'target_chapter_not_found' };
      }
      await agent.openChapter(target.chapterId);
      return { kind: 'navigated' };
    }
    if (!target.enrollmentKey || !playerRoute(new URL(observedUrl))) {
      return { kind: 'unexpected', reason: 'course_recovery_route_unverified' };
    }
    const candidates = await Promise.all(recoveryLinks().slice(0, maxRecoveryCandidates).map(async (candidate) => ({
      id: await digest(JSON.stringify([candidate.href, candidate.title])), ...candidate
    })));
    if (location.href !== observedUrl) return { kind: 'wait', reason: 'course_page_changed' };
    if (operation === 'discoverRecovery') {
      return { kind: 'candidates', candidates: candidates.map(({ id, title, chapterId }) => ({ id, title, chapterId })) };
    }
    const selected = candidates.find(({ id }) => id === candidateId);
    if (!selected) return { kind: 'unexpected', reason: 'recovery_candidate_unavailable' };
    const latest = await agent.inspect();
    const latestIssue = verify(latest) || verifyNavigation(latest);
    if (latestIssue) return latestIssue;
    if (location.href !== observedUrl) return { kind: 'wait', reason: 'course_page_changed' };
    if (!recoveryLinks().some(({ href, title }) => href === selected.href && title === selected.title)) {
      return { kind: 'unexpected', reason: 'recovery_candidate_unavailable' };
    }
    return { kind: 'recovery_href', href: selected.href };
  }
  if (!before.observation.course || before.unavailableFrames.length > 0) {
    return { kind: 'wait', reason: 'course_frames_unavailable' };
  }
  const tasks = before.observation.tasks.filter((task) => task.id === target.taskId);
  if (tasks.length !== 1 || tasks[0].chapterId !== target.chapterId) {
    return { kind: 'unexpected', reason: 'target_task_not_found' };
  }
  const selected = tasks[0];
  const runners = before.frames.map((frame) => frame.status).filter((status) => activeStates.includes(status.state));
  if (runners.some((status) => status.taskId !== selected.id)) {
    return { kind: 'user', reason: 'another_course_task_active' };
  }
  if (before.observation.blockedReason || selected.platformStatus === 'confirmed') return observed(before);
  if (operation === 'refresh') return observed(before);
  if (selected.platformStatus !== 'pending') return { kind: 'unexpected', reason: 'platform_status_unknown' };
  if (selected.availability !== 'executable') return { kind: 'wait', reason: 'target_video_unavailable' };

  if (operation === 'start' && runners.length === 0) {
    await agent.start(selected.id);
  } else if (operation === 'resume' && runners.length === 1 && runners[0].state === 'paused') {
    await agent.resume();
  } else {
    return observed(before);
  }
  return observed(await agent.inspect());
}

async function run({ operation, target, candidateId, maxRecoveryCandidates }) {
  const space = (await listTaskSpaces()).find((item) => item.id === target.spaceId);
  if (!space) return { kind: 'wait', reason: 'space_unavailable' };
  if (space.ownership !== 'agent') return { kind: 'user', reason: 'space_needs_agent_control' };
  if (typeof space.profileId !== 'string' || !space.profileId) {
    return { kind: 'user', reason: 'space_profile_unavailable' };
  }
  if (target.profileId !== undefined && space.profileId !== target.profileId) {
    return { kind: 'user', reason: 'space_profile_changed' };
  }

  const task = await taskSpace(space.id);
  if (task.ownership !== 'agent') return { kind: 'user', reason: 'space_needs_agent_control' };
  const tabs = await task.tabs();
  let tab = tabs.find((item) => item.label === target.page);
  if (!tab && target.courseId && target.clazzId && target.chapterId) {
    const matchingTabs = tabs.filter((item) => {
      if (addressState(item.url)) return false;
      const address = new URL(item.url);
      const params = new Map([...address.searchParams].map(([key, value]) => [key.toLowerCase(), value]));
      return params.get('courseid') === target.courseId &&
        (params.get('clazzid') || params.get('classid')) === target.clazzId &&
        (params.get('chapterid') || params.get('knowledgeid')) === target.chapterId;
    });
    if (matchingTabs.length === 1) tab = matchingTabs[0];
  }
  if (!tab) return { kind: 'wait', reason: 'course_page_unavailable' };
  const page = tab.label ? task.page(tab.label) : await task.adopt(tab.page);
  const currentUrl = await page.url();
  const addressIssue = addressState(currentUrl);
  if (addressIssue) return addressIssue;

  let result = await page.evaluate(observeCourse, { operation, target, candidateId, maxRecoveryCandidates });
  if (result?.kind === 'recovery_href' && operation === 'followRecovery') {
    if (await page.url() !== currentUrl) return { kind: 'wait', reason: 'course_page_changed' };
    try {
      await page.goto(result.href, { waitUntil: 'domcontentloaded', timeout: 12000 });
    } catch (error) {
      if (!/timeout|timed out|ERR_ABORTED/i.test(String(error?.message ?? error))) throw error;
    }
    return { kind: 'navigated' };
  }
  if (result?.kind === 'observed' && operation === 'refresh') {
    if (result.value.observation.blockedReason ||
        result.value.frames.some(({ status }) => ['starting', 'running', 'waiting_for_user'].includes(status.state)) ||
        result.value.observation.tasks.some((item) => item.id === target.taskId && item.platformStatus === 'confirmed')) {
      return { ...result, profileId: space.profileId };
    }
    if (await page.url() !== currentUrl) return { kind: 'wait', reason: 'course_page_changed' };
    const routeChapter = [...new URL(currentUrl).searchParams].find(([key]) => /^chapterid$/i.test(key))?.[1];
    if (routeChapter && routeChapter !== target.chapterId) return { kind: 'user', reason: 'reopen_target_chapter_before_refresh' };
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 12000 });
    const afterReload = addressState(await page.url());
    if (afterReload) return afterReload;
    result = await page.evaluate(observeCourse, { operation: 'afterRefresh', target });
  }
  return result?.kind === 'observed' ? { ...result, profileId: space.profileId } : result;
}

try {
  console.log('OCS_DURABLE_BROWSER_RESULT ' + JSON.stringify(await run(input)));
} catch (error) {
  const message = String(error?.message ?? error);
  let result;
  if (/EGO_.*(?:SPACE.*(?:IN_USE|CONTROL|INACTIVE|UNASSIGNED)|(?:USER|CONTROL)_TAKEN)|user[- ]owned|not assigned/i.test(message)) {
    result = { kind: 'user', reason: 'space_needs_agent_control' };
  } else if (/EGO_PAGE_UNRESPONSIVE|timeout|timed out|connection|browser.*(?:closed|offline)|frame is unavailable|inspect again/i.test(message)) {
    result = { kind: 'wait', reason: 'browser_temporarily_unavailable' };
  } else if (/task belongs to another course/i.test(message)) {
    result = { kind: 'user', reason: 'course_identity_changed' };
  } else {
    result = { kind: 'unexpected', reason: 'ocs_browser_operation_failed' };
  }
  console.log('OCS_DURABLE_BROWSER_RESULT ' + JSON.stringify(result));
}
`;

function commandFailure(output) {
	if (
		/EGO_.*(?:SPACE.*(?:IN_USE|CONTROL|INACTIVE|UNASSIGNED)|(?:USER|CONTROL)_TAKEN)|user[- ]owned|not assigned/i.test(
			output
		)
	) {
		return { kind: 'user', reason: 'space_needs_agent_control' };
	}
	return { kind: 'wait', reason: 'ego_browser_unavailable' };
}

function readResult(output, operation) {
	const line = output.split('\n').findLast((part) => part.startsWith(RESULT_PREFIX));
	if (!line) return { kind: 'unexpected', reason: 'missing_ego_browser_result' };
	try {
		const result = JSON.parse(line.slice(RESULT_PREFIX.length));
		if (result?.kind === 'observed' && result.value && typeof result.profileId === 'string') return result;
		if (['wait', 'user', 'unexpected'].includes(result?.kind) && typeof result.reason === 'string') return result;
		if (['openChapter', 'followRecovery'].includes(operation) && result?.kind === 'navigated') {
			return { kind: 'navigated' };
		}
		if (
			operation === 'discoverRecovery' &&
			result?.kind === 'candidates' &&
			Array.isArray(result.candidates) &&
			result.candidates.length <= MAX_RECOVERY_CANDIDATES &&
			result.candidates.every(
				(candidate) =>
					typeof candidate?.id === 'string' &&
					RECOVERY_CANDIDATE_ID.test(candidate.id) &&
					typeof candidate.title === 'string' &&
					candidate.title.length > 0 &&
					candidate.title.length <= 160 &&
					(candidate.chapterId === null ||
						(typeof candidate.chapterId === 'string' && CHAPTER_ID.test(candidate.chapterId)))
			)
		) {
			return {
				kind: 'candidates',
				candidates: result.candidates.map(({ id, title, chapterId }) => ({ id, title, chapterId }))
			};
		}
	} catch {
		// Command output never enters workflow logs or model context.
	}
	return { kind: 'unexpected', reason: 'invalid_ego_browser_result' };
}

function runBrowser(executable, input, signal) {
	if (signal?.aborted) return Promise.resolve({ kind: 'wait', reason: 'browser_operation_cancelled' });
	return new Promise((resolve) => {
		const child = spawn(executable, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		let stdout = '';
		let stderr = '';
		let termination;
		let killTimer;
		let settled = false;
		const timeout = setTimeout(() => terminate({ kind: 'wait', reason: 'ego_browser_timeout' }), OPERATION_TIMEOUT_MS);
		const abort = () => terminate({ kind: 'wait', reason: 'browser_operation_cancelled' });

		function finish(result) {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			clearTimeout(killTimer);
			signal?.removeEventListener('abort', abort);
			resolve(result);
		}

		function terminate(result) {
			if (termination || settled) return;
			termination = result;
			child.kill('SIGTERM');
			killTimer = setTimeout(() => {
				child.kill('SIGKILL');
				child.stdout.destroy();
				child.stderr.destroy();
				finish(termination);
			}, KILL_GRACE_MS);
		}

		signal?.addEventListener('abort', abort, { once: true });
		child.stdout.setEncoding('utf8').on('data', (chunk) => {
			if (termination || settled) return;
			stdout += chunk;
			if (stdout.length + stderr.length > MAX_OUTPUT)
				terminate({ kind: 'unexpected', reason: 'ego_browser_result_too_large' });
		});
		child.stderr.setEncoding('utf8').on('data', (chunk) => {
			if (termination || settled) return;
			stderr += chunk;
			if (stdout.length + stderr.length > MAX_OUTPUT)
				terminate({ kind: 'unexpected', reason: 'ego_browser_result_too_large' });
		});
		child.on('error', (error) => {
			finish(
				termination ??
					(error.code === 'ENOENT'
						? { kind: 'user', reason: 'ego_browser_not_installed' }
						: { kind: 'wait', reason: 'ego_browser_unavailable' })
			);
		});
		child.on('close', (code) => {
			const output = `${stdout}\n${stderr}`;
			finish(termination ?? (code === 0 ? readResult(output, input.operation) : commandFailure(output)));
		});
		child.stdin.on('error', () => {
			// The child exit supplies the outcome if it closes the input pipe early.
		});
		child.stdin.end('const input = ' + JSON.stringify(input) + ';\n' + BROWSER_PROGRAM);
		if (signal?.aborted) abort();
	});
}

export function createEgoBrowser({ executable = 'ego-browser' } = {}) {
	const act = async (operation, target, signal, candidateId) => {
		const { spaceId, page, profileId, taskId, courseId, clazzId, chapterId, enrollmentKey } = target ?? {};
		const identifiers = [profileId, taskId, courseId, clazzId, chapterId];
		if (
			!Number.isSafeInteger(spaceId) ||
			spaceId < 0 ||
			typeof page !== 'string' ||
			!/^p[1-9]\d*$/.test(page) ||
			identifiers.some((id) => id !== undefined && (typeof id !== 'string' || !id.trim() || id.length > 256)) ||
			(enrollmentKey !== undefined && (typeof enrollmentKey !== 'string' || !/^[0-9a-f]{64}$/.test(enrollmentKey))) ||
			(operation === 'followRecovery' &&
				(typeof candidateId !== 'string' || !RECOVERY_CANDIDATE_ID.test(candidateId))) ||
			(operation !== 'inspect' && identifiers.some((id) => id === undefined))
		) {
			return { kind: 'user', reason: 'invalid_browser_target' };
		}
		return runBrowser(
			executable,
			{
				operation,
				target: { spaceId, page, profileId, taskId, courseId, clazzId, chapterId, enrollmentKey },
				candidateId,
				maxRecoveryCandidates: MAX_RECOVERY_CANDIDATES
			},
			signal
		);
	};
	return {
		inspect: (target, signal) => act('inspect', target, signal),
		start: (target, signal) => act('start', target, signal),
		resume: (target, signal) => act('resume', target, signal),
		refresh: (target, signal) => act('refresh', target, signal),
		openChapter: (target, signal) => act('openChapter', target, signal),
		discoverRecovery: (target, signal) => act('discoverRecovery', target, signal),
		followRecovery: (target, candidateId, signal) => act('followRecovery', target, signal, candidateId)
	};
}
