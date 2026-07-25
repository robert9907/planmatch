#!/usr/bin/env tsx
// Imaging cost-sharing audit — advanced_imaging (MRI/CT/PET) + xray
// across every MA / MAPD plan in NC, TX, GA.
//
// Three-way in-DB compare:
//   PBP source (pbp_benefits_v2)   ← ground truth from CMS
//   pm_plan_benefits row           ← what Plan Match stores
//   Simulated agent render         ← what api/plans.ts + planDisplay
//                                    would produce for a broker
//
// The simulated render mirrors api/plans.ts::costShareFor's promotion
// logic (copay=0 with max>0 → promote max) and planDisplay.ts::
// formatCostShareWithRange's parse-then-match (description "$X–$Y"
// where low === cs.copay OR high === cs.copay renders the range).
//
// Emits a CSV of mismatches to _tmp/parity-audit/imaging-audit-<ts>.csv
// and a stdout summary broken down by category × state × root cause.
//
// MPF scraping intentionally not part of this pass — the point here is
// to prove the render fix works against the full production data set.
// A separate scrape pass can spot-check a sample against medicare.gov
// once the DB + render side are confirmed clean.
//
// Usage:
//   npx tsx scripts/parity-audit/audit-imaging.ts
//   npx tsx scripts/parity-audit/audit-imaging.ts --state NC
//   npx tsx scripts/parity-audit/audit-imaging.ts --carrier "unitedhealth"

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
const carrierArg = args.find((a) => a.startsWith('--carrier='))?.slice(10)
  ?? (args.includes('--carrier') ? args[args.indexOf('--carrier') + 1] : null);

// PBP taxonomy → pm_plan_benefits category. cms_pbp files diagnostic_
// radiology as the umbrella for both basic (xray) and advanced imaging
// depending on the plan; some carriers file separately as outpatient_xray.
const PBP_IMAGING_TYPES = new Set([
  'diagnostic_radiology', 'outpatient_xray', 'advanced_imaging',
  'therapeutic_radiology', 'diagnostic_test_procedures',
]);
const PM_IMAGING_CATEGORIES = ['advanced_imaging', 'xray'] as const;

interface PmBenefitRow {
  copay: number | null;
  coinsurance: number | null;
  max_coverage: number | null;
  benefit_description: string | null;
}
interface PlanImaging {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string;
  carrier: string;
  state: string;
  plan_type: string;
  pm_xray: PmBenefitRow | null;
  pm_advImg: PmBenefitRow | null;
}
interface PbpImagingRow {
  benefit_type: string;
  copay: number | null;
  copay_max: number | null;
  coinsurance: number | null;
  description: string | null;
  source: string | null;
}

// ── Simulate the agent's render path ──────────────────────────────────

// Mirrors api/plans.ts::costShareFor (medical, non-skip categories):
//   copay=0/null + max>0 → promoted copay = max
function simulateApiCostShare(row: PmBenefitRow | null): { copay: number | null; coinsurance: number | null; description: string | null } {
  if (!row) return { copay: null, coinsurance: null, description: null };
  const rawCopay = row.copay;
  const maxCoverage = row.max_coverage;
  const useMax = (rawCopay == null || rawCopay === 0) && maxCoverage != null && maxCoverage > 0;
  return {
    copay: useMax ? maxCoverage : rawCopay,
    coinsurance: row.coinsurance,
    description: row.benefit_description,
  };
}

// Mirrors src/agent-v3/planDisplay.ts::formatCostShareWithRange (post-fix
// commit — accepts high === cs.copay in addition to low === cs.copay).
const COST_RANGE_RE = /\$(\d[\d,]*)\s*[–\-—to]+\s*\$(\d[\d,]*)/i;
function simulateRender(cs: { copay: number | null; coinsurance: number | null; description: string | null }): string {
  if (cs.copay != null) {
    if (cs.description) {
      const m = cs.description.match(COST_RANGE_RE);
      if (m) {
        const low = parseInt(m[1].replace(/,/g, ''), 10);
        const high = parseInt(m[2].replace(/,/g, ''), 10);
        if (Number.isFinite(low) && Number.isFinite(high) && high > low && (low === cs.copay || high === cs.copay)) {
          return `$${low}–$${high}`;
        }
      }
    }
    return `$${cs.copay}`;
  }
  if (cs.coinsurance != null) return `${cs.coinsurance}%`;
  if (cs.description) return cs.description;
  return '—';
}

