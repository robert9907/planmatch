import { useEffect, useMemo, useRef, useState } from 'react';
import type { CostShare, Plan, FormularyTier } from '@/types/plans';
import type { Medication, Provider } from '@/types/session';
import type { FormularyHit } from '@/lib/formularyLookup';
import { getCachedFormulary } from '@/lib/formularyLookup';
import { startScreenShare, type ActiveShare } from '@/lib/screenShare';
import type { PharmacyMode, PlanDrugCost } from '@/lib/drugCosts';

// Scoped port of the v4 mockup. Everything lives under the `.qv4`
// root so the component's styles don't bleed into the rest of the app.
// Color tokens and typography track the mockup verbatim.
const CSS = `
.qv4 { --navy:#0d2f5e; --navy-lt:#1a4a8a; --sea:#83f0f9; --w:#fff;
  --g50:#f8f9fa; --g100:#f1f3f5; --g200:#e9ecef; --g300:#dee2e6;
  --g400:#ced4da; --g500:#adb5bd; --g600:#868e96; --g700:#495057;
  --g800:#343a40; --g900:#212529;
  --grn:#1a9c55; --grn-bg:rgba(46,204,113,.08); --grn-b:rgba(46,204,113,.25);
  --red:#d63031; --red-bg:rgba(231,76,60,.06); --red-b:rgba(231,76,60,.2);
  --amb:#e67e22;
  --fd:'Fraunces',serif; --fb:'Inter',sans-serif; --fm:'JetBrains Mono',monospace;
  font-family:var(--fb); color:var(--g900); background:var(--g50);
  -webkit-font-smoothing:antialiased;
}
.qv4 .wrap { overflow-x:auto; padding:16px 0 0; -webkit-overflow-scrolling:touch; }
.qv4 .wrap::-webkit-scrollbar { height:6px; }
.qv4 .wrap::-webkit-scrollbar-track { background:var(--g100); }
.qv4 .wrap::-webkit-scrollbar-thumb { background:var(--g400); border-radius:3px; }
.qv4 table { border-collapse:collapse; min-width:max-content; }
.qv4 th, .qv4 td { padding:8px 14px; text-align:left; vertical-align:middle;
  border-bottom:1px solid var(--g100); font-size:13px; white-space:nowrap; }
.qv4 .lc { position:sticky; left:0; z-index:10; background:var(--g50); font-weight:500;
  color:var(--g600); min-width:190px; max-width:190px; white-space:normal; }
.qv4 tr.sh td, .qv4 tr.sh th { font-size:10px; font-weight:700; text-transform:uppercase;
  letter-spacing:.08em; color:var(--navy); padding-top:18px; padding-bottom:6px;
  border-bottom:2px solid var(--navy); background:var(--g50); }
.qv4 tr.sh td { background:var(--w); }
.qv4 tr.sh td.cur-bg { background:var(--g100); }
.qv4 tr.sh td.win-bg { background:rgba(131,240,249,.06); }
.qv4 tr.tot td, .qv4 tr.tot th { font-weight:700; border-bottom:2px solid var(--g300); padding:10px 14px; }
.qv4 tr.tot th { background:var(--g100); color:var(--g900); font-size:13px; }
.qv4 tr.tot td { font-family:var(--fm); font-size:15px; }
.qv4 td { font-family:var(--fm); font-weight:500; color:var(--g800); min-width:260px; }
.qv4 td.cur-bg { background:var(--g100); }
.qv4 td.win-bg { background:rgba(131,240,249,.06); }
.qv4 td.wh { color:var(--navy); font-weight:700; }
.qv4 th.ph { padding:14px 16px; border-bottom:1px solid var(--g200); vertical-align:top;
  font-weight:400; min-width:260px; }
.qv4 th.ph.cur-bg { background:var(--g200); }
.qv4 th.ph.win-bg { background:var(--navy); color:var(--w); }
.qv4 th.ph.gb-bg { background:linear-gradient(135deg,#1a6b3a,#228B22); color:var(--w); }
.qv4 td.gb-bg { background:rgba(34,139,34,.04); }
.qv4 th.ph.med-bg { background:linear-gradient(135deg,#0d5e5e,#0d8a8a); color:var(--w); }
.qv4 td.med-bg { background:rgba(13,138,138,.04); }
.qv4 .ptag { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.08em;
  color:var(--g500); margin-bottom:3px; }
.qv4 .wtag { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.08em;
  color:var(--sea); margin-bottom:3px; }
.qv4 .mtag { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.08em;
  color:var(--sea); margin-bottom:3px; }
.qv4 .gtag { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.08em;
  color:#90EE90; margin-bottom:3px; }
.qv4 .pcar { font-size:11px; color:var(--g500); font-weight:500; margin-bottom:1px; }
.qv4 th.win-bg .pcar, .qv4 th.med-bg .pcar, .qv4 th.gb-bg .pcar { color:rgba(255,255,255,.55); }
.qv4 .pn { font-family:var(--fd); font-size:15px; font-weight:600; line-height:1.25; color:var(--g900); }
.qv4 th.win-bg .pn, .qv4 th.med-bg .pn, .qv4 th.gb-bg .pn { color:var(--w); }
.qv4 th.cur-bg .pn { color:var(--g700); }
.qv4 .pm { display:flex; align-items:center; gap:7px; margin-top:6px; }
.qv4 .pid { font-family:var(--fm); font-size:11px; color:var(--g500); }
.qv4 th.win-bg .pid, .qv4 th.med-bg .pid, .qv4 th.gb-bg .pid { color:rgba(255,255,255,.45); }
.qv4 .star { font-size:11px; font-weight:600; }
.qv4 .star.hi { color:var(--grn); } .qv4 .star.md { color:var(--amb); }
.qv4 th.win-bg .star, .qv4 th.med-bg .star { color:var(--sea); }
.qv4 th.gb-bg .star { color:#90EE90; }
.qv4 .ptyp { font-size:10px; font-weight:600; background:rgba(0,0,0,.05); border-radius:4px;
  padding:2px 6px; color:var(--g600); }
.qv4 th.win-bg .ptyp, .qv4 th.med-bg .ptyp, .qv4 th.gb-bg .ptyp {
  background:rgba(255,255,255,.12); color:rgba(255,255,255,.75);
}
.qv4 .ti { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px;
  border-radius:4px; font-size:10px; font-weight:700; font-family:var(--fm); margin-right:5px; flex-shrink:0; }
.qv4 .ti.t1, .qv4 .ti.t2, .qv4 .ti.t6 { background:#d4edda; color:#155724; }
.qv4 .ti.t3 { background:#fff3cd; color:#856404; }
.qv4 .ti.t4, .qv4 .ti.t5 { background:#f8d7da; color:#721c24; }
.qv4 .fl { display:inline-flex; gap:2px; margin-left:4px; }
.qv4 .fg { font-size:8px; font-weight:700; padding:1px 3px; border-radius:2px;
  background:rgba(243,156,18,.12); color:#b8860b; font-family:var(--fm); }
.qv4 .d { font-size:10px; font-weight:700; margin-left:5px; padding:1px 5px; border-radius:3px; font-family:var(--fm); }
.qv4 .d.s { background:var(--grn-bg); color:var(--grn); border:1px solid var(--grn-b); }
.qv4 .d.m { background:var(--red-bg); color:var(--red); border:1px solid var(--red-b); }
.qv4 .prov { display:inline-flex; align-items:center; gap:5px; font-family:var(--fb); font-size:13px; font-weight:700; }
.qv4 .prov.in { color:var(--grn); } .qv4 .prov.out { color:var(--red); }
.qv4 .pdot { width:8px; height:8px; border-radius:50%; }
.qv4 .pdot.in { background:#2ecc71; } .qv4 .pdot.out { background:var(--red); }
.qv4 tr.prov-row td, .qv4 tr.prov-row th { border-bottom:2px solid var(--g200); padding-top:12px; padding-bottom:12px; }
.qv4 .sub { font-size:11px; color:var(--g500); font-weight:400; }
.qv4 .act-cell { padding:10px 14px; vertical-align:top; }
.qv4 .abtn { display:block; width:100%; padding:9px; border-radius:7px; border:none;
  font-family:var(--fb); font-size:12px; font-weight:600; cursor:pointer; text-align:center; margin-bottom:5px; }
.qv4 .abtn.rec { background:var(--navy); color:var(--w); }
.qv4 .abtn.rec:hover { background:var(--navy-lt); }
.qv4 .win-bg .abtn.rec { background:var(--sea); color:var(--navy); }
.qv4 .abtn.sec { background:var(--g100); color:var(--g700); border:1px solid var(--g200); }
.qv4 tr.bl th, .qv4 tr.bl td { background:var(--navy); color:var(--w); border-bottom:none; padding:16px 14px;
  font-family:var(--fm); font-size:18px; font-weight:700; }
.qv4 tr.bl th { font-family:var(--fd); font-size:13px; }
.qv4 tr.bl td.tav-win { color:var(--sea); }
.qv4 tr.bl td.tav-gb { color:#90EE90; }
.qv4 tr.bl td.tav-cur { color:var(--w); }
.qv4 tr.ws th, .qv4 tr.ws td { background:var(--navy); border-bottom:none;
  font-size:11px; padding:0 14px 16px; font-weight:400; font-family:var(--fb);
  color:rgba(255,255,255,.7); white-space:normal; max-width:260px; }
.qv4 tr.ws th { color:rgba(255,255,255,.5); }
`;

