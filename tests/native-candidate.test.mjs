import test from 'node:test';
import { installNativeClock } from './helpers/native-clock.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { reserveMockAttempt, deliverMockAttempt, currentNativeGrant, readNativeAttempt } from '../src/native-candidate.ts';
import { runMockCandidate, MOCK_FIXTURE_SHA256 } from '../native/mock-codex-runner.mjs';

const NOW = Date.parse('2026-09-05T12:00:00.000Z');
const HEAD = 'a'.repeat(40);
const PREFIX = 'native-candidate:v1:';
const migrations = ['0001_factory.sql','0002_ingress-retry-state.sql','0003-state-history-and-active-issue.sql','0004-trusted-factory-registry.sql','0005-runtime-capacity-leases.sql','0008_native_candidate_receipts.sql'].map(name => readFileSync(new URL('../migrations/'+name, import.meta.url),'utf8'));
class D1 {
  constructor(raw) { this.raw=raw; this.before=null; this.after=null; }
  prepare(sql) {
    let args=[]; const owner=this;
    return {
      bind(...values) { args=values; return this; },
      async all() { return {results: owner.raw.prepare(sql).all(...args)}; },
      async first() { return owner.raw.prepare(sql).get(...args) ?? null; },
      async run() {
        owner.before?.(sql,args);
        const result=owner.raw.prepare(sql).run(...args);
        owner.after?.(sql,args);
        return {meta:{changes:result.changes}};
      },
    };
  }
}
function fixture() {
  const raw=new DatabaseSync(':memory:');
  for(const sql of migrations) raw.exec(sql);
  raw.prepare(`INSERT INTO factory_runs(dispatch_id,run_id,contract_digest,contract_json,linear_project_id,linear_issue_id,linear_identifier,repository,collision_group,base_sha,current_state,lease_fence,lease_expires_at,created_at,updated_at,lease_owner,branch,factory_id,registry_version,registry_digest,registry_entry_version)
    VALUES('dispatch-1','run-1','contract-1','{}','project-1','issue-1','MHO-253','mhoo-os/dark-factory','factory',?,'running',1,?,?,?,'workflow','factory/native','factory-1','v1','registry-digest','entry-1')`).run(HEAD,new Date(NOW+60_000).toISOString(),new Date(NOW).toISOString(),new Date(NOW).toISOString());
  raw.exec("INSERT INTO factory_lease_reservations(reservation_id,run_id,created_at) VALUES(1,'run-1','2026-09-05T12:00:00.000Z')");
  for(const key of ['global:1','factory:factory-1:1','repository:mhoo-os/dark-factory:1','collision:factory:1']) {
    raw.prepare("INSERT INTO factory_lease_members VALUES(1,?)").run(key);
    raw.prepare("INSERT INTO factory_leases(lease_key,owner,dispatch_id,fence,expires_at,factory_id,registry_version,registry_digest,registry_entry_version) VALUES(?,'workflow','run-1',0,?,'factory-1','v1','registry-digest','entry-1')").run(key,new Date(NOW+60_000).toISOString());
  }
  const db=new D1(raw);
  const request={runId:'run-1',contractDigest:'contract-1',expectedHeadSha:HEAD,requestDigest:'b'.repeat(64),deadlineMs:NOW+30_000};
  const reserve=()=>reserveMockAttempt(db,request,NOW);
  return {raw,db,request,reserve};
}
const candidate=()=>({status:'candidate',resultDigest:'c'.repeat(64),headSha:'d'.repeat(40),processStopped:true,usage:null,usageStatus:'UNKNOWN'});
const receipts=raw=>raw.prepare("SELECT result_json FROM factory_steps WHERE step_key LIKE ?").all(PREFIX+'receipt:%').map(row=>JSON.parse(row.result_json));
const deliver=(f,intent,runner=async()=>candidate(),revalidate=async()=>true,clock=()=>NOW)=>deliverMockAttempt(f.db,intent,runner,revalidate,clock);

