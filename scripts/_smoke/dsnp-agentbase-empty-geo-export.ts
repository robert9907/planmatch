// Phase 2 pre-AEP data cleanup — export AgentBase clients whose geo
// is too sparse to reach a plan pool. Two CSVs:
//   • agentbase-missing-geo-strict-2026-08-12.csv  (no state AND no zip)
//     30 clients as of 2026-08-12. Unrecoverable — the PoolIntegrityBanner
//     fires unconditionally; broker must capture state before the
//     bench can even show a truncated pool.
//   • agentbase-missing-geo-fallback-2026-08-12.csv  (no county AND no zip)
//     39 clients as of 2026-08-12. Superset of the strict list plus 9
//     clients whose state IS on file (usually NC) but neither county
//     nor zip. Same banner behavior — no county, no ZIP resolver
//     input, no pool.
// (The two sets diverge on the 9 clients with state='NC', county='',
// zip=''. The 30-list plus those 9 = the 39-list.)
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local','utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const ab = createClient(process.env.AGENTBASE_SUPABASE_URL!, process.env.AGENTBASE_SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

const OUT_STRICT   = '/Users/robertsimm/Desktop/agentbase-missing-geo-strict-2026-08-12.csv';
const OUT_FALLBACK = '/Users/robertsimm/Desktop/agentbase-missing-geo-fallback-2026-08-12.csv';

function csvEsc(v: unknown): string {
  const s = v == null ? '' : String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function writeCsv(path: string, rows: Record<string, unknown>[], header: string[]) {
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(header.map((c) => csvEsc(r[c])).join(','));
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}

async function main() {
  const cols = 'id, first_name, last_name, phone, email, dob, address, city, zip, county, state, status, lead_source, plan_name, plan_id, carrier, medicare_id, created_at, updated_at';
  const header = cols.split(', ');

  // Strict: no state AND no zip. Unrecoverable.
  const strict = await ab.from('clients').select(cols)
    .or('state.is.null,state.eq.')
    .or('zip.is.null,zip.eq.')
    .order('id', { ascending: true });
  if (strict.error) { console.error(strict.error); process.exit(1); }
  const strictRows = strict.data ?? [];
  await writeCsv(OUT_STRICT, strictRows as any, header);
  console.log(`  Wrote ${OUT_STRICT} — ${strictRows.length} rows (no state AND no zip)`);

  // Fallback: no county AND no zip. Superset; includes state-only rows.
  const fallback = await ab.from('clients').select(cols)
    .or('county.is.null,county.eq.')
    .or('zip.is.null,zip.eq.')
    .order('id', { ascending: true });
  if (fallback.error) { console.error(fallback.error); process.exit(1); }
  const fallbackRows = fallback.data ?? [];
  await writeCsv(OUT_FALLBACK, fallbackRows as any, header);
  console.log(`  Wrote ${OUT_FALLBACK} — ${fallbackRows.length} rows (no county AND no zip)`);

  const rows = fallbackRows;

  // Preview whether the "missing both" set has ANY other geo hint we
  // could recover from — address (freeform street), city (may reveal
  // state), medicare_id (state-of-issue in the alphanumeric prefix
  // for some contracts — worth eyeballing).
  console.log(`\n  Row-by-row preview:`);
  for (const r of rows as any[]) {
    console.log(`    id=${String(r.id).padStart(4)} ${(r.first_name ?? '').trim()} ${(r.last_name ?? '').trim().padEnd(22)} status=${(r.status ?? '—').padEnd(12)} state=${r.state ?? '—'} city=${(r.city ?? '—').padEnd(14)} lead=${r.lead_source ?? '?'}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
