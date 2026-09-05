import { test } from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, verify} from 'node:crypto';
import {githubInstallationToken} from '../src/github-app-auth.ts';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const env={GITHUB_APP_ID:'123',GITHUB_APP_INSTALLATION_ID:'456',GITHUB_APP_REPOSITORY:'mhoo-os/dark-factory',GITHUB_APP_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'})};
test('rejects wrong repository before network access, even with a legacy token',async()=>{
 await assert.rejects(githubInstallationToken({...env,GITHUB_TOKEN:'legacy'},'mhoo-os/other'),/repository_denied/);
});
test('requires explicit App configuration and PKCS8',async()=>{
 await assert.rejects(githubInstallationToken({},'mhoo-os/dark-factory'),/config_missing/);
 await assert.rejects(githubInstallationToken({...env,GITHUB_APP_PRIVATE_KEY:'invalid'},env.GITHUB_APP_REPOSITORY),/pkcs8/);
});
test('signs scoped JWT request and fails closed on response failures',async()=>{
 const original=globalThis.fetch;
 try {
 globalThis.fetch=async(url,options)=>{
 assert.equal(url,'https://api.github.com/app/installations/456/access_tokens');
 const parts=options.headers.Authorization.slice(7).split('.');
 assert.ok(verify('RSA-SHA256',Buffer.from(parts.slice(0,2).join('.')),publicKey,Buffer.from(parts[2],'base64url')));
 assert.equal(JSON.parse(Buffer.from(parts[1],'base64url')).iss,'123');
 assert.deepEqual(JSON.parse(options.body).repositories,['dark-factory']);
 return Response.json({token:'test-only',expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{contents:'write',pull_requests:'write',metadata:'read',checks:'read',statuses:'read'}});
 };
 assert.equal(await githubInstallationToken(env,env.GITHUB_APP_REPOSITORY),'test-only');
 globalThis.fetch=async()=>new Response('',{status:403});
 await assert.rejects(githubInstallationToken(env,env.GITHUB_APP_REPOSITORY),/failed_403/);
 globalThis.fetch=async()=>Response.json({token:'test-only',expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{administration:'write'}});
 await assert.rejects(githubInstallationToken(env,env.GITHUB_APP_REPOSITORY),/permissions_invalid/);
 globalThis.fetch=async()=>Response.json({token:'test-only',expires_at:'invalid'});
 await assert.rejects(githubInstallationToken(env,env.GITHUB_APP_REPOSITORY),/token_invalid/);
 } finally {globalThis.fetch=original;}
});
