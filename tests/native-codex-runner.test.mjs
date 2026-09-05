import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { runMockCandidate, MOCK_FIXTURE_SHA256 } from '../native/mock-codex-runner.mjs';

const options = overrides => ({ attemptId: 'attempt_1', deadlineMs: Date.now() + 2000, checkCurrentGrant: () => true, ...overrides });

test('mock fixture is pinned to exact SHA256', async () => {
  const bytes = await readFile(new URL('./fixtures/native-codex-mock.mjs', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), MOCK_FIXTURE_SHA256);
});

test('candidate observation is deterministic and usage remains unknown', async () => {
  const result = await runMockCandidate(options());
  assert.equal(result.status, 'candidate');
  assert.equal(result.headSha, 'f'.repeat(40));
  assert.equal(result.processStopped, true);
  assert.equal(result.usage, null);
  assert.equal(result.usageStatus, 'UNKNOWN');
  const bytes = JSON.stringify({ kind: 'candidate', attemptId: 'attempt_1', headSha: 'f'.repeat(40) });
  assert.equal(result.resultDigest, createHash('sha256').update(bytes).digest('hex'));
});

for (const [testMode, status, reason] of [
  ['malformed', 'ambiguous', 'malformed-result'],
  ['malformed-shape', 'ambiguous', 'malformed-result'],
  ['oversized', 'ambiguous', 'output-limit'],
  ['stderr-oversized', 'ambiguous', 'output-limit'],
  ['failed', 'failed', 'nonzero-exit'],
  ['launch-failure', 'failed', 'launch-failed'],
]) {
  test(`${testMode} cannot produce a candidate`, async () => {
    const result = await runMockCandidate(options({ testMode }));
    assert.equal(result.status, status);
    assert.equal(result.reason, reason);
    assert.equal(result.headSha, null);
    assert.equal(result.processStopped, true);
    assert.equal(result.usage, null);
  });
}

async function assertStoppedGroup(run) {
  const originalKill = process.kill;
  const groups = new Set();
  process.kill = function(pid, signal) {
    if (pid < 0) groups.add(pid);
    return originalKill.call(process, pid, signal);
  };
  let result;
  try { result = await run(); } finally { process.kill = originalKill; }
  assert.equal(result.processStopped, true);
  assert.ok(groups.size > 0, 'a real process group was observed');
  for (const group of groups) assert.throws(() => originalKill.call(process, group, 0), { code: 'ESRCH' });
  return result;
}

test('cancellation kills ordinary descendants and confirms the group is gone', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180);
  try {
    const result = await assertStoppedGroup(() => runMockCandidate(options({ testMode: 'descendant', signal: controller.signal })));
    assert.equal(result.status, 'cancelled');
  } finally { clearTimeout(timer); }
});

test('expiry kills ordinary descendants and confirms the group is gone', async () => {
  const result = await assertStoppedGroup(() => runMockCandidate(options({ testMode: 'descendant', deadlineMs: Date.now() + 180 })));
  assert.equal(result.status, 'expired');
});

test('a mock process ignoring SIGTERM is killed with SIGKILL', async () => {
  const result = await assertStoppedGroup(() => runMockCandidate(options({ testMode: 'stubborn', deadlineMs: Date.now() + 180 })));
  assert.equal(result.status, 'expired');
});

test('mock environment omits inherited values and has empty home directories', async () => {
  process.env.NATIVE_MOCK_MUST_NOT_INHERIT = 'synthetic-sentinel';
  try {
    assert.equal((await runMockCandidate(options())).status, 'candidate');
  } finally { delete process.env.NATIVE_MOCK_MUST_NOT_INHERIT; }
});

test('parent exit with a live descendant is ambiguous and cleans up', async () => {
  const result = await assertStoppedGroup(() => runMockCandidate(options({ testMode: 'orphan' })));
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.reason, 'descendant-outlived-parent');
  assert.equal(result.headSha, null);
});

test('invalid or unverifiable grants prevent spawn', async () => {
  for (const checkCurrentGrant of [() => false, () => { throw new Error('fenced'); }, () => new Promise(() => {})]) {
    const result = await runMockCandidate(options({ checkCurrentGrant }));
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.reason, 'grant-unverified');
    assert.equal(result.processStopped, true);
  }
});

test('grant loss while executing stops the process group', async () => {
  let calls = 0;
  const result = await assertStoppedGroup(() => runMockCandidate(options({
    testMode: 'descendant', checkCurrentGrant: () => { if (++calls > 5) throw new Error('stale fence'); return true; },
  })));
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.reason, 'grant-unverified');
});

test('the final candidate requires a fresh grant', async () => {
  let calls = 0;
  const result = await runMockCandidate(options({ checkCurrentGrant: () => ++calls === 1 }));
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.headSha, null);
});

test('already cancelled and expired attempts never launch', async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal((await runMockCandidate(options({ signal: controller.signal }))).status, 'cancelled');
  assert.equal((await runMockCandidate(options({ deadlineMs: Date.now() - 1 }))).status, 'expired');
});

test('execution configuration cannot select arbitrary commands or unbounded attempts', async () => {
  await assert.rejects(runMockCandidate(options({ testMode: '/bin/sh' })), /unsupported mock mode/);
  await assert.rejects(runMockCandidate(options({ attemptId: '../unsafe' })), /invalid attemptId/);
  await assert.rejects(runMockCandidate(options({ deadlineMs: Date.now() + 60000 })), /invalid bounded deadline/);
  await assert.rejects(runMockCandidate(options({ checkCurrentGrant: undefined })), /callback required/);
});

