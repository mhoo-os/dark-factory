import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildNativeLaunchPlan, requiredLaunchProfile, CLI_PIN, PROFILE_DIGEST } from '../native/launch-policy.mjs';

const NOW=1788609600000;
const hash=value=>createHash('sha256').update(value).digest('hex');
function input() {
  const intent={mode:'mock-only',attempt:0,attemptId:hash('run-1:native-candidate:v1:0'),deadlineMs:NOW+30000,requestDigest:'a'.repeat(64),mockPin:'ba81c1b65d13a573144acda2708f57d870eb176b647715b7d86c294d7f71ef88',run:{run_id:'run-1',dispatch_id:'dispatch-1',contract_digest:'sha256:'+'b'.repeat(64),linear_issue_id:'issue-1',linear_identifier:'MHO-253',repository:'mhoo-os/dark-factory',collision_group:'factory',base_sha:'c'.repeat(40),head_sha:null,branch:'factory/native',pr_number:null,lease_fence:1,factory_id:'factory-1',registry_version:'v1',registry_digest:'sha256:'+'d'.repeat(64),registry_entry_version:'entry-1'}};
  return {intent,expectedIntentDigest:hash(JSON.stringify(intent)),profile:requiredLaunchProfile(),model:'gpt-5.5',environmentId:'disposable-1',inheritedEnvironment:{},observation:{...CLI_PIN,executablePath:`/opt/mhoo/native/${CLI_PIN.version}/${CLI_PIN.platform}/${CLI_PIN.sha256}/codex`,isSymlink:false,profileDigest:PROFILE_DIGEST,profileWritable:false}};
}
const resign=value=>{value.expectedIntentDigest=hash(JSON.stringify(value.intent));return value;};

