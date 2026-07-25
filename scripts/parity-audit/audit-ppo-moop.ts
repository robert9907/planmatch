#!/usr/bin/env tsx
// Focused MOOP audit — PPO plans only. Exact dollar match required.
//
// Iterates cached MPF plan-detail JSON files, filters to PPO plans, parses
// the MOOP cost_share string (e.g. "$7,500 In and Out-of-network<br />
// $4,500 In-network") to extract IN + combined values, then compares
// against pm_plans.moop (IN) and pm_plans.moop_combined (IN+OON) for
// every plan.

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
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
const MPF_CACHE_DIR = path.join(REPO_ROOT, '_tmp', 'parity-audit', 'mpf');

const sb = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

interface MpfMoop {
  in: number | null;
  combined: number | null;
  raw: string;
}

// Parse cost_share string like:
//   "$7,500 In and Out-of-network<br />$4,500 In-network"
//   "$4,500 In-network only" (HMO)
//   "$8,300 In-network"
function parseMpfMoop(costShare: string): MpfMoop {
  const clean = costShare.replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
  // Match "$X,XXX In-network" (not preceded by "Out-of")
  const inMatch = clean.match(/\$([\d,]+)\s+In-network\b/i);
  // Match "$X,XXX In and Out-of-network" — the combined value
  const combinedMatch = clean.match(/\$([\d,]+)\s+In\s+and\s+Out-of-network/i);
  return {
    in: inMatch ? Number(inMatch[1].replace(/,/g, '')) : null,
    combined: combinedMatch ? Number(combinedMatch[1].replace(/,/g, '')) : null,
    raw: clean,
  };
}

interface Row {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string;
  profile_id: string;
  mpf_in: number | null;
  mpf_combined: number | null;
  mpf_raw: string;
  pm_moop: number | null;
  pm_moop_combined: number | null;
  in_match: 'PASS' | 'FAIL';
  combined_match: 'PASS' | 'FAIL' | 'N/A';
}

function padSeg(s: string): string {
  return s.padStart(3, '0');
}