type ColorBucket = 'cur' | 'win' | 'med' | 'gb' | 'plain';

interface Column {
  plan: Plan;
  bucket: ColorBucket;
  label: string; // e.g. "Current Plan", "Best Rx Match", "Lowest Medical Cost", "Healthy Profile Pick"
}

// ─── cost helpers ───────────────────────────────────────────────────

// "Dollar amounts everywhere" — never render the mockup-banned "Included"
// string. A filed copay is shown as $N; a filed coinsurance as N%;
// nothing filed (null/null) surfaces as $0 (Original Medicare default
// for the category) so totals and deltas stay computable.
function costText(cs: CostShare | null | undefined): string {
  if (!cs || (cs.copay == null && cs.coinsurance == null)) return '$0';
  if (cs.copay != null) return `$${fmtInt(cs.copay)}`;
  return `${cs.coinsurance}%`;
}

function fmtInt(n: number): string {
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}
function fmtUsd(n: number): string {
  const rounded = Math.round(n);
  return `$${rounded.toLocaleString()}`;
}
function fmtUsdSigned(diff: number): string {
  if (diff === 0) return '$0';
  const abs = Math.round(Math.abs(diff));
  return diff < 0 ? `−$${abs.toLocaleString()}` : `+$${abs.toLocaleString()}`;
}

// A plan's "dollar" cost for a service: copay when present, $0 when only
// coinsurance (we don't have a reference price to resolve percent into
// dollars). Used for delta math and medical-total sum so coinsurance
// rows don't skew comparisons in a misleading direction.
function dollarCost(cs: CostShare | null | undefined): number {
  if (!cs) return 0;
  return cs.copay ?? 0;
}

// ─── medication cost resolution (mirrors Step6QuoteDelivery) ────────

function planTierShare(plan: Plan, tier: FormularyTier | null): CostShare | null {
  if (tier == null || tier === 'excluded') return null;
  const map: Record<number, CostShare | undefined> = {
    1: plan.benefits.rx_tiers.tier_1,
    2: plan.benefits.rx_tiers.tier_2,
    3: plan.benefits.rx_tiers.tier_3,
    4: plan.benefits.rx_tiers.tier_4,
    5: plan.benefits.rx_tiers.tier_5,
  };
  return map[tier] ?? null;
}

interface ResolvedMed {
  tier: FormularyTier | null;
  copay: number | null;
  coinsurancePct: number | null;
  priorAuth: boolean;
  stepTherapy: boolean;
  quantityLimit: boolean;
  covered: boolean;
}

function resolveMed(plan: Plan, rxcui: string | null | undefined): ResolvedMed | null {
  if (!rxcui) return null;
  const hit: FormularyHit | null = getCachedFormulary(`${plan.contract_id}_${plan.plan_number}`, rxcui);
  if (!hit) return null;
  if (hit.tier === 'not_covered' || hit.tier === 'excluded') {
    return {
      tier: null,
      copay: null,
      coinsurancePct: null,
      priorAuth: hit.prior_auth,
      stepTherapy: hit.step_therapy,
      quantityLimit: hit.quantity_limit,
      covered: false,
    };
  }
  let copay = hit.copay;
  let coinsurancePct = hit.coinsurance != null ? Math.round(hit.coinsurance * 100) : null;
  if (copay == null && coinsurancePct == null) {
    const share = planTierShare(plan, hit.tier);
    if (share) {
      copay = share.copay;
      coinsurancePct = share.coinsurance;
    }
  }
  return {
    tier: hit.tier,
    copay,
    coinsurancePct,
    priorAuth: hit.prior_auth,
    stepTherapy: hit.step_therapy,
    quantityLimit: hit.quantity_limit,
    covered: true,
  };
}

interface PlanRxSummary {
  monthly: number;       // sum of copays (30-day) for covered meds
  hasCoinsurance: boolean; // any coinsurance-only med → show "~" approx
  uncovered: number;
}

function rxSummary(plan: Plan, meds: Medication[]): PlanRxSummary {
  let monthly = 0;
  let hasCoins = false;
  let uncovered = 0;
  for (const m of meds) {
    const r = resolveMed(plan, m.rxcui);
    if (!r) { uncovered += 1; continue; }
    if (!r.covered) { uncovered += 1; continue; }
    if (r.copay != null) monthly += r.copay;
    else if (r.coinsurancePct != null) hasCoins = true;
    else uncovered += 1;
  }
  return { monthly, hasCoinsurance: hasCoins, uncovered };
}

// ─── medical copay row catalog (drives the MEDICAL section) ─────────

interface MedicalRow {
  label: string;
  sub?: string;
  share: (p: Plan) => CostShare;
  // A handful of rows show as "$/day · N days" (inpatient, SNF) — the
  // row renderer looks for `unit` to append the per-day suffix and the
  // days count from a secondary source.
  unit?: 'per_day';
  inpatientDays?: boolean;
  // Rows that aren't sourced from pm_plan_benefits yet — we still
  // render them (mockup lists them) but surface the $0/Original-
  // Medicare baseline. E.g. preventive services, home health, hospice,
  // renal dialysis — Original Medicare covers these at $0 copay.
  originalMedicareZero?: boolean;
  // Original Medicare default coinsurance (20%) for Part-B-style
  // services the plan doesn't itemize; the cell shows "20%" when the
  // plan hasn't filed its own share.
  originalMedicare20?: boolean;
}

function omZero(): CostShare { return { copay: 0, coinsurance: null, description: null }; }
function om20(): CostShare { return { copay: null, coinsurance: 20, description: null }; }

