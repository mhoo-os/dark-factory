/** Source-only adapter boundary. Trusted context comes from canonical readback,
 * never a provider packet. The returned repair proposal grants no execution.
 */
type Packet = {
  review_id: string; target_head_sha: string; repository: string; pr_number: number;
  linear_issue_id: string; request_digest: string; verdict: string;
  // Reader supplies authenticated provider metadata and fetched-byte digest;
  // never copy a claimed author or digest out of review prose.
  author_id: string; url: string; peer_url: string; digest: string;
  findings: { id: string; severity: string }[];
};
export type ReviewContext = {
  request: Record<string, unknown>; requestDigest: string;
  trustedAuthors: { linear: string; github: string };
  currentHead: string; currentFence: number; currentRunId: string; currentContractDigest: string;
  stopped: boolean; nowMs: number; deadlineMs: number;
  completedRepairRounds: number; maxRepairRounds: number;
  remainingCostUsd: number | null; authorizedBlockerIds: string[];
};
export function assessReviewPair(context: ReviewContext, pair: {linear: Packet; github: Packet}) {
  const {request:r,requestDigest, trustedAuthors:a} = context;
  const fail = (): never => { throw new Error('review_pair_refused'); };
  const isDigest=(v:unknown)=>typeof v==='string' && /^sha256:[a-f0-9]{64}$/.test(v);
  if (r.review_request_version!=="mho253-v1" || "verdict" in r) fail();
  if (!isDigest(requestDigest) || !a.linear || !a.github) fail();
  for (const [kind,p] of Object.entries(pair)) {
    if (!['linear','github'].includes(kind) || !p || !isDigest(p.digest)
      || p.author_id !== a[kind as 'linear'|'github'] || p.request_digest !== requestDigest
      || !['PASS','REQUEST CHANGES'].includes(p.verdict)) fail();
    for (const key of ['review_id','target_head_sha','repository','pr_number','linear_issue_id'] as const) if(p[key]!==r[key])fail();
    if (!Array.isArray(p.findings) || p.findings.length>32 || p.findings.some(f=>!f || typeof f.id!=='string'
      || !/^[A-Za-z0-9._-]{1,128}$/.test(f.id) || !['Critical','High','Medium','Low'].includes(f.severity))
      || new Set(p.findings.map(f=>f.id)).size!==p.findings.length) fail();
  }
  const {linear:l,github:g}=pair;
  if (!l || !g || l.verdict!==g.verdict || l.peer_url!==g.url || g.peer_url!==l.url
    || JSON.stringify(l.findings)!==JSON.stringify(g.findings)) fail();
  const gh=`https://github.com/${r.repository}/pull/${r.pr_number}#issuecomment-`;
  if (typeof g.url!=='string' || !g.url.startsWith(gh) || !/^[1-9][0-9]*$/.test(g.url.slice(gh.length))
    || typeof l.url!=='string' || !l.url.startsWith(`https://linear.app/mhoo/issue/${r.linear_issue_id}/`)
    || !/^https:\/\/linear\.app\/mhoo\/issue\/MHO-[1-9][0-9]*\/[A-Za-z0-9-]+#comment-[a-f0-9-]{36}$/.test(l.url))fail();
  if (l.verdict==='PASS' && l.findings.length)fail();
  const current=context.stopped===false && context.currentRunId===r.canonical_run_id
    && context.currentContractDigest===r.contract_digest && context.currentFence===r.canonical_fence && context.currentHead===r.target_head_sha
    && Number.isSafeInteger(context.nowMs) && Number.isSafeInteger(context.deadlineMs) && context.nowMs<context.deadlineMs;
  const budget=Number.isSafeInteger(context.completedRepairRounds) && context.completedRepairRounds>=0
    && Number.isSafeInteger(context.maxRepairRounds) && context.maxRepairRounds>=1 && context.maxRepairRounds<=3
    && context.completedRepairRounds<context.maxRepairRounds && typeof context.remainingCostUsd==='number'
    && Number.isFinite(context.remainingCostUsd) && context.remainingCostUsd>0;
  const blockers=l.findings.filter(f=>['Critical','High'].includes(f.severity));
  const inScope=blockers.every(f=>context.authorizedBlockerIds.includes(f.id));
  const repairProposal=current && budget && inScope && blockers.length>0 && l.verdict==='REQUEST CHANGES';
  return {verdict:l.verdict,request_digest:requestDigest,review_id:r.review_id,
    linear_output_url:l.url,github_output_url:g.url,linear_digest:l.digest,github_digest:g.digest,
    repairDisposition:repairProposal?'eligible-proposal':'hold-or-noop',
    blockerIds:repairProposal?blockers.map(f=>f.id):[],
    liveExecutionAllowed:false as const,publicationAllowed:false as const,mergeAllowed:false as const};
}

/** A trusted read-only provider adapter, supplied by Cloudflare. No implementation
 * of a real provider/client is installed here. Snapshot canonical context before
 * yielding so a delayed fetch cannot retarget the review or reset its budgets.
 */
export async function readReviewPair(context: ReviewContext, reader: {
  readPair(request: Record<string,unknown>, requestDigest: string): Promise<{linear:Packet;github:Packet}>;
}) {
  const snapshot=structuredClone(context);
  const pair=await reader.readPair(structuredClone(snapshot.request),snapshot.requestDigest);
  return assessReviewPair(snapshot,pair);
}
