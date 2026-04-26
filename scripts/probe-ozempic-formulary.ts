// scripts/probe-ozempic-formulary.ts
//
// Task 2 — verify pm_formulary coverage for Ozempic.
// 1. Direct rxcui hit (1991306).
// 2. Walk SCD/SBD/GPCK/BPCK descendants and check each.
// 3. Brand-name expansion via /drugs.json?name=Ozempic.
// 4. Report which rxcuis (if any) CMS uses in pm_formulary.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function rxnav(path: string): Promise<unknown> {
  const r = await fetch(`https://rxnav.nlm.nih.gov/REST/${path}`);
  if (!r.ok) throw new Error(`RxNav ${path} ${r.status}`);
  return r.json();
}

async function gatherOzempicRxcuis(): Promise<Array<{ rxcui: string; tty: string; name: string }>> {
  const set = new Map<string, { rxcui: string; tty: string; name: string }>();
  // Anchor + descendants via /related
  const rel = (await rxnav('rxcui/1991306/related.json?tty=SCD+SBD+GPCK+BPCK+IN+PIN+MIN')) as any;
  for (const g of rel?.relatedGroup?.conceptGroup ?? []) {
    for (const c of g.conceptProperties ?? []) {
      set.set(String(c.rxcui), { rxcui: String(c.rxcui), tty: g.tty ?? '', name: c.name });
    }
  }
  set.set('1991306', { rxcui: '1991306', tty: 'SCD', name: 'semaglutide pen 1.34 MG/ML' });
  // Brand-name expansion
  const byName = (await rxnav('drugs.json?name=Ozempic')) as any;
  for (const g of byName?.drugGroup?.conceptGroup ?? []) {
    for (const c of g.conceptProperties ?? []) {
      if (!set.has(String(c.rxcui))) set.set(String(c.rxcui), { rxcui: String(c.rxcui), tty: g.tty ?? '', name: c.name });
    }
  }
  // Also include the ingredient (semaglutide rxcui 1991302)
  for (const known of ['1991302', '1991297', '1991306']) {
    if (!set.has(known)) set.set(known, { rxcui: known, tty: 'IN/SCD', name: 'semaglutide variant' });
  }
  return [...set.values()];
}

async function main() {
  const candidates = await gatherOzempicRxcuis();
  console.log(`Probing ${candidates.length} Ozempic-related rxcuis against pm_formulary…\n`);

  const rxcuis = candidates.map((c) => c.rxcui);
  const { data, error } = await sb
    .from('pm_formulary')
    .select('rxcui, contract_id, plan_id, tier, copay, coinsurance, prior_auth, step_therapy')
    .in('rxcui', rxcuis);
  if (error) throw error;

  const byRxcui = new Map<string, number>();
  for (const r of data ?? []) {
    byRxcui.set(String(r.rxcui), (byRxcui.get(String(r.rxcui)) ?? 0) + 1);
  }

  console.log('Coverage by rxcui:');
  let totalRows = 0;
  for (const c of candidates) {
    const n = byRxcui.get(c.rxcui) ?? 0;
    totalRows += n;
    const flag = n > 0 ? '✓' : '·';
    console.log(`  ${flag} ${c.rxcui.padEnd(8)} [${(c.tty ?? '?').padEnd(5)}] ${n.toString().padStart(5)} rows  ${c.name}`);
  }
  console.log(`\nTotal pm_formulary rows for Ozempic-family rxcuis: ${totalRows}`);

  // Show a sample of which (contract, plan) pairs carry it, plus
  // tier distribution.
  if (totalRows > 0) {
    const tiers = new Map<number | null, number>();
    const sampleContracts = new Set<string>();
    for (const r of data ?? []) {
      tiers.set(r.tier, (tiers.get(r.tier) ?? 0) + 1);
      if (sampleContracts.size < 10) sampleContracts.add(String(r.contract_id));
    }
    console.log('\nTier distribution:');
    for (const [t, n] of [...tiers.entries()].sort((a, b) => (a[0] ?? 99) - (b[0] ?? 99))) {
      console.log(`  Tier ${t ?? 'null'}: ${n} rows`);
    }
    console.log(`\nSample contracts: ${[...sampleContracts].join(', ')}`);
  } else {
    console.log('\n⚠ No Ozempic-family rxcuis are in pm_formulary.');
    console.log('CMS may use a different rxcui granularity for the formulary file');
    console.log('(e.g., the active-ingredient PIN rxcui or a generic semaglutide SCD');
    console.log('that\'s not in the Ozempic brand tree). Investigate with:');
    console.log('  SELECT DISTINCT rxcui FROM pm_formulary WHERE rxcui IN (SELECT rxcui FROM pm_drug_ndc WHERE drug_name ILIKE \'%semaglutide%\');');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
