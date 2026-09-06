import assert from 'node:assert/strict';

// Logical deadline only: grant, cleanup, I/O and test watchdog timers stay real.
export function installNativeClock(t) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  let now = 1_800_000_000_000;
  let deadline;
  const realTimeout = globalThis.setTimeout;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => {
    if (delay === 2000) {
      deadline = fn;
      return {}; // clearTimeout accepts this inert handle.
    }
    return realTimeout(fn, delay, ...args);
  });
  return {
    signal: controller.signal,
    advance: () => { now += 2000; },
    expire: () => {
      assert.equal(typeof deadline, 'function', 'runner armed its deadline');
      now += 2000;
      deadline();
    },
  };
}
