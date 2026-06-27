// _tmp/tx-targeted-loop.sh dependency — rebuilds _tmp/tx-still-todo.txt
// from the diff of "all TX state-mode targets" minus "ZIPs already
// scraped across every tx-scrape*.log". Exits 0 with todo count on stdout.

import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

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

function normalizeCountyName(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+county$/, '');
}

async function paginate<T>(
  pageFn: (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let p = 0; p < 200; p += 1) {
    const { data, error } = await pageFn(p * PAGE, p * PAGE + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

async function main() {
  const planRows = await paginate<{ county_name: string | null; county_fips: string | null }>(
    (from, to) =>
      sb.from('pm_plans').select('county_name, county_fips').eq('state', 'TX').range(from, to),
  );
  const fipsByCounty = new Map<string, string>();
  for (const r of planRows) {
    const key = normalizeCountyName(r.county_name);
    if (!key || !r.county_fips) continue;
    if (!fipsByCounty.has(key)) fipsByCounty.set(key, r.county_fips);
  }

  const zipRows = await paginate<{ zip: string; county: string | null }>((from, to) =>
    sb.from('pm_zip_county').select('zip, county').eq('state', 'TX').range(from, to),
  );
  const seenCounty = new Set<string>();
  const allTargets: Array<{ zip: string; fips: string }> = [];
  for (const r of zipRows) {
    const key = normalizeCountyName(r.county);
    if (seenCounty.has(key)) continue;
    const f = fipsByCounty.get(key);
    if (!f) continue;
    seenCounty.add(key);
    allTargets.push({ zip: r.zip, fips: f });
  }

  // Walk every tx-scrape*.log we find, including future runs the
  // loop produces — so each iteration narrows the todo set further.
  const done = new Set<string>();
  for (const f of readdirSync('_tmp').filter((n) => /^tx-scrape.*\.log$/.test(n))) {
    const txt = readFileSync(`_tmp/${f}`, 'utf8');
    for (const m of txt.matchAll(/^\s*[✓✗]?\s*(\d{5})\/(\d{5})/gm)) {
      done.add(m[1]);
    }
  }

  const todo = allTargets.filter((t) => !done.has(t.zip));
  writeFileSync(
    '_tmp/tx-still-todo.txt',
    (todo.map((t) => `${t.zip}/${t.fips}`).join('\n') + (todo.length ? '\n' : '')),
  );
  console.log(
    `TX todo: ${todo.length} (state targets=${allTargets.length}, done=${done.size})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
