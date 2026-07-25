#!/usr/bin/env tsx
// Backfill pm_plan_benefits copays for urgent_care / specialist /
// ambulance on MA/MAPD plans in NC/TX/GA. The 2026-07-24 parity audit
// surfaced 68 F1 fails where MPF reported a real dollar copay (e.g.
// $40 urgent_care, $65 specialist, $315 ambulance) but PM returned
// $0 flat. Root cause: pm_plan_benefits rows carry copay=0 +
// max_coverage=null (the landscape importer wrote a zero placeholder
// where cms_pbp actually holds the real value).
//
// This mirrors the pattern of mirror-diabetes-chiro-acupuncture-to-pm-
// benefits.ts: for every pm row where the structured copay is 0/null
// AND pbp_benefits carries a non-zero copay for the same category,
// UPDATE the pm row's copay to the pbp value. Preserves the description.
//
// Skip rules:
//   - Row explicitly says "not covered" — keep as-is.
//   - Existing pm.copay > 0 — real dispute, don't overwrite.
//   - pbp source rank: medicare_gov > sb_ocr > manual > cms_pbp.
//
// Modes:
//   default   → dry-run summary
//   --state   → scope by state (default NC,TX,GA)
//   --write   → execute UPDATEs

import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const sb = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false } });

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const stateArg = args.find((a) => a.startsWith('--state='))?.slice(8)
  ?? (args.includes('--state') ? args[args.indexOf('--state') + 1] : null);
const STATES = (stateArg ?? 'NC,TX,GA').split(',').map((s) => s.trim().toUpperCase());

const CATEGORIES = ['urgent_care', 'specialist', 'ambulance'] as const;
type Category = typeof CATEGORIES[number];

const PBP_RANK: Record<string, number> = { medicare_gov: 5, sb_ocr: 4, manual: 3, cms_pbp: 2, pbp: 2 };

function chunk<T>(a: T[], n: number): T[][] { const o: T[][]=[]; for (let i=0;i<a.length;i+=n) o.push(a.slice(i,i+n)); return o; }

function collapseRange(r: { copay: number | null; copay_max: number | null }): number | null {
  if (r.copay === 0 && r.copay_max != null && r.copay_max > 0) return r.copay_max;
  return r.copay;
}

interface PlanKey { contract_id: string; plan_id: string; segment_id: string; state: string }

async function loadPlans(): Promise<Map<string, PlanKey>> {
  const plans = new Map<string, PlanKey>();
  for (const st of STATES) {
    let from = 0;
    while (true) {
      const r = await sb.from('pm_plans').select('contract_id, plan_id, segment_id, plan_type').eq('state', st).not('plan_type', 'ilike', '%pdp%').range(from, from + 999);
      const c = r.data ?? [];
      for (const row of c as any[]) {
        const k = `${row.contract_id}-${row.plan_id}-${row.segment_id}`;
        if (!plans.has(k)) plans.set(k, { contract_id: row.contract_id, plan_id: row.plan_id, segment_id: row.segment_id, state: st });
      }
      if (c.length < 1000) break; from += 1000;
    }
  }
  return plans;
}

