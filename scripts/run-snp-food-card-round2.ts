// Round 2 food-card import — 146 D-SNP + C-SNP plans in NC/TX/GA.
//
// Mirrors scripts/run-dsnp-food-card-import.ts (commit 1227db1) with
// only these deltas:
//   • CSV path: scripts/captures/snp-food-card-gap-round2.csv
//   • CSV shape: 4-row title preamble + row-5 real header + banner
//     and carrier sub-header rows interleaved with data — filter to
//     rows whose Plan ID matches [HR]\d+-\d+
//   • PROVENANCE_TAG: [manual_capture_2026-07-09]
//   • Explicit plan-level skips per task: R6801-009 ($0 "no card"),
//     H9706-002 (BCBS TX, placeholder — would override existing
//     medicare_gov description)
//   • Classification per round-1 pattern: notes matching /^no food/ or
//     containing "no food (otc" → benefit_type='otc_allowance'; else
//     'food_card'. The "Food in Card (who qualifies)" column is what
//     carries the "no food (otc/dvh flex only)" marker in round 2 —
//     round 1 had it in the "notes" column.
//   • Everything else: identical to round 1 (DELETE+INSERT, segment
//     expansion via pm_plans, copay/copay_max/coverage_amount payload,
//     source='manual' outranks medicare_gov for CARRIER_AUTHORITATIVE
//     benefit types per api/plans.ts:404-419).

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
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
const projectId = url.replace(/^https?:\/\//, '').split('.')[0];
console.log(`Connected to Supabase project: ${projectId}`);
if (projectId !== 'rpcbrkmvalvdmroqzpaq') {
  console.error(`ABORT: expected rpcbrkmvalvdmroqzpaq, got ${projectId}`);
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const CSV_PATH = resolve(process.cwd(), 'scripts/captures/snp-food-card-gap-round2.csv');
const PROVENANCE_TAG = '[manual_capture_2026-07-09]';
const PLAN_YEAR = 2026;
const DRY_RUN = process.argv.includes('--dry-run');

// Explicit per-task plan-level skips.
const SKIP_PLANS = new Set<string>(['R6801-009', 'H9706-002']);

function parseCsv(text: string): string[][] {
  const out: string[][] = []; let cur: string[] = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else inQ = false; } else field += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { cur.push(field); field = ''; }
    else if (c === '\n') { cur.push(field); out.push(cur); cur = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || cur.length) { cur.push(field); out.push(cur); }
  return out;
}

// Round 1 classification, adapted for round-2 column shape. In round 2
// the "no food (otc/dvh flex only)" marker lives in column J (Food in
// Card — who qualifies), not the notes column. We inspect BOTH cells
// for the marker so future spreadsheet edits that shift copy between
// columns still classify correctly.
function classify(who: string, notes: string): 'food_card' | 'otc_allowance' {
  const merged = `${who} ${notes}`.toLowerCase();
  if (merged.includes('no food (otc') || merged.startsWith('no food') || /\bno food\b/.test(merged) && /\botc\b/.test(merged)) {
    return 'otc_allowance';
  }
  return 'food_card';
}

function parseAmount(raw: string): number {
  const cleaned = raw.replace(/[$,]/g, '').trim();
  if (!cleaned) return 0;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

interface Captured {
  contract_id: string;
  plan_id: string;
  cp: string;
  carrier: string;
  state: string;
  snp_type: string;
  amount: number;
  frequency: string;
  notes: string;
  who: string;
  benefit_type: 'food_card' | 'otc_allowance';
}

async function main() {
  const rows = parseCsv(readFileSync(CSV_PATH, 'utf8'));
  const planIdRe = /^[HR]\d{3,5}-\d{3,4}$/;
  const captured: Captured[] = [];
  const skipped: Array<{ cp: string; reason: string }> = [];

  // Row 4 (0-indexed) is the real header. Data starts at row 5.
  // Column order: Plan ID, Carrier, Plan Name, State, SNP Type,
  //   Sample ZIP, Food Card $/mo, Frequency, Notes,
  //   Food in Card (who qualifies), Current DB Status
  for (const r of rows) {
    const planId = (r[0] ?? '').trim();
    if (!planIdRe.test(planId)) continue; // banner / preamble / carrier sub-header
    if (SKIP_PLANS.has(planId)) {
      skipped.push({ cp: planId, reason: 'explicit per-task skip' });
      continue;
    }
    const [contract_id, plan_id] = planId.split('-');
    const amount = parseAmount(r[6] ?? '');
    const frequency = ((r[7] ?? '').trim() || 'monthly').toLowerCase();
    const notes = (r[8] ?? '').trim();
    const who = (r[9] ?? '').trim();
    if (amount === 0) {
      skipped.push({ cp: planId, reason: `amount=0 (${who || 'no note'})` });
      continue;
    }
    captured.push({
      contract_id,
      plan_id,
      cp: planId,
      carrier: (r[1] ?? '').trim(),
      state: (r[3] ?? '').trim(),
      snp_type: (r[4] ?? '').trim(),
      amount,
      frequency,
      notes,
      who,
      benefit_type: classify(who, notes),
    });
  }

  const foodCount = captured.filter((r) => r.benefit_type === 'food_card').length;
  const otcCount = captured.filter((r) => r.benefit_type === 'otc_allowance').length;
  console.log(`\nCSV parse:`);
  console.log(`  ${captured.length} captured  (${foodCount} food_card + ${otcCount} otc_allowance)`);
  console.log(`  ${skipped.length} skipped`);
  for (const s of skipped) console.log(`    ${s.cp}  ${s.reason}`);

  // ─── Resolve segments per plan (all pm_plans segment_ids) ────────────
  console.log(`\nResolving segments from pm_plans…`);
  const planSegs = new Map<string, string[]>();
  for (const r of captured) {
    const { data, error } = await sb
      .from('pm_plans')
      .select('segment_id')
      .eq('contract_id', r.contract_id)
      .eq('plan_id', r.plan_id);
    if (error) {
      console.error(`  pm_plans query failed for ${r.cp}: ${error.message}`);
      process.exit(1);
    }
    const segs = [...new Set((data ?? []).map((x: { segment_id: string | number | null }) => String(x.segment_id ?? '0')))];
    planSegs.set(r.cp, segs.length ? segs : ['0']);
  }
  const totalUpserts = captured.reduce((a, r) => a + (planSegs.get(r.cp)?.length ?? 0), 0);
  const multiSeg = captured.filter((r) => (planSegs.get(r.cp)?.length ?? 0) > 1);
  console.log(`  ${captured.length} plans → ${totalUpserts} upserts (${multiSeg.length} plans have >1 segment)`);
  if (multiSeg.length > 0 && multiSeg.length <= 15) {
    for (const r of multiSeg) console.log(`    ${r.cp}  segments=${planSegs.get(r.cp)?.join(',')}`);
  }

  // ─── Pre-snapshot existing rows for our set ──────────────────────────
  const ors = captured
    .map((r) => `and(contract_id.eq.${r.contract_id},plan_id.eq.${r.plan_id})`)
    .join(',');
  const { data: before } = await sb
    .from('pbp_benefits_v2')
    .select('contract_id, plan_id, benefit_type, source, copay')
    .or(ors)
    .in('benefit_type', ['food_card', 'otc_allowance']);
  console.log(`\nPRE-INSERT snapshot: ${before?.length ?? 0} existing food_card+otc_allowance rows for these plans`);
  const beforeBySrc: Record<string, number> = {};
  for (const r of (before ?? []) as Array<{ source: string }>) {
    beforeBySrc[r.source] = (beforeBySrc[r.source] ?? 0) + 1;
  }
  console.log(`  by source: ${JSON.stringify(beforeBySrc)}`);

  if (DRY_RUN) {
    console.log(`\n--dry-run: no writes. Sample of first 5 payloads:`);
    for (const r of captured.slice(0, 5)) {
      let monthly = r.amount;
      if (r.frequency === 'quarterly') monthly = r.amount / 3;
      else if (r.frequency === 'annual') monthly = r.amount / 12;
      console.log(`  ${r.cp}  ${r.benefit_type}  raw=$${r.amount}/${r.frequency}  → copay=${monthly.toFixed(2)}/mo  segs=${planSegs.get(r.cp)?.join(',')}`);
    }
    process.exit(0);
  }

  // ─── Execute ─────────────────────────────────────────────────────────
  console.log(`\nRunning ${totalUpserts} upserts…`);
  let ok = 0, fail = 0;
  for (const r of captured) {
    let monthly = r.amount;
    if (r.frequency === 'quarterly') monthly = r.amount / 3;
    else if (r.frequency === 'annual') monthly = r.amount / 12;
    const annualCap = monthly * 12;
    const description = `${PROVENANCE_TAG} $${monthly.toFixed(2)} per month — ${r.notes || r.who}`.slice(0, 1000);

    for (const segment_id of planSegs.get(r.cp) ?? []) {
      const payload = {
        contract_id: r.contract_id,
        plan_id: r.plan_id,
        segment_id,
        plan_year: PLAN_YEAR,
        benefit_type: r.benefit_type,
        copay: Number(monthly.toFixed(2)),
        copay_max: Number(annualCap.toFixed(2)),
        coverage_amount: Number(monthly.toFixed(2)),
        source: 'manual' as const,
        description,
      };
      // PostgREST can't onConflict against the expression unique index
      // uq_pbp_benefits_v2_natural (COALESCE(tier_id,'')). Same
      // workaround round 1 used: DELETE tier_id-null row at natural key
      // first, then INSERT. Existing tier_id='0' rows in the other
      // COALESCE bucket are untouched.
      const { error: delErr } = await sb.from('pbp_benefits_v2').delete()
        .eq('contract_id', r.contract_id)
        .eq('plan_id', r.plan_id)
        .eq('segment_id', segment_id)
        .eq('plan_year', PLAN_YEAR)
        .eq('benefit_type', r.benefit_type)
        .is('tier_id', null);
      if (delErr) {
        console.error(`  FAIL DELETE ${r.cp} seg=${segment_id} ${r.benefit_type}: ${delErr.message}`);
        fail += 1;
        continue;
      }
      const { error: insErr } = await sb.from('pbp_benefits_v2').insert(payload);
      if (insErr) {
        console.error(`  FAIL INSERT ${r.cp} seg=${segment_id} ${r.benefit_type}: ${insErr.message}`);
        fail += 1;
      } else {
        ok += 1;
      }
    }
  }
  console.log(`\nResult: ${ok} ok, ${fail} failed`);

  // ─── Verification 1: our batch by benefit_type ───────────────────────
  const { data: v1 } = await sb
    .from('pbp_benefits_v2')
    .select('benefit_type')
    .eq('source', 'manual')
    .like('description', `${PROVENANCE_TAG}%`);
  const v1count: Record<string, number> = {};
  for (const r of (v1 ?? []) as Array<{ benefit_type: string }>) {
    v1count[r.benefit_type] = (v1count[r.benefit_type] ?? 0) + 1;
  }
  console.log(`\nVerification 1 — round-2 manual+tag rows by benefit_type:`);
  console.log(`  ${JSON.stringify(v1count)}`);

  // ─── Verification 2: SNP coverage in NC/TX/GA ────────────────────────
  const { data: snps } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, snp_type')
    .in('snp_type', ['D-SNP', 'C-SNP'])
    .in('state', ['NC', 'TX', 'GA']);
  const dsnpSet = new Set<string>();
  const csnpSet = new Set<string>();
  for (const r of (snps ?? []) as Array<{ contract_id: string; plan_id: string; snp_type: string }>) {
    const cp = `${r.contract_id}-${r.plan_id}`;
    if (r.snp_type === 'D-SNP') dsnpSet.add(cp);
    else if (r.snp_type === 'C-SNP') csnpSet.add(cp);
  }
  const allSnp = new Set([...dsnpSet, ...csnpSet]);
  const snpOrs = [...allSnp].map((cp) => { const [c, p] = cp.split('-'); return `and(contract_id.eq.${c},plan_id.eq.${p})`; }).join(',');
  const { data: bRows } = await sb
    .from('pbp_benefits_v2')
    .select('contract_id, plan_id, benefit_type, source, copay')
    .or(snpOrs)
    .in('benefit_type', ['food_card', 'otc_allowance']);
  const SOURCE_RANK: Record<string, number> = { manual: 4, sb_ocr: 3, medicare_gov: 2, pbp_federal: 1 };
  const winnerByCp = new Map<string, { source: string; copay: number | null; benefit_type: string }>();
  for (const r of (bRows ?? []) as Array<{ contract_id: string; plan_id: string; benefit_type: string; source: string; copay: number | null }>) {
    if (r.benefit_type !== 'food_card') continue;
    const cp = `${r.contract_id}-${r.plan_id}`;
    const prior = winnerByCp.get(cp);
    if (!prior || (SOURCE_RANK[r.source] ?? 0) > (SOURCE_RANK[prior.source] ?? 0)) {
      winnerByCp.set(cp, { source: r.source, copay: r.copay, benefit_type: r.benefit_type });
    }
  }
  const realDollar = (set: Set<string>) => {
    let n = 0;
    for (const cp of set) {
      const w = winnerByCp.get(cp);
      if (w && typeof w.copay === 'number' && w.copay > 1) n += 1;
    }
    return n;
  };
  console.log(`\nVerification 2 — SNP food_card coverage (winner copay > 1) in NC/TX/GA:`);
  console.log(`  D-SNP: ${realDollar(dsnpSet)}/${dsnpSet.size}  (${(realDollar(dsnpSet) / dsnpSet.size * 100).toFixed(1)}%)`);
  console.log(`  C-SNP: ${realDollar(csnpSet)}/${csnpSet.size}  (${(realDollar(csnpSet) / csnpSet.size * 100).toFixed(1)}%)`);

  // ─── Verification 3: spot checks (one per carrier from round 2) ──────
  const spots = ['H5253-041', 'H5299-013', 'H3146-002', 'H4141-003', 'H5296-004'];
  console.log(`\nVerification 3 — spot checks:`);
  for (const cp of spots) {
    const [c, p] = cp.split('-');
    const { data } = await sb
      .from('pbp_benefits_v2')
      .select('segment_id, benefit_type, copay, source, description')
      .eq('contract_id', c).eq('plan_id', p)
      .eq('source', 'manual').eq('benefit_type', 'food_card');
    if (!data || data.length === 0) {
      console.log(`  ${cp}: no manual food_card row (may have been classified otc_allowance or skipped)`);
      continue;
    }
    for (const r of data as Array<{ segment_id: string; copay: number; description: string }>) {
      console.log(`  ${cp}  seg=${r.segment_id}  food_card copay=$${r.copay}  desc="${(r.description ?? '').slice(0, 80)}…"`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
