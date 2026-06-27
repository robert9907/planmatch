// scripts/probe-pdp-tier-source.ts — dump every tier in
// pbp_mrx_tier.txt for the affected plans, plus inspect the agent's
// SPUF importer to see whether tier cost-sharing is wired up at all.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PBP_DIR = '/Users/robertsimm/Code/plan-match/data/pbp';

function dumpAllTiers(contract: string, plan: string) {
  const path = join(PBP_DIR, 'pbp_mrx_tier.txt');
  if (!existsSync(path)) { console.log('no pbp_mrx_tier'); return; }
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n');
  const headers = lines[0].split('\t');
  const hIdx = headers.indexOf('pbp_a_hnumber');
  const pIdx = headers.indexOf('pbp_a_plan_identifier');
  const tIdx = headers.indexOf('mrx_tier_id');
  const labelIdx = headers.indexOf('mrx_tier_label_list');

  // Copay columns by retail tier
  const copayCols = [
    'mrx_tier_rstd_copay_1m',
    'mrx_tier_rstd_copay_3m',
    'mrx_tier_mostd_copay_1m',
    'mrx_tier_mostd_copay_3m',
    'mrx_tier_mospfd_copay_1m',
    'mrx_tier_mospfd_copay_3m',
  ];
  const coinsCols = [
    'mrx_tier_rstd_coins_pct_1m',
    'mrx_tier_rstd_coins_pct_3m',
    'mrx_tier_mostd_coins_pct_1m',
    'mrx_tier_mostd_coins_pct_3m',
  ];
  const copayIdx = copayCols.map((c) => ({ name: c, idx: headers.indexOf(c) }));
  const coinsIdx = coinsCols.map((c) => ({ name: c, idx: headers.indexOf(c) }));

  console.log(`\n=== ${contract}-${plan} ===`);
  let any = false;
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split('\t');
    if (parts[hIdx] !== contract || parts[pIdx] !== plan) continue;
    any = true;
    const tier = parts[tIdx];
    const label = parts[labelIdx];
    const copays = copayIdx.map((c) => `${c.name}=${parts[c.idx]}`).filter((v) => /=\S/.test(v) && !v.endsWith('=') && !v.endsWith('=undefined'));
    const coins = coinsIdx.map((c) => `${c.name}=${parts[c.idx]}`).filter((v) => /=\S/.test(v) && !v.endsWith('=') && !v.endsWith('=undefined'));
    console.log(`  tier=${tier} label="${label}"`);
    console.log(`    copays: ${copays.join(', ') || '(none)'}`);
    console.log(`    coins:  ${coins.join(', ') || '(none)'}`);
  }
  if (!any) console.log('  no matching rows');
}

// Affected plans + one working plan for comparison
dumpAllTiers('S5601', '016');  // Aetna SilverScript (all-null in pm_formulary)
dumpAllTiers('S5884', '133');  // Humana Basic Rx (all-null)
dumpAllTiers('S4802', '081');  // Wellcare (populated in pm_formulary)
dumpAllTiers('S5540', '002');  // BCBS NC (populated)

console.log('\n\n=== Importer code inspection ===');
const importerPath = '/Users/robertsimm/planmatch/planmatch/scripts/import-cms-spuf.ts';
if (existsSync(importerPath)) {
  const code = readFileSync(importerPath, 'utf8');
  console.log(`agent SPUF importer (${code.length} bytes)`);
  // Look for any mention of tier copay handling
  const copayMentions = code.split('\n').map((l, i) => ({ l, i })).filter(({ l }) => /copay|coinsurance|cost_share|tier_copay|pbp_mrx/i.test(l));
  console.log(`Lines mentioning copay/coinsurance/cost: ${copayMentions.length}`);
  for (const { l, i } of copayMentions.slice(0, 20)) {
    console.log(`  ${i + 1}: ${l.trim().slice(0, 120)}`);
  }
}
const importerPath2 = '/Users/robertsimm/Code/plan-match/scripts/import-formulary.ts';
if (existsSync(importerPath2)) {
  const code = readFileSync(importerPath2, 'utf8');
  console.log(`\nconsumer formulary importer (${code.length} bytes)`);
  const copayMentions = code.split('\n').map((l, i) => ({ l, i })).filter(({ l }) => /copay|coinsurance|cost_share|tier_copay|pbp_mrx/i.test(l));
  console.log(`Lines mentioning copay/coinsurance/cost: ${copayMentions.length}`);
  for (const { l, i } of copayMentions.slice(0, 30)) {
    console.log(`  ${i + 1}: ${l.trim().slice(0, 120)}`);
  }
}
