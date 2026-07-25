#!/usr/bin/env tsx
// Home Health + Discharge Meals parity audit — every MA/MAPD plan in
// NC, TX, GA. Three-way in-DB compare:
//
//   PBP source (pbp_benefits)      ← CMS PBP ground truth
//   pm_plan_benefits row           ← what Plan Match stores
//   Simulated agent + consumer     ← how each side renders it
//
// Two categories:
//   home_health        — CMS-mandatory Medicare Part A/B benefit
//                        (42 CFR § 409.42). Almost always $0 copay
//                        on MA plans. Missing row → consumer shows
//                        "Not filed", agent shows "—".
//   meal_benefit       — supplemental post-discharge meals (PBP B13c).
//                        Distinct from "meals" category (any-time
//                        food card, PBP B13a). Consumer + agent read
//                        meal_benefit specifically.
//
// No MPF scrape in this pass — the point is coverage-gap detection.
// pbp_benefits acts as ground truth; MPF spot-check is a separate pass.
//
// Usage:
//   npx tsx scripts/parity-audit/audit-home-health-meals.ts
//   npx tsx scripts/parity-audit/audit-home-health-meals.ts --state NC

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, '_tmp', 'parity-audit');

const sb = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const args = process.argv.slice(2);
const stateArg = args.find((a) => a.startsWith('--state='))?.slice(8)
  ?? (args.includes('--state') ? args[args.indexOf('--state') + 1] : null);
const STATES = (stateArg ?? 'NC,TX,GA').split(',').map((s) => s.trim().toUpperCase());

interface PmRow {
  copay: number | null;
  coinsurance: number | null;
  max_coverage: number | null;
  coverage_amount: number | null;
  benefit_description: string | null;
}
interface PbpRow {
  copay: number | null;
  copay_max: number | null;
  coinsurance: number | null;
  description: string | null;
  source: string | null;
}

interface Plan {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string;
  carrier: string;
  state: string;
  plan_type: string;
  pm_hh: PmRow | null;
  pm_mb: PmRow | null;
  pbp_hh: PbpRow[];
  pbp_mb: PbpRow[];
}

function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

async function loadPlans(): Promise<Map<string, Plan>> {
  const plans = new Map<string, Plan>();
  for (const st of STATES) {
    let from = 0;
    while (true) {
      const r = await sb.from('pm_plans')
        .select('contract_id, plan_id, segment_id, plan_name, carrier, state, plan_type')
        .eq('state', st)
        .not('plan_type', 'ilike', '%pdp%')
        .range(from, from + 999);
      const c = r.data ?? [];
      for (const row of c as any[]) {
        const k = `${row.contract_id}-${row.plan_id}-${row.segment_id}`;
        if (!plans.has(k)) {
          plans.set(k, { ...row, pm_hh: null, pm_mb: null, pbp_hh: [], pbp_mb: [] });
        }
      }
      if (c.length < 1000) break; from += 1000;
    }
  }
  return plans;
}

async function loadPmRows(plans: Map<string, Plan>, category: 'home_health' | 'meal_benefit', target: 'pm_hh' | 'pm_mb'): Promise<void> {
  let from = 0;
  while (true) {
    const r = await sb.from('pm_plan_benefits')
      .select('contract_id, plan_id, segment_id, copay, coinsurance, max_coverage, coverage_amount, benefit_description')
      .eq('benefit_category', category)
      .range(from, from + 999);
    const c = r.data ?? [];
    for (const row of c as any[]) {
      const k = `${row.contract_id}-${row.plan_id}-${row.segment_id}`;
      const p = plans.get(k);
      if (p) p[target] = {
        copay: row.copay, coinsurance: row.coinsurance,
        max_coverage: row.max_coverage, coverage_amount: row.coverage_amount,
        benefit_description: row.benefit_description,
      };
    }
    if (c.length < 1000) break; from += 1000;
  }
}

async function loadPbpRows(plans: Map<string, Plan>, benefitType: 'home_health' | 'meal_benefit', target: 'pbp_hh' | 'pbp_mb'): Promise<void> {
  const combined = [...new Set([...plans.values()].map((p) => `${p.contract_id}-${p.plan_id}`))];
  for (const slice of chunk(combined, 200)) {
    const r = await sb.from('pbp_benefits')
      .select('plan_id, copay, copay_max, coinsurance, description, source')
      .eq('benefit_type', benefitType)
      .in('plan_id', slice);
    for (const row of (r.data ?? []) as any[]) {
      const combinedId = row.plan_id as string;
      // Apply pbp row to every segment of this contract-plan
      for (const p of plans.values()) {
        if (`${p.contract_id}-${p.plan_id}` === combinedId) {
          p[target].push({
            copay: row.copay, copay_max: row.copay_max,
            coinsurance: row.coinsurance, description: row.description,
            source: row.source,
          });
        }
      }
    }
  }
}

// Consumer-side render (mirrors copayLong / copayValue / meal_benefit
// case in PlanDetail.tsx). "Not filed" when missing.
function consumerHomeHealth(pm: PmRow | null): string {
  if (!pm) return 'Not filed';
  if (pm.copay != null) return pm.copay === 0 ? '$0' : `$${pm.copay}`;
  if (pm.coinsurance != null) return `${pm.coinsurance}%`;
  return 'Not filed';
}
function consumerMealBenefit(pm: PmRow | null): string {
  if (!pm) return 'Not available';
  if (pm.benefit_description) return pm.benefit_description;
  if (pm.copay === 0) return 'Covered';
  return 'Not available';
}