async function main() {
  console.log(`=== ${WRITE ? 'WRITE' : 'DRY-RUN'} MODE ===`);
  console.log(`States: ${STATES.join(',')}`);
  const plans = await loadPlans();
  console.log(`MA/MAPD plans in scope: ${plans.size}\n`);

  let totalUpdated = 0;

  for (const cat of CATEGORIES) {
    console.log(`── ${cat} ──`);
    // Load existing pm rows
    const pmRows = new Map<string, { copay: number | null; coinsurance: number | null; benefit_description: string | null }>();
    {
      let from = 0;
      while (true) {
        const r = await sb.from('pm_plan_benefits').select('contract_id, plan_id, segment_id, copay, coinsurance, benefit_description').eq('benefit_category', cat).range(from, from + 999);
        const c = r.data ?? [];
        for (const row of c as any[]) pmRows.set(`${row.contract_id}-${row.plan_id}-${row.segment_id}`, row);
        if (c.length < 1000) break; from += 1000;
      }
    }

    // Load best pbp values
    const bestByPlan = new Map<string, { copay: number | null; copay_max: number | null; coinsurance: number | null; description: string | null; source: string | null }>();
    const combined = [...new Set([...plans.values()].map((p) => `${p.contract_id}-${p.plan_id}`))];
    for (const slice of chunk(combined, 200)) {
      const r = await sb.from('pbp_benefits').select('plan_id, copay, copay_max, coinsurance, description, source').eq('benefit_type', cat).in('plan_id', slice);
      for (const row of (r.data ?? []) as any[]) {
        const cur = bestByPlan.get(row.plan_id);
        const curRank = cur ? (PBP_RANK[cur.source ?? ''] ?? 0) : -1;
        const newRank = PBP_RANK[row.source ?? ''] ?? 0;
        // Prefer the row with real cost data if same rank
        if (newRank > curRank || (newRank === curRank && (cur?.copay == null || cur.copay === 0) && (row.copay != null && row.copay > 0))) {
          bestByPlan.set(row.plan_id, row);
        }
      }
    }

    const updates: Array<{ key: PlanKey; newCopay: number | null; newCoins: number | null; newDesc: string }> = [];
    let skipDispute = 0;
    let skipNotCovered = 0;
    let skipNoPbp = 0;
    for (const [k, plan] of plans) {
      const pm = pmRows.get(k);
      if (!pm) continue;   // Missing rows out of scope for this fix
      const desc = (pm.benefit_description ?? '').toLowerCase();
      if (desc.includes('not covered')) { skipNotCovered++; continue; }
      const isZeroish = (pm.copay == null || pm.copay === 0) && (pm.coinsurance == null || pm.coinsurance === 0);
      if (!isZeroish) { continue; }   // pm has a real value; either it matches or is a real dispute
      const pbp = bestByPlan.get(`${plan.contract_id}-${plan.plan_id}`);
      if (!pbp) { skipNoPbp++; continue; }
      const pbpCopay = collapseRange(pbp);
      // Only patch when pbp actually has a positive value
      if ((pbpCopay == null || pbpCopay === 0) && (pbp.coinsurance == null || pbp.coinsurance === 0)) continue;
      const newCopay = pbpCopay ?? null;
      const newCoins = pbp.coinsurance ?? null;
      const newDesc = newCopay != null
        ? `${cat.replace('_', ' ')} · $${newCopay} copay`
        : newCoins != null ? `${cat.replace('_', ' ')} · ${newCoins}% coinsurance`
        : pm.benefit_description ?? '';
      updates.push({ key: plan, newCopay, newCoins, newDesc });
    }

    console.log(`  pm rows for scope: ${[...plans.keys()].filter((k) => pmRows.has(k)).length}`);
    console.log(`  UPDATEs planned:   ${updates.length}`);
    console.log(`  skip not-covered:  ${skipNotCovered}`);
    console.log(`  skip no pbp data:  ${skipNoPbp}`);

    if (WRITE && updates.length > 0) {
      let ok = 0, err = 0, progress = 0;
      for (const u of updates) {
        const r = await sb.from('pm_plan_benefits').update({ copay: u.newCopay, coinsurance: u.newCoins, benefit_description: u.newDesc })
          .eq('contract_id', u.key.contract_id).eq('plan_id', u.key.plan_id).eq('segment_id', u.key.segment_id)
          .eq('benefit_category', cat);
        if (r.error) { console.error(`  UPDATE fail ${u.key.contract_id}-${u.key.plan_id}-${u.key.segment_id}: ${r.error.message}`); err++; }
        else ok++;
        progress++;
        if (progress % 50 === 0) console.log(`  progress: ${progress}/${updates.length}`);
      }
      console.log(`  DONE: ${ok} ok, ${err} failed`);
      totalUpdated += ok;
    } else if (updates.length > 0) {
      console.log(`  sample: ${updates[0].key.contract_id}-${updates[0].key.plan_id}-${updates[0].key.segment_id} → copay=$${updates[0].newCopay} coins=${updates[0].newCoins}`);
    }
    void skipDispute;
    console.log('');
  }

  console.log(`Total rows updated: ${totalUpdated}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
