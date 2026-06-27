// Step 1 only — dump pm_* tables + columns to _tmp/pm-schema.json
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
if (!url || !key) {
  console.error('Missing SUPABASE_URL / KEY');
  process.exit(1);
}

async function main() {
  const res = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.error('OpenAPI fetch failed:', res.status, res.statusText);
    process.exit(1);
  }
  const swagger = (await res.json()) as {
    definitions?: Record<string, { properties?: Record<string, { type?: string; format?: string }> }>;
  };
  const defs = swagger.definitions ?? {};
  const pmTables = Object.keys(defs).filter((n) => n.startsWith('pm_')).sort();

  mkdirSync('_tmp', { recursive: true });
  const out: Record<string, { column: string; type: string }[]> = {};
  for (const t of pmTables) {
    const props = defs[t].properties ?? {};
    out[t] = Object.entries(props).map(([name, spec]) => ({
      column: name,
      type: spec.format ?? spec.type ?? '?',
    }));
  }
  writeFileSync('_tmp/pm-schema.json', JSON.stringify(out, null, 2));
  console.log(`Wrote _tmp/pm-schema.json with ${pmTables.length} tables`);

  // Also print the column lists for pm_plans, pm_plan_benefits, pm_formulary
  for (const t of ['pm_plans', 'pm_plan_benefits', 'pm_formulary', 'pm_formulary_v2']) {
    if (out[t]) {
      console.log(`\n${t} (${out[t].length} cols):`);
      console.log(out[t].map((c) => `  ${c.column} : ${c.type}`).join('\n'));
    } else {
      console.log(`\n${t}: NOT FOUND`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
