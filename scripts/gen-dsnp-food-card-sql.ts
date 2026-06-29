// Generate dsnp-food-card-import.sql from the manual-capture CSV.
//
// Pipeline:
//   1. Load .env.local inline (template-probe pattern — unprefixed
//      SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).
//   2. Parse ~/Downloads/dsnp-food-card-capture - D-SNP Food Card Capture.csv
//   3. Classify each plan: food_card vs otc_allowance (Wellcare Spendables).
//   4. Query pm_plans to get real (segment_id, plan_year) per plan —
//      do NOT assume segment_id='000' / plan_year=2026.
//   5. Pre-check existing pbp_benefits_v2 rows for these 54 plans so
//      we know what the UPSERT will overwrite.
//   6. Emit SQL targeting pbp_benefits_v2 (NOT the pbp_benefits view):
//        - source='manual'
//        - description prefixed with [manual_capture_2026-06-29]
//        - coverage_amount = dollar amount
//        - ON CONFLICT (contract_id, plan_id, segment_id, plan_year,
//                       benefit_type, COALESCE(tier_id, '')) DO UPDATE
//
// Output: ~/planmatch/planmatch/scripts/migrations/dsnp-food-card-import.sql
//
// Run from ~/planmatch/planmatch so .env.local resolves.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const env: Record<string, string> = {};
for (const l of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  if (!l || l.startsWith('#') || !l.includes('=')) continue;
  const i = l.indexOf('=');
  let v = l.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[l.slice(0, i).trim()] = v;
}

