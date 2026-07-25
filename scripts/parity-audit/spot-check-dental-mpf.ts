#!/usr/bin/env tsx
// MPF-vs-PM reconciliation for the 26 dental-fail plans surfaced by
// audit-diabetes-chiro-acupuncture's sibling audit output. Follows
// the chiro-spot-check pattern:
//
//   1. For each failing plan, load the cached MPF plan-detail JSON
//      from _tmp/parity-audit/mpf/ (all 26 are cached).
//   2. Extract dental from ma_benefits[] where service or category
//      matches /dental/i. MPF files it as e.g.:
//        - service='PREVENTIVE_DENTAL' / 'COMPREHENSIVE_DENTAL' /
//          'DIAGNOSTIC_DENTAL' with cost_sharing[].min_copay
//        - category='PREVENTIVE_DENTAL'
//   3. Compute a preventive-min-copay and comprehensive-min-copay
//      from the MPF rows; if MPF has zero dental rows, mark the
//      plan as "MPF_NO_DENTAL" (PM must not claim dental coverage).
//   4. Compare against PM's dental_preventive + dental_comprehensive
//      + dental (fallback) benefit_categories.
//   5. UPDATE pm_plan_benefits.dental_preventive (or dental) to
//      match MPF; DELETE pm dental rows when MPF has zero coverage.
//
// Modes:
//   default  → dry-run summary
//   --write  → execute UPDATEs and DELETEs

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
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
const MPF_CACHE_DIR = path.join(OUT_DIR, 'mpf');
const PLAN_LIST = path.join(OUT_DIR, 'dental-plans.csv');

const sb = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false } });

const args = process.argv.slice(2);
const WRITE = args.includes('--write');

interface PlanKey { contract: string; plan: string; segment: string }

function loadPlans(): PlanKey[] {
  return readFileSync(PLAN_LIST, 'utf8').trim().split('\n').map((l) => {
    const parts = l.split('-');
    return { contract: parts[0], plan: parts[1], segment: (parts[2] ?? '0').replace(/^0+/, '') || '0' };
  });
}

function loadCachedPlan(k: PlanKey): unknown | null {
  if (!existsSync(MPF_CACHE_DIR)) return null;
  const seg = k.segment;
  const filename = `${k.contract}-${k.plan}-${seg}.json`;
  const profileDirs = readdirSync(MPF_CACHE_DIR).filter((d) => statSync(path.join(MPF_CACHE_DIR, d)).isDirectory());
  for (const pd of profileDirs) {
    const p = path.join(MPF_CACHE_DIR, pd, filename);
    if (existsSync(p)) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch {} }
  }
  return null;
}

interface MpfDental {
  preventiveCopay: number | null;
  preventiveCoins: number | null;
  comprehensiveCopay: number | null;
  comprehensiveCoins: number | null;
  hasAny: boolean;
}

function extractMpfDental(json: unknown): MpfDental {
  const card = (json as { plan_card?: Record<string, unknown> })?.plan_card;
  const arr = ((card?.ma_benefits ?? []) as Array<any>);
  const dental = arr.filter((b) => /dental/i.test(b.service ?? '') || /dental/i.test(b.category ?? ''));
  const evalCategory = (patterns: RegExp[]): { copay: number | null; coins: number | null } => {
    const rows = dental.filter((d) => patterns.some((r) => r.test(d.service ?? '') || r.test(d.category ?? '')));
    if (rows.length === 0) return { copay: null, coins: null };
    let minCopay: number | null = null;
    let minCoins: number | null = null;
    for (const row of rows) {
      const inNet = (row.cost_sharing ?? []).find((cs: any) => cs.network_status === 'IN_NETWORK');
      if (!inNet) continue;
      if (typeof inNet.min_copay === 'number') { minCopay = minCopay == null ? inNet.min_copay : Math.min(minCopay, inNet.min_copay); }
      if (typeof inNet.min_coinsurance === 'number') { minCoins = minCoins == null ? inNet.min_coinsurance : Math.min(minCoins, inNet.min_coinsurance); }
    }
    return { copay: minCopay, coins: minCoins };
  };
  const prev = evalCategory([/PREVENTIVE_DENTAL/, /DIAGNOSTIC_DENTAL/]);
  const comp = evalCategory([/COMPREHENSIVE_DENTAL/, /^DENTAL_/, /_DENTAL_(?!PREV|DIAG)/]);
  return {
    preventiveCopay: prev.copay, preventiveCoins: prev.coins,
    comprehensiveCopay: comp.copay, comprehensiveCoins: comp.coins,
    hasAny: dental.length > 0,
  };
}

interface PmDental { copay: number | null; coinsurance: number | null; benefit_description: string | null }

async function loadPmDental(k: PlanKey, cat: string): Promise<PmDental | null> {
  const seg = k.segment;
  const paddedSeg = seg.padStart(3, '0');
  const r = await sb.from('pm_plan_benefits').select('copay, coinsurance, benefit_description')
    .eq('contract_id', k.contract).eq('plan_id', k.plan)
    .in('segment_id', [seg, paddedSeg])
    .eq('benefit_category', cat).maybeSingle();
  return r.data ?? null;
}

interface Verdict {
  key: PlanKey;
  mpf: MpfDental;
  pmDental: PmDental | null;
  pmPrev: PmDental | null;
  pmComp: PmDental | null;
  action: 'UPDATE_PREV' | 'UPDATE_DENTAL_TO_MPF_PREV' | 'DELETE_PM_DENTAL' | 'NO_ACTION' | 'MANUAL';
  note: string;
}

