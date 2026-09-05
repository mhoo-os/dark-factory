import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MOCK_FIXTURE_SHA256 = 'ba81c1b65d13a573144acda2708f57d870eb176b647715b7d86c294d7f71ef88';
const fixture = fileURLToPath(new URL('../tests/fixtures/native-codex-mock.mjs', import.meta.url));
const modes = new Set(['candidate', 'malformed', 'malformed-shape', 'oversized', 'stderr-oversized', 'failed', 'hang', 'stubborn', 'descendant', 'orphan', 'launch-failure']);
const MAX_OUTPUT = 65536;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function groupAlive(pid) {
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

// Unix process groups demonstrate ordinary mock-descendant cleanup only.
// This is not containment for malicious daemons and does not replace cgroups.
async function stopGroup(pid) {
  if (!groupAlive(pid)) return true;
  try { process.kill(-pid, 'SIGTERM'); } catch { /* verify below */ }
  for (let n = 0; n < 10 && groupAlive(pid); n++) await sleep(10);
  if (groupAlive(pid)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* verify below */ }
    for (let n = 0; n < 20 && groupAlive(pid); n++) await sleep(10);
  }
  return !groupAlive(pid);
}

/** Mock only. deadlineMs is absolute Unix time; checkCurrentGrant must return true.
 * The caller owns persisted attempt/fence authority; this observer cannot publish.
 * testMode selects a fixed fixture behavior, never an executable or command.
 */
export async function runMockCandidate({ attemptId, deadlineMs, signal, checkCurrentGrant, testMode = 'candidate' }) {
  if (typeof attemptId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(attemptId)) throw new Error('invalid attemptId');
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs > Date.now() + 30000) throw new Error('invalid bounded deadline');
  if (typeof checkCurrentGrant !== 'function') throw new Error('current grant callback required');
  if (!modes.has(testMode)) throw new Error('unsupported mock mode');
  let directory;
  let child;
  let output = Buffer.alloc(0);
  let errorOutput = Buffer.alloc(0);
  const observation = (status, reason, processStopped = true, headSha = null) => ({
    status, reason, resultDigest: digest(output), headSha,
    usage: null, usageStatus: 'UNKNOWN', processStopped,
  });
  const interrupted = () => signal?.aborted ? 'cancelled' : Date.now() >= deadlineMs ? 'expired' : null;
  async function grantIsCurrent() {
    let timeout;
    try {
      return await Promise.race([
        Promise.resolve().then(checkCurrentGrant),
        new Promise(resolve => { timeout = setTimeout(() => resolve(false), Math.max(1, Math.min(100, deadlineMs - Date.now()))); }),
      ]) === true;
    } catch { return false; }
    finally { clearTimeout(timeout); }
  }
  try {
    if (interrupted()) return observation(interrupted(), 'before-spawn');
    if (process.platform === 'win32') return observation('failed', 'unix-process-groups-required');
    const fixtureBytes = await readFile(fixture);
    if (digest(fixtureBytes) !== MOCK_FIXTURE_SHA256) return observation('failed', 'mock-pin-mismatch');
    directory = await mkdtemp(join(tmpdir(), 'native-codex-mock-'));
    const home = join(directory, 'home');
    const codexHome = join(directory, 'codex');
    await Promise.all([mkdir(home), mkdir(codexHome)]);
    const verifiedFixture = join(directory, 'mock.mjs');
    await writeFile(verifiedFixture, fixtureBytes, { mode: 0o400, flag: 'wx' });
    if (!await grantIsCurrent()) return observation(interrupted() || 'ambiguous', 'grant-unverified');
    if (interrupted()) return observation(interrupted(), 'before-spawn');
    return await new Promise(resolve => {
      let finished = false;
      let monitoring = false;
      let interval;
      let deadline;
      const onAbort = () => { void finish('cancelled', 'abort-signal'); };
      async function finish(status, reason, headSha = null) {
        if (finished) return;
        finished = true;
        clearInterval(interval);
        clearTimeout(deadline);
        signal?.removeEventListener('abort', onAbort);
        const processStopped = await stopGroup(child?.pid);
        resolve(observation(processStopped ? status : 'ambiguous', processStopped ? reason : 'process-stop-unverified', processStopped, processStopped ? headSha : null));
      }
      child = spawn(process.execPath, [verifiedFixture, testMode, attemptId], {
        cwd: testMode === 'launch-failure' ? join(directory, 'absent') : directory,
        env: { HOME: home, CODEX_HOME: codexHome, TMPDIR: directory, NODE_V8_COVERAGE: '' },
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const collect = (chunk, stderr) => {
        if (finished) return;
        const prior = stderr ? errorOutput : output;
        const bytes = Buffer.concat([prior, chunk.subarray(0, Math.max(0, MAX_OUTPUT - prior.length))]);
        if (stderr) errorOutput = bytes; else output = bytes;
        if (prior.length + chunk.length > MAX_OUTPUT) void finish('ambiguous', 'output-limit');
      };
      child.stdout.on('data', chunk => collect(chunk, false));
      child.stderr.on('data', chunk => collect(chunk, true));
      child.on('error', () => { void finish('failed', 'launch-failed'); });
      child.on('close', async code => {
        if (finished) return;
        if (groupAlive(child.pid)) return void finish('ambiguous', 'descendant-outlived-parent');
        if (interrupted()) return void finish(interrupted(), 'attempt-interrupted');
        if (!await grantIsCurrent()) return void finish(interrupted() || 'ambiguous', 'grant-unverified');
        if (finished) return;
        if (interrupted()) return void finish(interrupted(), 'attempt-interrupted');
        if (code !== 0) return void finish('failed', 'nonzero-exit');
        let result;
        try { result = JSON.parse(output.toString('utf8')); } catch { /* reject below */ }
        if (result?.kind !== 'candidate' || result.attemptId !== attemptId || !/^[a-f0-9]{40}$/.test(result.headSha)) {
          return void finish('ambiguous', 'malformed-result');
        }
        void finish('candidate', 'mock-completed', result.headSha);
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      deadline = setTimeout(() => { void finish('expired', 'deadline'); }, Math.max(1, deadlineMs - Date.now()));
      interval = setInterval(async () => {
        if (finished || monitoring) return;
        monitoring = true;
        if (!await grantIsCurrent()) void finish(interrupted() || 'ambiguous', 'grant-unverified');
        monitoring = false;
      }, 20);
      if (interrupted()) void finish(interrupted(), 'attempt-interrupted');
    });
  } catch {
    const stopped = await stopGroup(child?.pid);
    return observation(stopped ? 'failed' : 'ambiguous', 'mock-runner-failed', stopped);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