const url = env.SUPABASE_URL!;
const key = env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const projectId = url.replace(/^https?:\/\//, '').split('.')[0];
console.log(`Connected to Supabase project: ${projectId}`);
if (projectId !== 'rpcbrkmvalvdmroqzpaq') {
  console.error(`ABORT: expected rpcbrkmvalvdmroqzpaq, got ${projectId}. Confirm with user before proceeding.`);
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const CSV_PATH = '/Users/robertsimm/Downloads/dsnp-food-card-capture - D-SNP Food Card Capture.csv';
const OUT_PATH = '/Users/robertsimm/planmatch/planmatch/scripts/migrations/dsnp-food-card-import.sql';
const PROVENANCE_TAG = '[manual_capture_2026-06-29]';

type Row = {
  contract_id: string;
  plan_id: string;
  cp: string;
  carrier: string;
  plan_name: string;
  state: string;
  sample_zip: string;
  amount: number;
  frequency: string;
  notes: string;
  food_class: string;       // last col of CSV
  benefit_type: 'food_card' | 'otc_allowance';
};

// ---- CSV parse ----
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\n') { cur.push(field); out.push(cur); cur = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); out.push(cur); }
  return out;
}

function classify(foodInCard: string): 'food_card' | 'otc_allowance' {
  const s = foodInCard.toLowerCase();
  if (s.includes('no food (otc') || s.startsWith('no food')) return 'otc_allowance';
  // 'Food incl.' (all members or SSBCI) → food_card
  // 'No card' → food_card with $0 (we still record the plan was checked)
  return 'food_card';
}

function parseAmount(raw: string): number {
  const cleaned = raw.replace(/[$,]/g, '').trim();
  if (!cleaned) return 0;
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function sqlEscape(s: string): string {
  if (s == null) return 'NULL';
  return `'${String(s).replace(/'/g, "''")}'`;
}

(async () => {
  const raw = readFileSync(CSV_PATH, 'utf8');
  const rows = parseCsv(raw);

  // Data row = first column matches H#####-###
  const planIdRe = /^H\d{4,5}-\d{3,}$/;
  const captured: Row[] = [];
  for (const r of rows) {
    const planId = (r[0] ?? '').trim();
    if (!planIdRe.test(planId)) continue;
    const [contract_id, plan_id] = planId.split('-');
    const carrier = (r[1] ?? '').trim();
    const plan_name = (r[2] ?? '').trim();
    const state = (r[3] ?? '').trim();
    const sample_zip = (r[4] ?? '').trim();
    const amount = parseAmount(r[5] ?? '');
    const frequency = (r[6] ?? '').trim() || 'monthly';
    const notes = (r[7] ?? '').trim();
    const food_class = (r[8] ?? '').trim();
    captured.push({
      contract_id, plan_id, cp: planId, carrier, plan_name, state, sample_zip,
      amount, frequency, notes, food_class,
      benefit_type: classify(food_class),
    });
  }

  console.log(`\nCSV rows parsed: ${captured.length}`);
  const byType = captured.reduce((m, r) => { m[r.benefit_type] = (m[r.benefit_type] ?? 0) + 1; return m; }, {} as Record<string, number>);
  console.log(`  food_card:     ${byType.food_card ?? 0}`);
  console.log(`  otc_allowance: ${byType.otc_allowance ?? 0}`);
  const byState = captured.reduce((m, r) => { m[r.state] = (m[r.state] ?? 0) + 1; return m; }, {} as Record<string, number>);
  console.log(`  by state:      ${JSON.stringify(byState)}`);

  // ---- Resolve segment_id per plan (plan_year hardcoded to 2026) ----
  const PLAN_YEAR = 2026;
  type KeyRow = { contract_id: string; plan_id: string; segment_id: string; plan_year: number };
  const planKeys = new Map<string, KeyRow[]>();
  for (const r of captured) {
    const { data, error } = await sb
      .from('pm_plans')
      .select('contract_id, plan_id, segment_id')
      .eq('contract_id', r.contract_id)
      .eq('plan_id', r.plan_id);
    if (error) { console.error(`pm_plans query failed for ${r.cp}:`, error.message); process.exit(1); }
    const distinct = new Map<string, KeyRow>();
    for (const row of (data ?? []) as any[]) {
      const seg = String(row.segment_id ?? '000');
      distinct.set(seg, {
        contract_id: row.contract_id,
        plan_id: row.plan_id,
        segment_id: seg,
        plan_year: PLAN_YEAR,
      });
    }
    planKeys.set(r.cp, [...distinct.values()]);
  }

  // Report any plans with no rows or multiple segments
  let missing = 0;
  let multi = 0;
  for (const [cp, keys] of planKeys) {
    if (keys.length === 0) { console.warn(`  MISSING pm_plans row: ${cp}`); missing++; }
    else if (keys.length > 1) {
      const segs = [...new Set(keys.map((k) => k.segment_id))];
      console.warn(`  MULTI segment: ${cp} → ${segs.join(', ')}`);
      multi++;
    }
  }
  console.log(`\npm_plans resolution: ${captured.length - missing} resolved, ${missing} missing, ${multi} multi-segment`);

  // ---- Pre-check existing rows ----
  const cpList = captured.map((r) => r.cp);
  let existing: any[] = [];
  for (let i = 0; i < cpList.length; i += 50) {
    const chunk = cpList.slice(i, i + 50);
    const ors = chunk.map((cp) => {
      const [c, p] = cp.split('-');
      return `and(contract_id.eq.${c},plan_id.eq.${p})`;
    }).join(',');
    const { data, error } = await sb
      .from('pbp_benefits_v2')
      .select('contract_id, plan_id, segment_id, plan_year, benefit_type, coverage_amount, copay, copay_max, source, description')
      .or(ors)
      .in('benefit_type', ['food_card', 'otc_allowance', 'meal_benefit', 'meals', 'otc']);
    if (error) { console.error(`pbp_benefits_v2 pre-check failed:`, error.message); process.exit(1); }
    existing.push(...(data ?? []));
  }
  console.log(`\nExisting pbp_benefits_v2 rows for these 54 plans (food/otc benefit_types): ${existing.length}`);
  const exBySource = existing.reduce((m, r) => { m[r.source] = (m[r.source] ?? 0) + 1; return m; }, {} as Record<string, number>);
  console.log(`  by source: ${JSON.stringify(exBySource)}`);
  const exByType = existing.reduce((m, r) => { m[r.benefit_type] = (m[r.benefit_type] ?? 0) + 1; return m; }, {} as Record<string, number>);
  console.log(`  by type:   ${JSON.stringify(exByType)}`);

  // ---- Emit SQL ----
  const lines: string[] = [];
  lines.push('-- dsnp-food-card-import.sql');
  lines.push(`-- Generated ${new Date().toISOString()} from`);
  lines.push(`-- ${CSV_PATH}`);
  lines.push(`-- Target: pbp_benefits_v2 (NOT the pbp_benefits view)`);
  lines.push(`-- Project: ${projectId} (plan-match-prod)`);
  lines.push(`-- Rows: ${captured.length} (${byType.food_card ?? 0} food_card + ${byType.otc_allowance ?? 0} otc_allowance)`);
  lines.push(`-- Provenance: source='manual' (top priority for food_card/otc_allowance per api/plans.ts:372-377)`);
  lines.push(`-- Description prefix: '${PROVENANCE_TAG}'`);
  lines.push(`-- Amount lands in copay (read path source of truth per api/plans.ts:412), plus copay_max (annual cap) and coverage_amount (semantic).`);
  lines.push(`-- tier_id left NULL — does not collide with existing tier_id='0' placeholder rows, manual source wins priority.`);
  lines.push('');
  lines.push('BEGIN;');
  lines.push('');

  let emitted = 0;
  let skipped = 0;
  for (const r of captured) {
    const keys = planKeys.get(r.cp) ?? [];
    if (keys.length === 0) {
      lines.push(`-- SKIP ${r.cp} (${r.state}, ${r.carrier}) — no pm_plans row`);
      skipped++;
      continue;
    }
    // Normalize amount to monthly if frequency given
    let monthlyAmount = r.amount;
    if (r.frequency.toLowerCase() === 'quarterly') monthlyAmount = r.amount / 3;
    else if (r.frequency.toLowerCase() === 'annual') monthlyAmount = r.amount / 12;
    const annualCap = monthlyAmount * 12;

    // Embed "per month" in the description so the api/plans.ts
    // normalizer doesn't misclassify the unit (lines 438-447).
    const desc = `${PROVENANCE_TAG} $${monthlyAmount.toFixed(2)} per month — ${r.notes}`.slice(0, 1000);
    for (const k of keys) {
      lines.push(`-- ${r.cp} ${r.state} ${r.carrier} → ${r.benefit_type} $${monthlyAmount.toFixed(2)}/mo (raw=$${r.amount}/${r.frequency}, seg=${k.segment_id})`);
      lines.push(
        `INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)`
      );
      lines.push(
        `VALUES (${sqlEscape(k.contract_id)}, ${sqlEscape(k.plan_id)}, ${sqlEscape(k.segment_id)}, ${k.plan_year}, ${sqlEscape(r.benefit_type)}, ${monthlyAmount.toFixed(2)}, ${annualCap.toFixed(2)}, ${monthlyAmount.toFixed(2)}, 'manual', ${sqlEscape(desc)})`
      );
      lines.push(`ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))`);
      lines.push(`DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;`);
      lines.push('');
      emitted++;
    }
  }

  lines.push('COMMIT;');
  lines.push('');
  lines.push('-- ─── Verification ───────────────────────────────────────────────');
  lines.push('-- 1. Inserted-row counts by benefit_type (this batch)');
  lines.push(`SELECT benefit_type, COUNT(*)`);
  lines.push(`FROM pbp_benefits_v2`);
  lines.push(`WHERE source = 'manual' AND description LIKE '${PROVENANCE_TAG}%'`);
  lines.push(`GROUP BY benefit_type;`);
  lines.push('');
  lines.push('-- 2. D-SNP coverage across NC/TX/GA');
  lines.push(`SELECT`);
  lines.push(`  COUNT(DISTINCT (p.contract_id || '-' || p.plan_id))                                       AS total_dsnps,`);
  lines.push(`  COUNT(DISTINCT CASE WHEN b.benefit_type = 'food_card'     THEN (p.contract_id || '-' || p.plan_id) END) AS has_food_card,`);
  lines.push(`  COUNT(DISTINCT CASE WHEN b.benefit_type = 'otc_allowance' THEN (p.contract_id || '-' || p.plan_id) END) AS has_otc_allowance`);
  lines.push(`FROM pm_plans p`);
  lines.push(`LEFT JOIN pbp_benefits_v2 b`);
  lines.push(`  ON p.contract_id = b.contract_id AND p.plan_id = b.plan_id`);
  lines.push(`  AND b.benefit_type IN ('food_card', 'otc_allowance')`);
  lines.push(`WHERE p.snp_type = 'D-SNP' AND p.state IN ('NC', 'TX', 'GA');`);

  writeFileSync(OUT_PATH, lines.join('\n') + '\n');
  console.log(`\nWrote ${emitted} INSERT statements (${skipped} skipped) → ${OUT_PATH}`);
})();
