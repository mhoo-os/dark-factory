import { createHash } from 'node:crypto';

// Discovery pin from the MHO-253 audit. Linux/guest pins remain unverified.
export const CLI_PIN = Object.freeze({
  version: '0.145.0', platform: 'darwin-arm64',
  sha256: '1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590',
});
const ROOT = '/opt/mhoo/native';
const WORKSPACE = '/work/candidate';
const AUTH = '/var/lib/mhoo-controller';
const DIGEST = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const digest = text => createHash('sha256').update(text).digest('hex');
const fail = () => { throw new Error('native_launch_policy_refused'); };
function keys(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...names].sort().join(',')) fail();
}
const text = value => typeof value === 'string' && /^[A-Za-z0-9_./:@-]{1,160}$/.test(value);

// Declarative acceptance requirements, NOT a rendered/installed Codex config.
// Future config rendering must prove every tool surface obeys these restrictions.
const PROFILE = {
  name: 'native-candidate-v1', policySystem: 'permission-profiles', approvalPolicy: 'never',
  legacySandbox: null, network: 'deny', extraTools: 'disabled', hooks: 'disabled',
  filesystem: { ':root': 'deny', ':minimal': 'read', [WORKSPACE]: 'write', '/work/scratch': 'write',
    [AUTH]: 'deny', '/proc': 'deny', '/run': 'deny', '/var/run': 'deny' },
  authMode: 'chatgpt', usageAccounting: 'UNKNOWN', publisherCredentials: 'absent',
};
export function requiredLaunchProfile() { return structuredClone(PROFILE); }
export const PROFILE_DIGEST = digest(JSON.stringify(PROFILE));

/** Pure proposal builder, never authorization or filesystem attestation.
 * intent is the exact PR32 persisted NativeIntent. expectedIntentDigest must come
 * from trusted Cloudflare readback, not candidate output. observation is supplied
 * by a future trusted artifact verifier; this function does not inspect a host.
 */
export function buildNativeLaunchPlan(input, now) {
  keys(input, ['intent', 'expectedIntentDigest', 'profile', 'model', 'environmentId', 'observation', 'inheritedEnvironment']);
  const { intent, observation, profile } = input;
  keys(intent, ['mode', 'attempt', 'attemptId', 'deadlineMs', 'requestDigest', 'mockPin', 'run']);
  const r = intent.run;
  keys(r, ['run_id','dispatch_id','contract_digest','linear_issue_id','linear_identifier','repository','collision_group',
    'base_sha','head_sha','branch','pr_number','lease_fence','factory_id','registry_version','registry_digest','registry_entry_version']);
  if (intent.mode !== 'mock-only' || intent.attempt !== 0 || !DIGEST.test(intent.attemptId)
    || intent.attemptId !== digest(r.run_id+':native-candidate:v1:0')
    || !DIGEST.test(intent.requestDigest) || !DIGEST.test(intent.mockPin)
    || !Number.isSafeInteger(now) || !Number.isSafeInteger(intent.deadlineMs)
    || intent.deadlineMs <= now || intent.deadlineMs > now+30_000
    || !DIGEST.test(input.expectedIntentDigest) || digest(JSON.stringify(intent)) !== input.expectedIntentDigest) fail();
  if (!Object.entries(r).filter(([k]) => !['head_sha','pr_number','lease_fence'].includes(k)).every(([,v]) => text(v))
    || !SHA.test(r.base_sha) || (r.head_sha !== null && !SHA.test(r.head_sha))
    || !/^sha256:[a-f0-9]{64}$/.test(r.contract_digest) || !/^sha256:[a-f0-9]{64}$/.test(r.registry_digest)
    || !/^mhoo-os\/[a-z0-9._-]+$/.test(r.repository) || !/^factory\/[a-z0-9-]+$/.test(r.branch)
    || !Number.isSafeInteger(r.lease_fence) || r.lease_fence < 1
    || (r.pr_number !== null && (!Number.isSafeInteger(r.pr_number) || r.pr_number < 1))) fail();
  // Exact policy bytes are intentionally conservative: no merge of caller rules.
  if (JSON.stringify(profile) !== JSON.stringify(PROFILE) || !/^gpt-[a-z0-9.-]{1,64}$/.test(input.model)
    || !/^disposable-[a-z0-9-]{1,80}$/.test(input.environmentId)) fail();
  keys(input.inheritedEnvironment, []);
  keys(observation, ['version','platform','sha256','executablePath','isSymlink','profileDigest','profileWritable']);
  const executablePath = `${ROOT}/${CLI_PIN.version}/${CLI_PIN.platform}/${CLI_PIN.sha256}/codex`;
  if (observation.version !== CLI_PIN.version || observation.platform !== CLI_PIN.platform
    || observation.sha256 !== CLI_PIN.sha256 || observation.executablePath !== executablePath
    || observation.isSymlink !== false || observation.profileDigest !== PROFILE_DIGEST || observation.profileWritable !== false) fail();
  const proposal = {
    kind: 'native-launch-proposal-v1', intentDigest: input.expectedIntentDigest,
    // Preserve canonical identity rather than issuing another run or attempt.
    intent: structuredClone(intent), environmentId: input.environmentId,
    executable: { path: executablePath, ...CLI_PIN }, profileDigest: PROFILE_DIGEST,
    argv: ['exec','--profile',PROFILE.name,'--ignore-user-config','--ignore-rules','--strict-config',
      '--ephemeral','--json','--color','never','--cd',WORKSPACE,'--model',input.model,'-'],
    env: { HOME: '/work/home', CODEX_HOME: AUTH, TMPDIR: '/work/scratch', PATH: '/usr/bin:/bin' },
    stdin: { mode: 'digest-bound-request', requestDigest: intent.requestDigest },
    bounds: { attempt: intent.attempt, maxAttempts: 1, deadlineMs: intent.deadlineMs, maxOutputBytes: 65536 },
    usageAccounting: 'UNKNOWN', containmentReadiness: 'UNPROVED',
    liveExecutionAllowed: false, publicationAllowed: false,
  };
  return { ...proposal, proposalDigest: digest(JSON.stringify(proposal)) };
}
