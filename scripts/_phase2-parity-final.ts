// Phase 2 FINAL — combined MAPD + SNP parity audit.
//
// Two CMS ground-truth sources:
//   • _tmp/medicare-gov/*.json          — /plans/search results (MAPD non-SNP)
//   • _tmp/medicare-gov-snp/detail/*    — /plan/{...} responses  (SNP)
//
// Agent-side source: pm_plans + pm_non_commissionable_contracts.
// Read-only. Writes report + per-county JSONs under _tmp/parity-data/.
//
// Run: npx tsx scripts/_phase2-parity-final.ts

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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

const COUNTIES = [
  { county: 'Durham',    state: 'NC', fips: '37063', mapdCache: '_tmp/medicare-gov/27713-37063.json' },
  { county: 'Harris',    state: 'TX', fips: '48201', mapdCache: '_tmp/medicare-gov/77001-48201.json' },
  { county: 'Bexar',     state: 'TX', fips: '48029', mapdCache: '_tmp/medicare-gov/78002-48029.json' },
  { county: 'Fulton',    state: 'GA', fips: '13121', mapdCache: '_tmp/medicare-gov/30004-13121.json' },
  { county: 'Alleghany', state: 'NC', fips: '37005', mapdCache: '_tmp/medicare-gov/28623-37005.json' },
];

