type Config = object;
const api = 'https://api.github.com';
function required(env: Config, name: string): string {
  const value = Reflect.get(env, name);
  if (typeof value !== 'string' || !value.trim()) throw new Error(`github_app_config_missing_${name}`);
  return value;
}
function encoded(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
export async function githubInstallationToken(env: Config, repository: string): Promise<string> {
  // Never fall back to a personal token. Installation and repository are explicit.
  if (repository !== required(env, 'GITHUB_APP_REPOSITORY') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('github_app_repository_denied');
  const appId = required(env, 'GITHUB_APP_ID');
  const installationId = required(env, 'GITHUB_APP_INSTALLATION_ID');
  if (!/^\d+$/.test(appId) || !/^\d+$/.test(installationId)) throw new Error('github_app_identity_invalid');
  const pem = required(env, 'GITHUB_APP_PRIVATE_KEY');
  if (!pem.includes('-----BEGIN PRIVATE KEY-----')) throw new Error('github_app_key_requires_pkcs8');
  const der = Uint8Array.from(atob(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const now = Math.floor(Date.now()/1000);
  const input = encoded(new TextEncoder().encode(JSON.stringify({alg:'RS256',typ:'JWT'})))+'.'+encoded(new TextEncoder().encode(JSON.stringify({iat:now-60,exp:now+300,iss:appId})));
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(input));
  const response = await fetch(`${api}/app/installations/${installationId}/access_tokens`, {
    method:'POST', headers:{Authorization:`Bearer ${input}.${encoded(new Uint8Array(signature))}`,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},
    body:JSON.stringify({repositories:[repository.split('/')[1]],permissions:{contents:'write',pull_requests:'write',checks:'read',statuses:'read'}}),signal:AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`github_app_token_failed_${response.status}`);
  const result = await response.json() as {token?:unknown;expires_at?:string;permissions?:Record<string,string>};
  if (typeof result.token !== 'string' || !result.token || !result.expires_at || !(Date.parse(result.expires_at)>Date.now()+60000)) throw new Error('github_app_token_invalid');
  const allowed = new Set(['contents','pull_requests','checks','statuses','metadata']);
  if (!result.permissions || Object.entries(result.permissions).some(([name,value])=>!allowed.has(name)||(!['contents','pull_requests'].includes(name)&&value!=='read'))) throw new Error('github_app_permissions_invalid');
  return result.token;
}
