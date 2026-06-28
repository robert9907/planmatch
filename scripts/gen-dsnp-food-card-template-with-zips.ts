// Add sample_zip column to the manual-fill template. Per gap D-SNP:
//   1. Look up all counties the plan serves from pm_plans.
//   2. Rank by population using a hard-coded biggest-counties map
//      (pm_zip_county is NC-only and the DB has no population table).
//   3. Pick top-ranked county; look up a ZIP for it:
//        - NC: pm_zip_county
//        - TX/GA: hard-coded county-center ZIPs for the metros,
//                  state-default fallback otherwise.
//
// Output:
//   ~/Code/plan-match/_tmp/dsnp-food-card-manual-template-with-zips.csv
//   ~/Desktop/dsnp-food-card-manual-template-with-zips.csv
//
// (/mnt/user-data/outputs/ is a Claude.ai web-UI path and doesn't
// exist in this Claude Code terminal env — the Desktop copy is the
// practical equivalent for download.)

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import os from 'node:os';

const env: Record<string, string> = {};
for (const l of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  if (!l || l.startsWith('#') || !l.includes('=')) continue;
  const i = l.indexOf('=');
  let v = l.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[l.slice(0, i).trim()] = v;
}
const sb = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

// Population rank — top metros per state. Rank 1 = highest pop.
// Counties not in the map get rank 999 (least preferred); plans that
// serve nothing-but-rural counties fall through to a state default.
// Names match pm_plans.county_name exactly (no " County" suffix).
const COUNTY_RANK: Record<string, Record<string, { rank: number; centerZip: string }>> = {
  TX: {
    'Harris':    { rank: 1,  centerZip: '77002' }, // Houston
    'Dallas':    { rank: 2,  centerZip: '75201' },
    'Tarrant':   { rank: 3,  centerZip: '76102' }, // Fort Worth
    'Bexar':     { rank: 4,  centerZip: '78205' }, // San Antonio
    'Travis':    { rank: 5,  centerZip: '78701' }, // Austin
    'Collin':    { rank: 6,  centerZip: '75002' },
    'Denton':    { rank: 7,  centerZip: '76201' },
    'Hidalgo':   { rank: 8,  centerZip: '78501' }, // McAllen
    'El Paso':   { rank: 9,  centerZip: '79901' },
    'Fort Bend': { rank: 10, centerZip: '77469' },
    'Montgomery': { rank: 11, centerZip: '77301' },
    'Williamson': { rank: 12, centerZip: '78626' },
    'Cameron':   { rank: 13, centerZip: '78520' }, // Brownsville
    'Nueces':    { rank: 14, centerZip: '78401' }, // Corpus Christi
    'Bell':      { rank: 15, centerZip: '76501' }, // Killeen
    'Brazoria':  { rank: 16, centerZip: '77515' },
    'Galveston': { rank: 17, centerZip: '77550' },
    'Jefferson': { rank: 18, centerZip: '77701' }, // Beaumont
    'Lubbock':   { rank: 19, centerZip: '79401' },
    'Webb':      { rank: 20, centerZip: '78040' }, // Laredo
    'McLennan':  { rank: 21, centerZip: '76701' }, // Waco
    'Smith':     { rank: 22, centerZip: '75701' }, // Tyler
    'Ellis':     { rank: 23, centerZip: '75165' },
    'Johnson':   { rank: 24, centerZip: '76028' },
    'Hays':      { rank: 25, centerZip: '78666' }, // San Marcos
  },
  GA: {
    'Fulton':    { rank: 1,  centerZip: '30303' }, // Atlanta
    'Gwinnett':  { rank: 2,  centerZip: '30043' }, // Lawrenceville
    'Cobb':      { rank: 3,  centerZip: '30060' }, // Marietta
    'DeKalb':    { rank: 4,  centerZip: '30030' }, // Decatur
    'Clayton':   { rank: 5,  centerZip: '30236' }, // Jonesboro
    'Cherokee':  { rank: 6,  centerZip: '30114' }, // Canton
    'Forsyth':   { rank: 7,  centerZip: '30040' }, // Cumming
    'Henry':     { rank: 8,  centerZip: '30253' }, // McDonough
    'Hall':      { rank: 9,  centerZip: '30501' }, // Gainesville
    'Richmond':  { rank: 10, centerZip: '30901' }, // Augusta
    'Chatham':   { rank: 11, centerZip: '31401' }, // Savannah
    'Houston':   { rank: 12, centerZip: '31069' }, // Perry
    'Bibb':      { rank: 13, centerZip: '31201' }, // Macon
    'Muscogee':  { rank: 14, centerZip: '31901' }, // Columbus
    'Paulding':  { rank: 15, centerZip: '30132' },
    'Douglas':   { rank: 16, centerZip: '30134' },
    'Newton':    { rank: 17, centerZip: '30014' },
    'Rockdale':  { rank: 18, centerZip: '30012' },
    'Coweta':    { rank: 19, centerZip: '30263' },
    'Fayette':   { rank: 20, centerZip: '30214' },
  },
  NC: {
    // NC uses pm_zip_county as primary; this map is the FALLBACK
    // ordering when multiple counties match a plan.
    'Wake':         { rank: 1,  centerZip: '27601' },
    'Mecklenburg':  { rank: 2,  centerZip: '28202' },
    'Guilford':     { rank: 3,  centerZip: '27401' },
    'Forsyth':      { rank: 4,  centerZip: '27101' },
    'Cumberland':   { rank: 5,  centerZip: '28301' },
    'Durham':       { rank: 6,  centerZip: '27701' },
    'Buncombe':     { rank: 7,  centerZip: '28801' }, // Asheville
    'New Hanover':  { rank: 8,  centerZip: '28401' }, // Wilmington
    'Union':        { rank: 9,  centerZip: '28110' },
    'Cabarrus':     { rank: 10, centerZip: '28025' },
  },
};
const STATE_DEFAULT_ZIP: Record<string, string> = {
  TX: '77002', // Houston
  GA: '30303', // Atlanta
  NC: '27601', // Raleigh
};

