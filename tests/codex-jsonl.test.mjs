import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseCodexJsonl, JSONL_LIMITS } from '../native/codex-jsonl.mjs';

const binding = { attemptId: 'trusted_attempt', requestDigest: 'a'.repeat(64) };
const thread = { type: 'thread.started', thread_id: 'synthetic_thread' };
const start = { type: 'turn.started' };
const done = { type: 'turn.completed' };
const encode = events => Buffer.from(events.map(value => JSON.stringify(value)).join('\n') + '\n');
const parse = events => parseCodexJsonl(encode(events), binding);

test('completed synthetic turn binds trusted context and hashes exact bytes', () => {
  const bytes = encode([thread, start, { type: 'item.completed', item: { text: 'secret raw text', headSha: 'f'.repeat(40) }, attemptId: 'forged' }, done]);
  const result = parseCodexJsonl(bytes, { ...binding, expectedThreadId: thread.thread_id });
  assert.deepEqual(result, {
    ...binding, inputDigest: createHash('sha256').update(bytes).digest('hex'), providerThreadId: thread.thread_id,
    status: 'completed', reason: 'turn-completed', tokenUsage: null, usageStatus: 'UNKNOWN', billingStatus: 'UNKNOWN',
    publicationAllowed: false, liveExecutionAllowed: false,
  });
  assert.ok(!JSON.stringify(result).includes('secret raw text'));
  assert.equal('headSha' in result, false);
});

test('observed token counts never become billing authority', () => {
  for (const usage of [{ input_tokens: 10, cached_input_tokens: 3, output_tokens: 4 }, { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }]) {
    const result = parse([thread, start, { ...done, usage }]);
    assert.deepEqual(result.tokenUsage, { inputTokens: usage.input_tokens, cachedInputTokens: usage.cached_input_tokens, outputTokens: usage.output_tokens });
    assert.equal(result.usageStatus, 'OBSERVED');
    assert.equal(result.billingStatus, 'UNKNOWN');
  }
});

test('invalid and missing token counts remain unknown', () => {
  for (const usage of [undefined, null, [], '10', {}, { input_tokens: -1, cached_input_tokens: 0, output_tokens: 1 },
    { input_tokens: 1.5, cached_input_tokens: 0, output_tokens: 1 }, { input_tokens: '2', cached_input_tokens: 0, output_tokens: 1 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, cached_input_tokens: 0, output_tokens: 1 },
    { input_tokens: 1, cached_input_tokens: 2, output_tokens: 1 }]) {
    const result = parse([thread, start, { ...done, usage }]);
    assert.equal(result.status, 'completed');
    assert.equal(result.tokenUsage, null);
    assert.equal(result.usageStatus, 'UNKNOWN');
  }
});

test('failed errors discard messages and only exact synthetic allowance code needs a human', () => {
  for (const type of ['turn.failed', 'error']) {
    for (const code of [undefined, 'unknown_failure', 'allowance_exhausted']) {
      const event = type === 'error' ? { type, code, message: 'do not leak' } : { type, error: { code, message: 'do not leak' } };
      const result = parse([thread, start, event]);
      assert.equal(result.status, code === 'allowance_exhausted' ? 'needs-human' : 'failed');
      assert.equal(result.reason, code === 'allowance_exhausted' ? 'allowance-exhausted' : 'turn-failed');
      assert.equal(result.tokenUsage, null);
      assert.ok(!JSON.stringify(result).includes('do not leak'));
      assert.equal(result.liveExecutionAllowed, false);
    }
  }
  assert.equal(parse([thread, start, { type: 'turn.failed' }]).status, 'failed');
});

test('reordered, repeated, resumed, interrupted and unterminated turns are ambiguous', () => {
  for (const events of [[start, thread, done], [thread, done], [thread, thread], [thread, start],
    [thread, start, start, done], [thread, start, done, done], [thread, start, done, start],
    [thread, start, { type: 'thread.resumed' }], [thread, start, { type: 'turn.interrupted' }],
    [thread, start, { type: 'unknown' }], [thread, start, done, { type: 'error' }]]) {
    const result = parse(events);
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.tokenUsage, null);
  }
});

test('all three item event types are accepted only within the turn', () => {
  for (const type of ['item.started', 'item.updated', 'item.completed']) {
    assert.equal(parse([thread, start, { type }, done]).status, 'completed');
    assert.equal(parse([thread, { type }, start, done]).status, 'ambiguous');
  }
});

test('invalid envelopes and unsafe thread identifiers are rejected', () => {
  for (const invalid of [null, false, 7, [], {}, { type: 1 }]) assert.equal(parse([invalid]).reason, 'invalid-event');
  for (const thread_id of [undefined, null, 7, '', 'bad\nthread', 'x'.repeat(129)]) {
    assert.equal(parse([{ type: 'thread.started', thread_id }]).reason, 'thread-start-required');
  }
  const result = parseCodexJsonl(encode([thread, start, done]), { ...binding, expectedThreadId: 'other' });
  assert.equal(result.reason, 'thread-mismatch');
  assert.equal(result.status, 'ambiguous');
});

test('missing newline, malformed JSON, invalid UTF8 and empty lines fail closed', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('{}')]) assert.equal(parseCodexJsonl(bytes, binding).reason, 'truncated');
  assert.equal(parseCodexJsonl(Buffer.from('{\n'), binding).reason, 'malformed-json');
  assert.equal(parseCodexJsonl(Buffer.from([0xff, 10]), binding).reason, 'invalid-utf8');
  assert.equal(parseCodexJsonl(Buffer.from('\n'), binding).reason, 'empty-line');
  assert.equal(parseCodexJsonl(Buffer.from('\ufeff{}\n'), binding).reason, 'malformed-json');
});

test('fixed byte, line and event limits are enforced before JSON parsing', () => {
  const tooBig = parseCodexJsonl(new Uint8Array(JSONL_LIMITS.bytes + 1), binding);
  assert.equal(tooBig.reason, 'input-too-large');
  assert.equal(tooBig.inputDigest, null);
  assert.equal(parseCodexJsonl(Buffer.from('x'.repeat(JSONL_LIMITS.lineBytes + 1) + '\n'), binding).reason, 'line-too-large');
  assert.equal(parseCodexJsonl(Buffer.from('{}\n'.repeat(JSONL_LIMITS.events + 1)), binding).reason, 'too-many-events');
  assert.equal(parseCodexJsonl(Buffer.from('x'.repeat(JSONL_LIMITS.lineBytes) + '\n'), binding).reason, 'malformed-json');
  const many = [thread, start, ...Array.from({ length: JSONL_LIMITS.events - 3 }, () => ({ type: 'item.updated' })), done];
  assert.equal(parse(many).status, 'completed');
});

test('invalid trusted binding and nonbyte input are programmer errors', () => {
  assert.throws(() => parseCodexJsonl('text', binding), /bytes_required/);
  for (const context of [undefined, {}, { ...binding, attemptId: 1 }, { ...binding, attemptId: '' },
    { ...binding, requestDigest: 1 }, { ...binding, requestDigest: 'bad' },
    { ...binding, expectedThreadId: 1 }, { ...binding, expectedThreadId: 'unsafe\n' }]) {
    assert.throws(() => parseCodexJsonl(encode([thread, start, done]), context), /trusted_binding_invalid/);
  }
});
