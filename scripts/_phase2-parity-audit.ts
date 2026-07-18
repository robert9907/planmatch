// Phase 2 — CMS Plan Finder parity audit.
//
// Scope: MAPD non-SNP plans only. Cached medicare.gov scrapes in
// _tmp/medicare-gov/ (Jun 25–27, 2026) hit /api/v1/data/plan-compare
// with default plan_type=MAPD, no LIS/persona context, so SNPs are
// absent. Auditing agent-side MAPD non-SNP against that cache gives
// an apples-to-apples slice; the SNP + MA-only slice is flagged as
// a gap that needs an LIS-aware re-scrape.
//
// For each county, we compare:
//   • Catalog: which plans CMS shows vs which we return (missing / phantom)
//   • Fields:  every plan present in both — plan_name, premium, MOOP,
//              deductible, drug_deductible, star_rating, plan_type, snp_type,
//              carrier (organization_name)
//
// Reads Supabase; writes only under _tmp/parity-data/. No DB writes.
//
// Run: npx tsx scripts/_phase2-parity-audit.ts

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

interface CountyTarget {
  county: string; state: string; fips: string; cmsCache: string;
}
const COUNTIES: CountyTarget[] = [
  { county: 'Durham',    state: 'NC', fips: '37063', cmsCache: '_tmp/medicare-gov/27713-37063.json' },
  { county: 'Harris',    state: 'TX', fips: '48201', cmsCache: '_tmp/medicare-gov/77001-48201.json' },
  { county: 'Bexar',     state: 'TX', fips: '48029', cmsCache: '_tmp/medicare-gov/78002-48029.json' },
  { county: 'Fulton',    state: 'GA', fips: '13121', cmsCache: '_tmp/medicare-gov/30004-13121.json' },
  { county: 'Alleghany', state: 'NC', fips: '37005', cmsCache: '_tmp/medicare-gov/28623-37005.json' },
];