// Mirrors apps/web/src/lib/copay.ts::extractCopayValue (consumer, post
// commit 90c849a — includes zero-copay range branch).
function simulateConsumerRender(row: PmBenefitRow | null): string {
  if (!row) return '—';
  if (row.benefit_description) {
    const desc = row.benefit_description.trim();
    if (/\bdays?\b/i.test(desc) && /\$\d/.test(desc)) return desc;
  }
  if (row.copay != null && row.copay > 0) {
    if (row.max_coverage != null && row.max_coverage > row.copay) {
      return `$${Math.round(row.copay)}–$${Math.round(row.max_coverage)} copay`;
    }
    return `$${Math.round(row.copay)} copay`;
  }
  if (row.coinsurance != null && row.coinsurance > 0) return `${Math.round(row.coinsurance)}% coinsurance`;
  if (row.copay === 0) {
    if (row.max_coverage != null && row.max_coverage > 0) return `$0–$${Math.round(row.max_coverage)} copay`;
    return '$0 copay';
  }
  return '—';
}

// ── Data loaders ──────────────────────────────────────────────────────

async function loadPlans(): Promise<Map<string, PlanImaging>> {
  const plans = new Map<string, PlanImaging>();
  for (const st of STATES) {
    let from = 0;
    while (true) {
      let q = sb
        .from('pm_plans')
        .select('contract_id, plan_id, segment_id, plan_name, carrier, state, plan_type')
        .eq('state', st)
        .not('plan_type', 'ilike', '%pdp%');
      if (carrierArg) q = q.ilike('carrier', `%${carrierArg}%`);
      const r = await q.range(from, from + 999);
      const chunk = r.data ?? [];
      for (const row of chunk as any[]) {
        const key = `${row.contract_id}-${row.plan_id}-${row.segment_id}`;
        if (plans.has(key)) continue;
        plans.set(key, { ...row, pm_xray: null, pm_advImg: null });
      }
      if (chunk.length < 1000) break;
      from += 1000;
    }
  }
  return plans;
}

async function loadPmBenefits(plans: Map<string, PlanImaging>): Promise<void> {
  // Fetch pm_plan_benefits rows for the imaging categories in bulk,
  // paginating the 1000-row cap.
  for (const cat of PM_IMAGING_CATEGORIES) {
    let from = 0;
    while (true) {
      const r = await sb
        .from('pm_plan_benefits')
        .select('contract_id, plan_id, segment_id, benefit_category, copay, coinsurance, max_coverage, benefit_description')
        .eq('benefit_category', cat)
        .range(from, from + 999);
      const chunk = r.data ?? [];
      for (const row of chunk as any[]) {
        const key = `${row.contract_id}-${row.plan_id}-${row.segment_id}`;
        const plan = plans.get(key);
        if (!plan) continue;
        const rec: PmBenefitRow = {
          copay: row.copay,
          coinsurance: row.coinsurance,
          max_coverage: row.max_coverage,
          benefit_description: row.benefit_description,
        };
        if (cat === 'xray') plan.pm_xray = rec;
        else if (cat === 'advanced_imaging') plan.pm_advImg = rec;
      }
      if (chunk.length < 1000) break;
      from += 1000;
    }
  }
}

async function loadPbpImaging(plans: Map<string, PlanImaging>): Promise<Map<string, PbpImagingRow[]>> {
  const byPlan = new Map<string, PbpImagingRow[]>();
  // pbp_benefits stores plan_id as combined "H5253-039".
  const combinedIds = new Set([...plans.values()].map((p) => `${p.contract_id}-${p.plan_id}`));
  const idList = [...combinedIds];
  // Chunk .in() to stay under URL length limits
  const CHUNK = 200;
  for (const cat of ['diagnostic_radiology', 'outpatient_xray', 'advanced_imaging']) {
    for (let i = 0; i < idList.length; i += CHUNK) {
      const slice = idList.slice(i, i + CHUNK);
      const r = await sb
        .from('pbp_benefits')
        .select('plan_id, benefit_type, copay, copay_max, coinsurance, description, source')
        .eq('benefit_type', cat)
        .in('plan_id', slice);
      for (const row of (r.data ?? []) as any[]) {
        const list = byPlan.get(row.plan_id) ?? [];
        list.push({
          benefit_type: row.benefit_type,
          copay: row.copay,
          copay_max: row.copay_max,
          coinsurance: row.coinsurance,
          description: row.description,
          source: row.source,
        });
        byPlan.set(row.plan_id, list);
      }
    }
  }
  return byPlan;
}

