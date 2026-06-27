// Diagnostic: does pm_provider_network_cache mix 2-part and 3-part
// plan_id shapes? If yes, the API's `.in('plan_id', <2-part keys>)`
// filter at api/plan-brain-data.ts:206 silently drops every 3-part row.

import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const NPI_KLEIN = '1619976297';

async function paginate<T>(
  pageFn: (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>,
): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 50; p++) {
    const { data, error } = await pageFn(p * 1000, p * 1000 + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  // ── 1. Cache-wide plan_id shape distribution ────────────────────────
  const rows = await paginate<{ plan_id: string; segment_id: string | null }>(
    (from, to) =>
      sb.from('pm_provider_network_cache')
        .select('plan_id, segment_id')
        .range(from, to),
  );
  const shapeCounts = new Map<string, number>();
  for (const r of rows) {
    const shape = `${r.plan_id.split('-').length}-part / seg=${r.segment_id ?? 'null'}`;
    shapeCounts.set(shape, (shapeCounts.get(shape) ?? 0) + 1);
  }
  console.log(`Sampled ${rows.length} cache rows (first ${50 * 1000} max).`);
  console.log('plan_id shape × segment_id distribution:');
  for (const [s, c] of [...shapeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.toString().padStart(6)}  ${s}`);
  }

  // ── 2. Klein's rows specifically ─────────────────────────────────────
  const { data: kleinRows } = await sb
    .from('pm_provider_network_cache')
    .select('plan_id, segment_id, covered')
    .eq('npi', NPI_KLEIN);
  console.log(`\nKlein NPI ${NPI_KLEIN}: ${kleinRows?.length ?? 0} rows total`);
  console.log('Each row\'s plan_id + segment_id + covered:');
  for (const r of kleinRows ?? []) {
    const parts = r.plan_id.split('-');
    const shape = parts.length === 3 ? '3-part' : parts.length === 2 ? '2-part' : `${parts.length}-part`;
    console.log(`  ${shape.padEnd(7)}  plan_id="${r.plan_id}"  segment_id=${r.segment_id ?? 'null'}  covered=${r.covered}`);
  }

  // ── 3. Simulate the bug: does .in('plan_id', [2-part list]) miss
  //       3-part Klein rows? ───────────────────────────────────────────
  // First, gather all Klein contract-plans (2-part) and contract-plan-segments (3-part)
  const klein2part = new Set<string>();
  const klein3part = new Set<string>();
  for (const r of kleinRows ?? []) {
    const parts = r.plan_id.split('-');
    if (parts.length === 2) klein2part.add(r.plan_id);
    else if (parts.length === 3) {
      klein3part.add(r.plan_id);
      klein2part.add(`${parts[0]}-${parts[1]}`);
    }
  }
  // Now query with .in('plan_id', <2-part Klein keys>) — same shape as the API
  if (klein2part.size > 0) {
    const { data: twoPartHits } = await sb
      .from('pm_provider_network_cache')
      .select('plan_id, segment_id, covered')
      .eq('npi', NPI_KLEIN)
      .in('plan_id', [...klein2part]);
    console.log(`\nSimulated API filter \`.in('plan_id', [${klein2part.size} 2-part keys])\`:`);
    console.log(`  hits: ${twoPartHits?.length ?? 0}`);
    const got2 = (twoPartHits ?? []).filter((r) => r.plan_id.split('-').length === 2).length;
    const got3 = (twoPartHits ?? []).filter((r) => r.plan_id.split('-').length === 3).length;
    console.log(`  of which 2-part rows: ${got2}`);
    console.log(`  of which 3-part rows: ${got3}  ← these would be silently DROPPED if the table had them`);
    if (klein3part.size > 0) {
      console.log(`\n⚠️  Klein has ${klein3part.size} 3-part rows in the cache, but the API filter only returns 2-part — those 3-part rows are INVISIBLE to the brain.`);
    } else {
      console.log(`\nKlein has zero 3-part rows in the cache; filter works correctly for THIS NPI.`);
    }
  }

  // ── 4. Cross-check: do ANY Durham plans have 3-part Klein rows? ────
  const { data: durhamPlans } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id')
    .eq('state', 'NC')
    .ilike('county_name', '%Durham%')
    .eq('sanctioned', false);
  const durham2part = new Set<string>();
  const durham3part = new Set<string>();
  for (const p of durhamPlans ?? []) {
    durham2part.add(`${p.contract_id}-${p.plan_id}`);
    durham3part.add(`${p.contract_id}-${p.plan_id}-${p.segment_id ?? '0'}`);
  }
  console.log(`\nDurham plan keys: ${durham2part.size} unique 2-part, ${durham3part.size} unique 3-part`);
  const klein3PartInDurham = [...klein3part].filter((k) => {
    const parts = k.split('-');
    return durham2part.has(`${parts[0]}-${parts[1]}`);
  });
  console.log(`Klein 3-part cache rows that correspond to Durham plans: ${klein3PartInDurham.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
