import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {reserveSyntheticRepairPlan,runSyntheticRepairLoop} from '../src/repair-continuation.ts';
import {handleChatLaneRequest} from '../src/chat-lane-registry.ts';
import {readReviewPair} from '../src/review-pair.ts';
const D='sha256:'+'b'.repeat(64),H='a'.repeat(40),P='review-repair:v1:';
class D1{constructor(raw){this.raw=raw;this.after=null;}prepare(sql){let args=[];const o=this;return{bind(...v){args=v;return this;},async first(){return o.raw.prepare(sql).get(...args)??null;},async all(){return{results:o.raw.prepare(sql).all(...args)};},async run(){o.before?.(sql,args);const r=o.raw.prepare(sql).run(...args);o.after?.(sql,args);return{meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}};}};}}
async function fixture(overrides={},passAt=1){
 const raw=new DatabaseSync(':memory:');
 for(const name of ['0001_factory.sql','0002_ingress-retry-state.sql','0003-state-history-and-active-issue.sql','0004-trusted-factory-registry.sql','0004_chat_lane_registry.sql','0005-runtime-capacity-leases.sql','0005_chat_lane_transition_guards.sql','0006_chat_lane_activation_guard.sql','0007_chat_lane_rollback_compatibility.sql','0008_native_candidate_receipts.sql','0009_review_result_receipts.sql','0010_repair_attempt_receipts.sql'])raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const db=new D1(raw),now=Date.now(),expiry=new Date(now+60000).toISOString();
 raw.prepare(`INSERT INTO factory_runs(dispatch_id,run_id,contract_digest,contract_json,linear_project_id,linear_issue_id,linear_identifier,repository,collision_group,base_sha,head_sha,pr_number,branch,current_state,lease_owner,lease_fence,lease_expires_at,factory_id,registry_version,registry_digest,registry_entry_version,created_at,updated_at)
 VALUES('dispatch','run',?,'{}','project','issue','MHO-253','mhoo-os/dark-factory','factory',?,?,34,'factory/test','running','workflow',1,?,'f','v1','rd','e',?,?)`).run(D,H,H,expiry,new Date(now).toISOString(),new Date(now).toISOString());
 raw.prepare("INSERT INTO factory_lease_reservations VALUES(1,'run',?)").run(new Date(now).toISOString());
 for(const key of ['global:1','factory:f:1','repository:mhoo-os/dark-factory:1','collision:factory:1']){raw.prepare('INSERT INTO factory_lease_members VALUES(1,?)').run(key);raw.prepare("INSERT INTO factory_leases(lease_key,owner,dispatch_id,fence,expires_at,factory_id,registry_version,registry_digest,registry_entry_version) VALUES(?,'workflow','run',1,?,'f','v1','rd','e')").run(key,expiry);}
 raw.exec("UPDATE chat_lanes SET chat_id='fake-review-chat',status='IDLE' WHERE lane_id='review-1'");
 const limits={mode:'synthetic-only',deadlineMs:now+30000,costCapMicros:1000,initialSpentMicros:100,roundCostMicros:200,maxRounds:3,requiredChecks:[{name:'test',producerId:1}],trustedAuthors:{linear:'l',github:'g'},authorizedBlockerIds:['fix'],...overrides};
 const state={head:H,repairs:0,passAt,holds:[],now};
 const adapters={readHead:async()=>state.head,readCI:async head=>({repository:'mhoo-os/dark-factory',prNumber:34,head,complete:true,required:limits.requiredChecks,checks:[{name:'test',producerId:1,head,status:'completed',conclusion:'success'}]}),
  readPair:async(request,requestDigest)=>{const verdict=state.repairs>=state.passAt?'PASS':'REQUEST CHANGES',l='https://linear.app/mhoo/issue/MHO-253/review#comment-00000000-0000-4000-8000-000000000001',g='https://github.com/mhoo-os/dark-factory/pull/34#issuecomment-'+(state.repairs+1),p={...request,request_digest:requestDigest,verdict,findings:verdict==='PASS'?[]:[{id:'fix',severity:'High'}],digest:D};return{linear:{...p,author_id:'l',url:l,peer_url:g},github:{...p,author_id:'g',url:g,peer_url:l}};},
  repair:async claim=>{assert.equal(await claim.currentGrant(),true);state.repairs++;state.head=String(state.repairs).repeat(40);return{head:state.head,resultDigest:'c'.repeat(64),processStopped:true};},readAccounting:async()=>50};
 const request={review_request_version:'mho253-v1',canonical_run_id:'run',canonical_fence:1,contract_digest:D,prior_review_id:null,repository:'mhoo-os/dark-factory',pr_number:34,linear_issue_id:'MHO-253',target_head_sha:H,review_id:'MHOO-initial-review'};
 const api=async(path,payload)=>{const r=await handleChatLaneRequest(new Request('https://fake.test'+path,{method:'POST',body:JSON.stringify(payload)}),db);assert.equal(r.ok,true);return r.json();};
 const lane=await api('/chat-lanes/lease',{lane_type:'review',idempotency_key:'initial',assignment:request});
 const context={request,requestDigest:lane.request_digest,trustedAuthors:limits.trustedAuthors,currentHead:H,currentRunId:'run',currentContractDigest:D,currentFence:1,stopped:false,nowMs:now,deadlineMs:limits.deadlineMs,completedRepairRounds:0,maxRepairRounds:3,remainingCostUsd:1,authorizedBlockerIds:['fix']};
 const paired=await readReviewPair(context,adapters);
 await api('/chat-lane-assignments/'+lane.assignment_id,{lease_token:lane.lease_token,status:'PUBLISHING'});
 await api('/chat-lane-assignments/'+lane.assignment_id,{lease_token:lane.lease_token,status:'COMPLETED',...paired,output_digest:D,completion_manifest:{...request,...paired,verification:{method:'authenticated_operator_v1',attested_by:'synthetic',attested_at:new Date(now).toISOString()}}});
 const reserve=()=>reserveSyntheticRepairPlan(db,'run',lane.assignment_id,limits,state.now);
 const hold=async reason=>{state.holds.push(reason);raw.exec("UPDATE factory_runs SET current_state='needs-human'");};
 const execute=()=>runSyntheticRepairLoop(db,'run',adapters,hold,()=>state.now);
 const count=kind=>raw.prepare('SELECT count(*) AS n FROM factory_steps WHERE step_key GLOB ?').get(P+kind+':*').n;
 return{raw,db,limits,state,adapters,reserve,execute,count};
}
const disabled=r=>{assert.equal(r.liveExecutionAllowed,false);assert.equal(r.publicationAllowed,false);assert.equal(r.mergeAllowed,false);};
test('complete synthetic repair -> new exact-head CI -> independent PASS -> durable replay',async()=>{
 const f=await fixture();await f.reserve();const r=await f.execute();assert.equal(r.outcome,'human-review-ready');disabled(r);assert.equal(f.state.repairs,1);assert.equal(f.count('claim'),1);assert.equal(f.count('result'),1);
 assert.equal(f.raw.prepare("SELECT COUNT(*) AS n FROM chat_lane_assignments WHERE status='COMPLETED'").get().n,2);
 assert.equal((await f.execute()).outcome,'human-review-ready');assert.equal(f.state.repairs,1);
 f.state.head='f'.repeat(40);assert.equal((await f.execute()).outcome,'held');
});
test('three-round ceiling persists across invocation, never resets after head or review change',async()=>{
 const f=await fixture();f.state.passAt=99;await f.reserve();assert.equal((await f.execute()).reason,'repair_rounds_exhausted');assert.equal(f.state.repairs,3);assert.equal(f.count('claim'),3);assert.equal(f.count('result'),3);await f.execute();assert.equal(f.state.repairs,3);
});
test('full cost reservations preserve original prior spend and tighter budget',async()=>{
 const f=await fixture({costCapMicros:500,roundCostMicros:300});f.state.passAt=99;await f.reserve();assert.equal((await f.execute()).outcome,'held');assert.equal(f.state.repairs,1);assert.equal(f.count('claim'),1);
});
for(const edit of [{initialSpentMicros:null},{costCapMicros:0},{roundCostMicros:0},{maxRounds:4},{maxRounds:0},{requiredChecks:[]},{requiredChecks:[{name:'test',producerId:0}]}])test('unverified original limits '+JSON.stringify(edit),async()=>{const f=await fixture(edit);await assert.rejects(f.reserve(),/repair_limits_unverified/);assert.equal(f.state.repairs,0);});
for(const mutate of [ci=>ci.complete=false,ci=>ci.head='wrong',ci=>ci.repository='other/repo',ci=>ci.prNumber=35,ci=>ci.required=[],ci=>ci.checks=[],ci=>ci.checks.push(ci.checks[0]),ci=>ci.checks[0].producerId=99,ci=>ci.checks[0].head='wrong',ci=>ci.checks[0].status='in_progress',ci=>ci.checks[0].conclusion='skipped',ci=>ci.checks[0].conclusion='failure'])test('required CI refusal '+mutate.toString(),async()=>{
 const f=await fixture();await f.reserve();const read=f.adapters.readCI;f.adapters.readCI=async head=>{const ci=await read(head);mutate(ci);return ci;};assert.equal((await f.execute()).reason,'repair_ci_unverified');assert.equal(f.state.repairs,0);assert.equal(f.count('claim'),0);
});
for(const mutation of ["UPDATE control_flags SET value='true'","UPDATE factory_runs SET lease_fence=2","UPDATE factory_runs SET registry_digest='changed'","DELETE FROM factory_leases WHERE lease_key='global:1'"])test('atomic admission refuses authority movement '+mutation,async()=>{
 const f=await fixture();await f.reserve();const read=f.adapters.readCI;f.adapters.readCI=async head=>{const ci=await read(head);f.raw.exec(mutation);return ci;};assert.equal((await f.execute()).outcome,'held');assert.equal(f.state.repairs,0);
});
test('racing admission creates at most one claim and one repair',async()=>{const f=await fixture();await f.reserve();const results=await Promise.all([f.execute(),f.execute()]);assert.equal(f.count('claim'),1);assert.ok(f.state.repairs<=1);results.forEach(disabled);});
for(const point of ['claim','result'])test('lost acknowledgment at '+point+' cannot resend',async()=>{
 const f=await fixture();await f.reserve();f.db.after=(sql,args)=>{if(args[0]===P+point+':1')throw Error('lost acknowledgment');};assert.equal((await f.execute()).outcome,'held');f.db.after=null;const before=f.state.repairs;await f.execute();assert.equal(f.state.repairs,before);assert.equal(f.count('claim'),1);
});
for(const cost of [null,201,-1])test('unknown or excessive attempt accounting holds '+cost,async()=>{const f=await fixture();await f.reserve();f.adapters.readAccounting=async()=>cost;assert.equal((await f.execute()).reason,'repair_accounting_unknown_or_exhausted');assert.equal(f.count('result'),0);await f.execute();assert.equal(f.state.repairs,1);});
test('failed new-head CI prevents re-review and canonical head advancement',async()=>{
 const f=await fixture();await f.reserve();const read=f.adapters.readCI;f.adapters.readCI=async head=>{const ci=await read(head);if(head!==H)ci.checks[0].conclusion='failure';return ci;};assert.equal((await f.execute()).reason,'repair_ci_unverified');assert.equal(f.raw.prepare('SELECT head_sha FROM factory_runs').get().head_sha,H);assert.equal(f.raw.prepare('SELECT count(*) AS n FROM chat_lane_assignments').get().n,1);
});
test('plan, claims and receipts are append-only; a new caller cannot enlarge budget',async()=>{
 const f=await fixture();await f.reserve();await f.reserve();f.limits.costCapMicros=9999;await assert.rejects(f.reserve(),/repair_plan_conflict/);await f.execute();
 for(const sql of ["UPDATE factory_steps SET result_json='{}' WHERE step_key LIKE 'review-repair:%'","DELETE FROM factory_steps WHERE step_key LIKE 'review-repair:%'","INSERT OR REPLACE INTO factory_steps SELECT * FROM factory_steps WHERE step_key LIKE 'review-repair:%'"])assert.throws(()=>f.raw.exec(sql),/repair_receipt_immutable/);
});
test('completed attempt cannot reuse its grant callback for a later round',async()=>{
 const f=await fixture();await f.reserve();let grant;const repair=f.adapters.repair;f.adapters.repair=async claim=>{grant=claim.currentGrant;return repair(claim);};await f.execute();assert.equal(await grant(),false);await f.reserve();
});
for(const edit of [{mode:'live'},{maxRounds:1.5},{costCapMicros:NaN},{initialSpentMicros:-1},{roundCostMicros:1.5},{deadlineMs:0},{deadlineMs:NaN},{requiredChecks:null},{requiredChecks:Array(33).fill({name:'x',producerId:1})},{requiredChecks:[{name:'',producerId:1}]},{requiredChecks:[{name:'x',producerId:1.5}]},{requiredChecks:[{name:'x',producerId:1},{name:'x',producerId:2}]}])test('invalid immutable grant '+JSON.stringify(edit),async()=>{const f=await fixture(edit);await assert.rejects(f.reserve(),/repair_limits_unverified/);});
test('initial independently stored PASS records exact CI without a repair',async()=>{const f=await fixture({},0);await f.reserve();assert.equal((await f.execute()).outcome,'human-review-ready');assert.equal(f.count('claim'),0);assert.equal(f.state.repairs,0);});
for(const sql of ["DELETE FROM factory_schema_meta WHERE schema_name='review-repair-receipts'","UPDATE factory_runs SET head_sha='bad'","UPDATE control_flags SET value='true'"])test('initialization gate '+sql,async()=>{const f=await fixture();f.raw.exec(sql);await assert.rejects(f.reserve());});
test('missing plan never invokes an adapter',async()=>{const f=await fixture();await assert.rejects(f.execute(),/repair_plan_missing/);assert.equal(f.state.repairs,0);});
test('expiry and scope refusal never claim a round',async()=>{for(const expire of [true,false]){const f=await fixture(expire?{}:{authorizedBlockerIds:[]});await f.reserve();if(expire)f.state.now=f.limits.deadlineMs;assert.equal((await f.execute()).outcome,'held');assert.equal(f.count('claim'),0);}});
for(const mutation of ["UPDATE chat_lane_assignments SET status='BLOCKED'","DROP TRIGGER review_request_no_rewrite; UPDATE chat_lane_assignments SET assignment_json=json_set(assignment_json,'$.canonical_run_id','other')","DROP TRIGGER review_result_no_rewrite; UPDATE chat_lane_assignments SET completion_manifest_json=json_set(completion_manifest_json,'$.linear_digest','wrong')"])test('completed review is required and bound '+mutation,async()=>{const f=await fixture();await f.reserve();f.raw.exec(mutation);assert.equal((await f.execute()).outcome,'held');assert.equal(f.count('claim'),0);});
for(const edit of [{head:null},{head:H},{resultDigest:'bad'},{processStopped:false}])test('invalid repair result is held '+JSON.stringify(edit),async()=>{const f=await fixture();await f.reserve();const repair=f.adapters.repair;f.adapters.repair=async c=>({...await repair(c),...edit});assert.equal((await f.execute()).reason,'repair_result_unverified');assert.equal(f.count('result'),0);});
test('post-repair head movement and second accounting ambiguity cannot complete',async()=>{
 for(const reason of ['head','accounting','lane']){const f=await fixture();await f.reserve();const repair=f.adapters.repair;let reads=0;
 f.adapters.repair=async c=>{const result=await repair(c);if(reason==='head')f.state.head='f'.repeat(40);if(reason==='lane')f.raw.exec("UPDATE chat_lanes SET status='BLOCKED' WHERE lane_id='review-1'");return result;};
 if(reason==='accounting')f.adapters.readAccounting=async()=>++reads===1?50:null;
 assert.equal((await f.execute()).outcome,'held');assert.equal(f.count('result'),0);
 }
});
for(const point of ['claim','head','result'])test('authority races SQL '+point,async()=>{const f=await fixture();await f.reserve();f.db.before=(sql,args)=>{if((point==='head'&&sql.startsWith('UPDATE factory_runs AS'))||(point!=='head'&&args[0]===P+point+':1'))f.raw.exec("UPDATE control_flags SET value='true'");};assert.equal((await f.execute()).outcome,'held');assert.equal(f.count('result'),0);});
for(const key of ['repository','pr_number','linear_issue_id'])test('paired review must select the canonical target '+key,async()=>{const f=await fixture();await f.reserve();f.raw.exec('DROP TRIGGER review_request_no_rewrite');f.raw.prepare("UPDATE chat_lane_assignments SET assignment_json=json_set(assignment_json,?,?)").run('$.'+key,'wrong');assert.equal((await f.execute()).reason,'repair_review_binding');assert.equal(f.state.repairs,0);});
test('PASS cannot survive STOP racing its durable CI receipt',async()=>{const f=await fixture({},0);await f.reserve();f.db.before=(sql,args)=>{if(String(args[0]).startsWith(P+'ready:'))f.raw.exec("UPDATE control_flags SET value='true'");};assert.equal((await f.execute()).outcome,'held');});
