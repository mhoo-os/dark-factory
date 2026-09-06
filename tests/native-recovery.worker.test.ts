import { env } from "cloudflare:workers";
import { afterEach, beforeAll, expect, it } from "vitest";
import worker, { __TEST_ONLY__ as control } from "../src/index";
import { reserveMockAttempt, deliverMockAttempt } from "../src/native-candidate";
import m1 from "../migrations/0001_factory.sql?raw";
import m2 from "../migrations/0002_ingress-retry-state.sql?raw";
import m3 from "../migrations/0003-state-history-and-active-issue.sql?raw";
import m4 from "../migrations/0004-trusted-factory-registry.sql?raw";
import m5 from "../migrations/0005-runtime-capacity-leases.sql?raw";
import m8 from "../migrations/0008_native_candidate_receipts.sql?raw";

beforeAll(async()=>{
  for (const migration of [m1,m2,m3,m4,m5]) for (const sql of migration.split(/;\s*(?:\r?\n|$)/).map(x=>x.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
  // Preserve each trigger body as one D1 statement.
  for (const sql of m8.split(/END;|(?<=VALUES \('native-candidate-receipts',1\));/).map(x=>x.trim()).filter(Boolean)) {
    await env.DB.prepare(sql.includes('CREATE TRIGGER')?sql+'\nEND;':sql).run();
  }
});
afterEach(async()=>{ await env.DB.prepare('DELETE FROM factory_leases').run(); });
let sequence=0;
const limits={global:1,factory:1,repository:1,collision:1};
async function fixture() {
  const id='native-recovery-'+(++sequence), now=Date.now();
  await env.DB.prepare("UPDATE control_flags SET value='false' WHERE key='stop'").run();
  const run={run_id:id,dispatch_id:id,factory_id:'native',repository:'mhoo-os/dark-factory',collision_group:'native',registry_version:'v1',registry_digest:'digest',registry_entry_version:'1',lease_fence:null,created_at:new Date(now).toISOString()};
  await env.DB.prepare(`INSERT INTO factory_runs(dispatch_id,run_id,contract_digest,contract_json,linear_project_id,linear_issue_id,linear_identifier,repository,collision_group,base_sha,current_state,created_at,updated_at,branch,factory_id,registry_version,registry_digest,registry_entry_version)
    VALUES(?,?,?,'{}','project',?,'MHO-253',?,? ,?,'running',?,?,'factory/native',?,?,?,?)`).bind(id,id,'contract',id,run.repository,run.collision_group,'a'.repeat(40),run.created_at,run.created_at,run.factory_id,run.registry_version,run.registry_digest,run.registry_entry_version).run();
  const lease=await control.acquireLease(env.DB,run as never,limits);
  expect(lease).not.toBeNull();
  await env.DB.prepare("UPDATE factory_runs SET lease_owner='workflow',lease_fence=?,lease_expires_at=? WHERE run_id=?").bind(lease!.fence,lease!.expiresAt,id).run();
  const intent=await reserveMockAttempt(env.DB,{runId:id,contractDigest:'contract',expectedHeadSha:'a'.repeat(40),requestDigest:'b'.repeat(64),deadlineMs:now+30000},now);
  const held={...run,lease_fence:lease!.fence};
  const expire=async()=>{await env.DB.prepare("UPDATE factory_leases SET expires_at=? WHERE dispatch_id=?").bind(new Date(0).toISOString(),id).run();await env.DB.prepare("UPDATE factory_runs SET lease_expires_at=? WHERE run_id=?").bind(new Date(0).toISOString(),id).run();};
  // Test-only cleanup of capacity; immutable native evidence stays in the DB.
  const cleanup=async()=>{await env.DB.prepare('DELETE FROM factory_leases WHERE dispatch_id=?').bind(id).run();};
  return {id,intent,held,expire,cleanup,now};
}
const candidate={status:'candidate' as const,resultDigest:'c'.repeat(64),headSha:'d'.repeat(40),processStopped:true,usage:null,usageStatus:'UNKNOWN' as const};

it('canonical candidate readback parks unknown accounting once, keeps receipt and all capacity',async()=>{
  const f=await fixture();
  const delivered=await control.deliverAndReconcileNativeMock(env.DB,f.intent,async()=>candidate,async()=>true,()=>f.now);
  expect(delivered).toMatchObject({canonicalDisposition:'needs-human',publicationAllowed:false});
  expect(await control.reconcileNativeAttempt(env.DB,f.id)).toBe('needs-human');
  expect(await control.reconcileNativeAttempt(env.DB,f.id)).toBe('needs-human');
  const row=await env.DB.prepare('SELECT current_state,lease_fence,result_json FROM factory_runs WHERE run_id=?').bind(f.id).first();
  expect(row).toMatchObject({current_state:'needs-human',lease_fence:f.held.lease_fence});
  expect(JSON.parse(row!.result_json as string)).toMatchObject({reason:'native_accounting_unverified',publication_allowed:false,usage_status:'UNKNOWN'});
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM factory_transitions WHERE dispatch_id=?').bind(f.id).first()).toMatchObject({n:1});
  await expect(control.releaseLease(env.DB,f.held as never)).rejects.toThrow('native_capacity_held');
  await f.expire();
  expect(await control.acquireLease(env.DB,f.held as never,limits)).toBeNull();
  await env.DB.prepare("INSERT INTO factory_runs(dispatch_id,run_id,contract_digest,contract_json,linear_project_id,linear_issue_id,linear_identifier,repository,collision_group,base_sha,current_state,created_at,updated_at) SELECT 'replacement','replacement',contract_digest,contract_json,linear_project_id,'replacement','MHO-999',repository,collision_group,base_sha,'queued',created_at,updated_at FROM factory_runs WHERE run_id=?").bind(f.id).run();
  const replacement={...f.held,run_id:'replacement',dispatch_id:'replacement'};
  expect(await control.acquireLease(env.DB,replacement as never,limits)).toBeNull();
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM factory_leases WHERE dispatch_id=?').bind(f.id).first()).toMatchObject({n:4});
  await f.cleanup();
});
it('scheduled expiry recovery quarantines a lost launch acknowledgment without releasing capacity',async()=>{
  const f=await fixture();
  const bytes=JSON.stringify({attemptId:f.intent.attemptId,intentDigest:await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(f.intent))).then(b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join(''))});
  await env.DB.prepare("INSERT INTO factory_steps(run_id,step_key,status,result_json,updated_at) VALUES(?,'native-candidate:v1:launch','observation',?,?)").bind(f.id,bytes,new Date().toISOString()).run();
  await f.expire();
  await env.DB.prepare("UPDATE control_flags SET value='true' WHERE key='stop'").run();
  await worker.scheduled({} as never,env);
  await worker.scheduled({} as never,env);
  const row=await env.DB.prepare('SELECT current_state,result_json FROM factory_runs WHERE run_id=?').bind(f.id).first();
  expect(row!.current_state).toBe('needs-human');
  expect(JSON.parse(row!.result_json as string).reason).toBe('native_delivery_ambiguous');
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM factory_leases WHERE dispatch_id=?').bind(f.id).first()).toMatchObject({n:4});
  await f.cleanup();
});
it('unclaimed attempts retain ordinary recovery; stale fences and stopped runs cannot be retargeted',async()=>{
  expect(await control.reconcileNativeAttempt(env.DB,'missing')).toBe('unclaimed');
  const f=await fixture();
  expect(await control.reconcileNativeAttempt(env.DB,f.id)).toBe('unclaimed');
  await deliverMockAttempt(env.DB,f.intent,async()=>({...candidate,processStopped:false,status:'ambiguous'}),async()=>true,()=>f.now);
  await env.DB.prepare('UPDATE factory_runs SET lease_fence=lease_fence+1 WHERE run_id=?').bind(f.id).run();
  expect(await control.reconcileNativeAttempt(env.DB,f.id)).toBe('fenced');
  await env.DB.prepare("UPDATE factory_runs SET lease_fence=?,current_state='stopped' WHERE run_id=?").bind(f.held.lease_fence,f.id).run();
  expect(await control.reconcileNativeAttempt(env.DB,f.id)).toBe('state-held');
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM factory_transitions WHERE dispatch_id=?').bind(f.id).first()).toMatchObject({n:0});
  await f.cleanup();
});
it('expired unclaimed native intent follows the existing lease recovery path',async()=>{
  const f=await fixture(); await f.expire();
  await env.DB.prepare("UPDATE control_flags SET value='true' WHERE key='stop'").run();
  await worker.scheduled({} as never,env);
  expect(await env.DB.prepare('SELECT current_state,lease_fence FROM factory_runs WHERE run_id=?').bind(f.id).first()).toMatchObject({current_state:'needs-human',lease_fence:null});
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM factory_leases WHERE dispatch_id=?').bind(f.id).first()).toMatchObject({n:0});
});
it('composed failure readback binds the original run despite caller mutation',async()=>{
  const f=await fixture();
  const result=await control.deliverAndReconcileNativeMock(env.DB,f.intent,async()=>{
    f.intent.run.run_id='unrelated'; throw Error('private runner error');
  },async()=>true,()=>f.now);
  expect(result).toMatchObject({disposition:'quarantined',canonicalDisposition:'needs-human',publicationAllowed:false});
  const row=await env.DB.prepare('SELECT current_state,result_json FROM factory_runs WHERE run_id=?').bind(f.id).first();
  expect(row!.current_state).toBe('needs-human');
  expect(JSON.parse(row!.result_json as string).reason).toBe('native_stop_unconfirmed');
  expect(row!.result_json).not.toContain('private runner error');
});
it('repair claims retain shared capacity through release and scheduled expiry',async()=>{
  const f=await fixture();
  await env.DB.prepare("INSERT INTO factory_steps(run_id,step_key,status,result_json,updated_at) VALUES(?,'review-repair:v1:claim:1','synthetic','{}',?)").bind(f.id,new Date().toISOString()).run();
  await expect(control.releaseLease(env.DB,f.held as never)).rejects.toThrow('native_capacity_held');
  await f.expire();expect(await control.acquireLease(env.DB,f.held as never,limits)).toBeNull();
  await env.DB.prepare("UPDATE control_flags SET value='true' WHERE key='stop'").run();
  await worker.scheduled({} as never,env);
  expect(await env.DB.prepare('SELECT current_state,lease_fence FROM factory_runs WHERE run_id=?').bind(f.id).first()).toMatchObject({current_state:'needs-human',lease_fence:f.held.lease_fence});
  expect(await env.DB.prepare('SELECT count(*) AS n FROM factory_leases WHERE dispatch_id=?').bind(f.id).first()).toMatchObject({n:4});
});
