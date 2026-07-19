// Phase 4 remaining data fixes — 9 rows across 8 plans.
//
// Source of truth: _tmp/phase4-failures.json (records with segment_id
// "0" and root_cause in {"E","A"}, filtered to the fields where CMS
// truth is unambiguous single-segment). Verified via
// scripts/_probe-p4-9.ts before writing.
//
// Fixes:
//   P1  H1189-003  lab      UPDATE copay 50 → 0    (CHRISTUS)
//   P1  H1189-004  lab      UPDATE copay 50 → 0    (CHRISTUS)
//   P1  H1189-008  lab      UPDATE copay 75 → 0    (CHRISTUS)
//   P2  H7115-006  lab      UPDATE copay 25 → 0    (Memorial Hermann)
//   P2  H7115-006  mh_ind   UPDATE copay 40 → 0    (Memorial Hermann)
//   P3  H4513-009  mh_ind   INSERT copay=0         (HealthSpring — no row)
//   P4  H2593-031  snf      UPDATE copay null → 0  (Wellpoint C-SNP)
//   P4  H6351-004  snf      UPDATE copay null → 0  (Liberty C-SNP)
//   P4  R2604-002  snf      UPDATE copay null → 0  (UHC Regional PPO C-SNP)
//
// Idempotent, --write guarded, per-row before/after logged.
// Run: npx tsx scripts/_fix-phase4-remaining.ts           (dry-run)
//      npx tsx scripts/_fix-phase4-remaining.ts --write   (execute)

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const WRITE = process.argv.includes('--write');

type Op =
  | { kind: 'update'; label: string; contract: string; plan: string; category: string; new_copay: number }
  | { kind: 'insert'; label: string; contract: string; plan: string; segment: string; category: string; new_copay: number; description: string };

const OPS: Op[] = [
  // P1 — CHRISTUS Health Advantage lab drift
  { kind: 'update', label: 'P1 CHRISTUS H1189-003 lab',           contract: 'H1189', plan: '003', category: 'lab',                                    new_copay: 0 },
  { kind: 'update', label: 'P1 CHRISTUS H1189-004 lab',           contract: 'H1189', plan: '004', category: 'lab',                                    new_copay: 0 },
  { kind: 'update', label: 'P1 CHRISTUS H1189-008 lab',           contract: 'H1189', plan: '008', category: 'lab',                                    new_copay: 0 },
  // P2 — Memorial Hermann Prime Value drift (lab + MH)
  { kind: 'update', label: 'P2 MemHermann H7115-006 lab',         contract: 'H7115', plan: '006', category: 'lab',                                    new_copay: 0 },
  { kind: 'update', label: 'P2 MemHermann H7115-006 mh_ind',      contract: 'H7115', plan: '006', category: 'mental_health_outpatient_individual',    new_copay: 0 },
  // P3 — HealthSpring Courage MH row missing entirely
  { kind: 'insert', label: 'P3 HealthSpring H4513-009 mh_ind',    contract: 'H4513', plan: '009', segment: '0',
    category: 'mental_health_outpatient_individual',              new_copay: 0,
    description: '$0 copay (CMS-verified, Phase 4)' },
  // P4 — C-SNP SNF copay nulls (CMS reports $0 for all three)
  { kind: 'update', label: 'P4 Wellpoint H2593-031 snf',          contract: 'H2593', plan: '031', category: 'snf',                                    new_copay: 0 },
  { kind: 'update', label: 'P4 Liberty H6351-004 snf',            contract: 'H6351', plan: '004', category: 'snf',                                    new_copay: 0 },
  { kind: 'update', label: 'P4 UHC R2604-002 snf',                contract: 'R2604', plan: '002', category: 'snf',                                    new_copay: 0 },
];

async function main() {
  const mode = WRITE ? 'WRITE' : 'DRY-RUN';
  console.log(`Phase 4 remaining data fixes (${mode})`);
  console.log('─'.repeat(80));

  let ok = 0, skipped = 0, fail = 0, inserted = 0;

  for (const op of OPS) {
    // Fetch current state
    const { data: rows, error: readErr } = await sb.from('pm_plan_benefits')
      .select('id, contract_id, plan_id, segment_id, benefit_category, copay, coinsurance, coverage_amount, benefit_description')
      .eq('contract_id', op.contract).eq('plan_id', op.plan)
      .eq('benefit_category', op.category);
    if (readErr) { console.error(`  ${op.label}: READ ERR ${readErr.message}`); fail++; continue; }

    if (op.kind === 'update') {
      if (!rows || rows.length === 0) {
        console.error(`  ${op.label}: EXPECTED existing row but NONE found — refusing to auto-INSERT. Skipping.`);
        fail++; continue;
      }
      for (const r of rows) {
        const before = r.copay;
        if (before === op.new_copay) {
          console.log(`  ${op.label}: id=${r.id} already copay=${before} (no-op)`);
          skipped++; continue;
        }
        console.log(`  ${op.label}: id=${r.id} BEFORE copay=${before} → AFTER copay=${op.new_copay}`);
        if (!WRITE) continue;
        const { error: upErr } = await sb.from('pm_plan_benefits')
          .update({ copay: op.new_copay })
          .eq('id', r.id);
        if (upErr) { console.error(`    UPDATE err id=${r.id}: ${upErr.message}`); fail++; continue; }
        ok++;
      }
    } else {
      // insert
      if (rows && rows.length > 0) {
        // Row exists — treat as update so idempotent re-runs converge.
        for (const r of rows) {
          if (r.copay === op.new_copay) {
            console.log(`  ${op.label}: id=${r.id} already exists with copay=${r.copay} (no-op)`);
            skipped++; continue;
          }
          console.log(`  ${op.label}: id=${r.id} row already exists — UPDATE copay=${r.copay} → ${op.new_copay}`);
          if (!WRITE) continue;
          const { error: upErr } = await sb.from('pm_plan_benefits')
            .update({ copay: op.new_copay })
            .eq('id', r.id);
          if (upErr) { console.error(`    UPDATE err id=${r.id}: ${upErr.message}`); fail++; continue; }
          ok++;
        }
        continue;
      }
      console.log(`  ${op.label}: NO ROW → INSERT copay=${op.new_copay} desc="${op.description}"`);
      if (!WRITE) continue;
      const { data: insRow, error: insErr } = await sb.from('pm_plan_benefits').insert({
        contract_id: op.contract,
        plan_id: op.plan,
        segment_id: op.segment,
        benefit_category: op.category,
        benefit_description: op.description,
        copay: op.new_copay,
      }).select('id').single();
      if (insErr) { console.error(`    INSERT err: ${insErr.message}`); fail++; continue; }
      console.log(`    INSERTED id=${insRow?.id}`);
      inserted++;
    }
  }

  console.log('');
  console.log('─'.repeat(80));
  console.log(`Summary: updated=${ok}  inserted=${inserted}  no-op=${skipped}  errors=${fail}`);
  console.log(WRITE ? 'DONE (writes committed)' : 'DRY-RUN complete. Re-run with --write.');
}
main().catch((e) => { console.error(e); process.exit(1); });