async function main() {
  console.log(`=== ${WRITE ? 'WRITE' : 'DRY-RUN'} MODE ===`);
  const plans = loadPlans();
  console.log(`Loaded ${plans.length} dental-fail plans`);

  const results: Verdict[] = [];
  for (const k of plans) {
    const cached = loadCachedPlan(k);
    if (!cached) { results.push({ key: k, mpf: { preventiveCopay: null, preventiveCoins: null, comprehensiveCopay: null, comprehensiveCoins: null, hasAny: false }, pmDental: null, pmPrev: null, pmComp: null, action: 'MANUAL', note: 'no MPF cache' }); continue; }
    const mpf = extractMpfDental(cached);
    const pmDental = await loadPmDental(k, 'dental');
    const pmPrev = await loadPmDental(k, 'dental_preventive');
    const pmComp = await loadPmDental(k, 'dental_comprehensive');

    let action: Verdict['action'] = 'NO_ACTION';
    let note = '';
    if (!mpf.hasAny) {
      // MPF has no dental. If PM claims dental coverage, either delete or mark not covered.
      if (pmDental || pmPrev || pmComp) {
        action = 'DELETE_PM_DENTAL';
        note = 'MPF has no dental rows; PM claims dental — mark as not covered';
      } else {
        note = 'MPF and PM both have no dental — no action';
      }
    } else {
      // MPF has dental. Compare copays.
      const mpfPrevCopay = mpf.preventiveCopay ?? 0;  // preventive is usually $0
      if (pmPrev) {
        if (pmPrev.copay !== mpfPrevCopay) {
          action = 'UPDATE_PREV';
          note = `pm dental_preventive.copay ${pmPrev.copay} → mpf ${mpfPrevCopay}`;
        } else note = 'pm dental_preventive matches mpf';
      } else if (pmDental) {
        // Only a flat 'dental' row on PM. Update its copay to MPF preventive.
        if (pmDental.copay !== mpfPrevCopay) {
          action = 'UPDATE_DENTAL_TO_MPF_PREV';
          note = `pm dental.copay ${pmDental.copay} → mpf preventive ${mpfPrevCopay}`;
        } else note = 'pm dental matches mpf preventive';
      } else {
        note = 'no pm dental row + mpf has data — needs INSERT (out of scope)';
      }
    }
    results.push({ key: k, mpf, pmDental, pmPrev, pmComp, action, note });
  }

  // Summary
  const byAction = new Map<string, number>();
  for (const r of results) byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
  console.log('\n=== Summary by action ===');
  for (const [a, n] of [...byAction.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${a.padEnd(28)} ${n}`);

  // Detail
  console.log('\n=== Detail ===');
  for (const r of results) {
    console.log(`  ${r.key.contract}-${r.key.plan}-${r.key.segment}  ${r.action}  |  ${r.note}`);
  }

  if (!WRITE) { console.log('\n(dry-run — pass --write to apply)'); return; }

  console.log('\n=== Applying writes ===');
  let ok = 0, err = 0;
  for (const r of results) {
    const seg = r.key.segment;
    const paddedSeg = seg.padStart(3, '0');
    try {
      if (r.action === 'DELETE_PM_DENTAL') {
        // Mark rows as not-covered rather than delete — keep the row so
        // the render layer says "Not covered" instead of "Not filed".
        const q = await sb.from('pm_plan_benefits').update({
          copay: null, coinsurance: null, max_coverage: null, coverage_amount: null,
          benefit_description: 'Dental services · not covered by this plan',
        })
          .eq('contract_id', r.key.contract).eq('plan_id', r.key.plan)
          .in('segment_id', [seg, paddedSeg])
          .in('benefit_category', ['dental', 'dental_preventive', 'dental_comprehensive']);
        if (q.error) throw q.error;
        ok++;
      } else if (r.action === 'UPDATE_PREV') {
        const desc = (r.mpf.preventiveCopay === 0) ? 'Dental preventive · $0 copay' : `Dental preventive · $${r.mpf.preventiveCopay} copay`;
        const q = await sb.from('pm_plan_benefits').update({ copay: r.mpf.preventiveCopay, coinsurance: r.mpf.preventiveCoins, benefit_description: desc })
          .eq('contract_id', r.key.contract).eq('plan_id', r.key.plan)
          .in('segment_id', [seg, paddedSeg])
          .eq('benefit_category', 'dental_preventive');
        if (q.error) throw q.error;
        ok++;
      } else if (r.action === 'UPDATE_DENTAL_TO_MPF_PREV') {
        const desc = (r.mpf.preventiveCopay === 0) ? 'Dental · $0 preventive copay' : `Dental · $${r.mpf.preventiveCopay} preventive copay`;
        const q = await sb.from('pm_plan_benefits').update({ copay: r.mpf.preventiveCopay, coinsurance: r.mpf.preventiveCoins, benefit_description: desc })
          .eq('contract_id', r.key.contract).eq('plan_id', r.key.plan)
          .in('segment_id', [seg, paddedSeg])
          .eq('benefit_category', 'dental');
        if (q.error) throw q.error;
        ok++;
      }
    } catch (e) { console.error(`  fail ${r.key.contract}-${r.key.plan}-${r.key.segment}: ${(e as Error).message}`); err++; }
  }
  console.log(`  ${ok} ok, ${err} failed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
