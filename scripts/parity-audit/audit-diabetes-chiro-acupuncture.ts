#!/usr/bin/env tsx
// Diabetes management / Chiropractic / Acupuncture parity audit —
// every MA/MAPD plan in NC, TX, GA. Same three-way in-DB compare
// as audit-imaging.ts and audit-home-health-meals.ts (no MPF scrape
// in this pass — pbp_benefits is ground truth for the gap check).
//
// Categories checked:
//   diabetic_supplies  — test strips, lancets, monitors, DSMT, shoes.
//                        The catch-all PBP bucket for diabetes-related
//                        supplemental cost sharing. Medicare covers
//                        the underlying DME; MA plans file their own
//                        cost share here. Almost always $0 on MA-PD.
//   chiropractic       — Medicare-covered manual manipulation of the
//                        spine to correct subluxation. Federally
//                        required benefit — every MA plan files a
//                        row (usually a small copay: $10–$25).
//   acupuncture        — Medicare-covered for chronic low back pain
//                        (up to 12 sessions / 90 days, per SSA
//                        1861(gg)). Rare on MA (~2-4% of plans file
//                        a supplemental benefit beyond the covered
//                        low-back-pain sessions).
//
// Usage:
//   npx tsx scripts/parity-audit/audit-diabetes-chiro-acupuncture.ts
//   npx tsx scripts/parity-audit/audit-diabetes-chiro-acupuncture.ts --state NC

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
const OUT_DIR = path.join(__dirname, '..', '..', '_tmp', 'parity-audit');

const sb = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const args = process.argv.slice(2);
const stateArg = args.find((a) => a.startsWith('--state='))?.slice(8)
  ?? (args.includes('--state') ? args[args.indexOf('--state') + 1] : null);
const STATES = (stateArg ?? 'NC,TX,GA').split(',').map((s) => s.trim().toUpperCase());

const CATEGORIES = ['diabetic_supplies', 'chiropractic', 'acupuncture'] as const;
type Category = typeof CATEGORIES[number];

interface PmRow { copay: number | null; coinsurance: number | null; max_coverage: number | null; coverage_amount: number | null; benefit_description: string | null }
interface PbpRow { copay: number | null; copay_max: number | null; coinsurance: number | null; description: string | null; source: string | null }

interface Plan {
  contract_id: string; plan_id: string; segment_id: string; plan_name: string;
  carrier: string; state: string; plan_type: string; snp_type: string | null;
  pm: Record<Category, PmRow | null>;
  pbp: Record<Category, PbpRow[]>;
}

function chunk<T>(a: T[], n: number): T[][] { const o: T[][]=[]; for (let i=0;i<a.length;i+=n) o.push(a.slice(i,i+n)); return o; }

const PBP_RANK: Record<string, number> = { medicare_gov: 5, sb_ocr: 4, manual: 3, cms_pbp: 2, pbp: 2 };
function bestPbp(rows: PbpRow[]): PbpRow | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => (PBP_RANK[b.source ?? ''] ?? 0) - (PBP_RANK[a.source ?? ''] ?? 0))[0];
}

async function loadPlans(): Promise<Map<string, Plan>> {
  const plans = new Map<string, Plan>();
  for (const st of STATES) {
    let from = 0;
    while (true) {
      const r = await sb.from('pm_plans')
        .select('contract_id, plan_id, segment_id, plan_name, carrier, state, plan_type, snp_type')
        .eq('state', st)
        .not('plan_type', 'ilike', '%pdp%')
        .range(from, from + 999);
      const c = r.data ?? [];
      for (const row of c as any[]) {
        const k = `${row.contract_id}-${row.plan_id}-${row.segment_id}`;
        if (!plans.has(k)) {
          plans.set(k, {
            contract_id: row.contract_id, plan_id: row.plan_id, segment_id: row.segment_id,
            plan_name: row.plan_name, carrier: row.carrier, state: st, plan_type: row.plan_type, snp_type: row.snp_type,
            pm: { diabetic_supplies: null, chiropractic: null, acupuncture: null },
            pbp: { diabetic_supplies: [], chiropractic: [], acupuncture: [] },
          });
        }
      }
      if (c.length < 1000) break; from += 1000;
    }
  }
  return plans;
}

