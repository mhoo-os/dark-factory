import {readReviewPair} from './review-pair.ts';
import {handleChatLaneRequest} from './chat-lane-registry.ts';
const P='review-repair:v1:';
const sha=(x:unknown)=>typeof x==='string' && /^[a-f0-9]{40}$/.test(x);
const money=(x:unknown)=>Number.isSafeInteger(x) && Number(x)>=0;
const hash=async(x:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(x)))),b=>b.toString(16).padStart(2,'0')).join('');
type Run={run_id:string;contract_digest:string;repository:string;branch:string;base_sha:string;head_sha:string;pr_number:number;linear_identifier:string;lease_fence:number;factory_id:string;registry_version:string;registry_digest:string;registry_entry_version:string};
export type RepairLimits={mode:'synthetic-only';deadlineMs:number;costCapMicros:number;initialSpentMicros:number|null;roundCostMicros:number;maxRounds:number;requiredChecks:{name:string;producerId:number}[];trustedAuthors:{linear:string;github:string};authorizedBlockerIds:string[]};
type Plan={run:Run;limits:RepairLimits;assignmentId:string};
type CI={repository:string;prNumber:number;head:string;complete:boolean;required:{name:string;producerId:number}[];checks:{name:string;producerId:number;head:string;status:string;conclusion:string}[]};
export type SyntheticRepairAdapters={
  readHead:()=>Promise<string>; readCI:(head:string)=>Promise<CI>;
  readPair:Parameters<typeof readReviewPair>[1]['readPair'];
  repair:(claim:{claimId:string;head:string;blockerIds:string[];deadlineMs:number;costCapMicros:number;currentGrant:()=>Promise<boolean>})=>Promise<{head:string;resultDigest:string;processStopped:boolean}>;
  readAccounting:(claimId:string)=>Promise<number|null>;
};
const get=async(db:D1Database,runId:string,key:string)=>db.prepare('SELECT result_json FROM factory_steps WHERE run_id=? AND step_key=?').bind(runId,P+key).first<{result_json:string}>();
// Reuse the canonical run, STOP flag and all four reserved capacity domains.
const GUARD=`r.run_id=? AND r.contract_digest=? AND r.repository=? AND r.branch=? AND r.base_sha=? AND r.head_sha=? AND r.pr_number=? AND r.linear_identifier=?
 AND r.lease_fence=? AND r.current_state='running' AND r.lease_owner='workflow' AND julianday(r.lease_expires_at)>julianday(?)
 AND r.factory_id=? AND r.registry_version=? AND r.registry_digest=? AND r.registry_entry_version=?
 AND (SELECT value FROM control_flags WHERE key='stop')='false'
 AND EXISTS(SELECT 1 FROM factory_lease_reservations q WHERE q.reservation_id=r.lease_fence AND q.run_id=r.run_id)
 AND (SELECT COUNT(*) FROM factory_lease_members WHERE reservation_id=r.lease_fence)=4
 AND (SELECT COUNT(*) FROM factory_lease_members m JOIN factory_leases l ON l.lease_key=m.lease_key
 WHERE m.reservation_id=r.lease_fence AND l.dispatch_id=r.run_id AND l.owner='workflow'
 AND l.factory_id=r.factory_id AND l.registry_version=r.registry_version AND l.registry_digest=r.registry_digest
 AND l.registry_entry_version=r.registry_entry_version AND julianday(l.expires_at)>julianday(?)
 AND l.lease_key IN ('global:1','factory:'||r.factory_id||':1','repository:'||r.repository||':1','collision:'||r.collision_group||':1'))=4`;