// ── Main audit ────────────────────────────────────────────────────────

interface AuditRow {
  contract: string;
  plan: string;
  segment: string;
  planName: string;
  carrier: string;
  state: string;
  planType: string;
  category: 'xray' | 'advanced_imaging';
  pmCopay: number | null;
  pmCoins: number | null;
  pmMax: number | null;
  pmDesc: string | null;
  agentRender: string;
  consumerRender: string;
  pbpBest: string;      // "cms_pbp: copay=50 max=50 / medicare_gov: copay=190"
  issue: string;        // "OK" / "RANGE_COLLAPSED" / "MISSING_PM_ROW" / etc.
}

function summarize(rows: AuditRow[]): void {
  const byIssue = new Map<string, number>();
  const byCat = new Map<string, Map<string, number>>();
  for (const r of rows) {
    byIssue.set(r.issue, (byIssue.get(r.issue) ?? 0) + 1);
    const cm = byCat.get(r.category) ?? new Map<string, number>();
    cm.set(r.issue, (cm.get(r.issue) ?? 0) + 1);
    byCat.set(r.category, cm);
  }
  console.log('\n=== Summary by issue ===');
  const total = rows.length;
  for (const [issue, n] of [...byIssue.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${issue.padEnd(24)} ${String(n).padStart(6)}  (${((n / total) * 100).toFixed(1)}%)`);
  }
  console.log('\n=== Summary by category × issue ===');
  for (const [cat, cm] of byCat) {
    console.log(`  [${cat}]`);
    for (const [issue, n] of [...cm.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${issue.padEnd(24)} ${String(n).padStart(6)}`);
    }
  }
}