test('persisted intent survives adapter recreation and identical reservation replay',async()=>{
  const f=fixture(), intent=await f.reserve();
  assert.deepEqual(await reserveMockAttempt(new D1(f.raw),f.request,NOW),intent);
  assert.equal(await currentNativeGrant(f.db,intent,NOW),true);
  assert.equal(f.raw.prepare('SELECT count(*) AS n FROM factory_steps').get().n,1);
  assert.equal(intent.attempt,0); assert.equal(intent.mode,'mock-only');
  assert.match(intent.attemptId,/^[0-9a-f]{64}$/);
});

test('concurrent delivery claims cross the runner boundary once and retain one receipt',async()=>{
  const f=fixture(), intent=await f.reserve(); let calls=0;
  const runner=async({checkCurrentGrant})=>{calls++; assert.equal(await checkCurrentGrant(),true); return {...candidate(),stdout:'never persist this'};};
  const results=await Promise.all([deliver(f,intent,runner),deliver(f,intent,runner)]);
  assert.equal(calls,1);
  assert.deepEqual(results.map(x=>x.disposition).sort(),['ambiguous-no-resend','mock-candidate-recorded']);
  assert.equal(results.every(x=>x.publicationAllowed===false),true);
  const [receipt]=receipts(f.raw); assert.equal(receipts(f.raw).length,1);
  assert.equal(receipt.result.usage,null); assert.equal(receipt.result.usageStatus,'UNKNOWN');
  assert.equal(receipt.publicationAllowed,false); assert.equal('stdout' in receipt.result,false);
  assert.equal((await deliver(f,intent,runner)).disposition,'ambiguous-no-resend'); assert.equal(calls,1);
});

for(const [field,value] of [['deadlineMs',NOW+20_000],['requestDigest','e'.repeat(64)]]) test('duplicate cannot change '+field,async()=>{
  const f=fixture(); await f.reserve();
  await assert.rejects(reserveMockAttempt(f.db,{...f.request,[field]:value},NOW),/native_intent_conflict/);
});
test('duplicate cannot acquire a new fence or mutate a stored intent',async()=>{
  const f=fixture(),intent=await f.reserve();
  await assert.rejects(currentNativeGrant(f.db,{...intent,deadlineMs:NOW+1},NOW),/native_intent_conflict/);
  f.raw.exec('UPDATE factory_runs SET lease_fence=2');
  await assert.rejects(f.reserve(),/native_intent_conflict/);
});

for(const request of [{requestDigest:'bad'},{expectedHeadSha:'bad'},{deadlineMs:NOW},{deadlineMs:NOW+30_001},{deadlineMs:NaN},{deadlineMs:NOW+0.5}]) test('invalid bounded request '+JSON.stringify(request),async()=>{
  const f=fixture(); await assert.rejects(reserveMockAttempt(f.db,{...f.request,...request},NOW),/native_request_invalid/);
});
for(const mutation of ["DELETE FROM factory_schema_meta WHERE schema_name='native-candidate-receipts'","UPDATE factory_schema_meta SET schema_version=2 WHERE schema_name='native-candidate-receipts'"]) test('schema guard '+mutation,async()=>{
  const f=fixture();f.raw.exec(mutation);await assert.rejects(f.reserve(),/native_schema_unverified/);
});
for(const mutation of ["DELETE FROM factory_lease_members; DELETE FROM factory_lease_reservations; DELETE FROM factory_runs","UPDATE factory_runs SET contract_digest='changed'","UPDATE factory_runs SET head_sha='changed'","UPDATE factory_runs SET base_sha='bad'","UPDATE factory_runs SET branch='main'","UPDATE factory_runs SET lease_fence=NULL","UPDATE factory_runs SET lease_fence=0"]) test('run binding guard '+mutation,async()=>{
  const f=fixture();f.raw.exec(mutation);await assert.rejects(f.reserve(),/native_run_binding_invalid/);
});

