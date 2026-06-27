// Read-only audit of AgentBase meds/providers surface. Loads the AGENTBASE
// service-role key from the agentbase-crm repo .env.local (the agent repo's
// key is stale/401).

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

function loadEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m) env[m[1]] = m[3];
  }
  return env;
}

const env = loadEnv('/Users/robertsimm/Documents/GitHub/agentbase-crm/.env.local');
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing keys in agentbase-crm/.env.local');
  process.exit(1);
}
console.log('AgentBase URL:', url);

const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  console.log('\n=== 1. Table existence + counts ===');
  for (const t of ['clients', 'client_medications', 'client_providers', 'providers', 'planmatch_sessions', 'leads']) {
    const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true });
    if (error) console.log(`  ${t}: ERROR ${error.code} ${error.message}`);
    else console.log(`  ${t}: rows=${count}`);
  }

  console.log('\n=== 2. client_medications column shape ===');
  {
    const { data, error } = await sb.from('client_medications').select('*').limit(1);
    if (error) console.log('ERROR:', error.message);
    else if (!data?.length) console.log('(empty table)');
    else for (const [k, v] of Object.entries(data[0])) console.log(`  ${k}: ${v === null ? 'null' : typeof v} (sample=${JSON.stringify(v)?.slice(0, 40)})`);
  }

  console.log('\n=== 3. client_providers column shape ===');
  {
    const { data, error } = await sb.from('client_providers').select('*').limit(1);
    if (error) console.log('ERROR:', error.message);
    else if (!data?.length) console.log('(empty table)');
    else for (const [k, v] of Object.entries(data[0])) console.log(`  ${k}: ${v === null ? 'null' : typeof v} (sample=${JSON.stringify(v)?.slice(0, 40)})`);
  }

  console.log('\n=== 4. providers column shape ===');
  {
    const { data, error } = await sb.from('providers').select('*').limit(1);
    if (error) console.log('ERROR:', error.message);
    else if (!data?.length) console.log('(empty)');
    else for (const [k, v] of Object.entries(data[0])) console.log(`  ${k}: ${v === null ? 'null' : typeof v}`);
  }

  console.log('\n=== 5. Recent client_medications (10) ===');
  {
    const { data, error } = await sb
      .from('client_medications')
      .select('id, client_id, name, dose, rxcui, tier, synced_from_planmatch_at, created_at')
      .order('id', { ascending: false })
      .limit(10);
    if (error) console.log('ERROR:', error.message);
    else for (const r of data ?? []) console.log(' ', JSON.stringify(r));
  }

  console.log('\n=== 6. Recent client_providers (10) ===');
  {
    const { data, error } = await sb
      .from('client_providers')
      .select('id, client_id, provider_id, last_known_network_status, last_known_plan_id, synced_from_planmatch_at, created_at')
      .order('id', { ascending: false })
      .limit(10);
    if (error) console.log('ERROR:', error.message);
    else for (const r of data ?? []) console.log(' ', JSON.stringify(r));
  }

  console.log('\n=== 7. Recent planmatch_sessions (5) — what landed via webhook ===');
  {
    const { data, error } = await sb
      .from('planmatch_sessions')
      .select('id, session_token, status, received_at, linked_client_id, medications, providers, raw_payload')
      .order('received_at', { ascending: false })
      .limit(5);
    if (error) console.log('ERROR:', error.message);
    else for (const r of data ?? []) {
      const meds = Array.isArray((r as any).medications) ? (r as any).medications : [];
      const provs = Array.isArray((r as any).providers) ? (r as any).providers : [];
      const rawAB = (r as any).raw_payload?.agentbase_client_id;
      console.log(`  id=${(r as any).id} token=${(r as any).session_token?.slice(0,20)}... status=${(r as any).status} received=${(r as any).received_at}`);
      console.log(`     linked_client_id=${(r as any).linked_client_id} (raw_payload.agentbase_client_id=${rawAB})`);
      console.log(`     medications jsonb len=${meds.length} sample=${meds.length ? JSON.stringify(meds[0]).slice(0,160) : '(empty)'}`);
      console.log(`     providers jsonb len=${provs.length} sample=${provs.length ? JSON.stringify(provs[0]).slice(0,160) : '(empty)'}`);
    }
  }

  console.log('\n=== 8. Sync stamp coverage ===');
  {
    const { data: meds } = await sb.from('client_medications').select('client_id, synced_from_planmatch_at').limit(5000);
    const medTally = new Map<number, number>();
    let medsSynced = 0;
    for (const r of meds ?? []) {
      medTally.set(r.client_id as number, (medTally.get(r.client_id as number) ?? 0) + 1);
      if (r.synced_from_planmatch_at) medsSynced += 1;
    }
    console.log(`  client_medications total: ${meds?.length}, distinct clients: ${medTally.size}, with sync stamp: ${medsSynced}`);

    const { data: links } = await sb.from('client_providers').select('client_id, synced_from_planmatch_at').limit(5000);
    const linkTally = new Map<number, number>();
    let linksSynced = 0;
    for (const r of links ?? []) {
      linkTally.set(r.client_id as number, (linkTally.get(r.client_id as number) ?? 0) + 1);
      if (r.synced_from_planmatch_at) linksSynced += 1;
    }
    console.log(`  client_providers total: ${links?.length}, distinct clients: ${linkTally.size}, with sync stamp: ${linksSynced}`);
  }

  console.log('\n=== 9. Inserts in last 7 days ===');
  {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    for (const t of ['client_medications', 'client_providers']) {
      const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true }).gte('created_at', since);
      if (error) console.log(`  ${t}: ERROR ${error.message}`);
      else console.log(`  ${t} created since ${since.slice(0,10)}: ${count}`);
    }
    const { count: sessCount } = await sb.from('planmatch_sessions').select('*', { count: 'exact', head: true }).gte('received_at', since);
    console.log(`  planmatch_sessions received since ${since.slice(0,10)}: ${sessCount}`);
  }

  console.log('\n=== 10. Linkage check: planmatch_sessions w/ linked_client_id vs structured rows ===');
  {
    const { data: sessions } = await sb
      .from('planmatch_sessions')
      .select('id, linked_client_id, received_at, medications, providers')
      .not('linked_client_id', 'is', null)
      .order('received_at', { ascending: false })
      .limit(10);
    for (const s of sessions ?? []) {
      const cid = (s as any).linked_client_id;
      const { count: medCount } = await sb.from('client_medications').select('*', { count: 'exact', head: true }).eq('client_id', cid);
      const { count: provCount } = await sb.from('client_providers').select('*', { count: 'exact', head: true }).eq('client_id', cid);
      const jsonMeds = Array.isArray((s as any).medications) ? (s as any).medications.length : 0;
      const jsonProvs = Array.isArray((s as any).providers) ? (s as any).providers.length : 0;
      console.log(`  session#${(s as any).id} → client_id=${cid}: payload had ${jsonMeds} meds / ${jsonProvs} providers; DB now has ${medCount} meds / ${provCount} providers for that client`);
    }
  }

  console.log('\nDone.');
}

main().catch((err) => { console.error(err); process.exit(1); });