function csvEscape(s: string): string {
  if (s == null) return '';
  const str = String(s);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

async function ncZipForCounty(county: string): Promise<string | null> {
  const { data } = await sb.from('pm_zip_county').select('zip').eq('county', county).eq('state', 'NC').limit(1);
  return (data?.[0] as any)?.zip ?? null;
}

(async () => {
  // Pre-load the existing gap JSON for first-county-ZIP fallback
  const existingZips = new Map<string, string>();
  try {
    const existing = JSON.parse(readFileSync('/Users/robertsimm/Code/plan-match/_tmp/gap-dsnps-for-sb-discovery.json', 'utf8'));
    for (const p of existing as Array<{ contract_id: string; plan_id: string; zip: string }>) {
      existingZips.set(`${p.contract_id}-${p.plan_id}`, p.zip);
    }
  } catch { /* OK if missing */ }

  // 1. Pull current gap from DB (mirror gen-dsnp-food-card-template.ts)
  let from = 0;
  const seen = new Set<string>();
  const plans: Array<{ contract_id: string; plan_id: string; cp: string; carrier: string; state: string; plan_name: string }> = [];
  for (;;) {
    const { data, error } = await sb.from('pm_plans').select('contract_id, plan_id, state, carrier, plan_name').in('state', ['NC', 'TX', 'GA']).eq('snp_type', 'D-SNP').range(from, from + 999);
    if (error || !data || data.length === 0) break;
    for (const r of data as any[]) {
      const cp = `${r.contract_id}-${r.plan_id}`;
      if (seen.has(cp)) continue;
      seen.add(cp);
      plans.push({ contract_id: r.contract_id, plan_id: r.plan_id, cp, carrier: r.carrier ?? '', state: r.state, plan_name: r.plan_name ?? '' });
    }
    if (data.length < 1000) break;
    from += 1000;
  }
  const cpList = plans.map((p) => p.cp);
  const haveDollar = new Set<string>();
  for (let i = 0; i < cpList.length; i += 200) {
    const chunk = cpList.slice(i, i + 200);
    const { data } = await sb.from('pbp_benefits').select('plan_id, copay, copay_max, description').in('plan_id', chunk).in('benefit_type', ['food_card', 'meal_benefit', 'meals', 'otc', 'otc_allowance']);
    for (const r of (data ?? []) as any[]) {
      const hasMax = r.copay_max != null && r.copay_max > 0;
      const hasCopay = r.copay != null && r.copay > 0;
      const hasDescDollar = typeof r.description === 'string' && /\$\s*\d/.test(r.description);
      if (hasMax || hasCopay || hasDescDollar) haveDollar.add(r.plan_id);
    }
  }
  const gap = plans.filter((p) => !haveDollar.has(p.cp));
  console.log(`Gap plans: ${gap.length}`);

  // 2. Resolve sample_zip per plan
  type Out = typeof gap[number] & { sample_zip: string; zip_source: string };
  const out: Out[] = [];
  for (const p of gap) {
    const { data: counties } = await sb
      .from('pm_plans')
      .select('county_name')
      .eq('contract_id', p.contract_id)
      .eq('plan_id', p.plan_id);
    const distinct = [...new Set((counties ?? []).map((r: any) => r.county_name).filter((c: any) => !!c))];
    const stateMap = COUNTY_RANK[p.state] ?? {};
    // Sort counties by hardcoded rank (1 best); unknowns sink to 999
    distinct.sort((a, b) => (stateMap[a]?.rank ?? 999) - (stateMap[b]?.rank ?? 999));
    const topCounty = distinct[0];
    let zip: string | null = null;
    let source = '';
    if (topCounty) {
      const ranked = stateMap[topCounty];
      if (ranked) {
        zip = ranked.centerZip;
        source = `${topCounty} County center (rank ${ranked.rank})`;
      } else if (p.state === 'NC') {
        const ncZip = await ncZipForCounty(topCounty);
        if (ncZip) {
          zip = ncZip;
          source = `pm_zip_county lookup for ${topCounty}`;
        }
      }
    }
    if (!zip) {
      // Fall back to the existing gap JSON's zip (alphabetical-first
      // county — guaranteed in the plan's service area, just not the
      // most-populated). Better than state-default which may not be in
      // the plan's service area at all (e.g. rural-TX D-SNPs that
      // don't serve Houston).
      const existing = existingZips.get(p.cp);
      if (existing) {
        zip = existing;
        source = `first-county fallback (rural-only plan, no top-25 metro served)`;
      } else {
        zip = STATE_DEFAULT_ZIP[p.state] ?? '';
        source = `state-default (last resort)`;
      }
    }
    out.push({ ...p, sample_zip: zip, zip_source: source });
  }

  // 3. Sort: state, carrier, plan_id
  out.sort((a, b) =>
    a.state.localeCompare(b.state) ||
    a.carrier.localeCompare(b.carrier) ||
    a.cp.localeCompare(b.cp),
  );

  // 4. Emit CSV — sample_zip after state for usability
  const lines: string[] = ['plan_id,carrier,state,sample_zip,plan_name,food_card_amount,frequency,notes'];
  for (const p of out) {
    lines.push([
      csvEscape(p.cp),
      csvEscape(p.carrier),
      csvEscape(p.state),
      csvEscape(p.sample_zip),
      csvEscape(p.plan_name),
      '', '', '',
    ].join(','));
  }
  const body = lines.join('\n') + '\n';
  const path1 = '/Users/robertsimm/Code/plan-match/_tmp/dsnp-food-card-manual-template-with-zips.csv';
  const path2 = resolve(os.homedir(), 'Desktop/dsnp-food-card-manual-template-with-zips.csv');
  writeFileSync(path1, body);
  writeFileSync(path2, body);
  console.log(`\nWrote ${out.length} rows to:\n  ${path1}\n  ${path2}`);

  // 5. Breakdown of zip sources
  const bySource = new Map<string, number>();
  for (const p of out) {
    const key = p.zip_source.includes('state-default') ? 'state-default (LAST RESORT)' :
                p.zip_source.includes('first-county fallback') ? 'first-county (rural-only plan)' :
                p.zip_source.includes('pm_zip_county') ? 'pm_zip_county (NC)' :
                'hardcoded metro';
    bySource.set(key, (bySource.get(key) ?? 0) + 1);
  }
  console.log('\nZIP source breakdown:');
  for (const [k, v] of bySource) console.log(`  ${v.toString().padStart(3)}  ${k}`);

  // Show fallbacks
  const fallbacks = out.filter((p) => !p.zip_source.startsWith(p.state === 'NC' ? 'pm_zip_county' : '') && p.zip_source.includes('fallback'));
  if (fallbacks.length > 0) {
    console.log('\nFirst-county fallbacks (zip IS in service area but not a major metro):');
    for (const p of fallbacks) {
      const { data: cn } = await sb.from('pm_plans').select('county_name').eq('contract_id', p.contract_id).eq('plan_id', p.plan_id).limit(8);
      const cnList = [...new Set((cn ?? []).map((r: any) => r.county_name))].slice(0, 6);
      console.log(`  ${p.cp}  ${p.state}  zip=${p.sample_zip}  served=${cnList.join(',')}…`);
    }
  }
})();