// ─── CMS normalization ────────────────────────────────────────────
function parseUsd(s: any): number | null {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const m = String(s).match(/\$?([\d,]+(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}
function parseMoopString(s: any): { inNet: number | null; combined: number | null } {
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
function cmsSnpBase(v: string | null | undefined): string | null {
  if (!v || v === 'SNP_TYPE_NOT_SNP') return null;
  if (v === 'SNP_TYPE_DUAL_ELIGIBLE')       return 'D-SNP';
  if (v === 'SNP_TYPE_CHRONIC_OR_DISABLING') return 'C-SNP';
  if (v === 'SNP_TYPE_CHRONIC_CONDITION')    return 'C-SNP';
  if (v === 'SNP_TYPE_INSTITUTIONAL')        return 'I-SNP';
  return v;
}
// Compare CMS SNP base label to pm_plans.snp_type (which is 'D-SNP',
// 'C-SNP', 'I-SNP'). SNP type is also embedded in plan_type strings
// on the agent side ("HMO D-SNP", "PPO C-SNP"). We compare only the
// short snp_type field; plan_type suffix is checked separately.
function snpEquivalent(cms: string | null, pm: string | null): boolean {
  return (cms ?? '') === (pm ?? '');
}
// pm plan_type strings include the SNP suffix ("HMO D-SNP"); CMS
// category is just the network type ("HMO"). Strip the SNP suffix
// from pm before comparing to CMS category.
function normalizePmPlanType(pt: string): string {
  return pt.replace(/\s+(C-SNP|D-SNP|I-SNP)$/i, '').trim();
}

// ─── Slice: MAPD from search results ─────────────────────────────
interface Ground {
  key: string;
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string;
  carrier: string;
  plan_type: string;         // "HMO", "PPO", "HMO-POS", "Regional PPO"
  snp_type: string | null;
  monthly_premium: number;   // partc + partd
  consumer_premium: number;  // calculated_monthly_premium (SNPs) or partc+partd (MAPD)
  moop: number | null;
  moop_combined: number | null;
  annual_deductible: number;
  drug_deductible: number | null;
  star_rating: number | null;
  slice: 'MAPD non-SNP' | 'D-SNP' | 'C-SNP' | 'I-SNP';
}

function loadMapdCache(path: string): Ground[] {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return (raw.plans ?? []).map((p: any): Ground => {
    const m = parseMoopString(p.maximum_oopc);
    return {
      key: `${p.contract_id}-${p.plan_id}`,
      contract_id: p.contract_id,
      plan_id: p.plan_id,
      segment_id: String(p.segment_id ?? '0'),
      plan_name: p.name,
      carrier: p.organization_name,
      plan_type: cmsCategoryToPlanType(p.category),
      snp_type: cmsSnpBase(p.snp_type),
      monthly_premium: (p.partc_premium ?? 0) + (p.partd_premium ?? 0),
      consumer_premium: p.calculated_monthly_premium ?? ((p.partc_premium ?? 0) + (p.partd_premium ?? 0)),
      moop: m.inNet,
      moop_combined: m.combined,
      annual_deductible: parseUsd(p.annual_deductible) ?? 0,
      drug_deductible: p.drug_plan_deductible ?? null,
      star_rating: p.overall_star_rating?.rating ?? null,
      slice: 'MAPD non-SNP',
    };
  });
}
function loadSnpDetails(): Map<string, Ground & { counties: string[] }> {
  const dir = '_tmp/medicare-gov-snp/detail';
  const out = new Map<string, Ground & { counties: string[] }>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const pc = j.response?.plan_card;
    if (!pc) continue;
    const snpBase = cmsSnpBase(pc.snp_type);
    const slice: Ground['slice'] =
      snpBase === 'D-SNP' ? 'D-SNP' :
      snpBase === 'C-SNP' ? 'C-SNP' :
      snpBase === 'I-SNP' ? 'I-SNP' : 'MAPD non-SNP';
    const moopStr = pc.package_benefits?.BENEFIT_MAXIMUM_OOPC?.network_costs?.NETWORK_TYPE_NA?.cost_share
                 ?? pc.package_benefits?.BENEFIT_MAXIMUM_OOPC?.network_costs?.NETWORK_TYPE_IN_NETWORK?.cost_share;
    const m = parseMoopString(moopStr);
    const g: Ground = {
      key: `${pc.contract_id}-${pc.plan_id}`,
      contract_id: pc.contract_id,
      plan_id: pc.plan_id,
      segment_id: String(pc.segment_id ?? '0'),
      plan_name: pc.name,
      carrier: pc.organization_name,
      plan_type: cmsCategoryToPlanType(pc.category),
      snp_type: snpBase,
      monthly_premium: (pc.partc_premium ?? 0) + (pc.partd_premium ?? 0),
      consumer_premium: pc.calculated_monthly_premium ?? ((pc.partc_premium ?? 0) + (pc.partd_premium ?? 0)),
      moop: m.inNet,
      moop_combined: m.combined,
      annual_deductible: parseUsd(pc.annual_deductible) ?? 0,
      drug_deductible: pc.drug_plan_deductible ?? null,
      star_rating: pc.overall_star_rating?.rating ?? null,
      slice,
    };
    out.set(g.key, { ...g, counties: j.counties ?? [] });
  }
  return out;
}

// ─── PM ──────────────────────────────────────────────────────────
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
  consumer_premium: number;
  moop: number | null;
  moop_combined: number | null;
  annual_deductible: number;
  drug_deductible: number | null;
  star_rating: number | null;
  dsnp_eligible_tiers: any;
  sanctioned: boolean;
  nonComm: boolean;
}
async function loadNonComm() {
  const { data } = await sb.from('pm_non_commissionable_contracts').select('contract_id, plan_number');
  return {
    contracts: new Set((data ?? []).filter((r: any) => !r.plan_number).map((r: any) => r.contract_id)),
    plans:     new Set((data ?? []).filter((r: any) => r.plan_number).map((r: any) => `${r.contract_id}-${r.plan_number}`)),
  };
}
async function loadAgentPool(state: string, county: string, nc: { contracts: Set<string>; plans: Set<string> }): Promise<PmPlan[]> {
  const { data } = await sb.from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, carrier, plan_type, snp_type, monthly_premium, moop, moop_combined, annual_deductible, drug_deductible, star_rating, sanctioned, dsnp_eligible_tiers')
    .eq('state', state)
    .ilike('county_name', `%${county}%`);
  return (data ?? []).map((r: any): PmPlan => ({
    key: `${r.contract_id}-${r.plan_id}`,
    contract_id: r.contract_id,
    plan_id: r.plan_id,
    segment_id: String(r.segment_id ?? '0'),
    plan_name: r.plan_name,
    carrier: r.carrier,
    plan_type: r.plan_type,
    snp_type: r.snp_type,
    // For SNPs the consumer-facing premium is different from the raw partc+partd.
    // pm_plans doesn't have a dedicated consumer_premium column; agent-side derives
    // it in the compare screen. For D-SNPs it's $0 by convention; for others it's
    // the monthly_premium.
    monthly_premium: r.monthly_premium ?? 0,
    consumer_premium: r.snp_type === 'D-SNP' ? 0 : (r.monthly_premium ?? 0),
    moop: r.moop ?? null,
    moop_combined: r.moop_combined ?? null,
    annual_deductible: r.annual_deductible ?? 0,
    drug_deductible: r.drug_deductible ?? null,
    star_rating: r.star_rating ?? null,
    dsnp_eligible_tiers: r.dsnp_eligible_tiers,
    sanctioned: !!r.sanctioned,
    nonComm: nc.contracts.has(r.contract_id) || nc.plans.has(`${r.contract_id}-${r.plan_id}`),
  }));
}

// ─── Diff ────────────────────────────────────────────────────────
// consumer_premium is a UI-computed field (agent renders D-SNP as $0
// as a broker-facing convention). pm_plans doesn't store it, so
// removing it from the parity comparison — it's a display concern.
// The raw monthly_premium (partc+partd) IS a stored field and IS in
// the comparator.
type FieldKey =
  | 'plan_name' | 'carrier' | 'plan_type' | 'snp_type'
  | 'monthly_premium'
  | 'moop' | 'moop_combined' | 'annual_deductible'
  | 'drug_deductible' | 'star_rating';
const FIELDS: FieldKey[] = [
  'plan_name', 'carrier', 'plan_type', 'snp_type',
  'monthly_premium',
  'moop', 'moop_combined', 'annual_deductible',
  'drug_deductible', 'star_rating',
];
function starMatch(cms: any, pm: any): boolean {
  const c = cms == null ? 0 : Number(cms);
  const p = pm == null ? 0 : Number(pm);
  return c === p;
}
function drugDedMatch(cms: any, pm: any): boolean {
  const c = cms == null ? 0 : Number(cms);
  const p = pm == null ? 0 : Number(pm);
  return c === p;
}
function moopCombinedMatch(cms: any, pm: any): boolean {
  if (cms == null && pm == null) return true;
  if (cms == null || pm == null) return cms == null;
  return cms === pm;
}
function carriersEquivalent(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.trim() === b.trim()) return true;
  if (/^Blue Cross and Blue Shield of/i.test(a) && /^Blue Cross and Blue Shield of/i.test(b)) return true;
  return false;
}
function planTypeMatch(cms: string, pm: string): boolean {
  return cms === normalizePmPlanType(pm);
}
function diffPlan(cms: Ground, pm: PmPlan): Array<{ field: FieldKey; cms: any; pm: any }> {
  const out: Array<{ field: FieldKey; cms: any; pm: any }> = [];
  for (const f of FIELDS) {
    const a = (cms as any)[f];
    const b = (pm as any)[f];
    let ok: boolean;
    if (f === 'carrier') ok = carriersEquivalent(a, b);
    else if (f === 'plan_type') ok = planTypeMatch(a, b);
    else if (f === 'snp_type') ok = snpEquivalent(a, b);
    else if (f === 'moop_combined') ok = moopCombinedMatch(a, b);
    else if (f === 'star_rating') ok = starMatch(a, b);
    else if (f === 'drug_deductible') ok = drugDedMatch(a, b);
    else if (a == null && b == null) ok = true;
    else if (typeof a === 'number' && typeof b === 'number') ok = a === b;
    else if (typeof a === 'string' && typeof b === 'string') ok = a.trim() === b.trim();
    else if (a == null || b == null) ok = false;
    else ok = String(a).trim() === String(b).trim();
    if (!ok) out.push({ field: f, cms: a, pm: b });
  }
  return out;
}

// ─── Main ────────────────────────────────────────────────────────
interface CountyReport {
  county: string; state: string; fips: string;
  totals: { cms: number; pm: number; matched: number; missing: number; phantom: number };
  bySlice: Record<string, { cms: number; pm: number; matched: number }>;
  fieldStats: Record<FieldKey, { match: number; mismatch: number }>;
  missingFromPm: Array<{ key: string; plan_name: string; slice: string; reason: string }>;
  phantomInPm: Array<{ key: string; plan_name: string; snp_type: string | null }>;
  fieldDiffs: Array<{ key: string; plan_name: string; slice: string; diffs: Array<{ field: FieldKey; cms: any; pm: any }> }>;
}

async function auditCounty(t: any, nc: any, snpDetails: Map<string, Ground & { counties: string[] }>): Promise<CountyReport> {
  // CMS ground truth: MAPD from cache + SNPs (filtered to this county's SNP set).
  const cmsMapd = loadMapdCache(t.mapdCache).filter((p) => p.snp_type == null);
  const pm = await loadAgentPool(t.state, t.county, nc);
  const pmComm = pm.filter((p) => !p.sanctioned && !p.nonComm);

  // SNPs relevant to this county — those whose scrape marked them present in this county
  const cmsSnp: Ground[] = [];
  for (const [k, s] of snpDetails) {
    if (s.counties.includes(t.county)) cmsSnp.push(s);
  }
  const cmsAll = [...cmsMapd, ...cmsSnp];
  const cmsByKey = new Map(cmsAll.map((c) => [c.key, c]));

  // Agent slice: commissionable MA (exclude PDP). Split by SNP.
  const pmAudit = pmComm.filter((p) => p.plan_type !== 'PDP');
  const pmByKey = new Map(pmAudit.map((p) => [p.key, p]));

  // Missing = in CMS but not in PM audit set
  const missing: CountyReport['missingFromPm'] = [];
  for (const c of cmsAll) {
    if (pmByKey.has(c.key)) continue;
    const inFull = pm.find((p) => p.key === c.key);
    const reason = !inFull ? 'not in pm_plans'
      : inFull.sanctioned ? 'sanctioned=true'
      : inFull.nonComm ? 'in pm_non_commissionable_contracts'
      : inFull.plan_type === 'PDP' ? 'plan_type=PDP'
      : 'unknown';
    missing.push({ key: c.key, plan_name: c.plan_name, slice: c.slice, reason });
  }
  // Phantom = in PM audit but not in CMS
  const phantom: CountyReport['phantomInPm'] = [];
  for (const p of pmAudit) {
    if (!cmsByKey.has(p.key)) phantom.push({ key: p.key, plan_name: p.plan_name, snp_type: p.snp_type });
  }

  // Field diff on intersection
  const fieldStats: Record<FieldKey, { match: number; mismatch: number }> = {} as any;
  for (const f of FIELDS) fieldStats[f] = { match: 0, mismatch: 0 };
  const fieldDiffs: CountyReport['fieldDiffs'] = [];
  const bySlice: Record<string, { cms: number; pm: number; matched: number }> = {
    'MAPD non-SNP': { cms: 0, pm: 0, matched: 0 },
    'D-SNP': { cms: 0, pm: 0, matched: 0 },
    'C-SNP': { cms: 0, pm: 0, matched: 0 },
    'I-SNP': { cms: 0, pm: 0, matched: 0 },
  };
  for (const c of cmsAll) bySlice[c.slice].cms += 1;
  for (const p of pmAudit) {
    const s: string = p.snp_type === 'D-SNP' ? 'D-SNP' : p.snp_type === 'C-SNP' ? 'C-SNP' : p.snp_type === 'I-SNP' ? 'I-SNP' : 'MAPD non-SNP';
    bySlice[s].pm += 1;
  }
  let matched = 0;
  for (const c of cmsAll) {
    const p = pmByKey.get(c.key);
    if (!p) continue;
    matched += 1;
    bySlice[c.slice].matched += 1;
    const diffs = diffPlan(c, p);
    for (const f of FIELDS) {
      const isDiff = diffs.some((d) => d.field === f);
      if (isDiff) fieldStats[f].mismatch += 1;
      else fieldStats[f].match += 1;
    }
    if (diffs.length > 0) fieldDiffs.push({ key: c.key, plan_name: c.plan_name, slice: c.slice, diffs });
  }

  return {
    county: t.county, state: t.state, fips: t.fips,
    totals: { cms: cmsAll.length, pm: pmAudit.length, matched, missing: missing.length, phantom: phantom.length },
    bySlice,
    fieldStats,
    missingFromPm: missing,
    phantomInPm: phantom,
    fieldDiffs,
  };
}

async function main() {
  console.log('Phase 2 FINAL — Combined MAPD + SNP parity');
  console.log('─'.repeat(70));
  const nc = await loadNonComm();
  const snpDetails = loadSnpDetails();
  console.log(`SNP detail cache: ${snpDetails.size} plans loaded`);
  console.log(`Non-comm filter:  ${nc.contracts.size} contracts, ${nc.plans.size} plan-level entries`);

  const reports: CountyReport[] = [];
  for (const t of COUNTIES) {
    const r = await auditCounty(t, nc, snpDetails);
    reports.push(r);
    const tot = r.totals;
    console.log(`\n${t.county} ${t.state}`);
    console.log(`  CMS=${tot.cms}  PM=${tot.pm}  matched=${tot.matched}  missing=${tot.missing}  phantom=${tot.phantom}`);
    for (const s of ['MAPD non-SNP','D-SNP','C-SNP','I-SNP']) {
      const bs = r.bySlice[s];
      if (bs.cms > 0 || bs.pm > 0) console.log(`    ${s.padEnd(14)}  cms=${bs.cms}  pm=${bs.pm}  matched=${bs.matched}`);
    }
    const mSum = Object.values(r.fieldStats).reduce((s, x) => s + x.match, 0);
    const dSum = Object.values(r.fieldStats).reduce((s, x) => s + x.mismatch, 0);
    console.log(`    Field parity ${mSum}/${mSum+dSum} = ${((mSum/(mSum+dSum))*10000/100).toFixed(2)}%`);
    writeFileSync(join('_tmp', 'parity-data', `${t.state}-${t.county.toLowerCase()}-${t.fips}-FINAL.json`), JSON.stringify(r, null, 2));
  }

  // Aggregate
  const agg = { cms: 0, pm: 0, matched: 0, missing: 0, phantom: 0 };
  const fieldAgg: Record<FieldKey, { match: number; mismatch: number }> = {} as any;
  for (const f of FIELDS) fieldAgg[f] = { match: 0, mismatch: 0 };
  const sliceAgg: Record<string, { cms: number; pm: number; matched: number }> = {
    'MAPD non-SNP': { cms: 0, pm: 0, matched: 0 },
    'D-SNP': { cms: 0, pm: 0, matched: 0 },
    'C-SNP': { cms: 0, pm: 0, matched: 0 },
    'I-SNP': { cms: 0, pm: 0, matched: 0 },
  };
  for (const r of reports) {
    agg.cms += r.totals.cms; agg.pm += r.totals.pm; agg.matched += r.totals.matched;
    agg.missing += r.totals.missing; agg.phantom += r.totals.phantom;
    for (const f of FIELDS) { fieldAgg[f].match += r.fieldStats[f].match; fieldAgg[f].mismatch += r.fieldStats[f].mismatch; }
    for (const s of Object.keys(sliceAgg)) {
      sliceAgg[s].cms += r.bySlice[s].cms;
      sliceAgg[s].pm += r.bySlice[s].pm;
      sliceAgg[s].matched += r.bySlice[s].matched;
    }
  }
  console.log(`\n${'─'.repeat(70)}\nTOTALS across 5 counties`);
  console.log(`  CMS plans:  ${agg.cms}   PM plans:  ${agg.pm}   Matched:  ${agg.matched}`);
  console.log(`  Missing:    ${agg.missing}   Phantom:  ${agg.phantom}`);
  console.log(`\nPer slice:`);
  for (const s of Object.keys(sliceAgg)) {
    const bs = sliceAgg[s];
    console.log(`  ${s.padEnd(14)}  cms=${bs.cms}  pm=${bs.pm}  matched=${bs.matched}`);
  }
  console.log(`\nPer field:`);
  const totalM = Object.values(fieldAgg).reduce((s, x) => s + x.match, 0);
  const totalD = Object.values(fieldAgg).reduce((s, x) => s + x.mismatch, 0);
  for (const f of FIELDS) {
    const s = fieldAgg[f];
    const p = (s.match + s.mismatch) === 0 ? 0 : Math.round((s.match / (s.match + s.mismatch)) * 10000) / 100;
    console.log(`  ${f.padEnd(20)}  ${s.match}/${s.match + s.mismatch}  = ${p}%`);
  }
  console.log(`\n  TOTAL ${totalM}/${totalM + totalD} = ${((totalM/(totalM+totalD))*10000/100).toFixed(2)}%`);

  writeFileSync('_tmp/parity-data/_aggregate-FINAL.json', JSON.stringify({ counties: reports, totals: agg, bySlice: sliceAgg, byField: fieldAgg }, null, 2));
  console.log(`\nRaw data: _tmp/parity-data/*-FINAL.json`);
}
main().catch((e) => { console.error(e); process.exit(1); });