const bind=(p:Plan,head:string,now:number)=>{const r=p.run;return [r.run_id,r.contract_digest,r.repository,r.branch,r.base_sha,head,r.pr_number,r.linear_identifier,r.lease_fence,new Date(now).toISOString(),r.factory_id,r.registry_version,r.registry_digest,r.registry_entry_version,new Date(now).toISOString()];};
async function write(db:D1Database,p:Plan,key:string,value:unknown,head:string,now:number,extra='',params:unknown[]=[]){
  if(now>=p.limits.deadlineMs)return false;
  const result=await db.prepare(`INSERT INTO factory_steps(run_id,step_key,status,result_json,updated_at,factory_id,registry_version,registry_digest,registry_entry_version)
 SELECT r.run_id,?,'synthetic',?,?,r.factory_id,r.registry_version,r.registry_digest,r.registry_entry_version FROM factory_runs r WHERE ${GUARD}
 AND NOT EXISTS(SELECT 1 FROM factory_steps WHERE run_id=r.run_id AND step_key=?) ${extra}`).bind(P+key,JSON.stringify(value),new Date(now).toISOString(),...bind(p,head,now),P+key,...params).run();
  return result.meta.changes===1;
}
/** Only the trusted Workflow supplies original limits/accounting. No budget is
 * inferred from a review packet, candidate usage, missing receipt, or token count.
 */
export async function reserveSyntheticRepairPlan(db:D1Database,runId:string,assignmentId:string,input:RepairLimits,now=Date.now()){
  const limits=structuredClone(input);
  if(limits.mode!=='synthetic-only'||!Number.isSafeInteger(limits.maxRounds)||limits.maxRounds<1||limits.maxRounds>3
    ||!money(limits.costCapMicros)||!money(limits.initialSpentMicros)||!money(limits.roundCostMicros)||limits.roundCostMicros<1
    ||Number(limits.initialSpentMicros)+limits.roundCostMicros>limits.costCapMicros||!Number.isSafeInteger(limits.deadlineMs)||limits.deadlineMs<=now
    ||!Array.isArray(limits.requiredChecks)||!limits.requiredChecks.length||limits.requiredChecks.length>32
    ||limits.requiredChecks.some(c=>!c.name||!Number.isSafeInteger(c.producerId)||c.producerId<1)
    ||new Set(limits.requiredChecks.map(c=>c.name)).size!==limits.requiredChecks.length)throw Error('repair_limits_unverified');
  const schema=await db.prepare("SELECT schema_version FROM factory_schema_meta WHERE schema_name='review-repair-receipts'").first<{schema_version:number}>();
  if(schema?.schema_version!==1)throw Error('repair_schema_unverified');
  const run=await db.prepare('SELECT run_id,contract_digest,repository,branch,base_sha,head_sha,pr_number,linear_identifier,lease_fence,factory_id,registry_version,registry_digest,registry_entry_version FROM factory_runs WHERE run_id=?').bind(runId).first<Run>();
  if(!run||!sha(run.head_sha)||!sha(run.base_sha))throw Error('repair_run_invalid');
  const plan={run,limits,assignmentId};
  const old=await get(db,runId,'plan');
  if(old){const previous:Plan=JSON.parse(old.result_json);if(JSON.stringify(previous.limits)!==JSON.stringify(limits)||previous.assignmentId!==assignmentId||Object.keys(run).some(k=>k!=='head_sha'&&run[k as keyof Run]!==previous.run[k as keyof Run]))throw Error('repair_plan_conflict');return;}
  if(!await write(db,plan,'plan',plan,run.head_sha,now))throw Error('repair_grant_inactive');
}
function requireCI(p:Plan,head:string,ci:CI){
  if(ci.repository!==p.run.repository||ci.prNumber!==p.run.pr_number||ci.head!==head||ci.complete!==true
    ||JSON.stringify(ci.required)!==JSON.stringify(p.limits.requiredChecks)||!Array.isArray(ci.checks)||ci.checks.length>128)throw Error('repair_ci_unverified');
  for(const expected of p.limits.requiredChecks){const matches=ci.checks.filter(c=>c.name===expected.name);
    if(matches.length!==1||matches[0].producerId!==expected.producerId||matches[0].head!==head||matches[0].status!=='completed'||matches[0].conclusion!=='success')throw Error('repair_ci_unverified');}
}
const api=async(db:D1Database,path:string,payload:unknown)=>{const response=await handleChatLaneRequest(new Request('https://synthetic.invalid'+path,{method:'POST',body:JSON.stringify(payload)}),db);if(!response?.ok)throw Error('repair_review_lane_held');return response.json() as Promise<Record<string,unknown>>;};
/** Bounded Workflow composition over synthetic adapters, not a scheduler.
 * Each claim reserves its full round ceiling (repair AND re-review); unused cost
 * is not refunded into another attempt. Uncertain claims are never resent.
 */
