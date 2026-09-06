// Trusted disposable fixture: never imports Codex or reads credentials.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';

// macOS adds its text-encoding locale even to an otherwise empty environment.
if (Object.keys(process.env).some(key => !['HOME', 'CODEX_HOME', 'TMPDIR', 'NODE_V8_COVERAGE', '__CF_USER_TEXT_ENCODING'].includes(key)) ||
    process.env.NODE_V8_COVERAGE !== '' ||
    readdirSync(process.env.HOME).length || readdirSync(process.env.CODEX_HOME).length) process.exit(90);

const [mode, attemptId] = process.argv.slice(2);
const candidate = () => process.stdout.write(JSON.stringify({
  kind: 'candidate', attemptId, headSha: 'f'.repeat(40),
}));

if (mode === 'candidate') candidate();
else if (mode === 'malformed') process.stdout.write('{broken');
else if (mode === 'malformed-shape') process.stdout.write('{"kind":"candidate","headSha":"invalid"}');
else if (mode === 'oversized') process.stdout.write('x'.repeat(131072));
else if (mode === 'stderr-oversized') process.stderr.write('x'.repeat(131072));
else if (mode === 'failed') process.exitCode = 7;
else if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'stubborn') {
  process.on('SIGTERM', () => {});
  process.stderr.write('stubborn-ready\n');
  setInterval(() => {}, 1000);
}
else if (mode === 'descendant' || mode === 'orphan') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: {}, stdio: 'ignore',
  });
  process.stderr.write(`descendant:${child.pid}\n`);
  if (mode === 'orphan') {
    child.unref();
    candidate();
  } else setInterval(() => {}, 1000);
} else process.exitCode = 9;
