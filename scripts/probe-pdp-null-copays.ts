// scripts/probe-pdp-null-copays.ts — diagnose which PDP carriers ship
// NULL tier copays in pm_formulary, locate the source-of-truth in
// CMS PBP Section D, and size the gap.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const sb = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function main() {
  // STEP 1 — which PDP carriers have null tier copays?
  console.log('========== STEP 1: NC PDP plans + tier copay nullness ==========');
  const { data: pdpPlans } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, carrier')
    .eq('state', 'NC')
    .eq('plan_type', 'PDP');
  const seen = new Set<string>();
  const uniquePdp = (pdpPlans ?? []).filter((p) => {
    const k = `${p.contract_id}-${p.plan_id}-${p.segment_id ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`Distinct NC PDP plan-segments: ${uniquePdp.length}`);

  // For each PDP, sample tier copays from pm_formulary
  // Use the canonical contract+plan tuple (formulary is segment-agnostic).
  const carrierStats = new Map<
    string,
    { plans: Set<string>; allNullPlans: Set<string>; populated: Set<string> }
  >();

  for (const p of uniquePdp) {
    const planKey = `${p.contract_id}-${p.plan_id}`;
    const carrier = p.carrier ?? 'Unknown';
    if (!carrierStats.has(carrier)) {
      carrierStats.set(carrier, { plans: new Set(), allNullPlans: new Set(), populated: new Set() });
    }
    const stat = carrierStats.get(carrier)!;
    stat.plans.add(planKey);

    // Sample distinct tier cost-sharing rows
    const { data: tiers } = await sb
      .from('pm_formulary')
      .select('tier, copay, coinsurance')
      .eq('contract_id', p.contract_id)
      .eq('plan_id', p.plan_id)
      .limit(50);
    const distinctTiers = new Map<number, { copay: number | null; coinsurance: number | null }>();
    for (const t of tiers ?? []) {
      const tnum = t.tier as number;
      if (!distinctTiers.has(tnum)) distinctTiers.set(tnum, { copay: t.copay as number | null, coinsurance: t.coinsurance as number | null });
    }
    const allNull = [...distinctTiers.values()].every((x) => x.copay == null && x.coinsurance == null);
    const anyPopulated = [...distinctTiers.values()].some((x) => x.copay != null || x.coinsurance != null);
    if (allNull && distinctTiers.size > 0) stat.allNullPlans.add(planKey);
    if (anyPopulated) stat.populated.add(planKey);
  }

  console.log('\n--- Per-carrier breakdown ---');
  for (const [carrier, stat] of [...carrierStats.entries()].sort()) {
    console.log(`  ${carrier}: total=${stat.plans.size}  allNullTiers=${stat.allNullPlans.size}  hasValues=${stat.populated.size}`);
    if (stat.allNullPlans.size > 0) {
      console.log(`    affected plans: ${[...stat.allNullPlans].sort().join(', ')}`);
    }
  }

  // STEP 2 — CMS PBP Section D source for one affected plan (e.g., S5601-020)
  console.log('\n\n========== STEP 2: CMS PBP Section D for affected plans ==========');
  const PBP_DIR = '/Users/robertsimm/Code/plan-match/data/pbp';
  if (!existsSync(PBP_DIR)) {
    console.log('  (no PBP dir at', PBP_DIR, ')');
  } else {
    // Section D files for Part D — typically pbp_section_d_*, ds_*, etc.
    const files = readdirSync(PBP_DIR).filter((f) => /section_d|^pbp_d|^ds_|drugs|formulary|tier/i.test(f));
    console.log('Candidate Section D files:', files);

    // Sample affected plans
    const samples: Array<{contract: string; plan: string; label: string}> = [];
    for (const [carrier, stat] of carrierStats.entries()) {
      if (stat.allNullPlans.size === 0) continue;
      const first = [...stat.allNullPlans].sort()[0];
      const [c, p] = first.split('-');
      samples.push({ contract: c, plan: p, label: `${carrier} ${first}` });
    }

    for (const s of samples.slice(0, 3)) {
      console.log(`\n--- Probing PBP files for ${s.label} (${s.contract}-${s.plan}) ---`);
      for (const f of files) {
        const path = join(PBP_DIR, f);
        try {
          if (statSync(path).size > 200 * 1024 * 1024) continue; // skip massive
        } catch { continue; }
        const raw = readFileSync(path, 'utf8');
        const lines = raw.split('\n');
        if (lines.length < 2) continue;
        const headers = lines[0].split('\t');
        const hIdx = headers.indexOf('pbp_a_hnumber');
        const pIdx = headers.indexOf('pbp_a_plan_identifier');
        if (hIdx < 0 || pIdx < 0) continue;
        const matches: string[][] = [];
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split('\t');
          if (parts[hIdx] === s.contract && parts[pIdx] === s.plan) matches.push(parts);
        }
        if (matches.length === 0) continue;
        console.log(`  ${f}: ${matches.length} rows`);
        // Find columns that look like tier copay/coinsurance
        const tierCols = headers.filter((h) => /tier|copay|coins|cost_share|ds_|ben_cov/i.test(h));
        // Dump first row with only non-empty interesting cols
        const r = matches[0];
        const fields: string[] = [];
        for (let i = 0; i < headers.length; i++) {
          if (!tierCols.includes(headers[i])) continue;
          const v = r[i];
          if (v && v.trim() !== '' && v !== '0') fields.push(`${headers[i]}=${v}`);
        }
        if (fields.length > 0) {
          console.log(`    sample (non-empty tier/copay cols): ${fields.slice(0, 40).join(' | ')}`);
        } else {
          console.log(`    no non-empty tier/copay-like columns in first row`);
        }
      }
    }
  }

  // STEP 3 — locate the importer
  console.log('\n\n========== STEP 3: locate formulary / SPUF importer ==========');
  const repoRoots = ['/Users/robertsimm/Code/plan-match', '/Users/robertsimm/planmatch/planmatch'];
  for (const root of repoRoots) {
    const scriptsDir = join(root, 'scripts');
    if (!existsSync(scriptsDir)) continue;
    const files = readdirSync(scriptsDir).filter((f) => /formulary|spuf|pbp.*d|tier|drug.*import|import.*drug/i.test(f));
    console.log(`  ${scriptsDir}:`);
    for (const f of files) console.log(`    ${f}`);
  }

  // STEP 4 — separate cost-sharing source check
  console.log('\n\n========== STEP 4: separate cost-sharing tables ==========');
  // Try a few likely table names
  for (const tbl of ['pm_drug_cost_tiers', 'pm_tier_cost_sharing', 'pbp_section_d', 'pm_part_d_cost_share', 'pm_pdp_tiers']) {
    try {
      const { error, data } = await sb.from(tbl).select('*').limit(1);
      if (!error) {
        console.log(`  ${tbl}: EXISTS (sample keys: ${data?.[0] ? Object.keys(data[0]).join(',') : 'empty'})`);
      } else if ((error.message ?? '').toLowerCase().includes('does not exist') || error.code === '42P01') {
        // table missing
      } else {
        console.log(`  ${tbl}: error: ${error.message}`);
      }
    } catch (e) {
      // ignore
    }
  }
  // Also list every pm_* table by sampling information_schema-ish — skip, just check pm_formulary columns
  console.log('\npm_formulary columns sample:');
  const { data: pfm } = await sb.from('pm_formulary').select('*').limit(1);
  if (pfm?.[0]) console.log(`  ${Object.keys(pfm[0]).join(', ')}`);
  console.log('\npbp_benefits Part D rows for an affected plan (S5601-020):');
  const { data: pbpDrows } = await sb
    .from('pbp_benefits')
    .select('plan_id, benefit_type, copay, copay_max, coinsurance, tier_id, description, source')
    .like('plan_id', 'S5601-020%')
    .or('benefit_type.like.rx_tier%,benefit_type.like.%cost_share%,benefit_type.like.%tier%');
  for (const r of pbpDrows ?? []) {
    console.log(`  ${JSON.stringify(r)}`);
  }

  // Also look in pbp_b14 or D-section files for ds_ columns
  console.log('\nLooking for pbp_b14 / pbp_ds / drug-cost-sharing PBP files:');
  if (existsSync(PBP_DIR)) {
    const dFiles = readdirSync(PBP_DIR).filter((f) => /^pbp_b14|^pbp_ds|^ds_|drug_costsharing|pbp_section/i.test(f) || /^pbp_b9|^pbp_b10|^pbp_d/i.test(f));
    console.log('  candidate files:', dFiles);
    // Inspect one — pbp_ds_vbid.txt or pbp_Section_D.sas equiv
    for (const f of dFiles.slice(0, 5)) {
      const path = join(PBP_DIR, f);
      const head = readFileSync(path, 'utf8').split('\n')[0];
      console.log(`\n  ${f} columns (first 30): ${head.split('\t').slice(0, 30).join(', ')}`);
    }
  }

  // STEP 5 — gap sizing
  console.log('\n\n========== STEP 5: gap size ==========');
  let totalAllNull = 0;
  let totalCarriersAffected = 0;
  for (const stat of carrierStats.values()) {
    if (stat.allNullPlans.size > 0) {
      totalAllNull += stat.allNullPlans.size;
      totalCarriersAffected++;
    }
  }
  console.log(`Carriers affected: ${totalCarriersAffected}`);
  console.log(`Distinct PDP contract+plan pairs affected: ${totalAllNull}`);

  // Total PDP rows × 5 tiers
  const totalPdpPlans = uniquePdp.length;
  console.log(`Total NC PDP plan-segments: ${totalPdpPlans}`);
  // Sample a couple of all-null plans for # of formulary rows
  const sample = [...carrierStats.values()].flatMap((s) => [...s.allNullPlans]).slice(0, 3);
  for (const planKey of sample) {
    const [c, p] = planKey.split('-');
    const { count } = await sb
      .from('pm_formulary')
      .select('*', { count: 'exact', head: true })
      .eq('contract_id', c)
      .eq('plan_id', p);
    console.log(`  ${planKey}: ${count} formulary rows × all NULL cost-share`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