const MEDICAL_ROWS: MedicalRow[] = [
  { label: 'PCP Visit', share: (p) => p.benefits.medical.primary_care },
  { label: 'Specialist Visit', share: (p) => p.benefits.medical.specialist },
  {
    label: 'Telehealth', sub: 'medical · virtual',
    share: (p) => p.benefits.medical.telehealth,
  },
  {
    label: 'Telehealth', sub: 'mental health · virtual',
    share: (p) => p.benefits.medical.telehealth,
  },
  {
    label: 'Preventive Services', sub: 'wellness visit · screenings',
    share: () => omZero(), originalMedicareZero: true,
  },
  { label: 'Lab Services', share: (p) => p.benefits.medical.lab_services },
  { label: 'Diagnostic Tests & Procedures', share: (p) => p.benefits.medical.diagnostic_tests },
  { label: 'X-Rays', share: (p) => p.benefits.medical.xray },
  {
    label: 'Diagnostic Radiology', sub: 'MRI · CT scan',
    share: (p) => p.benefits.medical.diagnostic_radiology,
  },
  {
    label: 'Therapeutic Radiology', share: (p) => p.benefits.medical.therapeutic_radiology,
  },
  { label: 'Emergency Room', share: (p) => p.benefits.medical.emergency },
  { label: 'Urgent Care', share: (p) => p.benefits.medical.urgent_care },
  {
    label: 'Outpatient Surgery', sub: 'hospital',
    share: (p) => p.benefits.medical.outpatient_surgery_hospital,
  },
  {
    label: 'Outpatient Surgery', sub: 'ambulatory surgical center',
    share: (p) => p.benefits.medical.outpatient_surgery_asc,
  },
  { label: 'Outpatient Observation', share: (p) => p.benefits.medical.outpatient_observation },
  {
    label: 'Outpatient Mental Health', sub: 'individual',
    share: (p) => p.benefits.medical.mental_health_individual,
  },
  {
    label: 'Outpatient Mental Health', sub: 'group therapy',
    share: (p) => p.benefits.medical.mental_health_group,
  },
  { label: 'Outpatient PT / OT / Speech', share: (p) => p.benefits.medical.physical_therapy },
  {
    label: 'Outpatient Rx Therapy', sub: 'infusion · injection · chemo',
    share: () => om20(), originalMedicare20: true,
  },
  {
    label: 'Part B Drugs', sub: 'chemo · insulin · other',
    share: () => om20(), originalMedicare20: true,
  },
  {
    label: 'Inpatient Hospital', sub: 'per day · max days',
    share: (p) => p.benefits.medical.inpatient, unit: 'per_day', inpatientDays: true,
  },
];

// ─── column classification ──────────────────────────────────────────

// Pick the navy/teal/green winners given a finalist pool, the currently
// active plan (if any), and the session's medication count. Everything
// that isn't assigned a bucket falls through to `plain`. Max 6 columns
// total to fit on a standard laptop screen without too much horizontal
// scroll.
function classifyColumns(
  finalists: Plan[],
  currentPlan: Plan | null,
  medicationCount: number,
): Column[] {
  const cols: Column[] = [];
  const used = new Set<string>();
  if (currentPlan) {
    cols.push({ plan: currentPlan, bucket: 'cur', label: 'Current Plan' });
    used.add(currentPlan.id);
  }

  // Candidate pool excludes current plan so we never color the pinned
  // column a second time.
  const pool = finalists.filter((p) => !used.has(p.id));

  // Best Rx Match — tier-aware approximation: lowest generic-tier copay
  // weighted sum. We don't have actual med-level data here without the
  // formulary cache, so we score using the plan's rx_tiers.tier_1..3
  // fallback. Good enough for auto-selection; the full per-drug math
  // still runs inside the rows.
  function rxScore(p: Plan): number {
    const t1 = p.benefits.rx_tiers.tier_1.copay ?? 0;
    const t2 = p.benefits.rx_tiers.tier_2.copay ?? 0;
    const t3 = p.benefits.rx_tiers.tier_3.copay ?? 0;
    const drugDed = p.drug_deductible ?? 0;
    return t1 * 2 + t2 * 2 + t3 + drugDed / 20;
  }
  const bestRx = [...pool].sort((a, b) => rxScore(a) - rxScore(b))[0];
  if (bestRx) {
    cols.push({ plan: bestRx, bucket: 'win', label: 'Best Rx Match' });
    used.add(bestRx.id);
  }

  // Lowest Medical Cost — sum of PCP/Specialist/ER/Urgent/Inpatient
  // copays (plus a few outpatient categories). MOOP works as the tie-
  // breaker so a plan with the same copay profile but lower out-of-
  // pocket ceiling wins.
  function medicalScore(p: Plan): number {
    const m = p.benefits.medical;
    return dollarCost(m.primary_care) +
      dollarCost(m.specialist) +
      dollarCost(m.emergency) +
      dollarCost(m.urgent_care) +
      dollarCost(m.inpatient) +
      dollarCost(m.outpatient_surgery_hospital) +
      dollarCost(m.outpatient_surgery_asc) +
      p.moop_in_network / 100;
  }
  const remainingAfterRx = finalists.filter((p) => !used.has(p.id));
  const lowestMed = [...remainingAfterRx].sort((a, b) => medicalScore(a) - medicalScore(b))[0];
  if (lowestMed) {
    cols.push({ plan: lowestMed, bucket: 'med', label: 'Lowest Medical Cost' });
    used.add(lowestMed.id);
  }

  // Healthy Profile Pick — only offered when the client takes fewer than
  // 3 medications (as a stand-in for "fewer than 3 distinct therapeutic
  // classes"; the session doesn't track therapeutic class directly).
  // Picks the plan with the highest Part B giveback among the rest.
  if (medicationCount < 3) {
    const remaining = finalists.filter((p) => !used.has(p.id));
    const gb = [...remaining].sort((a, b) => b.part_b_giveback - a.part_b_giveback)[0];
    if (gb && gb.part_b_giveback > 0) {
      cols.push({ plan: gb, bucket: 'gb', label: 'Healthy Profile Pick' });
      used.add(gb.id);
    }
  }

  // Fill up to 6 columns with remaining finalists in the order the
  // upstream filter engine produced.
  for (const p of finalists) {
    if (cols.length >= 6) break;
    if (used.has(p.id)) continue;
    cols.push({ plan: p, bucket: 'plain', label: p.plan_name });
    used.add(p.id);
  }
  return cols;
}

// ─── per-plan totals ────────────────────────────────────────────────

interface PlanTotals {
  rxMonthly: number;
  rxAnnual: number;
  rxHasCoins: boolean;
  medicalPerVisit: number; // sum across MEDICAL_ROWS (copay only)
  inpatientMaxStay: number; // copay * max days (5-day default)
  annualCost: number;       // rxAnnual + rx deductible
  extraBenefitsValue: number; // annual sum of benefits
  totalAnnualValue: number;   // annualCost - extraBenefits - giveback*12
}

// Inpatient per-stay benchmark — most PBP plans file tiered days
// (e.g. $375/day days 1-5, $0/day 6-90). Without access to the full
// tier schedule here we estimate a 5-day stay, which matches the
// mockup's "max stay cost" copy.
const INPATIENT_DAYS = 5;
// Annual expected-visit weighting for Copay Savings. Most brokers quote
// a one-visit-per-service baseline; the mockup echoes "$590/visit".
// Keeping weight=1 across the board preserves that interpretation.

