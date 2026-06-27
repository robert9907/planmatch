// scripts/audit-cms-pbp-diff.ts
//
// Step 7 — download the CMS PBP Benefits ZIP for plan year 2026,
// extract every (contract_id, plan_id, segment_id, state) tuple from
// PlanArea.txt, and diff against pm_plans for NC/TX/GA.
//
// Output is appended to _tmp/audit-report.md.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { downloadZip } from './cms-pbp/download.js';
import yauzl, { type Entry } from 'yauzl';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
if (!url || !key) {
  console.error('Missing env');
  process.exit(1);
}
const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const PBP_URL = 'https://www.cms.gov/files/zip/pbp-benefits-2026.zip';
const STATES = new Set(['NC', 'TX', 'GA']);

// CMS PBP uses 2-digit FIPS state codes in stcd; map to USPS so we can
// diff against the DB (which stores 2-letter USPS).
const STATE_FIPS_TO_USPS: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO',
  '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI',
  '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY',
  '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
  '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH',
  '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
  '54': 'WV', '55': 'WI', '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP',
  '72': 'PR', '78': 'VI',
};

interface PbpPlanKey {
  hnumber: string;
  planId: string;
  segmentId: string;
  state: string;
}

async function listZip(filePath: string): Promise<{ entries: string[] }> {
  return await new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const entries: string[] = [];
      zip.on('entry', (e: Entry) => {
        entries.push(e.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve({ entries }));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

async function readEntryAsLines(
  filePath: string,
  entryName: string,
  onLine: (line: string, idx: number) => void,
): Promise<void> {
  return await new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('entry', (e: Entry) => {
        if (e.fileName !== entryName) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(e, (err2, stream) => {
          if (err2) return reject(err2);
          const rl = createInterface({ input: stream as unknown as Readable, crlfDelay: Infinity });
          let i = 0;
          rl.on('line', (line) => {
            onLine(line, i);
            i += 1;
          });
          rl.on('close', () => resolve());
          rl.on('error', reject);
        });
      });
      zip.on('end', () => resolve());
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

async function main() {
  const cached = process.env.PBP_CACHED_ZIP;
  let dl: { filePath: string; bytes: number; sha256: string };
  if (cached && existsSync(cached)) {
    console.log(`[step7] using cached ZIP ${cached}`);
    const { shaLocal } = await import('./cms-pbp/download.js');
    dl = await shaLocal(cached);
  } else {
    console.log('[step7] downloading PBP ZIP…');
    dl = await downloadZip(PBP_URL, 'pbp-benefits-2026.zip');
  }
  console.log(`[step7] zip at ${dl.filePath} (${(dl.bytes / 1_000_000).toFixed(1)} MB)`);

  const { entries } = await listZip(dl.filePath);
  console.log(`[step7] ${entries.length} entries in ZIP`);
  const planAreaName = entries.find((e) => e.toLowerCase() === 'planarea.txt');
  if (!planAreaName) {
    console.error('Could not find PlanArea.txt — entries:', entries);
    process.exit(1);
  }

  let header: string[] = [];
  const planSet = new Set<string>(); // h|plan|seg|state
  const stateCount = new Map<string, number>();
  const stateTypeBreakdown = new Map<string, number>(); // state|orgtype|planType|benCov → count (row count, not plan count)
  const planMeta = new Map<string, { orgtype: string; planType: string; benCov: string; eghp: string; pending: string }>();
  await readEntryAsLines(dl.filePath, planAreaName, (line, idx) => {
    if (idx === 0) {
      header = line.split('\t').map((h) => h.trim().toLowerCase());
      console.log('[step7] PlanArea header:', header.join(' | '));
      return;
    }
    const cells = line.split('\t');
    if (cells.length < header.length) return;
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i += 1) row[header[i]] = (cells[i] ?? '').trim();
    const h = row['pbp_a_hnumber'] ?? row['contract_id'] ?? '';
    const pid = row['pbp_a_plan_identifier'] ?? row['plan_id'] ?? '';
    const seg = row['segment_id'] ?? '000';
    const stRaw = row['stcd'] ?? row['state'] ?? '';
    const st = STATE_FIPS_TO_USPS[stRaw] ?? stRaw.toUpperCase();
    const orgtype = row['orgtype'] ?? '';
    const planType = row['pbp_a_plan_type'] ?? '';
    const benCov = row['pbp_a_ben_cov'] ?? '';
    const eghp = row['eghp_flag'] ?? '';
    const pending = row['pending_flag'] ?? '';
    if (!h || !pid || !st) return;
    const key = `${h}|${pid}|${seg}|${st}`;
    planSet.add(key);
    stateCount.set(st, (stateCount.get(st) ?? 0) + 1);
    if (STATES.has(st)) {
      const tkey = `${st}|${orgtype}|${planType}|${benCov}`;
      stateTypeBreakdown.set(tkey, (stateTypeBreakdown.get(tkey) ?? 0) + 1);
    }
    planMeta.set(`${h}-${pid}|${st}`, { orgtype, planType, benCov, eghp, pending });
  });
  console.log(`[step7] unique plan-state tuples from PBP: ${planSet.size}`);

  const cmsPlans: PbpPlanKey[] = [...planSet].map((k) => {
    const [hnumber, planId, segmentId, state] = k.split('|');
    return { hnumber, planId, segmentId, state };
  });
  const cmsByState = new Map<string, Set<string>>(); // state → set of "h-pid"
  for (const p of cmsPlans) {
    if (!cmsByState.has(p.state)) cmsByState.set(p.state, new Set());
    cmsByState.get(p.state)!.add(`${p.hnumber}-${p.planId}`);
  }

  // Pull NC/TX/GA plans from DB
  console.log('[step7] fetching DB plan keys…');
  const { data: dbRows, error } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, state, plan_name, carrier')
    .in('state', [...STATES])
    .range(0, 49999);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  const dbBy = new Map<string, Set<string>>(); // state → set of "h-pid"
  const dbMeta = new Map<string, { carrier: string; name: string }>();
  for (const r of dbRows ?? []) {
    if (!dbBy.has(r.state)) dbBy.set(r.state, new Set());
    const k = `${r.contract_id}-${r.plan_id}`;
    dbBy.get(r.state)!.add(k);
    if (!dbMeta.has(`${r.state}|${k}`)) {
      dbMeta.set(`${r.state}|${k}`, { carrier: r.carrier ?? '?', name: r.plan_name ?? '?' });
    }
  }

  // Diff
  const out: string[] = [];
  out.push('\n# Step 7 — CMS PBP 2026 cross-reference\n');
  out.push(`Source: ${PBP_URL}`);
  out.push(`Release SHA-256: \`${dl.sha256}\``);
  out.push(`PBP ZIP size: ${(dl.bytes / 1_000_000).toFixed(1)} MB`);
  out.push(`PBP unique plan-state tuples: ${planSet.size}\n`);

  out.push('\n## CMS plan-state row counts by state (top 15)\n');
  const stateRows = [...stateCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([state, n]) => `| ${state} | ${n} |`)
    .join('\n');
  out.push('| state | tuples |');
  out.push('| --- | --- |');
  out.push(stateRows);

  const diffSummary: { state: string; cms: number; db: number; cmsOnly: number; dbOnly: number }[] = [];
  const cmsOnlyDetail: { state: string; key: string }[] = [];
  const dbOnlyDetail: { state: string; key: string; carrier: string; name: string }[] = [];

  for (const st of STATES) {
    const cms = cmsByState.get(st) ?? new Set<string>();
    const db = dbBy.get(st) ?? new Set<string>();
    const cmsOnly = [...cms].filter((k) => !db.has(k));
    const dbOnly = [...db].filter((k) => !cms.has(k));
    diffSummary.push({
      state: st,
      cms: cms.size,
      db: db.size,
      cmsOnly: cmsOnly.length,
      dbOnly: dbOnly.length,
    });
    for (const k of cmsOnly) cmsOnlyDetail.push({ state: st, key: k });
    for (const k of dbOnly) {
      const meta = dbMeta.get(`${st}|${k}`);
      dbOnlyDetail.push({ state: st, key: k, carrier: meta?.carrier ?? '?', name: meta?.name ?? '?' });
    }
  }

  out.push('\n## Plan-count diff (NC/TX/GA, contract+plan keyed) — RAW (includes PDPs / SNPs / cost plans)\n');
  out.push('| state | cms_plans | db_plans | cms_only | db_only |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const d of diffSummary) {
    out.push(`| ${d.state} | ${d.cms} | ${d.db} | ${d.cmsOnly} | ${d.dbOnly} |`);
  }

  // Filter: PBP-Benefits 2026 contains MA plan packages (no PDPs — that's
  // a separate PBP-Rx file). But it includes EGWP (employer group plans,
  // eghp_flag=1) and pending plans (pending_flag=1) which a consumer-
  // facing app like Plan Match doesn't carry. Strip those out for a
  // fair comparison.
  out.push('\n## Plan-count diff (NC/TX/GA) — FILTERED to consumer MA plans (eghp_flag=0, pending_flag=0)\n');
  out.push('| state | cms_consumer_ma | db_plans | cms_only | db_only |');
  out.push('| --- | --- | --- | --- | --- |');
  const maCmsOnlyDetail: { state: string; key: string; orgtype: string; planType: string; benCov: string }[] = [];
  const maDbOnlyDetail: { state: string; key: string; carrier: string; name: string }[] = [];
  for (const st of STATES) {
    const cmsConsumer = new Set<string>();
    for (const p of cmsPlans) {
      if (p.state !== st) continue;
      const meta = planMeta.get(`${p.hnumber}-${p.planId}|${st}`);
      if (!meta) continue;
      if (meta.eghp === '1') continue;
      if (meta.pending === '1') continue;
      cmsConsumer.add(`${p.hnumber}-${p.planId}`);
    }
    const db = dbBy.get(st) ?? new Set<string>();
    const cmsOnly = [...cmsConsumer].filter((k) => !db.has(k));
    const dbOnly = [...db].filter((k) => !cmsConsumer.has(k));
    out.push(`| ${st} | ${cmsConsumer.size} | ${db.size} | ${cmsOnly.length} | ${dbOnly.length} |`);
    for (const k of cmsOnly) {
      const meta = planMeta.get(`${k}|${st}`)!;
      maCmsOnlyDetail.push({ state: st, key: k, orgtype: meta.orgtype, planType: meta.planType, benCov: meta.benCov });
    }
    for (const k of dbOnly) {
      const meta = dbMeta.get(`${st}|${k}`);
      maDbOnlyDetail.push({ state: st, key: k, carrier: meta?.carrier ?? '?', name: meta?.name ?? '?' });
    }
  }
  out.push('\n## Consumer-MA CMS-only plans (CMS has, DB missing) — first 100\n');
  if (maCmsOnlyDetail.length === 0) out.push('_none_');
  else {
    out.push('| state | contract-plan | orgtype | plan_type | ben_cov |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const r of maCmsOnlyDetail.slice(0, 100)) {
      out.push(`| ${r.state} | ${r.key} | ${r.orgtype} | ${r.planType} | ${r.benCov} |`);
    }
    out.push(`\n_${maCmsOnlyDetail.length} total consumer MA plans missing from DB_`);
  }
  out.push('\n## Consumer-MA DB-only plans (DB has, CMS PBP does not) — first 100\n');
  if (maDbOnlyDetail.length === 0) out.push('_none_');
  else {
    out.push('| state | contract-plan | carrier | plan_name |');
    out.push('| --- | --- | --- | --- |');
    for (const r of maDbOnlyDetail.slice(0, 100)) {
      out.push(`| ${r.state} | ${r.key} | ${r.carrier} | ${r.name} |`);
    }
    out.push(`\n_${maDbOnlyDetail.length} total DB-only plans (likely PDP or stale rows)_`);
  }

  out.push('\n## CMS-only plans (CMS has, DB missing) — first 100\n');
  if (cmsOnlyDetail.length === 0) out.push('_none_');
  else {
    out.push('| state | contract-plan |');
    out.push('| --- | --- |');
    for (const r of cmsOnlyDetail.slice(0, 100)) out.push(`| ${r.state} | ${r.key} |`);
    out.push(`\n_${cmsOnlyDetail.length} total_`);
  }

  out.push('\n## DB-only plans (DB has, CMS PBP does not) — first 100\n');
  if (dbOnlyDetail.length === 0) out.push('_none_');
  else {
    out.push('| state | contract-plan | carrier | plan_name |');
    out.push('| --- | --- | --- | --- |');
    for (const r of dbOnlyDetail.slice(0, 100)) {
      out.push(`| ${r.state} | ${r.key} | ${r.carrier} | ${r.name} |`);
    }
    out.push(`\n_${dbOnlyDetail.length} total_`);
  }

  writeFileSync('_tmp/audit-step7.md', out.join('\n') + '\n');
  writeFileSync(
    '_tmp/audit-cms-diff.json',
    JSON.stringify({ diffSummary, cmsOnlyDetail, dbOnlyDetail, maCmsOnlyDetail, maDbOnlyDetail, headerSeen: header, sha256: dl.sha256, bytes: dl.bytes }, null, 2),
  );
  console.log('[step7] wrote _tmp/audit-step7.md and _tmp/audit-cms-diff.json');
  console.log('[step7] summary:', diffSummary);
  console.log('[step7] MA-only CMS-only:', maCmsOnlyDetail.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
