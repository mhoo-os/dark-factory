import { createHash } from 'node:crypto';

export const JSONL_LIMITS = Object.freeze({ bytes: 65536, lineBytes: 8192, events: 256 });
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ITEMS = new Set(['item.started', 'item.updated', 'item.completed']);

/** Pure, synthetic grammar, not the complete official Codex 0.145 event contract:
 * thread.started{thread_id} -> turn.started -> item.* (zero or more) ->
 * exactly one turn.completed{usage?}, turn.failed{error?:{code?}}, or error{code?}.
 * Every event occupies one nonempty UTF-8 JSON line, including a final newline.
 * Only allowance_exhausted is recognized as a synthetic needs-human error code.
 * Item contents and error messages are discarded. No model field supplies an
 * attempt identity, commit, permission, billing value, or permission to retry.
 * Oversize bytes are rejected before hashing, so their inputDigest is null.
 */
export function parseCodexJsonl(bytes, { attemptId, requestDigest, expectedThreadId } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes_required');
  if (typeof attemptId !== 'string' || !ID.test(attemptId) ||
      typeof requestDigest !== 'string' || !DIGEST.test(requestDigest) ||
      (expectedThreadId !== undefined && (typeof expectedThreadId !== 'string' || !ID.test(expectedThreadId)))) {
    throw new TypeError('trusted_binding_invalid');
  }
  const result = {
    attemptId, requestDigest, inputDigest: null, providerThreadId: null,
    status: 'ambiguous', reason: 'incomplete', tokenUsage: null,
    usageStatus: 'UNKNOWN', billingStatus: 'UNKNOWN',
    publicationAllowed: false, liveExecutionAllowed: false,
  };
  const reject = reason => ({ ...result, status: 'ambiguous', reason, tokenUsage: null, usageStatus: 'UNKNOWN' });
  if (bytes.byteLength > JSONL_LIMITS.bytes) return reject('input-too-large');
  // Snapshot the bounded input so parsing and digest refer to the same bytes.
  const snapshot = Uint8Array.from(bytes);
  result.inputDigest = createHash('sha256').update(snapshot).digest('hex');
  if (!snapshot.length || snapshot[snapshot.length - 1] !== 10) return reject('truncated');
  let lineLength = 0;
  let events = 0;
  for (const byte of snapshot) {
    if (byte === 10) {
      if (++events > JSONL_LIMITS.events) return reject('too-many-events');
      if (!lineLength) return reject('empty-line');
      lineLength = 0;
    } else if (++lineLength > JSONL_LIMITS.lineBytes) return reject('line-too-large');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(snapshot); }
  catch { return reject('invalid-utf8'); }
  let state = 'thread';
  for (const line of text.slice(0, -1).split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { return reject('malformed-json'); }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') return reject('invalid-event');
    if (state === 'terminal') return reject('event-after-terminal');
    if (state === 'thread') {
      if (event.type !== 'thread.started' || typeof event.thread_id !== 'string' || !ID.test(event.thread_id)) return reject('thread-start-required');
      result.providerThreadId = event.thread_id;
      if (expectedThreadId !== undefined && event.thread_id !== expectedThreadId) return reject('thread-mismatch');
      state = 'turn';
    } else if (state === 'turn') {
      if (event.type !== 'turn.started') return reject('turn-start-required');
      state = 'items';
    } else if (ITEMS.has(event.type)) {
      // Raw item payloads have no authority and are never returned.
    } else if (event.type === 'turn.completed') {
      result.status = 'completed';
      result.reason = 'turn-completed';
      const usage = event.usage;
      if (usage && typeof usage === 'object' && !Array.isArray(usage) &&
          [usage.input_tokens, usage.cached_input_tokens, usage.output_tokens].every(value => Number.isSafeInteger(value) && value >= 0) &&
          usage.cached_input_tokens <= usage.input_tokens) {
        result.tokenUsage = { inputTokens: usage.input_tokens, cachedInputTokens: usage.cached_input_tokens, outputTokens: usage.output_tokens };
        result.usageStatus = 'OBSERVED';
      }
      state = 'terminal';
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      const code = event.type === 'error' ? event.code : event.error?.code;
      result.status = code === 'allowance_exhausted' ? 'needs-human' : 'failed';
      result.reason = code === 'allowance_exhausted' ? 'allowance-exhausted' : 'turn-failed';
      state = 'terminal';
    } else return reject(event.type === 'turn.interrupted' ? 'interrupted' : 'unexpected-event');
  }
  return state === 'terminal' ? result : reject('incomplete');
}
