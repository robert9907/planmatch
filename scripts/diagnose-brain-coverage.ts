// Diagnose why the brain reports 0/N meds covered + 0/N providers
// in-network on EVERY plan. Probes the three likely failure modes
// using the agent-v3 seed payload (Robert Johnson) as the canonical
// test case.

import { createClient } from '@supabase/supabase-js';
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

// Seed scenario from src/agent-v3/seed.ts (Robert Johnson, Durham NC).
const SEED_RXCUIS = ['2398842', '314077', '617311', '197321']; // Ozempic, Lisinopril, Atorvastatin, Gabapentin
const SEED_NPI = '1619976297'; // Dr. Combats (Klein Internal Medicine)

async function main() {
  // ── 1. Plan pool: every Durham plan ─────────────────────────────
  const { data: plans } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, carrier')
    .eq('state', 'NC')
    .ilike('county_name', '%Durham%');
  if (!plans) return;
  const seen = new Set<string>();
  const uniq = plans.filter((p) => {
    const k = `${p.contract_id}-${p.plan_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`Durham plans (unique): ${uniq.length}`);
  const segShapes = new Map<string, number>();
  for (const p of uniq) {
    const s = String(p.segment_id ?? 'null');
    segShapes.set(s, (segShapes.get(s) ?? 0) + 1);
  }
  console.log('pm_plans segment_id shapes:', Object.fromEntries(segShapes));

  // ── 2. Formulary — do the seed rxcuis exist for Durham plans? ────
  const contractIds = [...new Set(uniq.map((p) => p.contract_id))];
  const planIds = [...new Set(uniq.map((p) => p.plan_id))];
  const formularyRows: { contract_id: string; plan_id: string; rxcui: string; tier: number | null }[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data } = await sb
      .from('pm_formulary')
      .select('contract_id, plan_id, rxcui, tier')
      .in('contract_id', contractIds)
      .in('plan_id', planIds)
      .in('rxcui', SEED_RXCUIS)
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    formularyRows.push(...data);
    if (data.length < 1000) break;
  }
  const formByPlan = new Map<string, Set<string>>();
  for (const r of formularyRows) {
    const k = `${r.contract_id}-${r.plan_id}`;
    const set = formByPlan.get(k) ?? new Set();
    set.add(r.rxcui);
    formByPlan.set(k, set);
  }
  console.log(`\nFormulary — seed rxcuis × Durham plans:`);
  console.log(`  total rows returned: ${formularyRows.length}`);
  console.log(`  unique (plan, rxcui) pairs: ${formularyRows.length}`);
  const fullyCovered = uniq.filter((p) => formByPlan.get(`${p.contract_id}-${p.plan_id}`)?.size === SEED_RXCUIS.length).length;
  const partiallyCovered = uniq.filter((p) => {
    const s = formByPlan.get(`${p.contract_id}-${p.plan_id}`);
    return s && s.size > 0 && s.size < SEED_RXCUIS.length;
  }).length;
  const noneCovered = uniq.length - fullyCovered - partiallyCovered;
  console.log(`  plans with ALL ${SEED_RXCUIS.length} rxcuis: ${fullyCovered}`);
  console.log(`  plans with PARTIAL: ${partiallyCovered}`);
  console.log(`  plans with NONE: ${noneCovered}`);
  // Sample a plan with full coverage + tier distribution
  if (fullyCovered > 0) {
    const sample = uniq.find((p) => formByPlan.get(`${p.contract_id}-${p.plan_id}`)?.size === SEED_RXCUIS.length)!;
    console.log(`\nSample fully-covered plan: ${sample.carrier} | ${sample.plan_name} (${sample.contract_id}-${sample.plan_id})`);
    const { data: detail } = await sb
      .from('pm_formulary')
      .select('rxcui, tier, copay, coinsurance')
      .eq('contract_id', sample.contract_id)
      .eq('plan_id', sample.plan_id)
      .in('rxcui', SEED_RXCUIS);
    console.table(detail ?? []);
  }

  // ── 3. Provider network — does the seed NPI exist? ───────────────
  const { data: netRows } = await sb
    .from('pm_provider_network_cache')
    .select('plan_id, segment_id, npi, covered')
    .eq('npi', SEED_NPI);
  console.log(`\nProvider network — NPI ${SEED_NPI} total rows: ${netRows?.length ?? 0}`);
  if (netRows && netRows.length > 0) {
    const planIdShapes = new Map<string, number>();
    const segShapesNet = new Map<string, number>();
    for (const r of netRows) {
      const piShape = r.plan_id.split('-').length === 3 ? '3-part' : r.plan_id.split('-').length === 2 ? '2-part' : 'other';
      planIdShapes.set(piShape, (planIdShapes.get(piShape) ?? 0) + 1);
      const s = String(r.segment_id ?? 'null');
      segShapesNet.set(s, (segShapesNet.get(s) ?? 0) + 1);
    }
    console.log('  plan_id shapes:', Object.fromEntries(planIdShapes));
    console.log('  segment_id shapes:', Object.fromEntries(segShapesNet));
    // Cross-reference: how many Durham plans does this NPI have rows for?
    const npiByContractPlan = new Set<string>();
    for (const r of netRows) {
      // pm_provider_network_cache.plan_id might be "H4073-001" or "H4073-001-0"
      const parts = r.plan_id.split('-');
      const key = `${parts[0]}-${parts[1]}`;
      npiByContractPlan.add(key);
    }
    const durhamSeedNpiHits = uniq.filter((p) => npiByContractPlan.has(`${p.contract_id}-${p.plan_id}`));
    console.log(`  Durham plans where NPI has rows: ${durhamSeedNpiHits.length}/${uniq.length}`);
    const coveredCount = netRows.filter((r) => r.covered === true).length;
    console.log(`  rows where covered=true: ${coveredCount}/${netRows.length}`);
  }

  // ── 4. Sample API plan-brain-data response ──────────────────────
  console.log('\n=== Verdict ===');
  if (formularyRows.length === 0) {
    console.log('❌ Formulary returned ZERO rows for seed rxcuis. Either the rxcuis are stale or pm_formulary is missing.');
  } else if (fullyCovered === 0) {
    console.log('⚠ No Durham plan covers ALL 4 seed rxcuis. Some plans should — check pm_formulary import.');
  } else {
    console.log(`✓ ${fullyCovered} Durham plans cover all 4 seed rxcuis. Brain SHOULD report coveredCount=4 for those.`);
  }
  if (!netRows || netRows.length === 0) {
    console.log(`❌ NPI ${SEED_NPI} has zero rows in pm_provider_network_cache. Provider gate has nothing to match — brain reports unverified on every plan.`);
  } else {
    console.log(`✓ NPI ${SEED_NPI} has ${netRows.length} rows in pm_provider_network_cache.`);
  }
}

main().catch(console.error);
