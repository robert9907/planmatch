// Audit probe: AgentBase client_medications / client_providers sync surface.
// Read-only. No writes. Reports schema, FK cascade, RLS, current row counts,
// and recent inserts. Targets AgentBase project (wyyasqvouvdcovttzfnv).

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const url = process.env.AGENTBASE_SUPABASE_URL ?? '';
const key = process.env.AGENTBASE_SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!url || !key) {
  console.error('Missing AGENTBASE_SUPABASE_URL or AGENTBASE_SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
console.log(`AgentBase URL: ${url}`);

const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function rpcSql<T = unknown>(query: string): Promise<T[] | null> {
  // Try the standard pg_meta-style RPC names some Supabase installs expose
  for (const fn of ['execute_sql', 'sql', 'pg_meta_query']) {
    const { data, error } = await sb.rpc(fn, { query });
    if (!error) return data as T[];
    if (error.code !== 'PGRST202' && error.code !== '42883') {
      console.warn(`RPC ${fn} returned error:`, error.code, error.message);
    }
  }
  return null;
}

async function main() {
  console.log('\n=== 1. Do the tables exist? ===');
  for (const t of ['clients', 'client_medications', 'client_providers', 'providers']) {
    const { error, count } = await sb.from(t).select('*', { count: 'exact', head: true });
    if (error) {
      console.log(`  ${t}: ERROR ${error.code} — ${error.message}`);
    } else {
      console.log(`  ${t}: exists, count=${count ?? '?'}`);
    }
  }

  console.log('\n=== 2. client_medications columns (sample 1 row to infer shape) ===');
  {
    const { data, error } = await sb.from('client_medications').select('*').limit(1);
    if (error) console.log('  ERROR:', error.message);
    else if (!data || data.length === 0) {
      console.log('  (table empty — selecting head:* anyway to see keys)');
      // PostgREST returns no rows but exposes columns through select error if asked for non-existent. Skip.
    } else {
      console.log('  columns:', Object.keys(data[0]).sort().join(', '));
      console.log('  sample row keys+types:');
      for (const [k, v] of Object.entries(data[0])) {
        console.log(`    ${k}: ${v === null ? 'null' : typeof v}`);
      }
    }
  }

  console.log('\n=== 3. client_providers columns ===');
  {
    const { data, error } = await sb.from('client_providers').select('*').limit(1);
    if (error) console.log('  ERROR:', error.message);
    else if (!data || data.length === 0) console.log('  (table empty)');
    else {
      console.log('  columns:', Object.keys(data[0]).sort().join(', '));
      for (const [k, v] of Object.entries(data[0])) {
        console.log(`    ${k}: ${v === null ? 'null' : typeof v}`);
      }
    }
  }

  console.log('\n=== 4. providers columns ===');
  {
    const { data, error } = await sb.from('providers').select('*').limit(1);
    if (error) console.log('  ERROR:', error.message);
    else if (!data || data.length === 0) console.log('  (table empty)');
    else {
      console.log('  columns:', Object.keys(data[0]).sort().join(', '));
    }
  }

  console.log('\n=== 5. Row counts ===');
  for (const t of ['clients', 'client_medications', 'client_providers', 'providers', 'planmatch_sessions']) {
    const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true });
    if (error) console.log(`  ${t}: ERROR ${error.message}`);
    else console.log(`  ${t}: ${count}`);
  }

  console.log('\n=== 6. Recent client_medications (last 10) ===');
  {
    const { data, error } = await sb
      .from('client_medications')
      .select('id, client_id, name, dose, rxcui, tier, synced_from_planmatch_at, created_at')
      .order('id', { ascending: false })
      .limit(10);
    if (error) console.log('  ERROR:', error.message);
    else for (const r of data ?? []) console.log(' ', JSON.stringify(r));
  }

  console.log('\n=== 7. Recent client_providers (last 10) ===');
  {
    const { data, error } = await sb
      .from('client_providers')
      .select('id, client_id, provider_id, last_known_network_status, last_known_plan_id, synced_from_planmatch_at')
      .order('id', { ascending: false })
      .limit(10);
    if (error) console.log('  ERROR:', error.message);
    else for (const r of data ?? []) console.log(' ', JSON.stringify(r));
  }

  console.log('\n=== 8. Recent planmatch_sessions (last 5) ===');
  {
    const { data, error } = await sb
      .from('planmatch_sessions')
      .select('id, session_token, status, received_at, linked_client_id')
      .order('received_at', { ascending: false })
      .limit(5);
    if (error) console.log('  ERROR:', error.message);
    else for (const r of data ?? []) console.log(' ', JSON.stringify(r));
  }

  console.log('\n=== 9. Per-client meds counts (top 10 most meds) ===');
  {
    const { data: meds, error } = await sb
      .from('client_medications')
      .select('client_id')
      .limit(5000);
    if (error) console.log('  ERROR:', error.message);
    else {
      const tally = new Map<number, number>();
      for (const r of meds ?? []) {
        tally.set(r.client_id as number, (tally.get(r.client_id as number) ?? 0) + 1);
      }
      const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      for (const [cid, n] of top) console.log(`  client_id=${cid}: ${n} meds`);
      console.log(`  distinct clients with meds: ${tally.size}`);
    }
  }

  console.log('\n=== 10. Per-client provider link counts (top 10) ===');
  {
    const { data: links, error } = await sb
      .from('client_providers')
      .select('client_id')
      .limit(5000);
    if (error) console.log('  ERROR:', error.message);
    else {
      const tally = new Map<number, number>();
      for (const r of links ?? []) {
        tally.set(r.client_id as number, (tally.get(r.client_id as number) ?? 0) + 1);
      }
      const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      for (const [cid, n] of top) console.log(`  client_id=${cid}: ${n} providers`);
      console.log(`  distinct clients with provider links: ${tally.size}`);
    }
  }

  console.log('\n=== 11. RLS / FK cascade — via pg_meta-style RPC (best effort) ===');
  const rlsRes = await rpcSql<{ relname: string; relrowsecurity: boolean }>(
    `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('client_medications','client_providers','clients','providers')`,
  );
  if (rlsRes) console.log('  RLS:', rlsRes);
  else console.log('  (no SQL RPC available — RLS check skipped; see notes)');

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