test('unsupported process-group platform refuses to execute', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const result = await runMockCandidate(options());
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'unix-process-groups-required');
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});

test('a tampered fixture is refused before execution', async () => {
  mock.method(fs, 'readFile', async () => Buffer.from('tampered fixture'));
  syncBuiltinESMExports();
  try {
    const result = await runMockCandidate(options());
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'mock-pin-mismatch');
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});

test('filesystem failure produces a failed observation with no process', async () => {
  mock.method(fs, 'mkdtemp', async () => { throw new Error('disk unavailable'); });
  syncBuiltinESMExports();
  try {
    const result = await runMockCandidate(options());
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'mock-runner-failed');
    assert.equal(result.processStopped, true);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});

test('synchronous spawn failure produces a failed observation', async () => {
  mock.method(childProcess, 'spawn', () => { throw new Error('spawn unavailable'); });
  syncBuiltinESMExports();
  try {
    const result = await runMockCandidate(options());
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'mock-runner-failed');
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});

test('cancellation during the initial grant check prevents launch', async () => {
  const controller = new AbortController();
  const result = await runMockCandidate(options({ signal: controller.signal, checkCurrentGrant: () => { controller.abort(); return true; } }));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'before-spawn');
});

test('deadline during initial grant timeout is expired', async () => {
  const result = await runMockCandidate(options({ deadlineMs: Date.now() + 30, checkCurrentGrant: () => new Promise(() => {}) }));
  assert.equal(result.status, 'expired');
});

test('a hanging grant monitor kills execution and reports ambiguity', async () => {
  let calls = 0;
  const result = await assertStoppedGroup(() => runMockCandidate(options({
    testMode: 'hang', checkCurrentGrant: () => ++calls === 1 ? true : new Promise(() => {}),
  })));
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.reason, 'grant-unverified');
});

test('unverifiable process stop quarantines the observation', async () => {
  const originalKill = process.kill;
  const groups = new Set();
  process.kill = function(pid, signal) {
    if (pid < 0) groups.add(pid);
    if (signal === 0) throw Object.assign(new Error('probe denied'), { code: 'EPERM' });
    return originalKill.call(process, pid, signal);
  };
  let result;
  try { result = await runMockCandidate(options()); }
  finally { process.kill = originalKill; }
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.reason, 'process-stop-unverified');
  assert.equal(result.processStopped, false);
  assert.equal(result.headSha, null);
  for (const group of groups) assert.throws(() => originalKill.call(process, group, 0), { code: 'ESRCH' });
});

test('final readback denial rejects a completed candidate', async () => {
  mock.method(globalThis, 'setInterval', () => undefined);
  let calls = 0;
  try {
    const result = await runMockCandidate(options({ checkCurrentGrant: () => ++calls === 1 }));
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.reason, 'grant-unverified');
    assert.equal(result.headSha, null);
  } finally { mock.restoreAll(); }
});

test('cancellation during final readback cannot return a candidate', async () => {
  mock.method(globalThis, 'setInterval', () => undefined);
  const controller = new AbortController();
  let calls = 0;
  try {
    const result = await runMockCandidate(options({ signal: controller.signal, checkCurrentGrant: () => {
      if (++calls === 2) controller.abort();
      return true;
    } }));
    assert.equal(result.status, 'cancelled');
    assert.equal(result.headSha, null);
  } finally { mock.restoreAll(); }
});

test('deadline crossed during final readback rejects a completed candidate', async () => {
  mock.method(globalThis, 'setInterval', () => undefined);
  const now = Date.now();
  let current = now;
  mock.method(Date, 'now', () => current);
  let calls = 0;
  try {
    const result = await runMockCandidate(options({ checkCurrentGrant: () => {
      if (++calls === 2) current += 3000;
      return true;
    } }));
    assert.equal(result.status, 'expired');
    assert.equal(result.headSha, null);
  } finally { mock.restoreAll(); }
});

test('simultaneous cancellation and grant denial settle once as cancelled', async () => {
  mock.method(globalThis, 'setInterval', () => undefined);
  const controller = new AbortController();
  let calls = 0;
  try {
    const result = await runMockCandidate(options({ signal: controller.signal, checkCurrentGrant: () => {
      if (++calls === 2) { controller.abort(); return false; }
      return true;
    } }));
    assert.equal(result.status, 'cancelled');
    assert.equal(result.headSha, null);
    assert.equal(result.processStopped, true);
  } finally { mock.restoreAll(); }
});

test('cancellation at the spawn boundary kills the launched group', async () => {
  const controller = new AbortController();
  const originalSpawn = childProcess.spawn;
  mock.method(childProcess, 'spawn', (...args) => {
    const child = originalSpawn(...args);
    controller.abort();
    return child;
  });
  syncBuiltinESMExports();
  try {
    const result = await assertStoppedGroup(() => runMockCandidate(options({ signal: controller.signal })));
    assert.equal(result.status, 'cancelled');
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});

test('deadline reached at process exit rejects buffered candidate output', async () => {
  const now = Date.now();
  let current = now;
  mock.method(Date, 'now', () => current);
  const originalSpawn = childProcess.spawn;
  mock.method(childProcess, 'spawn', (...args) => {
    const child = originalSpawn(...args);
    child.once('exit', () => { current += 3000; });
    return child;
  });
  syncBuiltinESMExports();
  try {
    const result = await runMockCandidate(options());
    assert.equal(result.status, 'expired');
    assert.equal(result.headSha, null);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});