async function main() {
  const rows: Row[] = [];
  const seen = new Set<string>();

  // Walk all MPF cache dirs, extract PPO plan MOOPs
  const profileDirs = readdirSync(MPF_CACHE_DIR).filter((d) =>
    statSync(path.join(MPF_CACHE_DIR, d)).isDirectory(),
  );
  for (const pd of profileDirs) {
    const dir = path.join(MPF_CACHE_DIR, pd);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'snapshot.json');
    for (const f of files) {
      const filePath = path.join(dir, f);
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(filePath, 'utf8')); } catch { continue; }
      const card = (raw as { plan_card?: Record<string, unknown> })?.plan_card;
      if (!card) continue;
      const name = String(card.name ?? '');
      // PPO filter — name contains "(PPO)" or "(PPO-POS)"
      if (!/\(PPO(-\w+)?\)/.test(name)) continue;

      const contract = String(card.contract_id ?? '');
      const plan = String(card.plan_id ?? '');
      const segment = padSeg(String(card.segment_id ?? '0'));
      const key = `${contract}-${plan}-${segment}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const moopBenefit = (card.package_benefits as Record<string, unknown> | undefined)
        ?.BENEFIT_MAXIMUM_OOPC as
        | { network_costs?: Record<string, { cost_share?: string }> }
        | undefined;
      const netCosts = moopBenefit?.network_costs ?? {};
      const firstNet = Object.values(netCosts)[0];
      const costShare = firstNet?.cost_share ?? '';
      const parsed = parseMpfMoop(costShare);

      rows.push({
        contract_id: contract,
        plan_id: plan,
        segment_id: segment,
        plan_name: name,
        profile_id: pd,
        mpf_in: parsed.in,
        mpf_combined: parsed.combined,
        mpf_raw: parsed.raw,
        pm_moop: null,
        pm_moop_combined: null,
        in_match: 'FAIL',
        combined_match: 'FAIL',
      });
    }
  }

  console.log(`Found ${rows.length} unique PPO plans across MPF cache.`);
  if (rows.length === 0) {
    console.error('No PPO plans found. Cannot audit.');
    process.exit(1);
  }

  // Query pm_plans MOOPs for all
  const contracts = [...new Set(rows.map((r) => r.contract_id))];
  const plans = [...new Set(rows.map((r) => r.plan_id))];
  console.log(`Querying pm_plans (${contracts.length} contracts, ${plans.length} plans)…`);
  const pmRows = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, moop, moop_combined, plan_type, state')
    .in('contract_id', contracts)
    .in('plan_id', plans);
  if (pmRows.error) {
    console.error('pm_plans query failed:', pmRows.error.message);
    process.exit(1);
  }
  const pmIndex = new Map<string, { moop: number | null; moop_combined: number | null }>();
  for (const p of pmRows.data ?? []) {
    const rr = p as { contract_id: string; plan_id: string; segment_id?: string; moop: number | null; moop_combined: number | null };
    const seg = padSeg(rr.segment_id ?? '000');
    pmIndex.set(`${rr.contract_id}-${rr.plan_id}-${seg}`, {
      moop: rr.moop,
      moop_combined: rr.moop_combined,
    });
  }

  for (const r of rows) {
    const pmKey = `${r.contract_id}-${r.plan_id}-${r.segment_id}`;
    const pm = pmIndex.get(pmKey);
    r.pm_moop = pm?.moop ?? null;
    r.pm_moop_combined = pm?.moop_combined ?? null;
    r.in_match = r.mpf_in != null && r.pm_moop != null && r.mpf_in === r.pm_moop ? 'PASS' : 'FAIL';
    r.combined_match =
      r.mpf_combined == null
        ? 'N/A'
        : r.pm_moop_combined != null && r.mpf_combined === r.pm_moop_combined
          ? 'PASS'
          : 'FAIL';
  }

  // Report
  const total = rows.length;
  const inPass = rows.filter((r) => r.in_match === 'PASS').length;
  const combinedApplicable = rows.filter((r) => r.combined_match !== 'N/A').length;
  const combinedPass = rows.filter((r) => r.combined_match === 'PASS').length;

  console.log(`\n=== PPO MOOP AUDIT RESULTS ===`);
  console.log(`Total PPO plans: ${total}`);
  console.log(`IN MOOP matches:       ${inPass}/${total} (${(inPass / total * 100).toFixed(1)}%)`);
  console.log(`Combined MOOP matches: ${combinedPass}/${combinedApplicable} (${(combinedPass / Math.max(1, combinedApplicable) * 100).toFixed(1)}%)  [${total - combinedApplicable} plans had no combined MOOP in MPF]`);

  const failures = rows.filter((r) => r.in_match === 'FAIL' || r.combined_match === 'FAIL');
  if (failures.length === 0) {
    console.log(`\n✅ 100% MATCH ACROSS ${total} PPO PLANS`);
  } else {
    console.log(`\n❌ ${failures.length} PLANS WITH MISMATCHES:\n`);
    console.log('contract-plan-seg | plan_name | MPF_IN | PM_IN | IN_delta | MPF_comb | PM_comb | comb_delta');
    for (const r of failures) {
      const inDelta = r.mpf_in != null && r.pm_moop != null ? (r.pm_moop - r.mpf_in) : 'n/a';
      const combDelta = r.mpf_combined != null && r.pm_moop_combined != null ? (r.pm_moop_combined - r.mpf_combined) : 'n/a';
      console.log(`${r.contract_id}-${r.plan_id}-${r.segment_id} | ${r.plan_name.slice(0, 45).padEnd(45)} | ${String(r.mpf_in).padStart(6)} | ${String(r.pm_moop ?? 'null').padStart(6)} | ${String(inDelta).padStart(6)} | ${String(r.mpf_combined ?? '-').padStart(6)} | ${String(r.pm_moop_combined ?? 'null').padStart(6)} | ${String(combDelta).padStart(6)}`);
    }
  }

  // Persist detailed CSV
  const csvPath = path.join(REPO_ROOT, '_tmp', 'parity-audit', 'ppo-moop-audit.csv');
  const csvHeader = 'contract_id,plan_id,segment_id,plan_name,mpf_in,pm_moop,in_match,mpf_combined,pm_moop_combined,combined_match,mpf_raw';
  const csvRows = rows.map((r) =>
    [r.contract_id, r.plan_id, r.segment_id, JSON.stringify(r.plan_name), r.mpf_in ?? '', r.pm_moop ?? '', r.in_match, r.mpf_combined ?? '', r.pm_moop_combined ?? '', r.combined_match, JSON.stringify(r.mpf_raw)].join(','),
  );
  writeFileSync(csvPath, [csvHeader, ...csvRows].join('\n'));
  console.log(`\nCSV: ${csvPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