// Best pbp row (rank medicare_gov > sb_ocr > manual > cms_pbp)
const PBP_RANK: Record<string, number> = { medicare_gov: 5, sb_ocr: 4, manual: 3, cms_pbp: 2, pbp: 2 };
function bestPbp(rows: PbpRow[]): PbpRow | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => (PBP_RANK[b.source ?? ''] ?? 0) - (PBP_RANK[a.source ?? ''] ?? 0))[0];
}

interface AuditRow {
  contract: string; plan: string; segment: string; planName: string;
  carrier: string; state: string; planType: string;
  category: 'home_health' | 'meal_benefit';
  pmCopay: number | null; pmCoins: number | null;
  pmMax: number | null; pmCovAmt: number | null; pmDesc: string | null;
  consumerRender: string;
  pbpBest: string;
  issue: string;
}

async function main() {
  console.log(`States: ${STATES.join(',')}`);
  const plans = await loadPlans();
  console.log(`Loaded ${plans.size} MA/MAPD plan-segments`);

  console.log('Loading pm_plan_benefits (home_health + meal_benefit)…');
  await loadPmRows(plans, 'home_health', 'pm_hh');
  await loadPmRows(plans, 'meal_benefit', 'pm_mb');

  console.log('Loading pbp_benefits (home_health + meal_benefit)…');
  await loadPbpRows(plans, 'home_health', 'pbp_hh');
  await loadPbpRows(plans, 'meal_benefit', 'pbp_mb');

  const rows: AuditRow[] = [];
  for (const p of plans.values()) {
    for (const cat of ['home_health', 'meal_benefit'] as const) {
      const pm = cat === 'home_health' ? p.pm_hh : p.pm_mb;
      const pbp = cat === 'home_health' ? p.pbp_hh : p.pbp_mb;
      const bp = bestPbp(pbp);
      const consumerRender = cat === 'home_health' ? consumerHomeHealth(pm) : consumerMealBenefit(pm);

      let issue = 'OK';
      if (cat === 'home_health') {
        // Home health: PBP source almost always $0. Missing pm row +
        // pbp confirms $0 → PM_MISSING_PBP_HAS. Missing both → NO_DATA.
        if (!pm && bp) issue = 'PM_MISSING_PBP_HAS';
        else if (!pm && !bp) issue = 'NO_DATA';
        else if (pm && bp && pm.copay !== bp.copay && !(pm.copay == null && bp.copay == null)) {
          issue = 'VALUE_MISMATCH';
        }
      } else {
        // meal_benefit: not universal. Missing pm + pbp has = data gap.
        if (!pm && bp) issue = 'PM_MISSING_PBP_HAS';
        else if (!pm && !bp) issue = 'NEITHER_HAS_MEAL';
      }

      rows.push({
        contract: p.contract_id, plan: p.plan_id, segment: p.segment_id,
        planName: p.plan_name, carrier: p.carrier, state: p.state, planType: p.plan_type,
        category: cat,
        pmCopay: pm?.copay ?? null, pmCoins: pm?.coinsurance ?? null,
        pmMax: pm?.max_coverage ?? null, pmCovAmt: pm?.coverage_amount ?? null, pmDesc: pm?.benefit_description ?? null,
        consumerRender,
        pbpBest: bp ? `${bp.source}: copay=${bp.copay} coins=${bp.coinsurance} desc="${(bp.description ?? '').slice(0, 60)}"` : '(no pbp)',
        issue,
      });
    }
  }

  // Summary
  const byIssue = new Map<string, number>();
  const byCat = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const key = `${r.category}|${r.issue}`;
    byIssue.set(key, (byIssue.get(key) ?? 0) + 1);
    const cm = byCat.get(r.category) ?? new Map();
    cm.set(r.issue, (cm.get(r.issue) ?? 0) + 1);
    byCat.set(r.category, cm);
  }
  console.log('\n=== Summary by category × issue ===');
  for (const [cat, cm] of byCat) {
    console.log(`  [${cat}]`);
    const total = [...cm.values()].reduce((a, b) => a + b, 0);
    for (const [issue, n] of [...cm.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${issue.padEnd(28)} ${String(n).padStart(6)}  (${((n / total) * 100).toFixed(1)}%)`);
    }
  }

  // Write CSV
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const csvPath = path.join(OUT_DIR, `hh-meals-audit-${ts}.csv`);
  const header = 'contract,plan,segment,plan_name,carrier,state,plan_type,category,pm_copay,pm_coins,pm_max,pm_cov_amt,pm_desc,consumer_render,pbp_best,issue';
  const esc = (s: string | number | null): string => {
    if (s == null) return '';
    const v = String(s).replace(/"/g, '""');
    return /[,"\n]/.test(v) ? `"${v}"` : v;
  };
  const lines = [header, ...rows.map((r) => [
    r.contract, r.plan, r.segment, r.planName, r.carrier, r.state, r.planType, r.category,
    r.pmCopay, r.pmCoins, r.pmMax, r.pmCovAmt, r.pmDesc,
    r.consumerRender, r.pbpBest, r.issue,
  ].map(esc).join(','))];
  writeFileSync(csvPath, lines.join('\n'));
  console.log(`\nFull audit CSV: ${csvPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
