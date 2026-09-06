import test from 'node:test';
import assert from 'node:assert/strict';
import { assessContainmentContract, CONTAINMENT_CASES, FAKE_CANARY_DIGEST } from '../native/containment-contract.mjs';

const binding=()=>({environmentId:'disposable-1',intentDigest:'a'.repeat(64),profileDigest:'b'.repeat(64)});
const evidence=()=>CONTAINMENT_CASES.map(caseId=>({...binding(),caseId,canaryDigest:FAKE_CANARY_DIGEST,evidenceDigest:'c'.repeat(64),outcome:'pass',synthetic:true}));
function unproved(result) {assert.equal(result.containmentReadiness,'UNPROVED');assert.equal(result.liveExecutionAllowed,false);assert.equal(result.publicationAllowed,false);}
test('complete synthetic matrix is completeness only and never host readiness',()=>{
  const result=assessContainmentContract(evidence(),binding());assert.equal(result.syntheticContract,'complete');assert.equal(result.invalidEvidence,false);assert.deepEqual(result.missingCases,[]);unproved(result);
  assert.equal(new Set(CONTAINMENT_CASES).size,CONTAINMENT_CASES.length);assert.ok(CONTAINMENT_CASES.includes('detached-descendants'));
  assert.throws(()=>CONTAINMENT_CASES.push('new'),TypeError);
});
test('empty and partial valid evidence enumerate missing cases',()=>{
  const empty=assessContainmentContract([],binding());assert.deepEqual(empty.missingCases,[...CONTAINMENT_CASES]);assert.equal(empty.invalidEvidence,false);unproved(empty);
  const partial=assessContainmentContract(evidence().slice(1),binding());assert.equal(partial.syntheticContract,'incomplete');assert.deepEqual(partial.missingCases,[CONTAINMENT_CASES[0]]);unproved(partial);
});
for(const bad of [null,undefined,[],{},'binding',{...binding(),extra:true},{...binding(),environmentId:'real-host'},{...binding(),intentDigest:'bad'},{...binding(),profileDigest:'bad'}])test('invalid binding '+JSON.stringify(bad),()=>assert.throws(()=>assessContainmentContract(evidence(),bad),/containment_binding_invalid/));
for(const bad of [null,{},'receipts',Array(21).fill(null)])test('malformed or oversized evidence fails closed '+JSON.stringify(bad),()=>{
  const result=assessContainmentContract(bad,binding());assert.equal(result.syntheticContract,'incomplete');assert.equal(result.invalidEvidence,true);unproved(result);
});
for(const [field,bad] of [['caseId','unknown'],['environmentId','disposable-other'],['intentDigest','d'.repeat(64)],['profileDigest','e'.repeat(64)],['canaryDigest','f'.repeat(64)],['synthetic',false],['synthetic','true'],['outcome','fail'],['evidenceDigest','bad']])test('reject foreign, real or tampered receipt '+field+' '+bad,()=>{
  const rows=evidence();rows[0][field]=bad;const result=assessContainmentContract(rows,binding());assert.equal(result.invalidEvidence,true);assert.equal(result.syntheticContract,'incomplete');unproved(result);
});
test('duplicate case never substitutes for missing independent proof',()=>{
  const rows=evidence();rows[1]=structuredClone(rows[0]);const result=assessContainmentContract(rows,binding());assert.equal(result.invalidEvidence,true);assert.ok(result.missingCases.includes(CONTAINMENT_CASES[1]));unproved(result);
});
for(const bad of [null,{},[],{...evidence()[0],stdout:'fake canary'},{...evidence()[0],command:'cat /auth'},{...evidence()[0],credential:'fake'}])test('raw or malformed evidence rejected '+JSON.stringify(bad),()=>{
  const rows=evidence();rows[0]=bad;const result=assessContainmentContract(rows,binding());assert.equal(result.invalidEvidence,true);assert.equal(JSON.stringify(result).includes('fake canary'),false);unproved(result);
});
test('missing field does not become successful attestation',()=>{
  const rows=evidence();delete rows[0].evidenceDigest;assert.equal(assessContainmentContract(rows,binding()).invalidEvidence,true);
});
