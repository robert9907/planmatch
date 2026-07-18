// Fixes A + B — moop_combined backfill + H4513-083 in-network moop correction.
//
// Source of truth: cached CMS scrapes at _tmp/medicare-gov/*.json.
// Reads maximum_oopc from each plan, parses both legs ("$X In-network"
// and "$Y In and Out-of-network"), and:
//
//   FIX A — UPDATE pm_plans SET moop_combined = <cms combined>
//           WHERE contract_id AND plan_id AND segment_id
//             AND moop_combined IS NULL
//           (only touches nulls — no clobbering deliberate values)
//
//   FIX B — UPDATE pm_plans SET moop = 6900
//           WHERE contract_id='H4513' AND plan_id='083' AND moop = 7200
//           (guarded on the old value — safe re-run if already fixed)
//
// Idempotent. --write required to actually mutate; default is dry-run.
//
// Run: npx tsx scripts/_fixAB-moop-backfill.ts           (dry-run)
//      npx tsx scripts/_fixAB-moop-backfill.ts --write   (execute)

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!url || !key) { console.error('need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const WRITE = process.argv.includes('--write');

const CMS_FILES = [
  '_tmp/medicare-gov/27713-37063.json',
  '_tmp/medicare-gov/77001-48201.json',
  '_tmp/medicare-gov/78002-48029.json',
  '_tmp/medicare-gov/30004-13121.json',
  '_tmp/medicare-gov/28623-37005.json',
];

interface CmsMoop {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string;
  in_net: number | null;
  combined: number | null;
  source_files: string[];
}

function loadCmsMoops(): Map<string, CmsMoop> {
  const out = new Map<string, CmsMoop>();
  for (const f of CMS_FILES) {
    if (!existsSync(f)) continue;
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    for (const p of (raw.plans ?? [])) {
      const s = String(p.maximum_oopc ?? '');
      const cm = s.match(/\$?([\d,]+)\s*In and Out-of-network/i);
      const im = s.match(/\$?([\d,]+)\s*In-network/i);
      if (!im && !cm) continue;
      const key = `${p.contract_id}-${p.plan_id}-${p.segment_id ?? '0'}`;
      const existing = out.get(key);
      const combined = cm ? Number(cm[1].replace(/,/g, '')) : null;
      const inNet    = im ? Number(im[1].replace(/,/g, '')) : null;
      if (existing) {
        // Consistency guard — earlier cross-file scan showed zero conflicts.
        if (existing.combined != null && combined != null && existing.combined !== combined) {
          console.error(`  CONFLICT combined ${key}: had ${existing.combined}, new ${combined} (${f})`);
        }
        existing.source_files.push(f.split('/').pop() ?? f);
      } else {
        out.set(key, {
          contract_id: p.contract_id,
          plan_id: p.plan_id,
          segment_id: String(p.segment_id ?? '0'),
          plan_name: p.name,
          in_net: inNet,
          combined,
          source_files: [f.split('/').pop() ?? f],
        });
      }
    }
  }
  return out;
}

async function main() {
  const mode = WRITE ? 'WRITE' : 'DRY-RUN';
  console.log(`Fixes A + B — moop backfill (${mode})`);
  console.log(`DB: ${url.replace('https://', '').split('.')[0]}`);
  console.log('─'.repeat(70));

  const cms = loadCmsMoops();
  const withCombined = [...cms.values()].filter((c) => c.combined != null);
  console.log(`CMS cache: ${cms.size} distinct (contract-plan-segment) plans, ${withCombined.length} with combined MOOP`);

  // ── FIX A: moop_combined backfill ─────────────────────────────
  console.log('\n── FIX A: pm_plans.moop_combined backfill (PPO combined MOOP) ──');
  let toWriteA = 0;
  let alreadyMatchesA = 0;
  let noPmRowA = 0;
  let differsA = 0;
  const writesA: Array<{ key: string; plan_name: string; cms: number; pm_current: number | null; row_count: number }> = [];
  for (const c of withCombined) {
    const { data: rows, error } = await sb.from('pm_plans')
      .select('contract_id, plan_id, segment_id, plan_name, moop_combined, county_name, state')
      .eq('contract_id', c.contract_id)
      .eq('plan_id', c.plan_id)
      .eq('segment_id', c.segment_id);
    if (error) { console.error('  select err:', error); continue; }
    if (!rows || rows.length === 0) { noPmRowA += 1; continue; }
    const nulls = rows.filter((r: any) => r.moop_combined == null);
    const nonNullMatches = rows.filter((r: any) => r.moop_combined === c.combined);
    const nonNullDiffers = rows.filter((r: any) => r.moop_combined != null && r.moop_combined !== c.combined);
    if (nonNullMatches.length === rows.length) { alreadyMatchesA += 1; continue; }
    if (nonNullDiffers.length > 0) {
      differsA += 1;
      console.log(`  DIFFERS ${c.contract_id}-${c.plan_id}-${c.segment_id} ${c.plan_name} — some rows have moop_combined ≠ CMS; skipping to avoid clobber`);
      continue;
    }
    if (nulls.length === 0) continue;
    toWriteA += 1;
    writesA.push({ key: `${c.contract_id}-${c.plan_id}-${c.segment_id}`, plan_name: c.plan_name, cms: c.combined!, pm_current: null, row_count: nulls.length });
  }
  console.log(`  target: ${toWriteA} plans need backfill, spanning multiple county rows each`);
  console.log(`  already matches:    ${alreadyMatchesA}`);
  console.log(`  differs (skipped):  ${differsA}`);
  console.log(`  no pm_plans row:    ${noPmRowA}`);

  if (WRITE) {
    let updated = 0;
    for (const w of writesA) {
      const [contract, plan, segment] = w.key.split('-');
      const { data, error } = await sb.from('pm_plans')
        .update({ moop_combined: w.cms })
        .eq('contract_id', contract)
        .eq('plan_id', plan)
        .eq('segment_id', segment)
        .is('moop_combined', null)
        .select('id');
      if (error) { console.error(`  UPDATE err ${w.key}:`, error); continue; }
      updated += (data?.length ?? 0);
    }
    console.log(`\n  WROTE: ${writesA.length} plans, ${updated} pm_plans rows updated`);
  } else {
    console.log('\n  (dry-run) writes preview (first 10):');
    for (const w of writesA.slice(0, 10)) console.log(`    ${w.key.padEnd(15)} moop_combined=NULL → $${w.cms}  (${w.row_count} rows, ${w.plan_name})`);
    if (writesA.length > 10) console.log(`    …+${writesA.length - 10} more`);
  }

  // ── FIX B: H4513-083 moop correction (in-network) ─────────────
  console.log('\n── FIX B: H4513-083 in-network moop $7,200 → $6,900 ──');
  const cmsB = cms.get('H4513-083-0');
  if (!cmsB) {
    console.log('  CMS cache does not have H4513-083 — check alternate segment');
    for (const [k, v] of cms) if (k.startsWith('H4513-083-')) console.log(`  found: ${k}  in-net=$${v.in_net}  combined=$${v.combined}`);
  } else {
    console.log(`  CMS confirms H4513-083 in-net = $${cmsB.in_net}`);
  }

  const { data: rowsB } = await sb.from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, moop, county_name, state')
    .eq('contract_id', 'H4513')
    .eq('plan_id', '083');
  console.log(`  pm_plans rows for H4513-083: ${rowsB?.length ?? 0}`);
  const stale = (rowsB ?? []).filter((r: any) => r.moop === 7200);
  const correct = (rowsB ?? []).filter((r: any) => r.moop === 6900);
  console.log(`    already correct (moop=$6,900): ${correct.length}`);
  console.log(`    stale (moop=$7,200):           ${stale.length}`);
  const others = (rowsB ?? []).filter((r: any) => r.moop !== 7200 && r.moop !== 6900);
  if (others.length > 0) {
    console.log(`    other moop values (not touched): ${others.length}`);
    others.slice(0, 5).forEach((r: any) => console.log(`       ${r.county_name} ${r.state}  moop=$${r.moop}`));
  }
  if (WRITE && stale.length > 0) {
    const { data, error } = await sb.from('pm_plans')
      .update({ moop: 6900 })
      .eq('contract_id', 'H4513')
      .eq('plan_id', '083')
      .eq('moop', 7200)
      .select('id');
    if (error) console.error('  UPDATE err:', error);
    else console.log(`  WROTE: ${data?.length ?? 0} rows updated`);
  } else if (!WRITE) {
    console.log(`  (dry-run) would UPDATE ${stale.length} row(s) from $7,200 → $6,900`);
  }

  console.log('\n─'.repeat(70).slice(1));
  console.log(WRITE ? 'DONE (writes committed)' : 'DRY-RUN complete. Re-run with --write to execute.');
}
main().catch((e) => { console.error(e); process.exit(1); });
