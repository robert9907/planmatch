// scripts/probe-snp-redflags.ts — quantify red flags on NC SNP
// (CSNP / DSNP / ISNP) plans post-fix. Read-only.

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
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const CRITICAL_CATS = ['inpatient', 'primary_care', 'specialist', 'emergency', 'urgent_care', 'snf'];
const EXTRA_CATS = ['dental', 'vision', 'hearing', 'otc', 'transportation', 'fitness'];

interface PlanRow {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string;
  plan_type: string;
  snp: boolean;
  snp_type: string | null;
  carrier: string;
  county_name: string;
}

async function main() {
  // STEP 1 — every NC SNP plan
  console.log('========== STEP 1: NC SNP plan inventory ==========');
  const { data: allRows } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, plan_type, snp, snp_type, carrier, county_name')
    .eq('state', 'NC')
    .eq('snp', true)
    .order('carrier')
    .order('contract_id')
    .order('plan_id');
  const rows = (allRows ?? []) as PlanRow[];
  const seenTriple = new Set<string>();
  const triples: PlanRow[] = [];
  for (const r of rows) {
    const k = `${r.contract_id}-${r.plan_id}-${r.segment_id ?? ''}`;
    if (seenTriple.has(k)) continue;
    seenTriple.add(k);
    triples.push(r);
  }
  console.log(`Distinct SNP plan-segments in NC: ${triples.length}`);
  const bySnpType = new Map<string, number>();
  for (const t of triples) bySnpType.set(t.snp_type ?? 'unknown', (bySnpType.get(t.snp_type ?? 'unknown') ?? 0) + 1);
  console.log('By snp_type:');
  for (const [k, v] of [...bySnpType.entries()].sort()) console.log(`  ${k}: ${v}`);
  const byCarrier = new Map<string, number>();
  for (const t of triples) byCarrier.set(t.carrier ?? 'unknown', (byCarrier.get(t.carrier ?? 'unknown') ?? 0) + 1);
  console.log('By carrier:');
  for (const [k, v] of [...byCarrier.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

  // STEP 2 — per-plan benefit row counts + critical-category presence
  // Use distinct (contract, plan) pairs to avoid querying every county
  // segment.
  console.log('\n\n========== STEP 2: benefit-row presence per SNP plan ==========');
  const seenCp = new Set<string>();
  const cpUnique: PlanRow[] = [];
  for (const t of triples) {
    const k = `${t.contract_id}-${t.plan_id}`;
    if (seenCp.has(k)) continue;
    seenCp.add(k);
    cpUnique.push(t);
  }
  console.log(`Distinct contract-plan combos: ${cpUnique.length}`);

  type Diag = {
    contract: string;
    plan: string;
    snpType: string;
    carrier: string;
    benefitRowsAnySeg: number;
    presentCats: Set<string>;
    missingCritical: string[];
    missingExtras: string[];
  };
  const diags: Diag[] = [];
  for (const cp of cpUnique) {
    const { data: ben } = await sb
      .from('pm_plan_benefits')
      .select('benefit_category, segment_id')
      .eq('contract_id', cp.contract_id)
      .eq('plan_id', cp.plan_id);
    const presentCats = new Set<string>();
    for (const r of ben ?? []) presentCats.add(r.benefit_category as string);
    const missingCrit = CRITICAL_CATS.filter((c) => !presentCats.has(c));
    const missingExt = EXTRA_CATS.filter((c) => !presentCats.has(c));
    diags.push({
      contract: cp.contract_id,
      plan: cp.plan_id,
      snpType: cp.snp_type ?? 'unknown',
      carrier: cp.carrier ?? 'unknown',
      benefitRowsAnySeg: ben?.length ?? 0,
      presentCats,
      missingCritical: missingCrit,
      missingExtras: missingExt,
    });
  }

  // Bucket by red flag severity
  const fullyBroken = diags.filter((d) => d.benefitRowsAnySeg === 0);
  const missingCritical = diags.filter((d) => d.benefitRowsAnySeg > 0 && d.missingCritical.length > 0);
  const missingExtrasOnly = diags.filter((d) => d.benefitRowsAnySeg > 0 && d.missingCritical.length === 0 && d.missingExtras.length > 0);
  const clean = diags.filter((d) => d.benefitRowsAnySeg > 0 && d.missingCritical.length === 0 && d.missingExtras.length === 0);

  console.log(`\nFully broken (0 benefit rows across ALL segments): ${fullyBroken.length}`);
  for (const d of fullyBroken) console.log(`  ${d.contract}-${d.plan}  ${d.snpType}  ${d.carrier}`);
  console.log(`\nMissing one or more CRITICAL categories: ${missingCritical.length}`);
  for (const d of missingCritical) console.log(`  ${d.contract}-${d.plan}  ${d.snpType}  ${d.carrier}  missing=[${d.missingCritical.join(',')}]`);
  console.log(`\nMissing extras only (critical complete): ${missingExtrasOnly.length}`);
  for (const d of missingExtrasOnly) console.log(`  ${d.contract}-${d.plan}  ${d.snpType}  ${d.carrier}  missing=[${d.missingExtras.join(',')}]`);
  console.log(`\nClean (every critical + extra present): ${clean.length}`);

  // STEP 3 — wire response for Durham SNP plans: critical cells null?
  console.log('\n\n========== STEP 3: deployed wire for Durham SNP plans ==========');
  const r = await fetch(`https://planmatch.vercel.app/api/plans?state=NC&county=Durham&limit=2000&_=${Date.now()}`);
  const body = await r.json() as { plans: Array<Record<string, unknown>> };
  // Filter to SNP plan_type strings
  const snpWire = (body.plans ?? []).filter((p) => /SNP/i.test((p.plan_type as string) ?? ''));
  console.log(`SNP plans on the Durham wire: ${snpWire.length}`);
  const wireRedFlags: Array<{ id: string; name: string; nullCrit: string[] }> = [];
  for (const p of snpWire) {
    const med = (p.benefits as Record<string, Record<string, unknown>>)?.medical as Record<string, Record<string, unknown>> | undefined;
    const nullCrit: string[] = [];
    for (const cat of ['inpatient', 'mental_health_inpatient', 'snf', 'primary_care', 'specialist', 'emergency', 'urgent_care']) {
      const cs = med?.[cat];
      const allNull = cs && cs.copay == null && cs.coinsurance == null && (cs.description == null || (cs.description as string) === '');
      if (allNull) nullCrit.push(cat);
    }
    if (nullCrit.length > 0) {
      wireRedFlags.push({
        id: `${p.contract_id}-${p.plan_number}`,
        name: ((p.plan_name as string) ?? '').slice(0, 50),
        nullCrit,
      });
    }
  }
  console.log(`\nDurham SNP plans with at least one null critical cell on wire: ${wireRedFlags.length}`);
  for (const f of wireRedFlags) {
    console.log(`  ${f.id} "${f.name}" — null=[${f.nullCrit.join(',')}]`);
  }
  if (wireRedFlags.length === 0) console.log('  (none)');

  // STEP 4 — delta vs 61 red-flag baseline
  console.log('\n\n========== STEP 4: delta vs May "61 red flags" baseline ==========');
  console.log(`May baseline:                      61 SNP red flags`);
  console.log(`Today fully-broken (0 rows):       ${fullyBroken.length}`);
  console.log(`Today missing critical category:   ${missingCritical.length}`);
  console.log(`Today missing extras only:         ${missingExtrasOnly.length}`);
  console.log(`Today fully clean:                 ${clean.length}`);
  console.log(`Today wire null critical cells:    ${wireRedFlags.length} (Durham only)`);

  // Carrier-pattern check across remaining issues
  console.log('\nCarrier breakdown of remaining issues (DB-level):');
  const issueByCarrier = new Map<string, number>();
  for (const d of [...fullyBroken, ...missingCritical, ...missingExtrasOnly]) {
    issueByCarrier.set(d.carrier, (issueByCarrier.get(d.carrier) ?? 0) + 1);
  }
  for (const [k, v] of [...issueByCarrier.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  // Detailed category-miss frequency
  console.log('\nMost-frequent missing category (across all SNP plans):');
  const missFreq = new Map<string, number>();
  for (const d of diags) for (const c of d.missingCritical) missFreq.set(c, (missFreq.get(c) ?? 0) + 1);
  for (const d of diags) for (const c of d.missingExtras) missFreq.set(c, (missFreq.get(c) ?? 0) + 1);
  for (const [k, v] of [...missFreq.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v} plans`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
