import test from 'node:test';
import assert from 'node:assert/strict';
import {assessReviewPair,readReviewPair} from '../src/review-pair.ts';
const h='sha256:'+'a'.repeat(64);
function fixture(){
 const request={review_request_version:'mho253-v1',review_id:'MHOO-review-one',target_head_sha:'b'.repeat(40),repository:'mhoo-os/dark-factory',pr_number:34,linear_issue_id:'MHO-253',canonical_run_id:'run-253',canonical_fence:4,contract_digest:h};
 const context={request,requestDigest:h,trustedAuthors:{linear:'l',github:'g'},currentHead:request.target_head_sha,currentFence:4,currentRunId:'run-253',currentContractDigest:h,stopped:false,nowMs:1,deadlineMs:2,completedRepairRounds:0,maxRepairRounds:3,remainingCostUsd:1,authorizedBlockerIds:['blocker']};
 const l='https://linear.app/mhoo/issue/MHO-253/review#comment-00000000-0000-4000-8000-000000000001',g='https://github.com/mhoo-os/dark-factory/pull/34#issuecomment-1';
 const p={...request,request_digest:h,verdict:'REQUEST CHANGES',digest:h,findings:[{id:'blocker',severity:'High'}]};
 return {context,pair:{linear:{...structuredClone(p),author_id:'l',url:l,peer_url:g},github:{...structuredClone(p),author_id:'g',url:g,peer_url:l}}};
}
const safe=r=>{assert.equal(r.liveExecutionAllowed,false);assert.equal(r.publicationAllowed,false);assert.equal(r.mergeAllowed,false);};
test('authorized High blocker proposes only within the original three-round ceiling',()=>{
 const {context,pair}=fixture();
 for(const round of [0,1,2]){context.completedRepairRounds=round;const result=assessReviewPair(context,pair);assert.equal(result.repairDisposition,'eligible-proposal');assert.deepEqual(result.blockerIds,['blocker']);safe(result);}
 context.completedRepairRounds=3;assert.equal(assessReviewPair(context,pair).repairDisposition,'hold-or-noop');
});
for(const edit of [{currentContractDigest:'wrong'},{stopped:true},{currentHead:'c'.repeat(40)},{currentFence:5},{currentRunId:'other'},{nowMs:2},{nowMs:NaN},{deadlineMs:NaN},{completedRepairRounds:-1},{completedRepairRounds:0.5},{maxRepairRounds:4},{maxRepairRounds:0},{maxRepairRounds:1.5},{maxRepairRounds:1,completedRepairRounds:1},{remainingCostUsd:null},{remainingCostUsd:0},{remainingCostUsd:Infinity},{authorizedBlockerIds:[]}])test('canonical hold '+JSON.stringify(edit),()=>{
 const {context,pair}=fixture();const result=assessReviewPair({...context,...edit},pair);assert.equal(result.repairDisposition,'hold-or-noop');assert.deepEqual(result.blockerIds,[]);safe(result);
});
for(const severity of ['Critical','Medium','Low'])test('exact severity '+severity,()=>{
 const {context,pair}=fixture();pair.linear.findings[0].severity=pair.github.findings[0].severity=severity;
 const result=assessReviewPair(context,pair);assert.equal(result.repairDisposition,severity==='Critical'?'eligible-proposal':'hold-or-noop');safe(result);
});
test('PASS or empty request-changes cannot request repair',()=>{
 for(const verdict of ['PASS','REQUEST CHANGES']){const {context,pair}=fixture();for(const p of Object.values(pair)){p.verdict=verdict;p.findings=[];}const result=assessReviewPair(context,pair);assert.equal(result.repairDisposition,'hold-or-noop');safe(result);}
});
for(const mutate of [
 f=>f.context.request.review_request_version='other',f=>f.context.request.verdict='PASS',f=>f.context.requestDigest='bad',f=>f.context.trustedAuthors.linear='',f=>f.context.trustedAuthors.github='',
 f=>f.pair.extra=f.pair.linear,f=>f.pair.linear=null,f=>f.pair.linear.digest='bad',f=>f.pair.linear.author_id='forged',f=>f.pair.github.author_id='forged',f=>f.pair.linear.request_digest='wrong',f=>f.pair.linear.verdict='maybe',
 ...['review_id','target_head_sha','repository','pr_number','linear_issue_id'].map(key=>f=>f.pair.linear[key]='wrong'),
 f=>f.pair.linear.findings=null,f=>f.pair.linear.findings=Array(33).fill({id:'a',severity:'High'}),f=>f.pair.linear.findings=[null],f=>f.pair.linear.findings=[{id:0,severity:'High'}],f=>f.pair.linear.findings=[{id:'bad space',severity:'High'}],f=>f.pair.linear.findings=[{id:'a',severity:'unknown'}],f=>f.pair.linear.findings.push(f.pair.linear.findings[0]),
 f=>delete f.pair.linear,f=>delete f.pair.github,f=>f.pair.github.verdict='PASS',f=>f.pair.linear.peer_url='wrong',f=>f.pair.github.peer_url='wrong',f=>f.pair.github.findings=[],
 f=>{f.pair.github.url=1;f.pair.linear.peer_url=1;},f=>{f.pair.github.url='https://github.com/other/repo/pull/34#issuecomment-1';f.pair.linear.peer_url=f.pair.github.url;},f=>{f.pair.github.url+='?extra';f.pair.linear.peer_url=f.pair.github.url;},
 f=>{f.pair.linear.url=1;f.pair.github.peer_url=1;},f=>{f.pair.linear.url='https://linear.app/mhoo/issue/MHO-999/review#comment-00000000-0000-4000-8000-000000000001';f.pair.github.peer_url=f.pair.linear.url;},f=>{f.pair.linear.url+='?extra';f.pair.github.peer_url=f.pair.linear.url;},
 f=>{f.pair.linear.verdict=f.pair.github.verdict='PASS';}
])test('reject malformed or untrusted pair '+mutate.toString(),()=>{const f=fixture();mutate(f);assert.throws(()=>assessReviewPair(f.context,f.pair),/review_pair_refused/);});

test('synthetic reader binds request and budgets before awaited readback',async()=>{
 const {context,pair}=fixture();
 const result=await readReviewPair(context,{readPair:async(request,digest)=>{
   assert.equal(request.review_id,context.request.review_id);assert.equal(digest,h);
   request.target_head_sha='retargeted';context.request.target_head_sha='also-retargeted';
   context.maxRepairRounds=99;return pair;
 }});
 assert.equal(result.repairDisposition,'eligible-proposal');safe(result);
});
