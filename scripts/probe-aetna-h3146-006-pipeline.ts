// scripts/probe-aetna-h3146-006-pipeline.ts — confirm end-to-end
// that the regex matches the stored description and that the deployed
// agent /api/plans returns the inpatient row intact.

import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const sb = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function main() {
  // 1. Pull the raw inpatient description bytes
  const { data } = await sb
    .from('pm_plan_benefits')
    .select('benefit_description, copay, coinsurance')
    .eq('contract_id', 'H3146')
    .eq('plan_id', '006')
    .eq('benefit_category', 'inpatient')
    .limit(1);
  const row = data?.[0];
  if (!row) {
    console.log('NO ROW — using .eq("benefit_category","inpatient")');
    return;
  }
  const desc = row.benefit_description as string | null;
  console.log('=== STEP A: stored description bytes ===');
  console.log('Raw JSON:', JSON.stringify(desc));
  console.log('Length:', desc?.length);
  if (desc) {
    // Print the codepoint of each non-ASCII char so we can see if the
    // dash is U+2013, U+2014, U+2010, or something exotic.
    console.log('Non-ASCII codepoints in the description:');
    for (let i = 0; i < desc.length; i++) {
      const c = desc.charCodeAt(i);
      if (c > 127) {
        console.log(`  pos ${i} char="${desc[i]}" code=U+${c.toString(16).toUpperCase().padStart(4, '0')}`);
      }
    }
  }
  console.log('copay:', row.copay, 'coinsurance:', row.coinsurance);

  // 2. Apply the three live regexes used by formatInpatientLadder
  // (post-widening). Verbatim copy from src/lib/inpatient-format.ts.
  if (!desc) return;
  const RANGE_FIRST =
    /Days?\s+(\d+)\s*[–-]\s*(\d+)\s*:\s*\$\s*(\d+(?:\.\d+)?)\s*\/\s*day/gi;
  const AMOUNT_FIRST =
    /\$\s*(\d+(?:\.\d+)?)\s*\/\s*day\s*\(\s*days?\s+(\d+)\s*[–-]\s*(\d+)\s*\)/gi;
  const PER_DAY_FLAT =
    /\$\s*(\d+(?:\.\d+)?)\s*per[-\s]?day\s+copay/gi;

  console.log('\n=== STEP B: regex matches ===');
  const tiers: Array<{ dayStart: number; dayEnd: number; copay: number }> = [];
  let m;
  RANGE_FIRST.lastIndex = 0;
  while ((m = RANGE_FIRST.exec(desc)) !== null) {
    tiers.push({ dayStart: Number(m[1]), dayEnd: Number(m[2]), copay: Number(m[3]) });
  }
  AMOUNT_FIRST.lastIndex = 0;
  while ((m = AMOUNT_FIRST.exec(desc)) !== null) {
    tiers.push({ dayStart: Number(m[2]), dayEnd: Number(m[3]), copay: Number(m[1]) });
  }
  if (tiers.length === 0) {
    PER_DAY_FLAT.lastIndex = 0;
    while ((m = PER_DAY_FLAT.exec(desc)) !== null) {
      tiers.push({ dayStart: 1, dayEnd: 90, copay: Number(m[1]) });
    }
  }
  tiers.sort((a, b) => a.dayStart - b.dayStart);
  console.log('Parsed tiers:', tiers);
  if (tiers.length === 0) {
    console.log('❌ Regex parse returned ZERO tiers — would fall back to copay.');
  } else {
    const formatted = tiers.map((t) => `$${t.copay}/day · days ${t.dayStart}-${t.dayEnd}`).join('\n');
    console.log('Would render:');
    console.log(formatted);
  }

  // 3. Ping the deployed agent /api/plans and find what it sends
  // for H3146-006's inpatient CostShare. This proves whether the UI
  // is getting an empty CostShare from the wire (=> root cause
  // upstream of formatInpatientLadder).
  console.log('\n=== STEP C: deployed agent /api/plans response ===');
  const apiHosts = ['planmatch.vercel.app', 'planmatch-rob.vercel.app'];
  for (const host of apiHosts) {
    try {
      const r = await fetch(
        `https://${host}/api/plans?state=NC&county=Durham&limit=500`,
        { headers: { Accept: 'application/json' } },
      );
      console.log(`  ${host} HTTP ${r.status}`);
      if (!r.ok) continue;
      const body = (await r.json()) as { plans: Array<Record<string, unknown>> };
      const aetna = body.plans.find(
        (p) => p.contract_id === 'H3146' && p.plan_id === '006',
      );
      if (!aetna) {
        console.log(`  no H3146-006 plan in response (${body.plans.length} plans)`);
        continue;
      }
      const benefits = (aetna.benefits as Record<string, Record<string, unknown>>);
      const inp = benefits?.medical?.inpatient as Record<string, unknown> | undefined;
      console.log(`  Aetna H3146-006 benefits.medical.inpatient:`);
      console.log(`    ${JSON.stringify(inp, null, 2)}`);
      const mh = benefits?.medical?.mental_health_inpatient as Record<string, unknown> | undefined;
      console.log(`  Aetna H3146-006 benefits.medical.mental_health_inpatient:`);
      console.log(`    ${JSON.stringify(mh, null, 2)}`);
    } catch (err) {
      console.log(`  ${host}: ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