test('exact persisted PR32 NativeIntent yields a bound proposal with no execution or publication authority',()=>{
  const value=input(),plan=buildNativeLaunchPlan(value,NOW);
  assert.deepEqual(plan.intent,value.intent);assert.equal(plan.intentDigest,value.expectedIntentDigest);
  assert.equal(plan.liveExecutionAllowed,false);assert.equal(plan.publicationAllowed,false);
  assert.equal(plan.containmentReadiness,'UNPROVED');assert.equal(plan.usageAccounting,'UNKNOWN');
  assert.equal(plan.bounds.deadlineMs,value.intent.deadlineMs);assert.equal(plan.bounds.maxAttempts,1);
  assert.equal(plan.stdin.requestDigest,value.intent.requestDigest);
  assert.equal(plan.executable.sha256,CLI_PIN.sha256);assert.equal(plan.profileDigest,PROFILE_DIGEST);
  assert.deepEqual(plan.env,{HOME:'/work/home',CODEX_HOME:'/var/lib/mhoo-controller',TMPDIR:'/work/scratch',PATH:'/usr/bin:/bin'});
  assert.ok(plan.argv.includes('--ignore-user-config'));assert.ok(plan.argv.includes('--ignore-rules'));assert.ok(plan.argv.includes('--strict-config'));
  const {proposalDigest,...body}=plan;assert.equal(proposalDigest,hash(JSON.stringify(body)));
  value.intent.run.run_id='mutated';assert.equal(plan.intent.run.run_id,'run-1');
});
test('non-null exact head and PR identities are preserved',()=>{
  const value=input();value.intent.run.head_sha='e'.repeat(40);value.intent.run.pr_number=32;resign(value);
  const plan=buildNativeLaunchPlan(value,NOW);assert.equal(plan.intent.run.pr_number,32);assert.equal(plan.intent.run.head_sha,'e'.repeat(40));
});
test('required profile returns independent copies and pins remain frozen',()=>{
  const profile=requiredLaunchProfile();profile.filesystem[':root']='write';profile.network='allow';
  assert.equal(requiredLaunchProfile().filesystem[':root'],'deny');assert.equal(requiredLaunchProfile().network,'deny');
  assert.equal(PROFILE_DIGEST,hash(JSON.stringify(requiredLaunchProfile())));
  assert.throws(()=>{CLI_PIN.version='latest';},TypeError);
});
for(const bad of [null,[],{},'input'])test('reject malformed proposal input '+JSON.stringify(bad),()=>assert.throws(()=>buildNativeLaunchPlan(bad,NOW),/native_launch_policy_refused/));
for(const field of ['intent','expectedIntentDigest','profile','model','environmentId','observation','inheritedEnvironment'])test('reject missing '+field,()=>{
  const value=input();delete value[field];assert.throws(()=>buildNativeLaunchPlan(value,NOW),/native_launch_policy_refused/);
});
for(const location of ['root','intent','run','observation'])test('reject extra field at '+location,()=>{
  const value=input();(location==='root'?value:location==='run'?value.intent.run:value[location]).extra='unapproved';resign(value);
  assert.throws(()=>buildNativeLaunchPlan(value,NOW),/native_launch_policy_refused/);
});
for(const [field,bad] of [['mode','live'],['attempt',1],['attemptId','bad'],['attemptId','f'.repeat(64)],['requestDigest','bad'],['mockPin','bad'],['deadlineMs',NOW],['deadlineMs',NOW+30001],['deadlineMs',NaN],['deadlineMs',NOW+1.5]])test('reject signed invalid intent '+field+' '+bad,()=>{
  const value=input();value.intent[field]=bad;resign(value);assert.throws(()=>buildNativeLaunchPlan(value,NOW),/native_launch_policy_refused/);
});
for(const now of [NaN,Infinity,NOW+0.5])test('invalid clock '+now,()=>assert.throws(()=>buildNativeLaunchPlan(input(),now),/native_launch_policy_refused/));
test('expected digest cannot be substituted or replayed over mutated contents',()=>{
  for(const digest of ['invalid','0'.repeat(64)]){const value=input();value.expectedIntentDigest=digest;assert.throws(()=>buildNativeLaunchPlan(value,NOW),/native_launch_policy_refused/);}
  for(const field of ['deadlineMs','requestDigest']){const value=input();value.intent[field]=field==='deadlineMs'?NOW+20000:'e'.repeat(64);assert.throws(()=>buildNativeLaunchPlan(value,NOW),/native_launch_policy_refused/);}
});
for(const [field,bad] of [['run_id','bad space'],['base_sha','abc'],['head_sha','abc'],['contract_digest','b'.repeat(64)],['registry_digest','bad'],['repository','other/repo'],['branch','main'],['lease_fence',0],['lease_fence',1.5],['pr_number',0],['pr_number',1.5]])test('reject signed invalid canonical run '+field+' '+bad,()=>{
  const value=input();value.intent.run[field]=bad;if(field==='run_id')value.intent.attemptId=hash(bad+':native-candidate:v1:0');resign(value);
  assert.throws(()=>buildNativeLaunchPlan(value,NOW),/native_launch_policy_refused/);
});
for(const [field,bad] of [['version','latest'],['platform','linux-amd64'],['platform','unknown'],['sha256','e'.repeat(64)],['executablePath','/usr/local/bin/codex'],['isSymlink',true],['profileDigest','f'.repeat(64)],['profileWritable',true]])test('artifact observation refuses '+field,()=>{
  const value=input();value.observation[field]=bad;assert.throws(()=>buildNativeLaunchPlan(value,NOW),/native_launch_policy_refused/);
});
for(const key of ['OPENAI_API_KEY','CODEX_HOME','HOME','PATH','SSH_AUTH_SOCK','DOCKER_HOST','NODE_OPTIONS','HTTP_PROXY'])test('inherited environment refuses '+key,()=>{
  const value=input();value.inheritedEnvironment[key]='fake';assert.throws(()=>buildNativeLaunchPlan(value,NOW),/native_launch_policy_refused/);
});
for(const mutate of [p=>p.filesystem['/arbitrary']='write',p=>p.filesystem['/var/lib/mhoo-controller']='read',p=>p.filesystem['/run']='read',p=>p.extraTools='enabled',p=>p.hooks='enabled',p=>p.network='allow',p=>p.legacySandbox='workspace-write',p=>p.policySystem='legacy',p=>p.publisherCredentials='present'])test('closed profile rejects widening '+mutate.toString(),()=>{
  const value=input();mutate(value.profile);assert.throws(()=>buildNativeLaunchPlan(value,NOW),/native_launch_policy_refused/);
});
for(const [field,bad] of [['model','gpt-5.5;sh'],['environmentId','personal-home']])test('reject arbitrary '+field,()=>{
  const value=input();value[field]=bad;assert.throws(()=>buildNativeLaunchPlan(value,NOW),/native_launch_policy_refused/);
});

for (const field of ['requestDigest', 'mockPin']) {
  test('signed JSON intent rejects array digest: '+field, () => {
    const value=input(); value.intent[field]=[value.intent[field]]; resign(value);
    assert.throws(()=>buildNativeLaunchPlan(JSON.parse(JSON.stringify(value)),NOW),/native_launch_policy_refused/);
  });
}
for (const field of ['model', 'environmentId']) {
  test('JSON proposal rejects array selector: '+field, () => {
    const value=input(); value[field]=[value[field]];
    assert.throws(()=>buildNativeLaunchPlan(JSON.parse(JSON.stringify(value)),NOW),/native_launch_policy_refused/);
  });
}
test('signed JSON intent rejects array result head', () => {
  const value=input(); value.intent.run.head_sha=['e'.repeat(40)]; resign(value);
  assert.throws(()=>buildNativeLaunchPlan(JSON.parse(JSON.stringify(value)),NOW),/native_launch_policy_refused/);
});