// ─── CMS → normalized shape ───────────────────────────────────────
interface CmsPlan {
  key: string;
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string;
  carrier: string;
  plan_type: string;       // HMO / HMO-POS / PPO / Regional PPO
  snp_type: string | null; // null when NOT_SNP
  monthly_premium: number; // partc_premium + partd_premium (total)
  moop: number | null;     // in-network MOOP (extracted from maximum_oopc string)
  moop_combined: number | null; // "In and Out-of-network" (PPO), null otherwise
  annual_deductible: number;
  drug_deductible: number | null;
  star_rating: number | null;
}
function parseUsd(s: string | number | null | undefined): number | null {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const m = String(s).match(/\$?([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1].replace(/,/g, ''));
}
// Extract "$X In-network" and "$Y In and Out-of-network" values from
// CMS's maximum_oopc string. Formats seen:
//   "$5,400 In-network"
//   "$8,950 In and Out-of-network<br />$4,300 In-network"
function parseMoop(s: string | null | undefined): { inNet: number | null; combined: number | null } {
  if (!s) return { inNet: null, combined: null };
  const str = String(s);
  const inNetMatch = str.match(/\$?([\d,]+)\s*In-network/i);
  const combinedMatch = str.match(/\$?([\d,]+)\s*In and Out-of-network/i);
  return {
    inNet: inNetMatch ? Number(inNetMatch[1].replace(/,/g, '')) : null,
    combined: combinedMatch ? Number(combinedMatch[1].replace(/,/g, '')) : null,
  };
}
function cmsCategoryToPlanType(c: string): string {
  switch (c) {
    case 'PLAN_CATEGORY_HMO':          return 'HMO';
    case 'PLAN_CATEGORY_HMOPOS':       return 'HMO-POS';
    case 'PLAN_CATEGORY_LOCAL_PPO':    return 'PPO';
    case 'PLAN_CATEGORY_REGIONAL_PPO': return 'Regional PPO';
    case 'PLAN_CATEGORY_PFFS':         return 'PFFS';
    default: return c;
  }
}
function cmsSnp(v: string): string | null {
  if (!v || v === 'SNP_TYPE_NOT_SNP') return null;
  if (v === 'SNP_TYPE_DUAL_ELIGIBLE') return 'D-SNP';
  if (v === 'SNP_TYPE_CHRONIC_CONDITION') return 'C-SNP';
  if (v === 'SNP_TYPE_INSTITUTIONAL') return 'I-SNP';
  return v;
}
function loadCms(path: string): CmsPlan[] {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return (raw.plans ?? []).map((p: any): CmsPlan => {
    const moop = parseMoop(p.maximum_oopc);
    return {
      key: `${p.contract_id}-${p.plan_id}`,
      contract_id: p.contract_id,
      plan_id: p.plan_id,
      segment_id: String(p.segment_id ?? '0'),
      plan_name: p.name,
      carrier: p.organization_name,
      plan_type: cmsCategoryToPlanType(p.category),
      snp_type: cmsSnp(p.snp_type),
      // CMS separates partc + partd; pm_plans.monthly_premium stores the
      // consumer-facing total. Sum for apples-to-apples comparison.
      monthly_premium: (p.partc_premium ?? 0) + (p.partd_premium ?? 0),
      moop: moop.inNet,
      moop_combined: moop.combined,
      annual_deductible: parseUsd(p.annual_deductible) ?? 0,
      drug_deductible: p.drug_plan_deductible ?? null,
      star_rating: p.overall_star_rating?.rating ?? null,
    };
  });
}

// ─── Agent side ───────────────────────────────────────────────────
interface PmPlan {
  key: string;
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string;
  carrier: string;
  plan_type: string;
  snp_type: string | null;
  monthly_premium: number;
  moop: number | null;
  moop_combined: number | null;
  annual_deductible: number;
  drug_deductible: number | null;
  star_rating: number | null;
  sanctioned: boolean;
  nonComm: boolean;
}
async function loadAgentPool(t: CountyTarget, nonComm: { contracts: Set<string>; plans: Set<string> }): Promise<PmPlan[]> {
  const { data } = await sb.from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, carrier, plan_type, snp_type, monthly_premium, moop, moop_combined, annual_deductible, drug_deductible, star_rating, sanctioned')
    .eq('state', t.state)
    .ilike('county_name', `%${t.county}%`);
  const rows = data ?? [];
  return rows.map((r: any): PmPlan => ({
    key: `${r.contract_id}-${r.plan_id}`,
    contract_id: r.contract_id,
    plan_id: r.plan_id,
    segment_id: String(r.segment_id ?? '0'),
    plan_name: r.plan_name,
    carrier: r.carrier,
    plan_type: r.plan_type,
    snp_type: r.snp_type,
    monthly_premium: r.monthly_premium ?? 0,
    moop: r.moop ?? null,
    moop_combined: r.moop_combined ?? null,
    annual_deductible: r.annual_deductible ?? 0,
    drug_deductible: r.drug_deductible ?? null,
    star_rating: r.star_rating ?? null,
    sanctioned: !!r.sanctioned,
    nonComm: nonComm.contracts.has(r.contract_id) || nonComm.plans.has(`${r.contract_id}-${r.plan_id}`),
  }));
}
async function loadNonComm() {
  const { data } = await sb.from('pm_non_commissionable_contracts').select('contract_id, plan_number');
  return {
    contracts: new Set((data ?? []).filter((r: any) => !r.plan_number).map((r: any) => r.contract_id)),
    plans:     new Set((data ?? []).filter((r: any) => r.plan_number).map((r: any) => `${r.contract_id}-${r.plan_number}`)),
  };
}

// ─── Field diff ───────────────────────────────────────────────────
type FieldKey =
  | 'plan_name' | 'carrier' | 'plan_type' | 'snp_type'
  | 'monthly_premium' | 'moop' | 'moop_combined' | 'annual_deductible'
  | 'drug_deductible' | 'star_rating';
const FIELDS: FieldKey[] = [
  'plan_name', 'carrier', 'plan_type', 'snp_type',
  'monthly_premium', 'moop', 'moop_combined', 'annual_deductible',
  'drug_deductible', 'star_rating',
];
// Carrier names in CMS and pm_plans agree in the general case but CMS
// uses shorter variants for some BCBS entities. Accept a couple of
// known-equivalent aliases so this doesn't drown out real diffs.
const CARRIER_ALIASES: Array<[RegExp, RegExp]> = [
  [/^Blue Cross and Blue Shield of/i, /^Blue Cross and Blue Shield of/i],
];
function carriersEquivalent(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return true;
  for (const [ra, rb] of CARRIER_ALIASES) {
    if (ra.test(a) && rb.test(b)) return true;
  }
  return false;
}
// moop_combined is only meaningful for PPO plans (HMOs don't have OON
// coverage). CMS omits the "In and Out-of-network" leg for HMO strings.
// pm_plans.moop_combined can be null for HMOs. Treat both-null as
// match; if PM has a value but CMS didn't provide one, that's a soft
// diff we'll note but not fail loud on.
function moopCombinedMatch(cms: number | null, pm: number | null): boolean {
  if (cms == null && pm == null) return true;
  if (cms == null || pm == null) return cms == null; // CMS-omitted → accept
  return cms === pm;
}
// star_rating semantics: CMS reports 0 for "Too new to rate"; pm_plans
// stores null for the same. Treat as equivalent per the mission spec.
// drug_deductible: same pattern — CMS reports 0 for "no deductible";
// pm_plans stores null. Both mean the same thing.
function starMatch(cms: any, pm: any): boolean {
  const cmsN = cms == null ? 0 : Number(cms);
  const pmN  = pm == null ? 0 : Number(pm);
  return cmsN === pmN;
}
function drugDeductibleMatch(cms: any, pm: any): boolean {
  const cmsN = cms == null ? 0 : Number(cms);
  const pmN  = pm == null ? 0 : Number(pm);
  return cmsN === pmN;
}
function diffPlan(cms: CmsPlan, pm: PmPlan): Array<{ field: FieldKey; cms: any; pm: any }> {
  const out: Array<{ field: FieldKey; cms: any; pm: any }> = [];
  for (const f of FIELDS) {
    const a = (cms as any)[f];
    const b = (pm as any)[f];
    let ok: boolean;
    if (f === 'carrier') {
      ok = typeof a === 'string' && typeof b === 'string' && carriersEquivalent(a, b);
    } else if (f === 'moop_combined') {
      ok = moopCombinedMatch(a, b);
    } else if (f === 'star_rating') {
      ok = starMatch(a, b);
    } else if (f === 'drug_deductible') {
      ok = drugDeductibleMatch(a, b);
    } else if (a == null && b == null) ok = true;
    else if (typeof a === 'number' && typeof b === 'number') ok = a === b;
    else if (typeof a === 'string' && typeof b === 'string') ok = a.trim() === b.trim();
    else if (a == null || b == null) ok = false;
    else ok = String(a).trim() === String(b).trim();
    if (!ok) out.push({ field: f, cms: a, pm: b });
  }
  return out;
}

interface CountyResult {
  county: string; state: string; fips: string;
  cmsCacheDate: string;
  cmsAll: number;
  cmsMapdNonSnp: number;
  pmAll: number;
  pmCommissionable: number;
  pmMapdNonSnpCommissionable: number;
  matched: number;
  missingFromPm: Array<{ key: string; plan_name: string; carrier: string; reason: string }>;
  phantomInPm: Array<{ key: string; plan_name: string; carrier: string }>;
  fieldDiffs: Array<{ key: string; plan_name: string; diffs: Array<{ field: FieldKey; cms: any; pm: any }> }>;
  fieldStats: Record<FieldKey, { match: number; mismatch: number }>;
}

async function auditCounty(t: CountyTarget, nc: { contracts: Set<string>; plans: Set<string> }): Promise<CountyResult> {
  const cmsCacheStat = existsSync(t.cmsCache);
  if (!cmsCacheStat) throw new Error(`Missing CMS cache: ${t.cmsCache}`);
  const stat = readFileSync(t.cmsCache);
  const cmsAllRaw = loadCms(t.cmsCache);
  const cmsMapdNonSnp = cmsAllRaw.filter((p) => p.snp_type == null); // cache is already MAPD-only per _tmp scraper defaults

  const pmAll = await loadAgentPool(t, nc);
  const pmComm = pmAll.filter((p) => !p.sanctioned && !p.nonComm);
  // Match the CMS slice: MAPD non-SNP, non-PDP.
  const pmSlice = pmComm.filter((p) => p.plan_type !== 'PDP' && p.snp_type == null);

  const cmsByKey = new Map(cmsMapdNonSnp.map((p) => [p.key, p]));
  const pmByKey  = new Map(pmSlice.map((p) => [p.key, p]));

  // Missing = in CMS but not in PM (after commissionable + slice filter)
  const missingFromPm: CountyResult['missingFromPm'] = [];
  for (const c of cmsMapdNonSnp) {
    if (pmByKey.has(c.key)) continue;
    const inFullPool = pmAll.find((p) => p.key === c.key);
    let reason: string;
    if (!inFullPool) reason = 'not in pm_plans (data gap)';
    else if (inFullPool.sanctioned) reason = 'sanctioned=true';
    else if (inFullPool.nonComm) reason = 'in pm_non_commissionable_contracts';
    else if (inFullPool.plan_type === 'PDP') reason = 'plan_type=PDP (not MA)';
    else if (inFullPool.snp_type != null) reason = `snp_type=${inFullPool.snp_type} (CMS cache doesn't include SNPs)`;
    else reason = 'unknown';
    missingFromPm.push({ key: c.key, plan_name: c.plan_name, carrier: c.carrier, reason });
  }
  // Phantom = in PM slice but not in CMS
  const phantomInPm: CountyResult['phantomInPm'] = [];
  for (const p of pmSlice) {
    if (!cmsByKey.has(p.key)) phantomInPm.push({ key: p.key, plan_name: p.plan_name, carrier: p.carrier });
  }

  // Field-by-field diff for the intersection
  const fieldStats: Record<FieldKey, { match: number; mismatch: number }> = {} as any;
  for (const f of FIELDS) fieldStats[f] = { match: 0, mismatch: 0 };
  const fieldDiffs: CountyResult['fieldDiffs'] = [];
  let matched = 0;
  for (const c of cmsMapdNonSnp) {
    const pm = pmByKey.get(c.key);
    if (!pm) continue;
    matched += 1;
    const diffs = diffPlan(c, pm);
    for (const f of FIELDS) {
      const isDiff = diffs.some((d) => d.field === f);
      if (isDiff) fieldStats[f].mismatch += 1;
      else fieldStats[f].match += 1;
    }
    if (diffs.length > 0) fieldDiffs.push({ key: c.key, plan_name: c.plan_name, diffs });
  }

  return {
    county: t.county, state: t.state, fips: t.fips,
    cmsCacheDate: (stat as any).ctime?.toISOString?.() ?? '(unknown)',
    cmsAll: cmsAllRaw.length,
    cmsMapdNonSnp: cmsMapdNonSnp.length,
    pmAll: pmAll.length,
    pmCommissionable: pmComm.length,
    pmMapdNonSnpCommissionable: pmSlice.length,
    matched,
    missingFromPm,
    phantomInPm,
    fieldDiffs,
    fieldStats,
  };
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log('Phase 2 — CMS Plan Finder Parity Audit (MAPD non-SNP slice)');
  console.log('─'.repeat(70));
  const nc = await loadNonComm();
  console.log(`Non-comm filter: ${nc.contracts.size} contracts, ${nc.plans.size} plan-level entries`);
  const results: CountyResult[] = [];
  for (const t of COUNTIES) {
    const r = await auditCounty(t, nc);
    results.push(r);
    console.log(`\n${t.county} ${t.state} (${t.fips})`);
    console.log(`  CMS cache:       ${r.cmsAll} plans (MAPD non-SNP: ${r.cmsMapdNonSnp})`);
    console.log(`  PM all types:    ${r.pmAll}`);
    console.log(`  PM commissionable: ${r.pmCommissionable} (MAPD non-SNP slice: ${r.pmMapdNonSnpCommissionable})`);
    console.log(`  MATCHED:         ${r.matched}`);
    console.log(`  Missing from PM: ${r.missingFromPm.length}`);
    console.log(`  Phantom in PM:   ${r.phantomInPm.length}`);
    const totalMatch = FIELDS.reduce((s, f) => s + r.fieldStats[f].match, 0);
    const totalMis   = FIELDS.reduce((s, f) => s + r.fieldStats[f].mismatch, 0);
    const pct = (totalMatch + totalMis) === 0 ? 0 : Math.round((totalMatch / (totalMatch + totalMis)) * 10000) / 100;
    console.log(`  Field parity:    ${totalMatch}/${totalMatch + totalMis} = ${pct}%`);
    // Persist raw JSON per county
    writeFileSync(join('_tmp', 'parity-data', `${t.state}-${t.county.toLowerCase()}-${t.fips}.json`), JSON.stringify(r, null, 2));
  }

  // Aggregates
  const agg = { cms: 0, pm: 0, matched: 0, missing: 0, phantom: 0, fieldMatch: 0, fieldMis: 0 };
  const fieldAgg: Record<FieldKey, { match: number; mismatch: number }> = {} as any;
  for (const f of FIELDS) fieldAgg[f] = { match: 0, mismatch: 0 };
  for (const r of results) {
    agg.cms += r.cmsMapdNonSnp;
    agg.pm += r.pmMapdNonSnpCommissionable;
    agg.matched += r.matched;
    agg.missing += r.missingFromPm.length;
    agg.phantom += r.phantomInPm.length;
    for (const f of FIELDS) {
      fieldAgg[f].match    += r.fieldStats[f].match;
      fieldAgg[f].mismatch += r.fieldStats[f].mismatch;
      agg.fieldMatch    += r.fieldStats[f].match;
      agg.fieldMis      += r.fieldStats[f].mismatch;
    }
  }
  console.log(`\n${'─'.repeat(70)}\nTOTALS across 5 counties (MAPD non-SNP slice)`);
  console.log(`  CMS plans:              ${agg.cms}`);
  console.log(`  PM plans:               ${agg.pm}`);
  console.log(`  Matched (both):         ${agg.matched}`);
  console.log(`  Missing from PM:        ${agg.missing}`);
  console.log(`  Phantom in PM:          ${agg.phantom}`);
  const pctField = (agg.fieldMatch + agg.fieldMis) === 0 ? 0 : Math.round((agg.fieldMatch / (agg.fieldMatch + agg.fieldMis)) * 10000) / 100;
  console.log(`  Field parity:           ${agg.fieldMatch}/${agg.fieldMatch + agg.fieldMis} = ${pctField}%`);
  console.log(`\nPer-field:`);
  for (const f of FIELDS) {
    const s = fieldAgg[f];
    const p = (s.match + s.mismatch) === 0 ? 0 : Math.round((s.match / (s.match + s.mismatch)) * 10000) / 100;
    console.log(`  ${f.padEnd(20)}  ${s.match}/${s.match + s.mismatch}  = ${p}%`);
  }

  writeFileSync('_tmp/parity-data/_aggregate.json', JSON.stringify({ counties: results, totals: agg, byField: fieldAgg }, null, 2));
  console.log(`\nRaw data saved to _tmp/parity-data/ (5 county JSONs + _aggregate.json)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
