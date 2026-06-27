// Cross-carrier PDP copay/coinsurance pattern check. SilverScript
// S5601-016 showed 100% zero copay+coinsurance across all 5 tiers.
// Is this an Aetna-PDP-specific importer bug, or do all PDPs in
// pm_formulary skip cost-sharing by design?

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

interface PdpPick {
  carrier_match: string;
  contract_id: string;
  plan_id: string;
  segment_id: string;
  carrier: string | null;
  plan_name: string | null;
}

async function pickPdp(carrierLike: string): Promise<PdpPick | null> {
  const { data, error } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, carrier, plan_name')
    .ilike('carrier', carrierLike)
    .eq('plan_type', 'PDP')
    .limit(1);
  if (error) {
    console.error(`pick ${carrierLike}:`, error);
    return null;
  }
  if (!data || data.length === 0) return null;
  return { carrier_match: carrierLike, ...data[0] };
}

async function dumpFormularyPattern(pdp: PdpPick) {
  console.log('\n' + '─'.repeat(70));
  console.log(`  ${pdp.contract_id}-${pdp.plan_id}-${pdp.segment_id}  carrier=${JSON.stringify(pdp.carrier)}`);
  console.log(`  plan_name=${JSON.stringify(pdp.plan_name)}`);
  console.log('─'.repeat(70));

  // Total count
  const { count: total } = await sb
    .from('pm_formulary')
    .select('rxcui', { count: 'exact', head: true })
    .eq('contract_id', pdp.contract_id)
    .eq('plan_id', pdp.plan_id);
  console.log(`  total formulary rows: ${total ?? 0}`);
  if (!total) return;

  // Sample up to 2000 rows; bucket by (tier, copay, coinsurance)
  const { data: rows, error } = await sb
    .from('pm_formulary')
    .select('tier, copay, coinsurance')
    .eq('contract_id', pdp.contract_id)
    .eq('plan_id', pdp.plan_id)
    .limit(2000);
  if (error) {
    console.error('  sample err:', error);
    return;
  }
  const all = rows ?? [];

  // Per-tier zero/non-zero
  const tierStats = new Map<number | null, { n: number; zeroCopay: number; zeroCoins: number; bothZero: number }>();
  for (const r of all) {
    const t = r.tier ?? null;
    const c = tierStats.get(t) ?? { n: 0, zeroCopay: 0, zeroCoins: 0, bothZero: 0 };
    c.n++;
    if ((r.copay ?? 0) === 0) c.zeroCopay++;
    if ((r.coinsurance ?? 0) === 0) c.zeroCoins++;
    if ((r.copay ?? 0) === 0 && (r.coinsurance ?? 0) === 0) c.bothZero++;
    tierStats.set(t, c);
  }
  console.log(`  sampled rows: ${all.length}`);
  console.log('  per-tier breakdown:');
  for (const [t, v] of [...tierStats.entries()].sort((a, b) => Number(a[0] ?? 99) - Number(b[0] ?? 99))) {
    const pctBoth = v.n ? Math.round((v.bothZero / v.n) * 100) : 0;
    console.log(`    T${t ?? '∅'}:  n=${String(v.n).padStart(4)}  zero-copay=${String(v.zeroCopay).padStart(4)}  zero-coins=${String(v.zeroCoins).padStart(4)}  both-zero=${String(v.bothZero).padStart(4)} (${pctBoth}%)`);
  }

  // Show top 6 distinct (tier, copay, coinsurance) combos
  const combo = new Map<string, number>();
  for (const r of all) {
    const k = `T${r.tier ?? '∅'}|copay=${r.copay ?? '∅'}|coins=${r.coinsurance ?? '∅'}`;
    combo.set(k, (combo.get(k) ?? 0) + 1);
  }
  console.log('  top 8 distinct (tier, copay, coinsurance) tuples:');
  for (const [k, n] of [...combo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`    ${String(n).padStart(4)}× ${k}`);
  }

  // Show 5 NON-zero rows if any (confirm the column can hold non-zero)
  const nonZero = all.filter((r) => (r.copay ?? 0) > 0 || (r.coinsurance ?? 0) > 0);
  console.log(`  rows with copay OR coinsurance > 0: ${nonZero.length}`);
  for (const r of nonZero.slice(0, 5)) console.log(`    tier=${r.tier} copay=${r.copay} coins=${r.coinsurance}`);
}

const picks = [
  await pickPdp('%humana%'),
  await pickPdp('%wellcare%'),
  await pickPdp('%blue cross%'),
  await pickPdp('%cigna%'),
  await pickPdp('%aetna%'), // baseline (we already know this is all-zero per earlier probe)
];

// Catch other PDP carriers if the above missed
if (picks.every((p) => !p)) {
  const { data: anyPdp } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, carrier, plan_name')
    .eq('plan_type', 'PDP')
    .limit(5);
  console.log('\nNo matches for known carriers — first 5 PDPs in pm_plans:');
  for (const p of anyPdp ?? []) console.log(`  ${p.contract_id}-${p.plan_id}-${p.segment_id}  carrier=${p.carrier}  ${p.plan_name}`);
} else {
  for (const p of picks) if (p) await dumpFormularyPattern(p);
}

// Also: how many distinct PDP-carrier groups exist at all?
console.log('\n' + '═'.repeat(70));
console.log('  All distinct carriers offering PDPs in pm_plans');
console.log('═'.repeat(70));
const { data: allPdp } = await sb
  .from('pm_plans')
  .select('carrier')
  .eq('plan_type', 'PDP')
  .limit(5000);
const byCarrier = new Map<string, number>();
for (const r of allPdp ?? []) byCarrier.set(r.carrier ?? '∅', (byCarrier.get(r.carrier ?? '∅') ?? 0) + 1);
for (const [c, n] of [...byCarrier.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${c}`);
}