const staleMutations=[
  "UPDATE control_flags SET value='true'", "DELETE FROM control_flags", "UPDATE control_flags SET value='unknown'",
  "UPDATE factory_runs SET current_state='stopped'", "UPDATE factory_runs SET lease_owner='other'",
  "UPDATE factory_runs SET lease_expires_at='2026-09-05T12:00:00.000Z'",
  "DELETE FROM factory_lease_members; DELETE FROM factory_lease_reservations",
  "DELETE FROM factory_lease_members WHERE lease_key='global:1'", "DELETE FROM factory_leases WHERE lease_key='global:1'",
  "UPDATE factory_leases SET owner='other' WHERE lease_key='global:1'", "UPDATE factory_leases SET dispatch_id='other' WHERE lease_key='global:1'",
  "UPDATE factory_leases SET registry_digest='other' WHERE lease_key='global:1'", "UPDATE factory_leases SET registry_version='other' WHERE lease_key='global:1'",
  "UPDATE factory_leases SET factory_id='other' WHERE lease_key='global:1'", "UPDATE factory_leases SET registry_entry_version='other' WHERE lease_key='global:1'",
  "UPDATE factory_leases SET expires_at='2026-09-05T12:00:00.000Z' WHERE lease_key='global:1'",
  "UPDATE factory_lease_members SET lease_key='global:2' WHERE lease_key='global:1'",
];
for(const mutation of staleMutations) test('persisted authority refuses '+mutation,async()=>{
  const f=fixture(),intent=await f.reserve(); f.raw.exec(mutation);
  assert.equal(await currentNativeGrant(f.db,intent,NOW),false);
  let calls=0;assert.equal((await deliver(f,intent,async()=>{calls++;return candidate();})).disposition,'inactive');assert.equal(calls,0);
  const fresh=fixture();fresh.raw.exec(mutation);await assert.rejects(fresh.reserve(),/native_intent_conflict_or_inactive/);
});

test('deadline, external readback false and unavailable all refuse launch',async()=>{
  for(const [revalidate,clock] of [[async()=>true,()=>NOW+30_000],[async()=>false,()=>NOW],[async()=>{throw Error('private error');},()=>NOW]]) {
    const f=fixture(),intent=await f.reserve();assert.equal((await deliver(f,intent,async()=>{throw Error('must not run');},revalidate,clock)).disposition,'inactive');
    assert.equal(f.raw.prepare('SELECT count(*) AS n FROM factory_steps').get().n,1);
  }
});

for(const mutation of ["UPDATE control_flags SET value='true'","UPDATE factory_runs SET head_sha='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'","UPDATE factory_runs SET lease_fence=2","UPDATE factory_runs SET registry_digest='moved'"]) test('post-launch movement quarantines and keeps observation '+mutation,async()=>{
  const f=fixture(),intent=await f.reserve();
  const outcome=await deliver(f,intent,async()=>{f.raw.exec(mutation);return candidate();});
  assert.equal(outcome.disposition,'quarantined');assert.equal(outcome.publicationAllowed,false);
  assert.equal(receipts(f.raw)[0].result.status,'candidate');
});
test('post-launch expired or unavailable external authority quarantines',async()=>{
  for(const unavailable of [false,true]) {
    const f=fixture(),intent=await f.reserve();let completed=false;
    const outcome=await deliver(f,intent,async()=>{completed=true;return candidate();},async()=>{if(completed&&unavailable)throw Error('offline');return true;},()=>completed&&!unavailable?NOW+30_000:NOW);
    assert.equal(outcome.disposition,'quarantined');assert.equal(receipts(f.raw).length,1);
  }
});

for(const bad of [null, {status:'arbitrary'}, {resultDigest:'bad'}, {processStopped:'true'}, {headSha:'bad'}, {usage:0}, {usageStatus:'known'}, {headSha:null}, {processStopped:false}]) test('untrusted invalid observation becomes ambiguous '+JSON.stringify(bad),async()=>{
  const f=fixture(),intent=await f.reserve();
  assert.equal((await deliver(f,intent,async()=>bad===null?null:{...candidate(),...bad})).disposition,'quarantined');
  const receipt=receipts(f.raw)[0];assert.equal(receipt.result.usage,null);assert.equal(receipt.publicationAllowed,false);
});
for(const status of ['failed','ambiguous','cancelled','expired']) test('terminal '+status+' never enables publication',async()=>{
  const f=fixture(),intent=await f.reserve();assert.equal((await deliver(f,intent,async()=>({...candidate(),status,headSha:null}))).disposition,'quarantined');
  assert.equal(receipts(f.raw)[0].result.status,status);
});
test('runner exception is redacted and cannot trigger automatic resend',async()=>{
  const f=fixture(),intent=await f.reserve();let calls=0;
  const runner=async()=>{calls++;throw Error('Authorization: secret-token');};
  assert.equal((await deliver(f,intent,runner)).disposition,'quarantined');
  assert.equal((await deliver(f,intent,runner)).disposition,'ambiguous-no-resend');assert.equal(calls,1);
  const receipt=receipts(f.raw)[0];assert.equal(receipt.result.status,'ambiguous');assert.equal(JSON.stringify(receipt).includes('secret-token'),false);
});