async function loadPmRows(plans: Map<string, Plan>, category: Category): Promise<void> {
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
      if (p) p.pm[category] = { copay: row.copay, coinsurance: row.coinsurance, max_coverage: row.max_coverage, coverage_amount: row.coverage_amount, benefit_description: row.benefit_description };
    }
    if (c.length < 1000) break; from += 1000;
  }
}

async function loadPbpRows(plans: Map<string, Plan>, benefitType: string, category: Category): Promise<void> {
  const combined = [...new Set([...plans.values()].map((p) => `${p.contract_id}-${p.plan_id}`))];
  for (const slice of chunk(combined, 200)) {
    const r = await sb.from('pbp_benefits')
      .select('plan_id, copay, copay_max, coinsurance, description, source')
      .eq('benefit_type', benefitType)
      .in('plan_id', slice);
    for (const row of (r.data ?? []) as any[]) {
      const combinedId = row.plan_id as string;
      for (const p of plans.values()) {
        if (`${p.contract_id}-${p.plan_id}` === combinedId) {
          p.pbp[category].push({ copay: row.copay, copay_max: row.copay_max, coinsurance: row.coinsurance, description: row.description, source: row.source });
        }
      }
    }
  }
}

interface AuditRow {
  contract: string; plan: string; segment: string; planName: string;
  carrier: string; state: string; planType: string; snpType: string | null;
  category: Category;
  pmCopay: number | null; pmCoins: number | null; pmDesc: string | null;
  pbpBest: string;
  issue: string;
}

