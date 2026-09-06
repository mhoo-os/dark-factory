import { createHash } from 'node:crypto';

// Acceptance contract only: these labels never execute commands or probe a host.
export const CONTAINMENT_CASES = Object.freeze([
  'auth-read', 'auth-write', 'auth-enumeration', 'symlink-escape', 'hardlink-escape',
  'path-replacement', 'parent-environment', 'parent-fds', 'parent-memory',
  'unix-sockets', 'ssh-agent', 'docker-socket', 'management-network',
  'repository-config', 'hooks', 'mcp', 'file-tools', 'browser-connectors',
  'detached-descendants', 'guest-teardown',
]);
export const FAKE_CANARY_DIGEST = createHash('sha256').update('MHO253_FAKE_CANARY_NOT_A_CREDENTIAL').digest('hex');

const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);

/** Pure synthetic evidence completeness check. A pass is never host attestation.
 * Missing, duplicated, foreign or malformed receipts fail closed; no raw canary,
 * command, stdout or credential fields are admitted into returned evidence.
 */
export function assessContainmentContract(receipts, binding) {
  if (!binding || Object.keys(binding).sort().join(',') !== 'environmentId,intentDigest,profileDigest'
    || !matches(/^disposable-[a-z0-9-]{1,80}$/, binding.environmentId)
    || !matches(/^[a-f0-9]{64}$/, binding.intentDigest) || !matches(/^[a-f0-9]{64}$/, binding.profileDigest)) {
    throw new Error('containment_binding_invalid');
  }
  const passed = new Set();
  let valid = Array.isArray(receipts) && receipts.length <= CONTAINMENT_CASES.length;
  if (valid) for (const r of receipts) {
    if (!r || Object.keys(r).sort().join(',') !== 'canaryDigest,caseId,environmentId,evidenceDigest,intentDigest,outcome,profileDigest,synthetic'
      || !CONTAINMENT_CASES.includes(r.caseId) || passed.has(r.caseId)
      || r.environmentId !== binding.environmentId || r.intentDigest !== binding.intentDigest
      || r.profileDigest !== binding.profileDigest || r.canaryDigest !== FAKE_CANARY_DIGEST
      || r.synthetic !== true || r.outcome !== 'pass' || !matches(/^[a-f0-9]{64}$/, r.evidenceDigest)) {
      valid = false;
      break;
    }
    passed.add(r.caseId);
  }
  return {
    syntheticContract: valid && passed.size === CONTAINMENT_CASES.length ? 'complete' : 'incomplete',
    missingCases: CONTAINMENT_CASES.filter(id => !passed.has(id)),
    invalidEvidence: !valid, containmentReadiness: 'UNPROVED',
    liveExecutionAllowed: false, publicationAllowed: false,
  };
}