function computeTotals(plan: Plan, meds: Medication[]): PlanTotals {
  const rx = rxSummary(plan, meds);
  const rxMonthly = rx.monthly;
  const rxAnnual = rxMonthly * 12;

  let medicalPerVisit = 0;
  for (const row of MEDICAL_ROWS) {
    if (row.label === 'Inpatient Hospital') continue; // counted separately
    medicalPerVisit += dollarCost(row.share(plan));
  }

  const inpatientCopay = dollarCost(plan.benefits.medical.inpatient);
  const inpatientMaxStay = inpatientCopay * INPATIENT_DAYS;

  const annualCost = rxAnnual + (plan.drug_deductible ?? 0);

  const b = plan.benefits;
  const extraBenefitsValue =
    b.dental.annual_max +
    b.vision.eyewear_allowance_year +
    b.hearing.aid_allowance_year +
    b.otc.allowance_per_quarter * 4 +
    b.food_card.allowance_per_month * 12;

  const giveback = plan.part_b_giveback * 12;
  const totalAnnualValue = annualCost - extraBenefitsValue - giveback;

  return {
    rxMonthly,
    rxAnnual,
    rxHasCoins: rx.hasCoinsurance,
    medicalPerVisit,
    inpatientMaxStay,
    annualCost,
    extraBenefitsValue,
    totalAnnualValue,
  };
}

// ─── "Why switch?" plain-English copy ───────────────────────────────
//
// Built from concrete deltas vs the baseline column (current plan if
// provided, otherwise the first non-baseline finalist). Lists up to 4
// standout reasons. No filler copy — if nothing stands out we fall back
// to listing premium + MOOP.
function whySwitch(col: Column, baseline: Plan | null, totals: PlanTotals, baselineTotals: PlanTotals | null, medicationCount: number): string {
  if (col.bucket === 'cur') return 'Current plan';
  const reasons: string[] = [];
  if (baseline && baselineTotals) {
    if (totals.rxAnnual < baselineTotals.rxAnnual - 20) {
      reasons.push(`Lower Rx cost (saves $${Math.round(baselineTotals.rxAnnual - totals.rxAnnual)}/yr)`);
    }
    const moopSavings = baseline.moop_in_network - col.plan.moop_in_network;
    if (moopSavings >= 1000) {
      reasons.push(`$${Math.round(moopSavings / 1000)}K lower MOOP`);
    }
  }
  const b = col.plan.benefits;
  if (b.otc.allowance_per_quarter > 0) reasons.push(`$${b.otc.allowance_per_quarter * 4} OTC`);
  if (b.food_card.allowance_per_month > 0) reasons.push(`$${b.food_card.allowance_per_month * 12} food card`);
  if (b.transportation.rides_per_year > 0) reasons.push(`${b.transportation.rides_per_year} transport trips`);
  if (col.plan.part_b_giveback > 0) reasons.push(`$${col.plan.part_b_giveback}/mo Part B giveback`);
  if (col.bucket === 'gb' && medicationCount < 3) {
    reasons.push('healthy client unlikely to hit copays · ⚠ re-evaluate at AEP');
  }
  if (reasons.length === 0) {
    reasons.push(`$${col.plan.premium}/mo premium`);
    reasons.push(`$${col.plan.moop_in_network.toLocaleString()} MOOP`);
  }
  return reasons.slice(0, 5).join(' · ');
}

// ─── PROPS + COMPONENT ──────────────────────────────────────────────

interface QuoteDeliveryV4Props {
  finalists: Plan[];
  currentPlan: Plan | null;
  medications: Medication[];
  providers: Provider[];
  recommendation: string | null;
  onRecommend: (id: string | null) => void;
  onCopy: (plan: Plan) => void;
  onOpenSunfire: (plan: Plan) => void;
  formularyTick: number; // parent re-renders on tick bumps
  // Screen-share context. Button is hidden when clientPhone is empty
  // so the broker isn't prompted to pick a screen they can't SMS.
  clientPhone?: string;
  clientFirstName?: string;
  brokerName?: string;
  // Live Medicare.gov drug-cost data indexed by Plan.id and a few
  // normalized variants (see useDrugCosts). When present, overrides
  // the tier-based rxSummary() for the Total Rx Cost + Annual Cost +
  // Total Annual Value rows.
  planDrugCosts?: Record<string, PlanDrugCost>;
  pharmacyMode?: PharmacyMode;
  onPharmacyModeChange?: (mode: PharmacyMode) => void;
  drugCostsLoading?: boolean;
  drugCostsSource?: string | null;
  drugCostsError?: string | null;
}

