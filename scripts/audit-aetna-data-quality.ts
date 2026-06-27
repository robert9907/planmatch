// Audit: Aetna plan data quality across pm_plans, pm_plan_benefits,
// pm_formulary, pm_provider_directory, and pm_provider_network_cache.
// Six sections — read-only, no fixes.

import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
if (!url || !key) {
  console.error('Missing SUPABASE_URL / KEY');
  process.exit(1);
}
console.log(`Supabase host: ${new URL(url).host}\n`);

const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function paginate<T>(
  pageFn: (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>,
): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 50; p += 1) {
    const from = p * 1000;
    const { data, error } = await pageFn(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

const TIER_RE = /(Days?\s+\d+\s*[–-]\s*\d+\s*:\s*\$\s*\d+(?:\.\d+)?\s*\/\s*day)|(\$\s*\d+(?:\.\d+)?\s*\/\s*day\s*\(\s*days?\s+\d+\s*[–-]\s*\d+\s*\))/i;

function header(title: string) {
  console.log('\n' + '═'.repeat(74));
  console.log('  ' + title);
  console.log('═'.repeat(74));
}

interface PlanRow {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string | null;
  carrier: string | null;
  parent_organization: string | null;
  plan_type: string | null;
  state: string | null;
  county_name: string | null;
  monthly_premium: number | null;
  annual_deductible: number | null;
  moop: number | null;
  drug_deductible: number | null;
  star_rating: number | null;
}

// ─── Section 1 — Plan Inventory ───────────────────────────────────────
async function section1(): Promise<{ aetnaKeys: Set<string>; aetnaPlanIds: Set<string>; aetnaPlans: PlanRow[] }> {
  header('1. PLAN INVENTORY — Aetna');

  const aetna = await paginate<PlanRow>((from, to) =>
    sb
      .from('pm_plans')
      .select(
        'contract_id, plan_id, segment_id, plan_name, carrier, parent_organization, plan_type, state, county_name, monthly_premium, annual_deductible, moop, drug_deductible, star_rating',
      )
      .ilike('carrier', '%aetna%')
      .range(from, to),
  );
  console.log(`Total Aetna rows in pm_plans: ${aetna.length}`);

  // Breakdown by state
  const byState = new Map<string, number>();
  for (const r of aetna) byState.set(r.state ?? '∅', (byState.get(r.state ?? '∅') ?? 0) + 1);
  console.log('  By state:');
  for (const [s, n] of [...byState.entries()].sort()) console.log(`    ${s}: ${n}`);

  // Unique carriers (in case "Aetna" matches multiple branded carriers)
  const carriers = new Map<string, number>();
  for (const r of aetna) carriers.set(r.carrier ?? '∅', (carriers.get(r.carrier ?? '∅') ?? 0) + 1);
  console.log('  Distinct carrier strings:');
  for (const [c, n] of [...carriers.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${n.toString().padStart(5)}  ${c}`);

  // Unique (contract, plan, segment) and unique plan_id alone
  const tripleKeys = new Set(aetna.map((r) => `${r.contract_id}-${r.plan_id}-${r.segment_id}`));
  const planIds = new Set(aetna.map((r) => r.plan_id));
  console.log(`  unique (contract,plan,segment) tuples: ${tripleKeys.size}`);
  console.log(`  unique plan_id alone:                  ${planIds.size}`);

  // Duplicates within (contract, plan, segment, county_name)
  const fullKey = new Map<string, number>();
  for (const r of aetna) {
    const k = `${r.contract_id}-${r.plan_id}-${r.segment_id}|${r.state}|${r.county_name}`;
    fullKey.set(k, (fullKey.get(k) ?? 0) + 1);
  }
  const dups = [...fullKey.entries()].filter(([, n]) => n > 1);
  console.log(`  rows duplicated on (contract,plan,segment,state,county): ${dups.length}`);
  for (const [k, n] of dups.slice(0, 5)) console.log(`    ${n}× ${k}`);

  // Plan types
  const types = new Map<string, number>();
  for (const r of aetna) types.set(r.plan_type ?? '∅', (types.get(r.plan_type ?? '∅') ?? 0) + 1);
  console.log('  By plan_type:');
  for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${n.toString().padStart(5)}  ${t}`);

  return {
    aetnaKeys: new Set(aetna.map((r) => `${r.contract_id}-${r.plan_id}-${r.segment_id}`)),
    aetnaPlanIds: planIds,
    aetnaPlans: aetna,
  };
}

// ─── Section 2 — Benefit coverage compared to UHC + Humana ────────────
async function section2(aetnaKeys: Set<string>) {
  header('2. BENEFIT COVERAGE — rows per plan, vs UHC + Humana');

  async function carrierAvg(label: string, carrierLike: string) {
    const plans = await paginate<{ contract_id: string; plan_id: string; segment_id: string }>((from, to) =>
      sb.from('pm_plans').select('contract_id, plan_id, segment_id').ilike('carrier', carrierLike).range(from, to),
    );
    const planTriples = new Set(plans.map((p) => `${p.contract_id}-${p.plan_id}-${p.segment_id}`));
    const contractIds = [...new Set(plans.map((p) => p.contract_id))];
    const planIds = [...new Set(plans.map((p) => p.plan_id))];
    if (contractIds.length === 0) {
      console.log(`  ${label}: no plans`);
      return;
    }
    // Paginate benefits scoped to contract/plan ids; filter to actual plan triples client-side.
    const benefits = await paginate<{ contract_id: string; plan_id: string; segment_id: string; benefit_category: string }>(
      (from, to) =>
        sb
          .from('pm_plan_benefits')
          .select('contract_id, plan_id, segment_id, benefit_category')
          .in('contract_id', contractIds)
          .in('plan_id', planIds)
          .range(from, to),
    );
    const countByTriple = new Map<string, number>();
    const categoriesByTriple = new Map<string, Set<string>>();
    for (const b of benefits) {
      const t = `${b.contract_id}-${b.plan_id}-${b.segment_id}`;
      if (!planTriples.has(t)) continue;
      countByTriple.set(t, (countByTriple.get(t) ?? 0) + 1);
      const cats = categoriesByTriple.get(t) ?? new Set();
      cats.add(b.benefit_category);
      categoriesByTriple.set(t, cats);
    }
    const counts = [...countByTriple.values()].sort((a, b) => a - b);
    const plansWithZero = planTriples.size - countByTriple.size;
    const sum = counts.reduce((s, n) => s + n, 0);
    const avg = counts.length === 0 ? 0 : sum / counts.length;
    const min = counts[0] ?? 0;
    const max = counts[counts.length - 1] ?? 0;
    const median = counts.length === 0 ? 0 : counts[Math.floor(counts.length / 2)];
    console.log(`  ${label}:`);
    console.log(`    plans=${planTriples.size}  benefitRowsTotal=${benefits.length}`);
    console.log(`    rows/plan: min=${min}  median=${median}  avg=${avg.toFixed(1)}  max=${max}`);
    console.log(`    plans with ZERO benefit rows: ${plansWithZero}`);

    // Show 10 bottom + 3 top + check key benefit coverage
    const KEY = ['dental', 'vision', 'hearing', 'otc', 'fitness', 'transportation', 'partb_giveback', 'inpatient', 'pcp', 'primary_care', 'specialist'];
    const keyHit = new Map<string, number>();
    for (const cat of KEY) keyHit.set(cat, 0);
    for (const cats of categoriesByTriple.values()) {
      for (const cat of KEY) if (cats.has(cat)) keyHit.set(cat, (keyHit.get(cat) ?? 0) + 1);
    }
    console.log(`    plans WITH each key category (of ${planTriples.size}):`);
    for (const cat of KEY) {
      const n = keyHit.get(cat) ?? 0;
      const pct = planTriples.size === 0 ? 0 : Math.round((n / planTriples.size) * 100);
      console.log(`      ${cat.padEnd(18)} ${n.toString().padStart(5)}  ${pct}%`);
    }
  }

  void aetnaKeys; // (carrierAvg recomputes its own scope)
  await carrierAvg('Aetna   ', '%aetna%');
  await carrierAvg('UHC     ', '%united%');
  await carrierAvg('Humana  ', '%humana%');
}

// ─── Section 3 — Inpatient description shapes for Aetna ───────────────
async function section3() {
  header('3. INPATIENT description shape — Aetna');

  const aetnaPlans = await paginate<{ contract_id: string; plan_id: string; segment_id: string; plan_name: string | null }>(
    (from, to) =>
      sb.from('pm_plans').select('contract_id, plan_id, segment_id, plan_name').ilike('carrier', '%aetna%').range(from, to),
  );
  const triples = new Set(aetnaPlans.map((p) => `${p.contract_id}-${p.plan_id}-${p.segment_id}`));
  const contractIds = [...new Set(aetnaPlans.map((p) => p.contract_id))];
  const planIds = [...new Set(aetnaPlans.map((p) => p.plan_id))];

  const rows = await paginate<{
    contract_id: string;
    plan_id: string;
    segment_id: string;
    benefit_category: string;
    benefit_description: string | null;
    copay: number | null;
    coinsurance: number | null;
  }>((from, to) =>
    sb
      .from('pm_plan_benefits')
      .select('contract_id, plan_id, segment_id, benefit_category, benefit_description, copay, coinsurance')
      .in('contract_id', contractIds)
      .in('plan_id', planIds)
      .in('benefit_category', ['inpatient', 'inpatient_acute'])
      .range(from, to),
  );
  const scoped = rows.filter((r) => triples.has(`${r.contract_id}-${r.plan_id}-${r.segment_id}`));
  console.log(`  Aetna inpatient rows: ${scoped.length} (across ${triples.size} Aetna plan triples)`);

  let nullDesc = 0;
  let regexMatch = 0;
  let regexMiss = 0;
  const missShapes = new Map<string, number>();
  let copayMismatch = 0;
  const mismatchSamples: string[] = [];

  for (const r of scoped) {
    const desc = r.benefit_description;
    if (!desc) {
      nullDesc++;
      continue;
    }
    if (TIER_RE.test(desc)) regexMatch++;
    else {
      regexMiss++;
      const shape = desc.replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 110);
      missShapes.set(shape, (missShapes.get(shape) ?? 0) + 1);
    }
    // Copay/description mismatch (description says $0 but copay column shows >0)
    if (/\$\s*0\b/.test(desc) && (r.copay ?? 0) > 100) {
      copayMismatch++;
      if (mismatchSamples.length < 5) {
        mismatchSamples.push(`${r.contract_id}-${r.plan_id}-${r.segment_id}  copay=${r.copay}  desc=${JSON.stringify(desc)}`);
      }
    }
  }

  console.log(`    NULL benefit_description:  ${nullDesc}`);
  console.log(`    regex MATCH (either shape): ${regexMatch}`);
  console.log(`    regex MISS:                 ${regexMiss}`);
  if (missShapes.size > 0) {
    console.log('    top MISS shapes:');
    for (const [s, n] of [...missShapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`      ${n.toString().padStart(4)}× ${JSON.stringify(s)}`);
    }
  }
  console.log(`    description=$0 but copay>100 (mismatch): ${copayMismatch}`);
  for (const s of mismatchSamples) console.log(`      ${s}`);

  console.log('\n  5 RAW sample rows:');
  for (const r of scoped.slice(0, 5)) {
    console.log(`    ${r.contract_id}-${r.plan_id}-${r.segment_id}  copay=${r.copay ?? '∅'}  coins=${r.coinsurance ?? '∅'}`);
    console.log(`      desc: ${JSON.stringify(r.benefit_description)}`);
  }
}

// ─── Section 4 — Spot check 3 Aetna NC plans ──────────────────────────
async function section4() {
  header('4. SPOT CHECK — 3 random Aetna NC plans (full benefit dump + premium/MOOP/drug ded.)');

  const ncPlans = await paginate<PlanRow>((from, to) =>
    sb
      .from('pm_plans')
      .select(
        'contract_id, plan_id, segment_id, plan_name, carrier, parent_organization, plan_type, state, county_name, monthly_premium, annual_deductible, moop, drug_deductible, star_rating',
      )
      .ilike('carrier', '%aetna%')
      .eq('state', 'NC')
      .range(from, to),
  );
  console.log(`  Aetna NC rows: ${ncPlans.length}`);
  // Dedup to one row per (contract, plan, segment)
  const uniq = new Map<string, PlanRow>();
  for (const p of ncPlans) uniq.set(`${p.contract_id}-${p.plan_id}-${p.segment_id}`, p);
  const triples = [...uniq.values()];
  if (triples.length === 0) return;

  // Pick 3 deterministic samples (first / middle / last by sorted key)
  triples.sort((a, b) => `${a.contract_id}-${a.plan_id}-${a.segment_id}`.localeCompare(`${b.contract_id}-${b.plan_id}-${b.segment_id}`));
  const samples = [triples[0], triples[Math.floor(triples.length / 2)], triples[triples.length - 1]];

  for (const p of samples) {
    const triple = `${p.contract_id}-${p.plan_id}-${p.segment_id}`;
    console.log(`\n  ── ${triple}  ${p.plan_type ?? ''}  ${p.county_name ?? ''}, ${p.state ?? ''}`);
    console.log(`     ${p.plan_name ?? ''}  carrier="${p.carrier}"`);
    console.log(`     monthly_premium=${p.monthly_premium ?? '∅'}  moop=${p.moop ?? '∅'}  med_deductible=${p.annual_deductible ?? '∅'}  drug_deductible=${p.drug_deductible ?? '∅'}  stars=${p.star_rating ?? '∅'}`);

    const { data: benefits } = await sb
      .from('pm_plan_benefits')
      .select('benefit_category, benefit_description, copay, coinsurance, coverage_amount, max_coverage')
      .eq('contract_id', p.contract_id)
      .eq('plan_id', p.plan_id)
      .eq('segment_id', p.segment_id);

    console.log(`     benefit rows: ${benefits?.length ?? 0}`);
    const byCat = new Map<string, typeof benefits>();
    for (const b of benefits ?? []) {
      const arr = byCat.get(b.benefit_category) ?? [];
      arr!.push(b);
      byCat.set(b.benefit_category, arr);
    }
    const KEY = ['dental', 'vision', 'hearing', 'otc', 'fitness', 'transportation', 'telehealth', 'partb_giveback', 'inpatient', 'inpatient_acute', 'primary_care', 'pcp', 'specialist', 'emergency', 'urgent_care'];
    console.log(`     key categories present:`);
    for (const cat of KEY) {
      const hits = byCat.get(cat);
      if (hits && hits.length > 0) {
        const b = hits[0]!;
        const v = b.benefit_description ?? (b.copay != null ? `$${b.copay}` : b.coinsurance != null ? `${b.coinsurance}%` : b.coverage_amount != null ? `$${b.coverage_amount}` : '—');
        console.log(`       ✓ ${cat.padEnd(18)} ${JSON.stringify(String(v).slice(0, 90))}`);
      } else {
        console.log(`       ✗ ${cat}`);
      }
    }

    // Formulary count
    const { count: fmCount } = await sb
      .from('pm_formulary')
      .select('rxcui', { count: 'exact', head: true })
      .eq('contract_id', p.contract_id)
      .eq('plan_id', p.plan_id);
    console.log(`     formulary rows for (contract,plan)=${p.contract_id}-${p.plan_id}: ${fmCount ?? '?'}`);

    // Drug copay distribution — flag suspicious all-$0 cases
    const { data: drugs } = await sb
      .from('pm_formulary')
      .select('tier, copay, coinsurance')
      .eq('contract_id', p.contract_id)
      .eq('plan_id', p.plan_id)
      .limit(1000);
    if (drugs && drugs.length > 0) {
      const zeros = drugs.filter((d) => (d.copay ?? 0) === 0 && (d.coinsurance ?? 0) === 0).length;
      const tierCounts = new Map<number | null, number>();
      for (const d of drugs) tierCounts.set(d.tier ?? null, (tierCounts.get(d.tier ?? null) ?? 0) + 1);
      console.log(`     drugs sampled: ${drugs.length}  all-zero-cost: ${zeros}  tier distribution: ${[...tierCounts.entries()].map(([t, n]) => `T${t ?? '∅'}:${n}`).join(' ')}`);
    }
  }
}

// ─── Section 5 — Provider network ─────────────────────────────────────
async function section5() {
  header('5. PROVIDER NETWORK — Aetna cache + directory presence');

  const aetnaPlans = await paginate<{ contract_id: string; plan_id: string }>((from, to) =>
    sb.from('pm_plans').select('contract_id, plan_id').ilike('carrier', '%aetna%').range(from, to),
  );
  const combinedIds = [...new Set(aetnaPlans.map((p) => `${p.contract_id}-${p.plan_id}`))];
  console.log(`  Aetna distinct (contract,plan) keys: ${combinedIds.length}`);

  // pm_provider_network_cache — counts per status for Aetna keys.
  // Use the key column the cache stores (commonly "plan_id" or
  // "combined_plan_id" = contract-plan). Try the combined string.
  const cacheHits = await paginate<{ plan_id: string; status: string | null }>((from, to) =>
    sb.from('pm_provider_network_cache').select('plan_id, status').in('plan_id', combinedIds.slice(0, 500)).range(from, to),
  );
  console.log(`  pm_provider_network_cache rows matched (first 500 keys): ${cacheHits.length}`);
  const statusCounts = new Map<string, number>();
  for (const r of cacheHits) statusCounts.set(r.status ?? '∅', (statusCounts.get(r.status ?? '∅') ?? 0) + 1);
  for (const [s, n] of statusCounts) console.log(`    ${s}: ${n}`);

  // Comparison: UHC + Humana + BCBS keys hit ratio
  for (const [label, carrier] of [
    ['UHC', '%united%'],
    ['Humana', '%humana%'],
    ['BCBS NC', '%blue cross%'],
  ] as const) {
    const plans = await paginate<{ contract_id: string; plan_id: string }>((from, to) =>
      sb.from('pm_plans').select('contract_id, plan_id').ilike('carrier', carrier).eq('state', 'NC').range(from, to),
    );
    const keys = [...new Set(plans.map((p) => `${p.contract_id}-${p.plan_id}`))];
    if (keys.length === 0) {
      console.log(`  ${label} (NC) keys=0 — skipped`);
      continue;
    }
    const sample = keys.slice(0, 500);
    const hits = await paginate<{ plan_id: string }>((from, to) =>
      sb.from('pm_provider_network_cache').select('plan_id').in('plan_id', sample).range(from, to),
    );
    const distinctHitKeys = new Set(hits.map((h) => h.plan_id));
    console.log(`  ${label} (NC):  ${distinctHitKeys.size} / ${sample.length} sample keys appear in cache`);
  }

  // Directory presence — any provider whose plan affiliation references an Aetna key?
  // pm_provider_directory schema doesn't have carrier directly; use specialty_states + spot-check.
  const { count: dirCount } = await sb.from('pm_provider_directory').select('npi', { count: 'exact', head: true });
  console.log(`  pm_provider_directory total rows: ${dirCount ?? '?'}`);
}

// ─── Section 6 — Formulary ────────────────────────────────────────────
async function section6() {
  header('6. FORMULARY — row counts Aetna vs UHC vs Humana');

  for (const [label, carrier] of [
    ['Aetna', '%aetna%'],
    ['UHC', '%united%'],
    ['Humana', '%humana%'],
  ] as const) {
    const plans = await paginate<{ contract_id: string; plan_id: string }>((from, to) =>
      sb.from('pm_plans').select('contract_id, plan_id').ilike('carrier', carrier).range(from, to),
    );
    const planKeys = new Set(plans.map((p) => `${p.contract_id}-${p.plan_id}`));
    const contractIds = [...new Set(plans.map((p) => p.contract_id))];
    const planIds = [...new Set(plans.map((p) => p.plan_id))];
    if (contractIds.length === 0) {
      console.log(`  ${label}: no plans`);
      continue;
    }
    const fm = await paginate<{ contract_id: string; plan_id: string; rxcui: string }>((from, to) =>
      sb
        .from('pm_formulary')
        .select('contract_id, plan_id, rxcui')
        .in('contract_id', contractIds)
        .in('plan_id', planIds)
        .range(from, to),
    );
    const scoped = fm.filter((r) => planKeys.has(`${r.contract_id}-${r.plan_id}`));
    const byKey = new Map<string, number>();
    for (const r of scoped) {
      const k = `${r.contract_id}-${r.plan_id}`;
      byKey.set(k, (byKey.get(k) ?? 0) + 1);
    }
    const counts = [...byKey.values()].sort((a, b) => a - b);
    const zero = planKeys.size - byKey.size;
    const avg = counts.length ? counts.reduce((s, n) => s + n, 0) / counts.length : 0;
    const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
    console.log(`  ${label}: plan keys=${planKeys.size}, formulary rows total=${scoped.length}`);
    console.log(`    rows/plan: min=${counts[0] ?? 0}  median=${median}  avg=${avg.toFixed(0)}  max=${counts[counts.length - 1] ?? 0}`);
    console.log(`    plans with ZERO formulary entries: ${zero}`);
  }
}

async function main() {
  const { aetnaKeys } = await section1();
  await section2(aetnaKeys);
  await section3();
  await section4();
  await section5();
  await section6();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