export async function runSyntheticRepairLoop(db:D1Database,runId:string,adapters:SyntheticRepairAdapters,hold:(reason:string)=>Promise<void>,clock=Date.now){
  const disabled={liveExecutionAllowed:false,publicationAllowed:false,mergeAllowed:false};
  const stored=await get(db,runId,'plan');if(!stored)throw Error('repair_plan_missing');
  const p:Plan=JSON.parse(stored.result_json);const {limits:l}=p;let head=p.run.head_sha,assignmentId=p.assignmentId;
  const active=async()=>clock()<l.deadlineMs && Boolean(await db.prepare(`SELECT r.run_id FROM factory_runs r WHERE ${GUARD}`).bind(...bind(p,head,clock())).first());
  try{
    for(let round=1;round<=l.maxRounds;round++){
      const prior=await get(db,runId,'result:'+round);
      if(prior){const done=JSON.parse(prior.result_json);head=done.head;assignmentId=done.assignmentId;if(done.outcome==='human-review-ready'){requireCI(p,head,await adapters.readCI(head));if(await adapters.readHead()!==head||!await active())throw Error('repair_head_or_fence_changed');return {...disabled,outcome:done.outcome};}continue;}
      if(await get(db,runId,'claim:'+round))throw Error('repair_delivery_ambiguous');
      if(!await active())throw Error('repair_grant_inactive');
      const assignment=await db.prepare("SELECT assignment_json,request_digest,completion_manifest_json FROM chat_lane_assignments WHERE assignment_id=? AND status='COMPLETED'").bind(assignmentId).first<{assignment_json:string;request_digest:string;completion_manifest_json:string}>();
      if(!assignment?.completion_manifest_json)throw Error('repair_review_missing');
      const request=JSON.parse(assignment.assignment_json),receipt=JSON.parse(assignment.completion_manifest_json);
      if(request.canonical_run_id!==runId||request.canonical_fence!==p.run.lease_fence||request.contract_digest!==p.run.contract_digest||request.target_head_sha!==head||request.repository!==p.run.repository||request.pr_number!==p.run.pr_number||request.linear_issue_id!==p.run.linear_identifier)throw Error('repair_review_binding');
      const context={request,requestDigest:assignment.request_digest,trustedAuthors:l.trustedAuthors,currentHead:head,currentFence:p.run.lease_fence,currentRunId:runId,currentContractDigest:p.run.contract_digest,stopped:false,nowMs:clock(),deadlineMs:l.deadlineMs,completedRepairRounds:round-1,maxRepairRounds:l.maxRounds,remainingCostUsd:(l.costCapMicros-Number(l.initialSpentMicros)-(round-1)*l.roundCostMicros)/1e6,authorizedBlockerIds:l.authorizedBlockerIds};
      const pair=await readReviewPair(context,adapters);
      for(const key of ['request_digest','review_id','verdict','linear_output_url','github_output_url','linear_digest','github_digest'])if(pair[key as keyof typeof pair]!==receipt[key])throw Error('repair_review_receipt_changed');
      const ci=await adapters.readCI(head);requireCI(p,head,ci);
      if(await adapters.readHead()!==head||!await active())throw Error('repair_head_or_fence_changed');
      if(pair.verdict==='PASS'){const key='ready:'+await hash({head,reviewId:request.review_id});if(!await write(db,p,key,{head,ciDigest:await hash(ci),reviewId:request.review_id},head,clock())&&!await get(db,runId,key))throw Error('repair_grant_inactive');if(await adapters.readHead()!==head||!await active())throw Error('repair_head_or_fence_changed');return {...disabled,outcome:'human-review-ready'};}
      if(pair.repairDisposition!=='eligible-proposal')throw Error('repair_not_admissible');
      const claimId=await hash({runId,round,reviewId:request.review_id,head});
      const claim={claimId,round,head,reviewId:request.review_id,requestDigest:assignment.request_digest,ciDigest:await hash(ci),costReservationMicros:l.roundCostMicros,blockerIds:pair.blockerIds};
      const claimed=await write(db,p,'claim:'+round,claim,head,clock(),
        `AND (SELECT COUNT(*) FROM factory_steps WHERE run_id=r.run_id AND step_key GLOB 'review-repair:v1:claim:*')=?
         AND (SELECT COUNT(*) FROM factory_steps WHERE run_id=r.run_id AND step_key GLOB 'review-repair:v1:result:*')=?
         AND ?<=? AND NOT EXISTS(SELECT 1 FROM factory_steps WHERE run_id=r.run_id AND step_key GLOB 'review-repair:v1:claim:*' AND json_extract(result_json,'$.reviewId')=?)`,
        [round-1,round-1,Number(l.initialSpentMicros)+round*l.roundCostMicros,l.costCapMicros,request.review_id]);
      if(!claimed)throw Error('repair_claim_raced_or_exhausted');
      if(await adapters.readHead()!==head||!await active())throw Error('repair_head_or_fence_changed');
      let inFlight=true;let result;
      try{result=await adapters.repair({claimId,head,blockerIds:[...pair.blockerIds],deadlineMs:l.deadlineMs,costCapMicros:l.roundCostMicros,currentGrant:async()=>inFlight&&head===claim.head&&await active()});}
      finally{inFlight=false;}
      if(!sha(result.head)||result.head===head||typeof result.resultDigest!=='string'||!/^[a-f0-9]{64}$/.test(result.resultDigest)||result.processStopped!==true)throw Error('repair_result_unverified');
      const cost=await adapters.readAccounting(claimId);
      if(!money(cost)||Number(cost)>l.roundCostMicros)throw Error('repair_accounting_unknown_or_exhausted');
      const nextCI=await adapters.readCI(result.head);requireCI(p,result.head,nextCI);
      if(await adapters.readHead()!==result.head||!await active())throw Error('repair_head_or_fence_changed');
      // Synthetic trusted publisher readback only; candidate head alone cannot advance canonical head.
      const moved=await db.prepare(`UPDATE factory_runs AS r SET head_sha=? WHERE ${GUARD}`).bind(result.head,...bind(p,head,clock())).run();
      if(moved.meta.changes!==1)throw Error('repair_head_or_fence_changed');
      head=result.head;
      const nextRequest={...request,review_id:'MHOO-repair-'+claimId,prior_review_id:request.review_id,target_head_sha:head};
      const lane=await api(db,'/chat-lanes/lease',{lane_type:'review',idempotency_key:'repair-review:'+claimId,assignment:nextRequest});
      assignmentId=String(lane.assignment_id);
      await api(db,'/chat-lane-assignments/'+assignmentId,{lease_token:lane.lease_token,status:'PUBLISHING'});
      if(await adapters.readHead()!==head||!await active())throw Error('repair_head_or_fence_changed');
      requireCI(p,head,await adapters.readCI(head));
      const reviewed=await readReviewPair({...context,request:nextRequest,requestDigest:String(lane.request_digest),currentHead:head,nowMs:clock(),completedRepairRounds:round},adapters);
      const totalCost=await adapters.readAccounting(claimId);
      if(!money(totalCost)||Number(totalCost)<Number(cost)||Number(totalCost)>l.roundCostMicros)throw Error('repair_accounting_unknown_or_exhausted');
      if(await adapters.readHead()!==head||!await active())throw Error('repair_head_or_fence_changed');
      await api(db,'/chat-lane-assignments/'+assignmentId,{lease_token:lane.lease_token,status:'COMPLETED',...reviewed,output_digest:'sha256:'+await hash(reviewed),completion_manifest:{...nextRequest,...reviewed,verification:{method:'authenticated_operator_v1',attested_by:'synthetic-review-adapter',attested_at:new Date(clock()).toISOString()}}});
      requireCI(p,head,await adapters.readCI(head));
      const outcome=reviewed.verdict==='PASS'?'human-review-ready':'continue';
      if(!await write(db,p,'result:'+round,{outcome,head,assignmentId,claimId,resultDigest:result.resultDigest,ciDigest:await hash(nextCI),costMicros:totalCost},head,clock()))throw Error('repair_result_receipt_ambiguous');
      if(outcome==='human-review-ready')return {...disabled,outcome};
    }
    throw Error('repair_rounds_exhausted');
  }catch(error){const reason=error instanceof Error && /^repair_[a-z_]+$/.test(error.message)?error.message:'repair_adapter_ambiguous';await hold(reason);return {...disabled,outcome:'held',reason};}
}