export function QuoteDeliveryV4({
  finalists,
  currentPlan,
  medications,
  providers,
  recommendation,
  onRecommend,
  onCopy,
  onOpenSunfire,
  formularyTick,
  clientPhone,
  clientFirstName,
  brokerName,
  planDrugCosts,
  pharmacyMode,
  onPharmacyModeChange,
  drugCostsLoading,
  drugCostsSource,
  drugCostsError,
}: QuoteDeliveryV4Props) {
  // Re-subscribing to formularyTick keeps every memo below re-evaluating
  // as bulk formulary responses land. Without it the per-drug cells
  // would freeze on whatever cache snapshot the first render saw.
  void formularyTick;

  const columns = useMemo(
    () => classifyColumns(finalists, currentPlan, medications.length),
    [finalists, currentPlan, medications.length],
  );
  const baseTotals = useMemo(
    () => columns.map((c) => computeTotals(c.plan, medications)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns, medications, formularyTick],
  );
  // Overlay with live Medicare.gov costs when available. Medicare.gov's
  // annual figure already includes the Rx deductible, so we replace
  // annualCost outright and recompute the bottom-line total.
  const totals = useMemo(
    () => columns.map((c, i) => overrideWithLiveRx(baseTotals[i], c.plan, planDrugCosts)),
    [columns, baseTotals, planDrugCosts],
  );
  const baseline = currentPlan ?? columns[0]?.plan ?? null;
  const baselineIdx = columns.findIndex((c) => c.plan.id === baseline?.id);
  const baselineTotals = baselineIdx >= 0 ? totals[baselineIdx] : null;

  if (columns.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: '#868e96', fontSize: 13 }}>
        No finalists yet — complete Step 5 Benefit Filters so the funnel can narrow the pool.
      </div>
    );
  }

  const primaryProvider = providers[0] ?? null;

  return (
    <div className="qv4">
      <style>{CSS}</style>
      <ScreenShareBar
        clientPhone={clientPhone}
        clientFirstName={clientFirstName}
        brokerName={brokerName}
      />
      {onPharmacyModeChange && (
        <PharmacyModeBar
          mode={pharmacyMode ?? 'retail'}
          onChange={onPharmacyModeChange}
          loading={drugCostsLoading ?? false}
          source={drugCostsSource ?? null}
          error={drugCostsError ?? null}
          medsCount={medications.length}
        />
      )}
      <div className="wrap">
        <table>
          <thead>
            <tr>
              <th
                className="lc"
                style={{
                  fontFamily: 'Fraunces, serif',
                  fontSize: 18,
                  fontWeight: 700,
                  color: '#0d2f5e',
                  padding: '16px 14px',
                  borderBottom: '1px solid #e9ecef',
                }}
              >
                Quote Comparison
              </th>
              {columns.map((col) => (
                <PlanHeaderCell key={col.plan.id} col={col} />
              ))}
            </tr>
          </thead>
          <tbody>
            {/* YOUR MEDICATIONS */}
            <SectionRow heading="Your Medications" columns={columns} />
            {medications.map((med) => (
              <MedRow
                key={med.id}
                med={med}
                columns={columns}
                baselineIdx={baselineIdx}
              />
            ))}
            <TotalRow
              label="Total Rx Cost"
              columns={columns}
              renderValue={(_col, idx) => {
                const t = totals[idx];
                const prefix = t.rxHasCoins ? '~' : '';
                const delta =
                  baselineTotals && idx !== baselineIdx
                    ? t.rxAnnual - baselineTotals.rxAnnual
                    : 0;
                return (
                  <>
                    {prefix}${t.rxMonthly.toFixed(0)}/mo · {prefix}{fmtUsd(t.rxAnnual)}/yr
                    {baselineIdx !== idx && delta !== 0 && (
                      <span className={`d ${delta < 0 ? 's' : 'm'}`}>{fmtUsdSigned(delta)}</span>
                    )}
                  </>
                );
              }}
              baselineIdx={baselineIdx}
            />

            {/* PROVIDER */}
            {primaryProvider && (
              <tr className="prov-row">
                <th className="lc" style={{ fontWeight: 600, color: '#343a40' }}>
                  {primaryProvider.name}
                  {primaryProvider.specialty && (
                    <>
                      <br />
                      <span className="sub">{primaryProvider.specialty}</span>
                    </>
                  )}
                </th>
                {columns.map((col) => {
                  const status = primaryProvider.networkStatus?.[col.plan.id];
                  const inNet = status === 'in' || status === undefined;
                  const label = status === 'out' ? 'Not Found' : 'In-Network';
                  return (
                    <td key={col.plan.id} className={bgClass(col.bucket)}>
                      <span className={`prov ${inNet ? 'in' : 'out'}`}>
                        <span className={`pdot ${inNet ? 'in' : 'out'}`} />
                        {label}
                      </span>
                    </td>
                  );
                })}
              </tr>
            )}

            {/* MEDICAL COPAYS — no section heading (mockup chains straight in) */}
            {MEDICAL_ROWS.map((row, i) => (
              <CopayRow
                key={`${row.label}-${row.sub ?? i}`}
                row={row}
                columns={columns}
                baselineIdx={baselineIdx}
              />
            ))}
            <TotalRow
              label="Inpatient Total"
              sub="max stay cost"
              columns={columns}
              renderValue={(_col, idx) => {
                const val = totals[idx].inpatientMaxStay;
                const delta =
                  baselineTotals && idx !== baselineIdx
                    ? val - baselineTotals.inpatientMaxStay
                    : 0;
                return (
                  <>
                    {fmtUsd(val)}
                    {baselineIdx !== idx && delta !== 0 && (
                      <span className={`d ${delta < 0 ? 's' : 'm'}`}>{fmtUsdSigned(delta)}</span>
                    )}
                  </>
                );
              }}
              baselineIdx={baselineIdx}
            />
            {/* Skilled Nursing + a few more rows the mockup lists at the end */}
            <CopayRow
              row={{
                label: 'Skilled Nursing Facility',
                sub: 'per day · max days',
                share: () => omZero(),
                originalMedicareZero: true,
              }}
              columns={columns}
              baselineIdx={baselineIdx}
              suffix=" / day · 100 days"
            />
            <TotalRow
              label="Copay Savings"
              sub="per visit vs current"
              columns={columns}
              renderValue={(_col, idx) => {
                if (!baselineTotals || idx === baselineIdx) {
                  return <>{fmtUsd(totals[idx].medicalPerVisit)}/visit</>;
                }
                const delta = totals[idx].medicalPerVisit - baselineTotals.medicalPerVisit;
                const positive = delta < 0; // lower is better
                return (
                  <span style={{ color: positive ? '#1a9c55' : '#d63031', fontWeight: 700 }}>
                    {fmtUsdSigned(delta)}/visit
                    <span className={`d ${positive ? 's' : 'm'}`}>{positive ? '✓' : '✗'}</span>
                  </span>
                );
              }}
              baselineIdx={baselineIdx}
            />

            {/* PLAN COSTS */}
            <SectionRow heading="Plan Costs" columns={columns} />
            <PlainRow
              label="Monthly Premium"
              columns={columns}
              render={(p) => `$${p.premium}/mo`}
            />
            <PlainRow
              label="MOOP In-Network"
              columns={columns}
              render={(p) => fmtUsd(p.moop_in_network)}
              numericDelta={(p) => p.moop_in_network}
              baseline={baseline}
              baselineIdx={baselineIdx}
              lowerIsBetter
            />
            <PlainRow
              label="MOOP Out-of-Network"
              columns={columns}
              render={(p) =>
                p.moop_out_of_network != null ? fmtUsd(p.moop_out_of_network) : 'N/A'
              }
            />
            <PlainRow
              label="Medical Deductible"
              columns={columns}
              render={(p) => (p.annual_deductible != null ? fmtUsd(p.annual_deductible) : '$0')}
            />
            <PlainRow
              label="Rx Deductible"
              columns={columns}
              render={(p) => (p.drug_deductible != null ? fmtUsd(p.drug_deductible) : '$0')}
              numericDelta={(p) => p.drug_deductible ?? 0}
              baseline={baseline}
              baselineIdx={baselineIdx}
              lowerIsBetter
            />
            <PlainRow
              label="Star Rating"
              columns={columns}
              render={(p) => `${p.star_rating} ★`}
            />
            <TotalRow
              label="Annual Cost"
              sub="Rx + deductible"
              columns={columns}
              renderValue={(_col, idx) => {
                const val = totals[idx].annualCost;
                const delta =
                  baselineTotals && idx !== baselineIdx ? val - baselineTotals.annualCost : 0;
                return (
                  <>
                    {fmtUsd(val)}/yr
                    {baselineIdx !== idx && delta !== 0 && (
                      <span className={`d ${delta < 0 ? 's' : 'm'}`}>{fmtUsdSigned(delta)}</span>
                    )}
                  </>
                );
              }}
              baselineIdx={baselineIdx}
            />

            {/* EXTRA BENEFITS */}
            <SectionRow heading="Extra Benefits" columns={columns} />
            <PlainRow
              label="Routine Dental"
              sub="exams · cleanings · X-rays"
              columns={columns}
              render={() => '$0 copay'}
            />
            <PlainRow
              label="Comprehensive Dental"
              sub="fillings · crowns · root canals"
              columns={columns}
              render={(p) => `${fmtUsd(p.benefits.dental.annual_max)}/yr max`}
              numericDelta={(p) => p.benefits.dental.annual_max}
              baseline={baseline}
              baselineIdx={baselineIdx}
              lowerIsBetter={false}
            />
            <PlainRow
              label="Routine Eye Exam"
              columns={columns}
              render={() => '$0 · 1/yr'}
            />
            <PlainRow
              label="Eyewear Allowance"
              sub="frames · contacts · lenses"
              columns={columns}
              render={(p) => `${fmtUsd(p.benefits.vision.eyewear_allowance_year)}/yr`}
              numericDelta={(p) => p.benefits.vision.eyewear_allowance_year}
              baseline={baseline}
              baselineIdx={baselineIdx}
              lowerIsBetter={false}
            />
            <PlainRow
              label="Routine Hearing Exam"
              columns={columns}
              render={() => '$0 · 1/yr'}
            />
            <PlainRow
              label="Hearing Aid Allowance"
              sub="per aid · max 2/yr"
              columns={columns}
              render={(p) => `${fmtUsd(p.benefits.hearing.aid_allowance_year)}/yr`}
              numericDelta={(p) => p.benefits.hearing.aid_allowance_year}
              baseline={baseline}
              baselineIdx={baselineIdx}
              lowerIsBetter={false}
            />
            <PlainRow
              label="OTC Allowance"
              columns={columns}
              render={(p) =>
                `${fmtUsd(p.benefits.otc.allowance_per_quarter)}/qtr · ${fmtUsd(
                  p.benefits.otc.allowance_per_quarter * 4,
                )}/yr`
              }
              numericDelta={(p) => p.benefits.otc.allowance_per_quarter * 4}
              baseline={baseline}
              baselineIdx={baselineIdx}
              lowerIsBetter={false}
            />
            <PlainRow
              label="Food / Grocery Card"
              columns={columns}
              render={(p) =>
                `${fmtUsd(p.benefits.food_card.allowance_per_month)}/mo · ${fmtUsd(
                  p.benefits.food_card.allowance_per_month * 12,
                )}/yr`
              }
              numericDelta={(p) => p.benefits.food_card.allowance_per_month * 12}
              baseline={baseline}
              baselineIdx={baselineIdx}
              lowerIsBetter={false}
            />
            <PlainRow
              label="Fitness / Gym"
              columns={columns}
              render={(p) => p.benefits.fitness.program ?? (p.benefits.fitness.enabled ? 'Included' : '$0')}
            />
            <PlainRow
              label="Transportation"
              sub="non-emergency trips/yr"
              columns={columns}
              render={(p) =>
                p.benefits.transportation.rides_per_year > 0
                  ? `${p.benefits.transportation.rides_per_year} trips/yr`
                  : '0 trips'
              }
              numericDelta={(p) => p.benefits.transportation.rides_per_year}
              baseline={baseline}
              baselineIdx={baselineIdx}
              lowerIsBetter={false}
              suffixTransport
            />
            <PlainRow
              label="Part B Giveback"
              columns={columns}
              render={(p) =>
                `${p.part_b_giveback > 0 ? `$${p.part_b_giveback}/mo · $${p.part_b_giveback * 12}/yr` : '$0/mo · $0/yr'}`
              }
              numericDelta={(p) => p.part_b_giveback * 12}
              baseline={baseline}
              baselineIdx={baselineIdx}
              lowerIsBetter={false}
            />
            <TotalRow
              label="Extra Benefits Value"
              sub="annual vs current"
              columns={columns}
              renderValue={(_col, idx) => {
                const val = totals[idx].extraBenefitsValue;
                const delta =
                  baselineTotals && idx !== baselineIdx ? val - baselineTotals.extraBenefitsValue : 0;
                return (
                  <>
                    {fmtUsd(val)}/yr
                    {baselineIdx !== idx && delta !== 0 && (
                      <span className={`d ${delta >= 0 ? 's' : 'm'}`}>{fmtUsdSigned(delta)}</span>
                    )}
                  </>
                );
              }}
              baselineIdx={baselineIdx}
            />

            {/* BOTTOM LINE — navy band with Total Annual Value + Why Switch */}
            <tr className="bl">
              <th className="lc" style={{ background: '#0d2f5e', color: '#fff', borderBottom: 'none' }}>
                Total Annual Value
                <br />
                <span style={{ fontSize: 11, fontWeight: 400, color: 'rgba(255,255,255,.6)' }}>
                  Rx cost + deductible − benefits − giveback
                </span>
              </th>
              {columns.map((col, idx) => {
                const val = totals[idx].totalAnnualValue;
                const isBase = idx === baselineIdx;
                const savings =
                  !isBase && baselineTotals ? baselineTotals.totalAnnualValue - val : 0;
                const cls =
                  col.bucket === 'gb'
                    ? 'tav-gb'
                    : col.bucket === 'win' || col.bucket === 'med'
                      ? 'tav-win'
                      : isBase
                        ? 'tav-cur'
                        : '';
                return (
                  <td key={col.plan.id} className={cls}>
                    {val < 0 ? '−' : ''}{fmtUsd(Math.abs(val))}/yr
                    {!isBase && savings !== 0 && (
                      <span className="d s" style={{ fontSize: 12, marginLeft: 8 }}>
                        {savings > 0 ? `saves ${fmtUsd(savings)}` : `+${fmtUsd(Math.abs(savings))}`}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
            <tr className="ws">
              <th className="lc" style={{ color: 'rgba(255,255,255,.5)' }}>
                Why switch?
              </th>
              {columns.map((col, idx) => (
                <td key={col.plan.id}>
                  {whySwitch(col, baseline, totals[idx], baselineTotals, medications.length)}
                </td>
              ))}
            </tr>

            {/* ACTIONS */}
            <tr>
              <th className="lc" />
              {columns.map((col) => (
                <td key={col.plan.id} className={`act-cell ${bgClass(col.bucket)}`}>
                  {col.bucket === 'cur' ? (
                    <button type="button" className="abtn sec">
                      Keep Current Plan
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="abtn rec"
                        onClick={() =>
                          onRecommend(recommendation === col.plan.id ? null : col.plan.id)
                        }
                        style={
                          col.bucket === 'gb'
                            ? { background: '#228B22', color: '#fff' }
                            : col.bucket === 'win'
                              ? { background: '#83f0f9', color: '#0d2f5e' }
                              : undefined
                        }
                      >
                        {recommendation === col.plan.id
                          ? '✓ Recommended'
                          : col.bucket === 'gb'
                            ? 'Recommend (Healthy)'
                            : col.bucket === 'win'
                              ? '✓ Recommend This Plan'
                              : 'Recommend'}
                      </button>
                      <button
                        type="button"
                        className="abtn sec"
                        onClick={() => onOpenSunfire(col.plan)}
                      >
                        Open SunFire →
                      </button>
                      <button
                        type="button"
                        className="abtn sec"
                        onClick={() => onCopy(col.plan)}
                      >
                        Copy client info
                      </button>
                    </>
                  )}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── sub-components ─────────────────────────────────────────────────

function PlanHeaderCell({ col }: { col: Column }) {
  const tagByBucket: Record<ColorBucket, { cls: string; text: string }> = {
    cur: { cls: 'ptag', text: '📌 Current Plan' },
    win: { cls: 'wtag', text: '⭐ Best Rx Match' },
    med: { cls: 'mtag', text: '🏥 Lowest Medical Cost' },
    gb: { cls: 'gtag', text: '💰 Healthy Profile Pick' },
    plain: { cls: 'ptag', text: '' },
  };
  const tag = tagByBucket[col.bucket];
  const stars = col.plan.star_rating;
  const starClass = stars >= 4.5 ? 'hi' : stars >= 4 ? 'md' : '';
  return (
    <th className={`ph ${bgClass(col.bucket)}`}>
      {tag.text ? <div className={tag.cls}>{tag.text}</div> : <div style={{ height: 13 }} />}
      <div className="pcar">{col.plan.carrier}</div>
      <div className="pn">{col.plan.plan_name}</div>
      <div className="pm">
        <span className="pid">
          {col.plan.contract_id}-{col.plan.plan_number}
        </span>
        <span className={`star ${starClass}`}>{stars}★</span>
        <span className="ptyp">{col.plan.plan_type}</span>
      </div>
      {col.bucket === 'gb' && (
        <div
          style={{
            marginTop: 6,
            fontSize: 9,
            fontWeight: 600,
            color: '#FFD700',
            background: 'rgba(255,215,0,.15)',
            border: '1px solid rgba(255,215,0,.3)',
            borderRadius: 4,
            padding: '2px 6px',
            display: 'inline-block',
          }}
        >
          ⚠ RE-EVALUATE AT AEP
        </div>
      )}
    </th>
  );
}

function SectionRow({ heading, columns }: { heading: string; columns: Column[] }) {
  return (
    <tr className="sh">
      <th className="lc">{heading}</th>
      {columns.map((col) => (
        <td key={col.plan.id} className={bgClass(col.bucket)} />
      ))}
    </tr>
  );
}

function MedRow({
  med,
  columns,
  baselineIdx,
}: {
  med: Medication;
  columns: Column[];
  baselineIdx: number;
}) {
  const baseResolved =
    baselineIdx >= 0 ? resolveMed(columns[baselineIdx].plan, med.rxcui) : null;
  const baseCopay = baseResolved?.copay ?? null;
  return (
    <tr>
      <th className="lc">
        {med.name}
        {med.strength && (
          <>
            {' '}
            {med.strength}
          </>
        )}
        <br />
        <span className="sub">30-day</span>
      </th>
      {columns.map((col, idx) => {
        const r = resolveMed(col.plan, med.rxcui);
        const cls = bgClass(col.bucket);
        if (!r) {
          return (
            <td key={col.plan.id} className={cls}>
              …
            </td>
          );
        }
        if (!r.covered) {
          return (
            <td key={col.plan.id} className={cls} style={{ color: '#d63031', fontWeight: 700 }}>
              Not covered
            </td>
          );
        }
        const tierN = r.tier ?? 0;
        const tierCls = `ti t${tierN || 1}`;
        const costStr = r.copay != null ? `$${r.copay}` : r.coinsurancePct != null ? `${r.coinsurancePct}%` : '$0';
        let delta: { text: string; dir: 's' | 'm' } | null = null;
        if (idx !== baselineIdx && baseCopay != null && r.copay != null && r.copay !== baseCopay) {
          const diff = r.copay - baseCopay;
          delta = { text: fmtUsdSigned(diff), dir: diff < 0 ? 's' : 'm' };
        }
        const emphasize = col.bucket === 'win' && idx !== baselineIdx && r.copay != null && baseCopay != null && r.copay < baseCopay;
        return (
          <td key={col.plan.id} className={`${cls} ${emphasize ? 'wh' : ''}`}>
            <span className={tierCls}>{tierN}</span>
            {costStr}
            {(r.priorAuth || r.stepTherapy || r.quantityLimit) && (
              <span className="fl">
                {r.priorAuth && <span className="fg">PA</span>}
                {r.stepTherapy && <span className="fg">ST</span>}
                {r.quantityLimit && <span className="fg">QL</span>}
              </span>
            )}
            {delta && <span className={`d ${delta.dir}`}>{delta.text}</span>}
          </td>
        );
      })}
    </tr>
  );
}

function CopayRow({
  row,
  columns,
  baselineIdx,
  suffix,
}: {
  row: MedicalRow;
  columns: Column[];
  baselineIdx: number;
  suffix?: string;
}) {
  const baseCost = baselineIdx >= 0 ? dollarCost(row.share(columns[baselineIdx].plan)) : null;
  const baseHasPct = baselineIdx >= 0 ? row.share(columns[baselineIdx].plan).coinsurance != null : false;
  return (
    <tr>
      <th className="lc">
        {row.label}
        {row.sub && (
          <>
            <br />
            <span className="sub">{row.sub}</span>
          </>
        )}
      </th>
      {columns.map((col, idx) => {
        const cs = row.share(col.plan);
        const text = costText(cs);
        const planCopay = cs.copay;
        let deltaText: string | null = null;
        let deltaDir: 's' | 'm' | null = null;
        // Only show delta between two copay values (apples to apples).
        // Percent-to-dollar comparisons don't have a common baseline.
        if (
          baseCost != null &&
          !baseHasPct &&
          idx !== baselineIdx &&
          planCopay != null &&
          planCopay !== baseCost
        ) {
          const diff = planCopay - baseCost;
          deltaText = fmtUsdSigned(diff);
          deltaDir = diff < 0 ? 's' : 'm';
        }
        let suffixOut = '';
        if (suffix) suffixOut = suffix;
        else if (row.unit === 'per_day') suffixOut = '/day · 5 days';
        const emphasize = col.bucket === 'win' && deltaDir === 's';
        return (
          <td key={col.plan.id} className={`${bgClass(col.bucket)} ${emphasize ? 'wh' : ''}`}>
            {text}
            {suffixOut}
            {deltaText && <span className={`d ${deltaDir}`}>{deltaText}</span>}
          </td>
        );
      })}
    </tr>
  );
}

function PlainRow({
  label,
  sub,
  columns,
  render,
  numericDelta,
  baseline,
  baselineIdx,
  lowerIsBetter,
  suffixTransport,
}: {
  label: string;
  sub?: string;
  columns: Column[];
  render: (plan: Plan) => string;
  numericDelta?: (plan: Plan) => number;
  baseline?: Plan | null;
  baselineIdx?: number;
  lowerIsBetter?: boolean;
  suffixTransport?: boolean;
}) {
  const baseVal = baseline && numericDelta ? numericDelta(baseline) : null;
  return (
    <tr>
      <th className="lc">
        {label}
        {sub && (
          <>
            <br />
            <span className="sub">{sub}</span>
          </>
        )}
      </th>
      {columns.map((col, idx) => {
        const text = render(col.plan);
        let deltaText: string | null = null;
        let deltaDir: 's' | 'm' | null = null;
        if (numericDelta && baseVal != null && idx !== baselineIdx) {
          const v = numericDelta(col.plan);
          const diff = v - baseVal;
          if (diff !== 0) {
            const good = lowerIsBetter ? diff < 0 : diff > 0;
            deltaDir = good ? 's' : 'm';
            if (suffixTransport) {
              deltaText = diff > 0 ? `+${diff}` : `${diff}`;
            } else {
              deltaText = fmtUsdSigned(diff);
            }
          }
        }
        const emphasize = col.bucket === 'win' && deltaDir === 's';
        return (
          <td key={col.plan.id} className={`${bgClass(col.bucket)} ${emphasize ? 'wh' : ''}`}>
            {text}
            {deltaText && <span className={`d ${deltaDir}`}>{deltaText}</span>}
          </td>
        );
      })}
    </tr>
  );
}

function TotalRow({
  label,
  sub,
  columns,
  renderValue,
  baselineIdx,
}: {
  label: string;
  sub?: string;
  columns: Column[];
  renderValue: (col: Column, idx: number) => React.ReactNode;
  baselineIdx: number;
}) {
  return (
    <tr className="tot">
      <th className="lc">
        {label}
        {sub && (
          <>
            <br />
            <span className="sub" style={{ fontWeight: 400 }}>
              {sub}
            </span>
          </>
        )}
      </th>
      {columns.map((col, idx) => (
        <td
          key={col.plan.id}
          className={bgClass(col.bucket)}
          style={{
            color:
              col.bucket === 'win' || col.bucket === 'med'
                ? '#0d2f5e'
                : idx === baselineIdx
                  ? '#343a40'
                  : undefined,
          }}
        >
          {renderValue(col, idx)}
        </td>
      ))}
    </tr>
  );
}

function bgClass(bucket: ColorBucket): string {
  switch (bucket) {
    case 'cur': return 'cur-bg';
    case 'win': return 'win-bg';
    case 'med': return 'med-bg';
    case 'gb': return 'gb-bg';
    default: return '';
  }
}

// ─── Screen share bar ───────────────────────────────────────────────
//
// Lives above the comparison table. Single button that toggles between
// "Share Screen" and "Stop Sharing · MM:SS" with a red pulsing dot when
// active. Under the hood: getDisplayMedia → Twilio Video room → SMS
// link to the client's phone. The server caps at 30-min idle and also
// exposes a /api/screen-share-stop belt-and-suspenders cleanup.

function ScreenShareBar({
  clientPhone,
  clientFirstName,
  brokerName,
}: {
  clientPhone?: string;
  clientFirstName?: string;
  brokerName?: string;
}) {
  const [active, setActive] = useState<ActiveShare | null>(null);
  const [status, setStatus] = useState<'idle' | 'starting' | 'active' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [smsFailed, setSmsFailed] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef<number>(0);

  // Drive the MM:SS counter on the active button. Resets to 0 when the
  // share ends so the next start doesn't inherit a stale timer.
  useEffect(() => {
    if (status !== 'active') {
      setElapsed(0);
      return;
    }
    startedAtRef.current = Date.now();
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [status]);

  // Belt-and-suspenders: if the user navigates away from the app while
  // sharing, tear the room down so the viewer doesn't see a frozen
  // final frame for 30s.
  useEffect(() => {
    if (!active) return;
    function onUnload() { void active!.stop('unload'); }
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [active]);

  async function onStart() {
    if (!clientPhone) {
      setMessage('Add the client phone on Step 1 before sharing.');
      setStatus('error');
      return;
    }
    setStatus('starting');
    setMessage(null);
    setSmsFailed(false);
    setLink(null);
    try {
      const { active: a, share } = await startScreenShare({
        clientPhone,
        clientFirstName,
        brokerName,
        onEnded: (reason) => {
          setActive(null);
          setStatus('idle');
          if (reason === 'idle_timeout') setMessage('Auto-stopped after 30 minutes.');
          else if (reason === 'browser_stop') setMessage('Stopped from the browser control.');
          else setMessage(null);
        },
      });
      setActive(a);
      setLink(share.link);
      setSmsFailed(share.smsFailed);
      setStatus('active');
      if (share.smsFailed) {
        setMessage(`SMS didn't send — read aloud: ${share.link}`);
      } else {
        setMessage(`Texted ${clientFirstName || 'client'} at ${clientPhone}`);
      }
    } catch (err) {
      console.error('[screenShare] start failed', err);
      setStatus('error');
      const msg =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Permission denied — pick a tab or window to share.'
          : (err as Error).message;
      setMessage(msg);
    }
  }

  async function onStop() {
    if (active) await active.stop('manual');
  }

  const isActive = status === 'active';
  const phoneMissing = !clientPhone;
  const label = isActive
    ? `Stop Sharing · ${formatElapsed(elapsed)}`
    : status === 'starting'
      ? 'Starting…'
      : 'Share Screen';

  return (
    <div
      className="qv4-share"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        marginBottom: 8,
        background: isActive ? '#fff5f5' : '#f8f9fa',
        border: `1px solid ${isActive ? '#d63031' : '#e9ecef'}`,
        borderRadius: 10,
        fontFamily: 'Inter, sans-serif',
      }}
    >
      <button
        type="button"
        onClick={isActive ? onStop : onStart}
        disabled={status === 'starting' || phoneMissing}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 16px',
          borderRadius: 8,
          border: 'none',
          background: isActive ? '#d63031' : '#0d2f5e',
          color: '#fff',
          fontFamily: 'Inter, sans-serif',
          fontSize: 13,
          fontWeight: 600,
          cursor: phoneMissing ? 'not-allowed' : 'pointer',
          opacity: phoneMissing || status === 'starting' ? 0.7 : 1,
        }}
      >
        {isActive && <RecordingDot />}
        {label}
      </button>
      <div style={{ fontSize: 12, color: '#495057', flex: 1 }}>
        {phoneMissing ? (
          <span style={{ color: '#868e96' }}>
            Add the client phone on Step 1 to enable screen share.
          </span>
        ) : isActive ? (
          <>
            <div style={{ fontWeight: 600 }}>
              Sharing with {clientFirstName || 'client'} · {clientPhone}
            </div>
            {message && <div style={{ color: smsFailed ? '#d63031' : '#1a9c55' }}>{message}</div>}
            {link && (
              <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#868e96' }}>
                {link}
              </div>
            )}
          </>
        ) : status === 'error' ? (
          <span style={{ color: '#d63031' }}>{message}</span>
        ) : (
          <>
            <div>Walk {clientFirstName || 'the client'} through the quote on their phone.</div>
            <div style={{ color: '#868e96' }}>
              Opens a browser picker → texts {clientPhone} a one-tap link.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RecordingDot() {
  return (
    <>
      <style>
        {`@keyframes qv4-pulse { 0%,100% { opacity:1 } 50% { opacity:.3 } }`}
      </style>
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 0 0 2px rgba(255,255,255,.35)',
          animation: 'qv4-pulse 1.2s ease-in-out infinite',
        }}
      />
    </>
  );
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Live drug cost override ────────────────────────────────────────
//
// When Medicare.gov has returned real numbers for a plan, replace the
// tier-based rxSummary estimates so every downstream row (Total Rx
// Cost, Annual Cost, Total Annual Value) renders dollars-for-dollars
// the same figures the client would see on Plan Finder.

function lookupLivePlanCost(
  plan: Plan,
  map: Record<string, PlanDrugCost> | undefined,
): PlanDrugCost | null {
  if (!map) return null;
  const parts = plan.id.split('-');
  const seg = parts[2] ?? '0';
  const segPadded = seg.padStart(3, '0');
  return (
    map[plan.id] ??
    map[`${plan.contract_id}-${plan.plan_number}-${seg}`] ??
    map[`${plan.contract_id}-${plan.plan_number}-${segPadded}`] ??
    map[`${plan.contract_id}-${plan.plan_number}`] ??
    null
  );
}

function overrideWithLiveRx(
  base: PlanTotals,
  plan: Plan,
  map: Record<string, PlanDrugCost> | undefined,
): PlanTotals {
  const live = lookupLivePlanCost(plan, map);
  if (!live || live.annual_cost == null) return base;
  const rxAnnual = live.annual_cost;
  const rxMonthly = live.monthly_cost ?? rxAnnual / 12;
  // Medicare.gov's annual_cost is inclusive of the Rx deductible.
  const annualCost = rxAnnual;
  const giveback = plan.part_b_giveback * 12;
  const totalAnnualValue = annualCost - base.extraBenefitsValue - giveback;
  return {
    ...base,
    rxMonthly,
    rxAnnual,
    rxHasCoins: false,
    annualCost,
    totalAnnualValue,
  };
}

// ─── Pharmacy mode toggle ───────────────────────────────────────────

function PharmacyModeBar({
  mode,
  onChange,
  loading,
  source,
  error,
  medsCount,
}: {
  mode: PharmacyMode;
  onChange: (mode: PharmacyMode) => void;
  loading: boolean;
  source: string | null;
  error: string | null;
  medsCount: number;
}) {
  let status: { text: string; color: string };
  if (medsCount === 0) {
    status = { text: 'No medications — add Rx on Step 3 to see live drug pricing.', color: '#868e96' };
  } else if (loading) {
    status = { text: 'Loading live pricing from Medicare.gov…', color: '#0d2f5e' };
  } else if (error) {
    status = { text: `Live pricing unavailable — ${error}. Showing tier-based estimate.`, color: '#d63031' };
  } else if (source === 'rate_limited' || source === 'cache:rate_limited') {
    status = { text: 'Medicare.gov rate-limited — retry in 5 min. Showing estimate.', color: '#e67e22' };
  } else if (source === 'no_ndcs') {
    status = { text: 'No NDCs resolved for these drugs — showing tier-based estimate.', color: '#868e96' };
  } else if (source && source.startsWith('cache:')) {
    status = { text: 'Live prices (cached from Medicare.gov, 24h TTL).', color: '#1a9c55' };
  } else if (source === 'live') {
    status = { text: 'Live prices from Medicare.gov.', color: '#1a9c55' };
  } else {
    status = { text: 'Tier-based estimate. Live pricing runs when rxcuis resolve.', color: '#868e96' };
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        marginBottom: 8,
        background: '#f8f9fa',
        border: '1px solid #e9ecef',
        borderRadius: 10,
        fontFamily: 'Inter, sans-serif',
      }}
    >
      <div style={{ display: 'inline-flex', borderRadius: 8, background: '#e9ecef', padding: 3 }}>
        {(['retail', 'mail'] as const).map((m) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => onChange(m)}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                border: 'none',
                background: active ? '#fff' : 'transparent',
                color: active ? '#0d2f5e' : '#495057',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                boxShadow: active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
              }}
            >
              {m === 'retail' ? '30-day Retail' : '90-day Mail Order'}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 12, color: status.color, flex: 1 }}>{status.text}</div>
    </div>
  );
}