for(const when of ['launch','before-receipt','after-receipt']) test('durable crash '+when+' never repeats execution',async()=>{
  const f=fixture(),intent=await f.reserve();let calls=0;
  const runner=async()=>{calls++;return candidate();};
  const hook=(sql,args)=>{if(sql.startsWith('INSERT INTO factory_steps')&&((when==='launch'&&args[0]===PREFIX+'launch')||(when!=='launch'&&args[0].startsWith(PREFIX+'receipt:'))))throw Error('simulated-crash');};
  f.db[when==='before-receipt'?'before':'after']=hook;
  await assert.rejects(deliver(f,intent,runner),/simulated-crash/);
  f.db.before=f.db.after=null;
  assert.equal((await deliver(f,intent,runner)).disposition,'ambiguous-no-resend');
  assert.equal(calls,when==='launch'?0:1);assert.equal(receipts(f.raw).length,when==='after-receipt'?1:0);
});

test('native receipts reject UPDATE, DELETE and changing ordinary key into native namespace',async()=>{
  const f=fixture(),intent=await f.reserve();await deliver(f,intent);
  for(const sql of ["UPDATE factory_steps SET result_json='{}' WHERE step_key LIKE 'native-candidate:%'","DELETE FROM factory_steps WHERE step_key LIKE 'native-candidate:%'"]){assert.throws(()=>f.raw.exec(sql),/native_candidate_receipt_immutable/);}
  f.raw.exec("INSERT INTO factory_steps(run_id,step_key,status,updated_at) VALUES('run-1','ordinary','done','now')");
  assert.throws(()=>f.raw.exec("UPDATE factory_steps SET step_key='native-candidate:v1:forged' WHERE step_key='ordinary'"),/native_candidate_receipt_immutable/);
  f.raw.exec("UPDATE factory_steps SET status='changed' WHERE step_key='ordinary'");f.raw.exec("DELETE FROM factory_steps WHERE step_key='ordinary'");
  assert.equal(receipts(f.raw).length,1);
});

test('INSERT OR REPLACE and conflict-update cannot rewrite a native receipt with recursive triggers disabled',async()=>{
  const f=fixture();await f.reserve(); f.raw.exec('PRAGMA recursive_triggers=OFF');
  for(const suffix of ['', ' ON CONFLICT(run_id,step_key) DO UPDATE SET result_json=excluded.result_json']) {
    const verb=suffix?'INSERT':'INSERT OR REPLACE';
    assert.throws(()=>f.raw.prepare(`${verb} INTO factory_steps(run_id,step_key,status,result_json,updated_at) VALUES('run-1',?,'forged','{}','now')${suffix}`).run(PREFIX+'intent'),/native_candidate_receipt_immutable/);
  }
  assert.notEqual(f.raw.prepare('SELECT result_json FROM factory_steps').get().result_json,'{}');
});

test('deadline crossing during trusted revalidation prevents the launch claim',async()=>{
  const f=fixture(),intent=await f.reserve();let now=NOW,calls=0;
  const result=await deliver(f,intent,async()=>{calls++;return candidate();},async()=>{now=NOW+30_000;return true;},()=>now);
  assert.equal(calls,0);assert.equal(result.publicationAllowed,false);
  assert.equal(f.raw.prepare("SELECT count(*) AS n FROM factory_steps WHERE step_key=?").get(PREFIX+'launch').n,0);
});