async function main() {
  console.log(`States: ${STATES.join(',')}   carrier filter: ${carrierArg ?? '(all)'}`);
  console.log('Loading plans…');
  const plans = await loadPlans();
  console.log(`  ${plans.size} distinct (contract, plan, segment) plans in scope`);

  console.log('Loading pm_plan_benefits imaging rows…');
  await loadPmBenefits(plans);
  let withXray = 0, withAdv = 0;
  for (const p of plans.values()) {
    if (p.pm_xray) withXray++;
    if (p.pm_advImg) withAdv++;
  }
  console.log(`  xray rows: ${withXray}  |  advanced_imaging rows: ${withAdv}`);

  console.log('Loading pbp_benefits imaging rows…');
  const pbpByPlan = await loadPbpImaging(plans);
  console.log(`  distinct plans with any pbp imaging row: ${pbpByPlan.size}`);

  console.log('Building audit rows…');
  const auditRows: AuditRow[] = [];
  for (const plan of plans.values()) {
    for (const category of PM_IMAGING_CATEGORIES) {
      const pm = category === 'xray' ? plan.pm_xray : plan.pm_advImg;
      const pbp = (pbpByPlan.get(`${plan.contract_id}-${plan.plan_id}`) ?? [])
        .filter((r) => {
          if (category === 'xray') return r.benefit_type === 'outpatient_xray' || r.benefit_type === 'diagnostic_radiology';
          return r.benefit_type === 'advanced_imaging' || r.benefit_type === 'diagnostic_radiology';
        });
      const pbpBest = pbp.length === 0
        ? '(no pbp row)'
        : pbp.map((r) => `${r.source ?? '?'}: c=${r.copay}/m=${r.copay_max}${r.coinsurance != null ? '/coins=' + r.coinsurance : ''}`).join(' | ');

      const cs = simulateApiCostShare(pm);
      const agentRender = simulateRender(cs);
      const consumerRender = simulateConsumerRender(pm);

      let issue = 'OK';
      if (!pm) {
        if (pbp.length > 0 && pbp.some((r) => r.copay != null || r.coinsurance != null)) {
          issue = 'MISSING_PM_ROW_WITH_PBP';
        } else {
          issue = 'NO_DATA';
        }
      } else if (pm.copay === 0 && pm.max_coverage != null && pm.max_coverage > 0) {
        // Zero-floor range. Agent + consumer should both render a range.
        const okAgent = /^\$0–\$\d/.test(agentRender);
        const okConsumer = /^\$0–\$\d/.test(consumerRender);
        if (!okAgent && !okConsumer) issue = 'RANGE_COLLAPSED_BOTH';
        else if (!okAgent) issue = 'RANGE_COLLAPSED_AGENT';
        else if (!okConsumer) issue = 'RANGE_COLLAPSED_CONSUMER';
      } else if (pm.copay != null && pm.copay > 0 && pm.max_coverage != null && pm.max_coverage > pm.copay) {
        // Non-zero-min range.
        const okAgent = /^\$\d.*–\$\d/.test(agentRender);
        const okConsumer = /^\$\d.*–\$\d/.test(consumerRender);
        if (!okAgent && !okConsumer) issue = 'NONZERO_RANGE_COLLAPSED_BOTH';
        else if (!okAgent) issue = 'NONZERO_RANGE_COLLAPSED_AGENT';
        else if (!okConsumer) issue = 'NONZERO_RANGE_COLLAPSED_CONSUMER';
      } else if (pm.copay == null && pm.coinsurance == null && (pbp.length > 0 && pbp.some((r) => r.copay != null || r.coinsurance != null))) {
        issue = 'PM_NULL_PBP_HAS_VALUE';
      }

      auditRows.push({
        contract: plan.contract_id,
        plan: plan.plan_id,
        segment: plan.segment_id,
        planName: plan.plan_name,
        carrier: plan.carrier,
        state: plan.state,
        planType: plan.plan_type,
        category,
        pmCopay: pm?.copay ?? null,
        pmCoins: pm?.coinsurance ?? null,
        pmMax: pm?.max_coverage ?? null,
        pmDesc: pm?.benefit_description ?? null,
        agentRender,
        consumerRender,
        pbpBest,
        issue,
      });
    }
  }

  summarize(auditRows);

  // Emit CSV for full detail
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const csvPath = path.join(OUT_DIR, `imaging-audit-${ts}.csv`);
  const header = 'contract,plan,segment,plan_name,carrier,state,plan_type,category,pm_copay,pm_coins,pm_max,pm_desc,agent_render,consumer_render,pbp_best,issue';
  const escape = (s: string | number | null): string => {
    if (s == null) return '';
    const v = String(s).replace(/"/g, '""');
    return /[,"\n]/.test(v) ? `"${v}"` : v;
  };
  const lines = [header, ...auditRows.map((r) => [
    r.contract, r.plan, r.segment, r.planName, r.carrier, r.state, r.planType, r.category,
    r.pmCopay, r.pmCoins, r.pmMax, r.pmDesc,
    r.agentRender, r.consumerRender, r.pbpBest, r.issue,
  ].map(escape).join(','))];
  writeFileSync(csvPath, lines.join('\n'));
  console.log(`\nFull audit CSV: ${csvPath}`);

  // Print a few examples of each non-OK issue
  const bad = auditRows.filter((r) => r.issue !== 'OK' && r.issue !== 'NO_DATA');
  console.log(`\n=== Sample failures (${bad.length} total non-OK/non-NO_DATA) ===`);
  const byIssue = new Map<string, AuditRow[]>();
  for (const r of bad) {
    const list = byIssue.get(r.issue) ?? [];
    list.push(r);
    byIssue.set(r.issue, list);
  }
  for (const [issue, list] of byIssue) {
    console.log(`\n  [${issue}]  ${list.length} rows`);
    for (const r of list.slice(0, 3)) {
      console.log(`    ${r.contract}-${r.plan}-${r.segment} (${r.state}) ${r.category} carrier=${r.carrier.slice(0, 30)}`);
      console.log(`      pm: copay=${r.pmCopay} coins=${r.pmCoins} max=${r.pmMax}  desc="${r.pmDesc?.slice(0, 60)}"`);
      console.log(`      agent="${r.agentRender}"  consumer="${r.consumerRender}"`);
      console.log(`      pbp: ${r.pbpBest.slice(0, 100)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
