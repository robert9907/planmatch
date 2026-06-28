// Build the input list for SB URL discovery: 65 NC/TX/GA D-SNPs that
// still lack any food/OTC $ in pbp_benefits, paired with a sample
// fips/zip from pm_plans so Medicare.gov's plan-detail SPA can render
// the Documents section for that plan in a known county.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const env: Record<string, string> = {};
for (const l of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  if (!l || l.startsWith('#') || !l.includes('=')) continue;
  const i = l.indexOf('=');
  let v = l.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[l.slice(0, i).trim()] = v;
}
const sb = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

(async () => {
  // 1. NC/TX/GA D-SNPs
  let from = 0;
  const seen = new Set<string>();
  const plans: Array<{ contract_id: string; plan_id: string; segment_id: string; cp: string; state: string; carrier: string; name: string }> = [];
  for (;;) {
    const { data, error } = await sb.from('pm_plans').select('contract_id, plan_id, segment_id, state, carrier, plan_name').in('state', ['NC', 'TX', 'GA']).eq('snp_type', 'D-SNP').range(from, from + 999);
    if (error || !data || data.length === 0) break;
    for (const r of data as any[]) {
      const cp = `${r.contract_id}-${r.plan_id}`;
      if (seen.has(cp)) continue;
      seen.add(cp);
      plans.push({ contract_id: r.contract_id, plan_id: r.plan_id, segment_id: r.segment_id ?? '0', cp, state: r.state, carrier: r.carrier ?? '', name: r.plan_name ?? '' });
    }
    if (data.length < 1000) break;
    from += 1000;
  }

  // 2. Existing food $ — same query as probe-ssbci-postwrite
  const cpList = plans.map((p) => p.cp);
  const haveDollar = new Set<string>();
  for (let i = 0; i < cpList.length; i += 200) {
    const chunk = cpList.slice(i, i + 200);
    const { data } = await sb.from('pbp_benefits').select('plan_id, copay, copay_max, description').in('plan_id', chunk).in('benefit_type', ['food_card', 'meals', 'meal_benefit', 'otc', 'otc_allowance']);
    for (const r of (data ?? []) as any[]) {
      const hasMax = r.copay_max != null && r.copay_max > 0;
      const hasCopay = r.copay != null && r.copay > 0;
      const hasDescDollar = typeof r.description === 'string' && /\$\s*\d/.test(r.description);
      if (hasMax || hasCopay || hasDescDollar) haveDollar.add(r.plan_id);
    }
  }
  const gap = plans.filter((p) => !haveDollar.has(p.cp));
  console.log(`Gap D-SNPs: ${gap.length}`);

  // 3. Pull a sample fips + zip per gap plan:
  //   - county_name lives in pm_plans (per-county rows)
  //   - fips: join pm_county_fips on county_name + " County" suffix
  //     (pm_county_fips stores "Aransas County", pm_plans stores "Aransas")
  //   - zip: state-default if pm_zip_county misses (pm_zip_county is
  //     NC-only); the detail page doesn't gate Documents on exact zip,
  //     just needs a valid in-state zip to render
  const STATE_DEFAULT_ZIP: Record<string, string> = {
    NC: '27101', // Winston-Salem (Forsyth)
    TX: '78701', // Austin (Travis)
    GA: '30303', // Atlanta (Fulton)
  };
  type Out = { contract_id: string; plan_id: string; segment_id: string; plan_name: string; carrier: string; state: string; fips: string; zip: string };
  const out: Out[] = [];
  const skipped: string[] = [];
  for (const p of gap) {
    const { data: pm } = await sb.from('pm_plans').select('county_name, state').eq('contract_id', p.contract_id).eq('plan_id', p.plan_id).limit(1);
    const cn = (pm?.[0] as any)?.county_name;
    if (!cn) { skipped.push(`${p.cp}: no county_name`); continue; }
    // FIPS from pm_county_fips; try both with and without " County" suffix
    let fips: string | null = null;
    for (const name of [`${cn} County`, cn]) {
      const { data: cf } = await sb.from('pm_county_fips').select('fips').eq('county_name', name).eq('state', p.state).limit(1);
      if (cf && cf[0]) { fips = (cf[0] as any).fips; break; }
    }
    if (!fips) { skipped.push(`${p.cp}: county ${cn}/${p.state} not in pm_county_fips`); continue; }
    // ZIP: try pm_zip_county for that county; fall back to state default
    let zip: string | null = null;
    const { data: zc } = await sb.from('pm_zip_county').select('zip').eq('county', cn).eq('state', p.state).limit(1);
    if (zc && zc[0]) zip = (zc[0] as any).zip;
    if (!zip) zip = STATE_DEFAULT_ZIP[p.state] ?? null;
    if (!zip) { skipped.push(`${p.cp}: no zip`); continue; }
    out.push({
      contract_id: p.contract_id, plan_id: p.plan_id, segment_id: p.segment_id,
      plan_name: p.name, carrier: p.carrier, state: p.state,
      fips: String(fips).padStart(5, '0'),
      zip: String(zip).padStart(5, '0'),
    });
  }
  if (skipped.length > 0) {
    console.log(`\nSkipped ${skipped.length}:`);
    for (const s of skipped.slice(0, 10)) console.log(`  ${s}`);
    if (skipped.length > 10) console.log(`  …and ${skipped.length - 10} more`);
  }

  console.log(`\nResolved fips+zip for ${out.length} of ${gap.length} gap plans`);
  const outPath = '/Users/robertsimm/Code/plan-match/_tmp/gap-dsnps-for-sb-discovery.json';
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${outPath}`);

  // Breakdown
  const byCarrier = new Map<string, number>();
  for (const r of out) byCarrier.set(r.carrier, (byCarrier.get(r.carrier) ?? 0) + 1);
  console.log('\nBy carrier:');
  for (const [c, n] of [...byCarrier.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(3)}  ${c}`);
})();