async function main() {
  console.log(`States: ${STATES.join(',')}`);
  const plans = await loadPlans();
  console.log(`Loaded ${plans.size} MA/MAPD plan-segments`);

  console.log('Loading pm_plan_benefits (3 categories + specialist for chiro bundling)…');
  for (const cat of CATEGORIES) await loadPmRows(plans, cat);
  // For chiropractic VALUE_MISMATCH reconciliation: when MPF doesn't
  // file a distinct chiro benefit and pm.chi.copay == pm.specialist.
  // copay, the plan bundles chiro at the specialist rate and pm is
  // beneficiary-correct (regardless of pbp cms_pbp's value). See
  // scripts/parity-audit/inspect-chiro-sb-pdfs.ts for the deep-dive
  // that documented 69/76 mismatches as "specialist-bundled".
  const specialistByKey = new Map<string, number | null>();
  {
    let from = 0;
    while (true) {
      const r = await sb.from('pm_plan_benefits').select('contract_id, plan_id, segment_id, copay').eq('benefit_category', 'specialist').range(from, from + 999);
      const c = r.data ?? [];
      for (const row of c as any[]) specialistByKey.set(`${row.contract_id}-${row.plan_id}-${row.segment_id}`, row.copay ?? null);
      if (c.length < 1000) break; from += 1000;
    }
  }

  console.log('Loading pbp_benefits (3 categories + variants)…');
  await loadPbpRows(plans, 'diabetic_supplies', 'diabetic_supplies');
  await loadPbpRows(plans, 'chiropractic', 'chiropractic');
  // Also merge professional_services__chiropractic into the chiropractic
  // bucket — pbp files 46 rows under this alt key, mostly on C-SNP.
  await loadPbpRows(plans, 'professional_services__chiropractic', 'chiropractic');
  await loadPbpRows(plans, 'acupuncture', 'acupuncture');

  const rows: AuditRow[] = [];
  for (const p of plans.values()) {
    for (const cat of CATEGORIES) {
      const pm = p.pm[cat];
      const pbp = p.pbp[cat];
      const bp = bestPbp(pbp);
      let issue = 'OK';
      if (!pm && bp) issue = 'PM_MISSING_PBP_HAS';
      else if (!pm && !bp) issue = 'NEITHER_HAS';
      else if (pm && bp) {
        // Both have data — compare copay
        const pmCopay = pm.copay;
        const pbpCopay = bp.copay === 0 && bp.copay_max != null && bp.copay_max > 0 ? bp.copay_max : bp.copay;
        if (pmCopay !== pbpCopay && !(pmCopay == null && pbpCopay == null)) {
          // Chiropractic-specific reconciliation: on plans where MPF
          // doesn't file a distinct chiro benefit and pm.chi copay
          // equals the specialist copay, chiro is billed at the
          // specialist rate — pm reflects the beneficiary experience,
          // pbp's cms_pbp row is a filed-but-not-visible datum. Fold
          // into OK_SPECIALIST_BUNDLED (still counted as OK for the
          // headline rate; broken out for auditability).
          if (cat === 'chiropractic') {
            const specCopay = specialistByKey.get(`${p.contract_id}-${p.plan_id}-${p.segment_id}`) ?? null;
            if (specCopay != null && pmCopay === specCopay) {
              issue = 'OK_SPECIALIST_BUNDLED';
            } else {
              issue = 'VALUE_MISMATCH';
            }
          } else {
            issue = 'VALUE_MISMATCH';
          }
        }
      }
      rows.push({
        contract: p.contract_id, plan: p.plan_id, segment: p.segment_id, planName: p.plan_name,
        carrier: p.carrier, state: p.state, planType: p.plan_type, snpType: p.snp_type,
        category: cat,
        pmCopay: pm?.copay ?? null, pmCoins: pm?.coinsurance ?? null, pmDesc: pm?.benefit_description ?? null,
        pbpBest: bp ? `${bp.source}: copay=${bp.copay} max=${bp.copay_max} coins=${bp.coinsurance} desc="${(bp.description ?? '').slice(0, 60)}"` : '(no pbp)',
        issue,
      });
    }
  }

  const byCat = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const cm = byCat.get(r.category) ?? new Map<string, number>();
    cm.set(r.issue, (cm.get(r.issue) ?? 0) + 1);
    byCat.set(r.category, cm);
  }
  console.log('\n=== Summary by category × issue ===');
  for (const cat of CATEGORIES) {
    const cm = byCat.get(cat) ?? new Map();
    const total = [...cm.values()].reduce((a, b) => a + b, 0);
    console.log(`  [${cat}]`);
    for (const [issue, n] of [...cm.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${issue.padEnd(28)} ${String(n).padStart(6)}  (${((n / total) * 100).toFixed(1)}%)`);
    }
  }

  // C-SNP coverage detail for diabetic_supplies
  const cSnpPlans = [...plans.values()].filter((p) => /C-?SNP/i.test(p.snp_type ?? '') || /C-?SNP/i.test(p.plan_type ?? ''));
  const cSnpWithDiabetes = cSnpPlans.filter((p) => p.pm.diabetic_supplies != null || p.pbp.diabetic_supplies.length > 0);
  console.log(`\n  C-SNP plans in scope: ${cSnpPlans.length}   with any diabetic_supplies data (pm or pbp): ${cSnpWithDiabetes.length}`);

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const csvPath = path.join(OUT_DIR, `dca-audit-${ts}.csv`);
  const esc = (s: string | number | null): string => { if (s == null) return ''; const v = String(s).replace(/"/g, '""'); return /[,"\n]/.test(v) ? `"${v}"` : v; };
  const header = 'contract,plan,segment,plan_name,carrier,state,plan_type,snp_type,category,pm_copay,pm_coins,pm_desc,pbp_best,issue';
  const lines = [header, ...rows.map((r) => [r.contract, r.plan, r.segment, r.planName, r.carrier, r.state, r.planType, r.snpType, r.category, r.pmCopay, r.pmCoins, r.pmDesc, r.pbpBest, r.issue].map(esc).join(','))];
  writeFileSync(csvPath, lines.join('\n'));
  console.log(`\nCSV: ${csvPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
