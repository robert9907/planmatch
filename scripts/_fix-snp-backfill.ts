// Fix C follow-on — SNP field backfill from CMS plan-detail responses.
//
// The parity audit shows pm_plans is drifted from CMS for many SNPs
// on monthly_premium, annual_deductible, and moop_combined. CMS is
// authoritative per Phase 2 mission. This script:
//
//   1. Reads _tmp/medicare-gov-snp/detail/*.json (133 SNPs).
//   2. Extracts partc+partd, annual_deductible ($ parsed), moop
//      in-network + combined from BENEFIT_MAXIMUM_OOPC.
//   3. For each pm_plans row of the same contract+plan+segment,
//      UPDATEs any drifted field to the CMS value.
//
// Guards:
//   • Only touches fields where pm value != CMS value (idempotent).
//   • For moop_combined, only writes when pm is NULL (matches Fix A).
//   • Segment-aware — plan+segment may have different filings.
//   • --write required to mutate; default dry-run.
//
// Run: npx tsx scripts/_fix-snp-backfill.ts           (dry-run)
//      npx tsx scripts/_fix-snp-backfill.ts --write   (execute)

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const WRITE = process.argv.includes('--write');

function parseUsd(s: any): number | null {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const m = String(s).match(/\$?([\d,]+(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}
function parseMoopString(s: any): { inNet: number | null; combined: number | null } {
  if (!s) return { inNet: null, combined: null };
  const str = String(s);
  const inNetMatch = str.match(/\$?([\d,]+)\s*In-network/i);
  const combinedMatch = str.match(/\$?([\d,]+)\s*In and Out-of-network/i);
  return {
    inNet: inNetMatch ? Number(inNetMatch[1].replace(/,/g, '')) : null,
    combined: combinedMatch ? Number(combinedMatch[1].replace(/,/g, '')) : null,
  };
}

interface CmsSnp {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  monthly_premium: number;    // partc + partd
  annual_deductible: number;  // medical / plan deductible ($ parsed)
  drug_deductible: number | null;
  moop_in: number | null;
  moop_combined: number | null;
  snp_type: string | null;
  plan_name: string;
}
function loadCms(): CmsSnp[] {
  const dir = '_tmp/medicare-gov-snp/detail';
  const out: CmsSnp[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const pc = j.response?.plan_card;
    if (!pc) continue;
    const moopStr = pc.package_benefits?.BENEFIT_MAXIMUM_OOPC?.network_costs?.NETWORK_TYPE_NA?.cost_share
                 ?? pc.package_benefits?.BENEFIT_MAXIMUM_OOPC?.network_costs?.NETWORK_TYPE_IN_NETWORK?.cost_share;
    const m = parseMoopString(moopStr);
    out.push({
      contract_id: pc.contract_id,
      plan_id: pc.plan_id,
      segment_id: String(pc.segment_id ?? '0'),
      monthly_premium: (pc.partc_premium ?? 0) + (pc.partd_premium ?? 0),
      annual_deductible: parseUsd(pc.annual_deductible) ?? 0,
      drug_deductible: pc.drug_plan_deductible ?? null,
      moop_in: m.inNet,
      moop_combined: m.combined,
      snp_type: pc.snp_type,
      plan_name: pc.name,
    });
  }
  return out;
}

async function main() {
  const mode = WRITE ? 'WRITE' : 'DRY-RUN';
  console.log(`Fix C — SNP backfill from CMS plan-detail (${mode})`);
  console.log('─'.repeat(70));
  const cms = loadCms();
  console.log(`CMS detail: ${cms.length} SNP plans`);

  let touched = { monthly_premium: 0, annual_deductible: 0, moop_combined: 0, moop: 0 };
  let rowsAffected = { monthly_premium: 0, annual_deductible: 0, moop_combined: 0, moop: 0 };
  const plans_no_row: string[] = [];

  for (const c of cms) {
    const key = `${c.contract_id}-${c.plan_id}-${c.segment_id}`;
    const { data: rows } = await sb.from('pm_plans')
      .select('contract_id, plan_id, segment_id, monthly_premium, annual_deductible, moop, moop_combined')
      .eq('contract_id', c.contract_id)
      .eq('plan_id', c.plan_id)
      .eq('segment_id', c.segment_id);
    if (!rows || rows.length === 0) { plans_no_row.push(key); continue; }

    // Field-by-field intent
    const updates: Record<string, any> = {};
    const first = rows[0] as any;
    if ((first.monthly_premium ?? 0) !== c.monthly_premium) updates.monthly_premium = c.monthly_premium;
    if ((first.annual_deductible ?? 0) !== c.annual_deductible) updates.annual_deductible = c.annual_deductible;
    if (c.moop_in != null && first.moop !== c.moop_in) updates.moop = c.moop_in;
    // moop_combined: only write when pm is null (avoid clobber, mirrors Fix A)
    if (c.moop_combined != null && first.moop_combined == null) updates.moop_combined = c.moop_combined;

    if (Object.keys(updates).length === 0) continue;

    for (const f of Object.keys(updates)) touched[f as keyof typeof touched] += 1;

    if (WRITE) {
      const { data, error } = await sb.from('pm_plans')
        .update(updates)
        .eq('contract_id', c.contract_id)
        .eq('plan_id', c.plan_id)
        .eq('segment_id', c.segment_id)
        .select('id');
      if (error) { console.error(`  UPDATE err ${key}:`, error.message); continue; }
      for (const f of Object.keys(updates)) rowsAffected[f as keyof typeof rowsAffected] += (data?.length ?? 0);
    } else {
      const parts = Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`  ${key.padEnd(15)} ${c.snp_type?.slice(0, 5).padEnd(6)} ${parts} — ${rows.length} rows`);
    }
  }

  console.log(`\n─ Summary ─`);
  for (const f of ['monthly_premium','annual_deductible','moop_combined','moop'] as const) {
    console.log(`  ${f.padEnd(20)} plans_touched=${touched[f]}${WRITE ? `  rows_updated=${rowsAffected[f]}` : ''}`);
  }
  if (plans_no_row.length > 0) console.log(`  plans with no pm_plans row: ${plans_no_row.length}  (sample: ${plans_no_row.slice(0,3).join(',')})`);
  console.log(WRITE ? '\nDONE (writes committed)' : '\nDRY-RUN complete. Re-run with --write.');
}
main().catch((e) => { console.error(e); process.exit(1); });