test('stop changed after preflight is checked inside the launch INSERT',async()=>{
  const f=fixture(),intent=await f.reserve();let calls=0;
  const result=await deliver(f,intent,async()=>{calls++;return candidate();},async()=>{f.raw.exec("UPDATE control_flags SET value='true'");return true;});
  assert.equal(calls,0);assert.equal(result.publicationAllowed,false);
});

test('caller mutation during await cannot retarget persisted intent',async()=>{
  const f=fixture(),intent=await f.reserve();const original=structuredClone(intent);
  const result=await deliver(f,intent,async()=>candidate(),async()=>{intent.run.base_sha='f'.repeat(40);return true;});
  assert.equal(result.disposition,'mock-candidate-recorded');assert.deepEqual(receipts(f.raw)[0].intent,original);
});

test('real disposable mock process produces a persisted pin-bound receipt through the D1 seam',{timeout:15000},async t=>{
  const clock=installNativeClock(t);
  const f=fixture(),now=Date.now();
  const expiry=new Date(now+60_000).toISOString();
  f.raw.prepare('UPDATE factory_runs SET lease_expires_at=?').run(expiry);
  f.raw.prepare('UPDATE factory_leases SET expires_at=?').run(expiry);
  const intent=await reserveMockAttempt(f.db,{...f.request,deadlineMs:now+2000},now);
  assert.equal(intent.mockPin,MOCK_FIXTURE_SHA256);
  const result=await deliverMockAttempt(f.db,intent,options=>runMockCandidate({...options,signal:clock.signal}),async()=>true);
  assert.equal(result.disposition,'mock-candidate-recorded');assert.equal(result.publicationAllowed,false);
  const [receipt]=receipts(f.raw);assert.equal(JSON.stringify(receipt.intent),JSON.stringify(intent));
  assert.equal(receipt.result.processStopped,true);assert.equal(receipt.result.usage,null);
  assert.equal(receipt.result.headSha,'f'.repeat(40));
  const launch=f.raw.prepare('SELECT result_json FROM factory_steps WHERE step_key=?').get(PREFIX+'launch').result_json;
  assert.equal(receipt.launchDigest,createHash('sha256').update(launch).digest('hex'));
  assert.equal(JSON.parse(launch).intentDigest,createHash('sha256').update(JSON.stringify(intent)).digest('hex'));
  assert.equal(JSON.parse(launch).attemptId,intent.attemptId);
});

for(const movement of ['stop','fence','deadline']) test('authority moving during FINAL trusted revalidation quarantines '+movement,async()=>{
  const f=fixture(),intent=await f.reserve();let completed=false,now=NOW;
  const result=await deliver(f,intent,async()=>{completed=true;return candidate();},async()=>{
    if(completed) {
      if(movement==='stop')f.raw.exec("UPDATE control_flags SET value='true'");
      if(movement==='fence')f.raw.exec('UPDATE factory_runs SET lease_fence=2');
      if(movement==='deadline')now=intent.deadlineMs;
    }
    return true;
  },()=>now);
  assert.equal(result.disposition,'quarantined');assert.equal(result.publicationAllowed,false);
  assert.equal(receipts(f.raw)[0].disposition,'quarantined');
  assert.equal(receipts(f.raw)[0].result.status,'candidate');
});

