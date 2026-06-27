import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const url = process.env.AGENTBASE_SUPABASE_URL;
const key = process.env.AGENTBASE_SUPABASE_SERVICE_ROLE_KEY;
console.log('URL len:', url?.length, 'first 30:', url?.slice(0, 30));
console.log('KEY len:', key?.length, 'first 12:', key?.slice(0, 12), 'last 4:', key?.slice(-4));

const r = await fetch(`${url}/rest/v1/clients?select=id&limit=1`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});
console.log('GET /rest/v1/clients status:', r.status);
console.log('body:', (await r.text()).slice(0, 300));

// Also try without /rest/v1 — sometimes shorter keys are anon-only
const r2 = await fetch(`${url}/auth/v1/health`, {
  headers: { apikey: key },
});
console.log('GET /auth/v1/health status:', r2.status);
console.log('body:', (await r2.text()).slice(0, 200));