// Readback uses only persisted canonical bytes, including after caller loss.
test('native readback distinguishes absent, unclaimed and durable candidate',async()=>{
  const f=fixture(); assert.equal(await readNativeAttempt(f.db,'run-1'),null);
  const intent=await f.reserve(); assert.equal((await readNativeAttempt(f.db,'run-1')).claimed,false);
  const delivered=await deliver(f,intent); const observed=await readNativeAttempt(f.db,'run-1');
  assert.equal(observed.reason,'native_accounting_unverified');
  assert.equal(observed.receiptDigest,delivered.receiptDigest); assert.equal(observed.publicationAllowed,false);
  assert.equal(JSON.stringify(observed.intent),JSON.stringify(intent));
});
for (const status of ['failed','ambiguous']) test('native readback retains '+status+' hold',async()=>{
  const f=fixture(), intent=await f.reserve();
  await deliver(f,intent,async()=>({...candidate(),status,processStopped:status==='failed'}));
  assert.equal((await readNativeAttempt(f.db,'run-1')).reason,status==='failed'?'native_result_quarantined':'native_stop_unconfirmed');
});
test('lost result readback never guesses launch failure or permits resend',async()=>{
  const f=fixture(), intent=await f.reserve();
  f.db.after=(sql,args)=>{if(args[0]===PREFIX+'launch')throw Error('lost ack');};
  await assert.rejects(deliver(f,intent),/lost ack/); f.db.after=null;
  assert.equal((await readNativeAttempt(f.db,'run-1')).reason,'native_delivery_ambiguous');
});
for (const corruption of ['missing-intent','large-intent','wrong-run','wrong-attempt','bad-fence','bad-mode','wrong-launch','large-receipt','wrong-digest','wrong-binding','wrong-launch-digest','publication','bad-time','bad-disposition','bad-status','bad-result-digest','bad-stopped','bad-usage','bad-usage-status']) {
  test('corrupt canonical readback fails closed: '+corruption,async()=>{
    const f=fixture(), intent=await f.reserve(); await deliver(f,intent);
    // Deliberately corrupt a test-only database after removing its immutability
    // guard. Production guards remain unchanged and are tested above.
    f.raw.exec('DROP TRIGGER native_candidate_steps_no_update; DROP TRIGGER native_candidate_steps_no_delete');
    const row=f.raw.prepare("SELECT step_key,result_json FROM factory_steps WHERE step_key LIKE ?").get(PREFIX+'receipt:%');
    const receipt=JSON.parse(row.result_json);
    if(corruption==='missing-intent')f.raw.prepare('DELETE FROM factory_steps WHERE step_key=?').run(PREFIX+'intent');
    else if(corruption==='large-intent')f.raw.prepare('UPDATE factory_steps SET result_json=? WHERE step_key=?').run(' '.repeat(16385),PREFIX+'intent');
    else if(['wrong-run','wrong-attempt','bad-fence','bad-mode'].includes(corruption)) {
      if(corruption==='wrong-run')intent.run.run_id='other';
      if(corruption==='wrong-attempt')intent.attemptId='bad';
      if(corruption==='bad-fence')intent.run.lease_fence=0;
      if(corruption==='bad-mode')intent.mode='live';
      f.raw.prepare('UPDATE factory_steps SET result_json=? WHERE step_key=?').run(JSON.stringify(intent),PREFIX+'intent');
    } else if(corruption==='wrong-launch')f.raw.prepare('UPDATE factory_steps SET result_json=? WHERE step_key=?').run('{}',PREFIX+'launch');
    else if(corruption==='large-receipt')f.raw.prepare('UPDATE factory_steps SET result_json=? WHERE step_key=?').run(' '.repeat(32769),row.step_key);
    else if(corruption==='wrong-digest')f.raw.prepare('UPDATE factory_steps SET result_json=? WHERE step_key=?').run('{}',row.step_key);
    else {
      if(corruption==='wrong-binding')receipt.intent.run.run_id='other';
      if(corruption==='wrong-launch-digest')receipt.launchDigest='bad';
      if(corruption==='publication')receipt.publicationAllowed=true;
      if(corruption==='bad-time')receipt.observedAt='now';
      if(corruption==='bad-disposition')receipt.disposition='published';
      if(corruption==='bad-status')receipt.result.status='published';
      if(corruption==='bad-result-digest')receipt.result.resultDigest='bad';
      if(corruption==='bad-stopped')receipt.result.processStopped='true';
      if(corruption==='bad-usage')receipt.result.usage=0;
      if(corruption==='bad-usage-status')receipt.result.usageStatus='OBSERVED';
      const bytes=JSON.stringify(receipt), hash=createHash('sha256').update(bytes).digest('hex');
      f.raw.prepare('UPDATE factory_steps SET result_json=?,step_key=? WHERE step_key=?').run(bytes,PREFIX+'receipt:'+hash,row.step_key);
    }
    await assert.rejects(readNativeAttempt(f.db,'run-1'),/native_readback_invalid/);
  });
}
