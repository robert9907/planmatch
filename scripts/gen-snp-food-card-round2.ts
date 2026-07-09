// Generate the Round-2 food-card gap capture spreadsheet.
//
// Round 1 (commit 1227db1) covered 54 D-SNPs via manual capture. This
// round targets the remaining NC/TX/GA D-SNP + C-SNP plans that still
// don't have a real dollar amount in pbp_benefits_v2.
//
// Gap definition (strict): a plan is in the gap when its best food_card
// row (by source-priority: manual=4, sb_ocr=3, medicare_gov=2,
// pbp_federal=1) has copay <= 1, OR no food_card row exists at all.
// A copay=1 marker is the API's allowance-rescue sentinel — see
// api/plans.ts:508-515 — and renders as description text on the agent
// Compare screen, not a dollar amount.
//
// Output:
//   scripts/captures/snp-food-card-gap-round2.xlsx  (styled)
//   scripts/captures/snp-food-card-gap-round2.csv   (flat)
//
// Yellow-highlighted columns (G–J) are for Cowork to fill in from each
// carrier's 2026 SB PDF. K carries the current DB state for reference.

import { createClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// ─── Env load (inline reader, no dotenv dep) ────────────────────────────
const env: Record<string, string> = {};
if (existsSync(resolve(process.cwd(), '.env.local'))) {
  for (const l of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
    if (!l || l.startsWith('#') || !l.includes('=')) continue;
    const i = l.indexOf('=');
    let v = l.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[l.slice(0, i).trim()] = v;
  }
}
const SUPABASE_URL = env.SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY =
  env.SUPABASE_SERVICE_ROLE_KEY ??
  env.SUPABASE_ANON_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  '';
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Round 1 covered these 54 plans (from user's capture list). Skip
// them regardless of DB state so we don't send Cowork back to plans
// already handled. ─────────────────────────────────────────────────────
const ROUND1_COVERED = new Set<string>([
  'H5422-019', 'H8390-015', 'H8390-017', 'H5216-206', 'H3291-002',
  'H2406-052', 'H3256-004', 'H3256-005', 'H3256-006', 'H5322-049',
  'H5322-050', 'H0111-004', 'H1112-006', 'H1112-033', 'H1112-046',
  'H1112-047', 'H1112-048', 'H6351-005', 'H5253-041', 'H5253-116',
  'H5253-184', 'H4073-004', 'H6515-001', 'H6515-002', 'H6515-003',
  'H6515-004', 'H6515-005', 'H4514-023', 'H0062-011', 'H0062-012',
  'H0174-004', 'H0174-006', 'H0174-022', 'H0174-023', 'H0174-024',
  'H0174-025', 'H0174-026', 'H5294-010', 'H5294-015', 'H5294-021',
  'H5294-022', 'H5294-023', 'H5294-024', 'H5294-025', 'H2593-032',
  'H2593-044', 'H2593-045', 'H2593-046', 'H2593-047', 'H2593-048',
  'H2593-051', 'H2593-053', 'H8849-010', 'H8849-011',
]);

// ─── Source-priority rank for CARRIER_AUTHORITATIVE types (food_card,
// otc_allowance). Mirrors api/plans.ts:404-419 exactly. ────────────────
const SOURCE_RANK: Record<string, number> = { manual: 4, sb_ocr: 3, medicare_gov: 2, pbp_federal: 1 };

// ─── County → sample-zip map (copied verbatim from round 1 so both
// rounds resolve to the same test ZIP per county). ─────────────────────
const COUNTY_RANK: Record<string, Record<string, { rank: number; centerZip: string }>> = {
  TX: {
    'Harris': { rank: 1, centerZip: '77002' }, 'Dallas': { rank: 2, centerZip: '75201' },
    'Tarrant': { rank: 3, centerZip: '76102' }, 'Bexar': { rank: 4, centerZip: '78205' },
    'Travis': { rank: 5, centerZip: '78701' }, 'Collin': { rank: 6, centerZip: '75002' },
    'Denton': { rank: 7, centerZip: '76201' }, 'Hidalgo': { rank: 8, centerZip: '78501' },
    'El Paso': { rank: 9, centerZip: '79901' }, 'Fort Bend': { rank: 10, centerZip: '77469' },
    'Montgomery': { rank: 11, centerZip: '77301' }, 'Williamson': { rank: 12, centerZip: '78626' },
    'Cameron': { rank: 13, centerZip: '78520' }, 'Nueces': { rank: 14, centerZip: '78401' },
    'Bell': { rank: 15, centerZip: '76501' }, 'Brazoria': { rank: 16, centerZip: '77515' },
    'Galveston': { rank: 17, centerZip: '77550' }, 'Jefferson': { rank: 18, centerZip: '77701' },
    'Lubbock': { rank: 19, centerZip: '79401' }, 'Webb': { rank: 20, centerZip: '78040' },
    'McLennan': { rank: 21, centerZip: '76701' }, 'Smith': { rank: 22, centerZip: '75701' },
    'Ellis': { rank: 23, centerZip: '75165' }, 'Johnson': { rank: 24, centerZip: '76028' },
    'Hays': { rank: 25, centerZip: '78666' },
  },
  GA: {
    'Fulton': { rank: 1, centerZip: '30303' }, 'Gwinnett': { rank: 2, centerZip: '30043' },
    'Cobb': { rank: 3, centerZip: '30060' }, 'DeKalb': { rank: 4, centerZip: '30030' },
    'Clayton': { rank: 5, centerZip: '30236' }, 'Cherokee': { rank: 6, centerZip: '30114' },
    'Forsyth': { rank: 7, centerZip: '30040' }, 'Henry': { rank: 8, centerZip: '30253' },
    'Hall': { rank: 9, centerZip: '30501' }, 'Richmond': { rank: 10, centerZip: '30901' },
    'Chatham': { rank: 11, centerZip: '31401' }, 'Houston': { rank: 12, centerZip: '31069' },
    'Bibb': { rank: 13, centerZip: '31201' }, 'Muscogee': { rank: 14, centerZip: '31901' },
    'Paulding': { rank: 15, centerZip: '30132' }, 'Douglas': { rank: 16, centerZip: '30134' },
    'Newton': { rank: 17, centerZip: '30014' }, 'Rockdale': { rank: 18, centerZip: '30012' },
    'Coweta': { rank: 19, centerZip: '30263' }, 'Fayette': { rank: 20, centerZip: '30214' },
  },
  NC: {
    'Wake': { rank: 1, centerZip: '27601' }, 'Mecklenburg': { rank: 2, centerZip: '28202' },
    'Guilford': { rank: 3, centerZip: '27401' }, 'Forsyth': { rank: 4, centerZip: '27101' },
    'Cumberland': { rank: 5, centerZip: '28301' }, 'Durham': { rank: 6, centerZip: '27701' },
    'Buncombe': { rank: 7, centerZip: '28801' }, 'New Hanover': { rank: 8, centerZip: '28401' },
    'Union': { rank: 9, centerZip: '28110' }, 'Cabarrus': { rank: 10, centerZip: '28025' },
  },
};
const STATE_DEFAULT_ZIP: Record<string, string> = { TX: '77002', GA: '30303', NC: '27601' };

async function ncZipForCounty(county: string): Promise<string | null> {
  const { data } = await sb.from('pm_zip_county').select('zip').eq('county', county).eq('state', 'NC').limit(1);
  return (data?.[0] as { zip: string } | undefined)?.zip ?? null;
}

// ─── Carrier lookup guide — SB benefit-label + portal path per carrier.
// The order matches how they appear in the gap list. ───────────────────
const CARRIER_GUIDE: Array<{ carrier: string; brand: string; portal: string }> = [
  { carrier: 'UnitedHealthcare / UHC',      brand: 'UCard: "OTC + healthy food + utilities credit"',      portal: 'uhc.com/medicare → enter ZIP → plan details → UCard section' },
  { carrier: 'Devoted Health',              brand: '"Food & Home Card" (SSBCI section)',                  portal: 'devoted.com → plans → enter ZIP → find plan → benefits detail' },
  { carrier: 'Aetna (CVS Health)',          brand: '"Extra Supports Wallet" / "Extra Benefits Wallet"',   portal: 'aetnamedicare.com/prospective → enter ZIP → plan documents → SB' },
  { carrier: 'Anthem / Wellpoint (Elevance)', brand: '"Everyday Options Allowance" (SSBCI)',              portal: 'shop.anthem.com/medicare → enter ZIP → plan → benefits' },
  { carrier: 'Humana',                      brand: '"Healthy Options Allowance"',                          portal: 'humana.com/medicare → enter ZIP → plan finder → SB PDF' },
  { carrier: 'Wellcare / Centene',          brand: '"Spendables" card — NOTE: usually OTC/DVH only, NOT food. Verify per plan.', portal: 'wellcare.com/medicare → enter ZIP → plan → benefits' },
  { carrier: 'Molina Healthcare',           brand: '"MyChoice" card',                                     portal: 'molinahealthcare.com/medicare → enter ZIP → plan → benefits' },
  { carrier: 'CareSource',                  brand: '"Healthy Benefits+" card',                            portal: 'caresource.com/medicare → enter ZIP → SB PDF' },
  { carrier: 'BCBS / HCSC / Highmark',      brand: 'Check SB PDF — flex-card branding varies by BCBS licensee', portal: 'BCBS licensee sites vary; check licensee for the state' },
  { carrier: 'PruittHealth Premier',        brand: '"Healthy Living Flex Card"',                          portal: 'pruitthealthpremier.com → 2026 plans → SB PDF' },
  { carrier: 'Kaiser Permanente',           brand: 'Standalone MA — often no flex card. Check SB.',       portal: 'kp.org → medicare → SB PDF' },
  { carrier: 'Alignment Healthcare',        brand: '"ACCESS On-Demand" card',                             portal: 'alignmenthealthplan.com → enter ZIP → plan → SB PDF' },
  { carrier: 'SCAN',                        brand: '"Flex Card" — verify food inclusion',                 portal: 'scanhealthplan.com → enter ZIP → plan → SB PDF' },
];

// ─── Types ─────────────────────────────────────────────────────────────
interface PlanRow {
  contract_id: string;
  plan_id: string;
  cp: string;
  state: string;
  carrier: string;
  plan_name: string;
  snp_type: string;
  counties: string[];
  best_row: { source: string; copay: number | null; description: string | null } | null;
  db_status: string;
  sample_zip: string;
  zip_source: string;
}

// ─── Main ──────────────────────────────────────────────────────────────
(async () => {
  console.log('[round2] fetching D-SNP + C-SNP plans in NC/TX/GA…');
  const states = ['NC', 'TX', 'GA'];
  const snpTypes = ['D-SNP', 'C-SNP'];

  // Fetch all (contract, plan, county) rows; dedupe to unique (contract, plan)
  // per state with county list retained.
  const seen = new Map<string, PlanRow>();
  const PAGE = 1000;
  for (let from = 0; from < 100_000; from += PAGE) {
    const { data, error } = await sb
      .from('pm_plans')
      .select('contract_id, plan_id, state, snp_type, carrier, plan_name, county_name')
      .in('state', states)
      .in('snp_type', snpTypes)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data as Array<{ contract_id: string; plan_id: string; state: string; snp_type: string; carrier: string | null; plan_name: string | null; county_name: string | null }>) {
      const cp = `${r.contract_id}-${r.plan_id}`;
      const hit = seen.get(cp);
      if (hit) {
        if (r.county_name && !hit.counties.includes(r.county_name)) hit.counties.push(r.county_name);
      } else {
        seen.set(cp, {
          contract_id: r.contract_id,
          plan_id: r.plan_id,
          cp,
          state: r.state,
          carrier: (r.carrier ?? '').trim() || '—',
          plan_name: (r.plan_name ?? '').trim(),
          snp_type: r.snp_type,
          counties: r.county_name ? [r.county_name] : [],
          best_row: null,
          db_status: '',
          sample_zip: '',
          zip_source: '',
        });
      }
    }
    if (data.length < PAGE) break;
  }
  const allPlans = [...seen.values()];
  console.log(`[round2] ${allPlans.length} unique (contract, plan) SNP plans`);

  // ─── Fetch food_card rows from pbp_benefits_v2 (split-key schema) ────
  console.log('[round2] fetching pbp_benefits_v2 food_card rows…');
  const contracts = [...new Set(allPlans.map((p) => p.contract_id))];
  const planIds = [...new Set(allPlans.map((p) => p.plan_id))];
  const rows: Array<{ contract_id: string; plan_id: string; source: string; copay: number | null; description: string | null }> = [];
  for (let from = 0; from < 100_000; from += PAGE) {
    const { data, error } = await sb
      .from('pbp_benefits_v2')
      .select('contract_id, plan_id, source, copay, description')
      .eq('benefit_type', 'food_card')
      .in('contract_id', contracts)
      .in('plan_id', planIds)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as Array<{ contract_id: string; plan_id: string; source: string; copay: number | null; description: string | null }>));
    if (data.length < PAGE) break;
  }
  console.log(`[round2] ${rows.length} food_card rows fetched`);

  // Pick source-priority winner per (contract, plan)
  const winnerByCp = new Map<string, { source: string; copay: number | null; description: string | null }>();
  const allRowsByCp = new Map<string, Array<{ source: string; copay: number | null; description: string | null }>>();
  for (const r of rows) {
    const cp = `${r.contract_id}-${r.plan_id}`;
    const bucket = allRowsByCp.get(cp) ?? [];
    bucket.push({ source: r.source, copay: r.copay, description: r.description });
    allRowsByCp.set(cp, bucket);
    const prior = winnerByCp.get(cp);
    if (!prior || (SOURCE_RANK[r.source] ?? 0) > (SOURCE_RANK[prior.source] ?? 0)) {
      winnerByCp.set(cp, { source: r.source, copay: r.copay, description: r.description });
    }
  }

  // Apply to plans, classify gap
  for (const p of allPlans) {
    p.best_row = winnerByCp.get(p.cp) ?? null;
    if (!p.best_row) p.db_status = 'NO food_card row → renders "None"';
    else if (typeof p.best_row.copay === 'number' && p.best_row.copay > 1) {
      p.db_status = `[${p.best_row.source}] $${p.best_row.copay}`;
    } else {
      const desc = (p.best_row.description ?? '').slice(0, 60);
      p.db_status = `[${p.best_row.source}] copay=${p.best_row.copay ?? 'null'}${desc ? ' · "' + desc + '"' : ''}`;
    }
  }

  // ─── Gap definition (strict) + exclude round-1 covered ───────────────
  const gap: PlanRow[] = [];
  for (const p of allPlans) {
    if (ROUND1_COVERED.has(p.cp)) continue;
    const winner = p.best_row;
    const isGap = !winner || typeof winner.copay !== 'number' || winner.copay <= 1;
    if (isGap) gap.push(p);
  }
  console.log(`[round2] ${gap.length} gap plans after excluding ${ROUND1_COVERED.size} round-1 IDs`);

  // ─── Resolve sample_zip per plan (top-metro rank; NC uses pm_zip_county) ─
  console.log('[round2] resolving sample zips…');
  for (const p of gap) {
    const stateMap = COUNTY_RANK[p.state] ?? {};
    const distinct = [...new Set(p.counties)].sort((a, b) => (stateMap[a]?.rank ?? 999) - (stateMap[b]?.rank ?? 999));
    const topCounty = distinct[0];
    let zip: string | null = null;
    let source = '';
    if (topCounty) {
      const ranked = stateMap[topCounty];
      if (ranked) {
        zip = ranked.centerZip;
        source = `${topCounty} (rank ${ranked.rank})`;
      } else if (p.state === 'NC') {
        const ncZip = await ncZipForCounty(topCounty);
        if (ncZip) {
          zip = ncZip;
          source = `pm_zip_county lookup for ${topCounty}`;
        }
      }
    }
    if (!zip) {
      zip = STATE_DEFAULT_ZIP[p.state] ?? '';
      source = `state-default (last resort)`;
    }
    p.sample_zip = zip;
    p.zip_source = source;
  }

  // ─── Sort: state → SNP type → carrier → cp ───────────────────────────
  gap.sort((a, b) =>
    a.state.localeCompare(b.state) ||
    a.snp_type.localeCompare(b.snp_type) ||
    a.carrier.localeCompare(b.carrier) ||
    a.cp.localeCompare(b.cp),
  );

  // ─── Summary counts ──────────────────────────────────────────────────
  const byState: Record<string, number> = {};
  const bySnp: Record<string, number> = {};
  const byCarrier: Record<string, number> = {};
  for (const p of gap) {
    byState[p.state] = (byState[p.state] ?? 0) + 1;
    bySnp[p.snp_type] = (bySnp[p.snp_type] ?? 0) + 1;
    byCarrier[p.carrier] = (byCarrier[p.carrier] ?? 0) + 1;
  }
  const topCarriers = Object.entries(byCarrier).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // ─── Ensure output dir ───────────────────────────────────────────────
  const OUT_DIR = resolve(process.cwd(), 'scripts/captures');
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const XLSX_PATH = resolve(OUT_DIR, 'snp-food-card-gap-round2.xlsx');
  const CSV_PATH = resolve(OUT_DIR, 'snp-food-card-gap-round2.csv');

  // ─── XLSX ────────────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = 'planmatch/scripts/gen-snp-food-card-round2';
  wb.created = new Date();
  const ws = wb.addWorksheet('Gap Round 2', {
    views: [{ state: 'frozen', ySplit: 5 }],
  });

  // Column widths
  ws.columns = [
    { key: 'plan_id',   width: 14 },
    { key: 'carrier',   width: 25 },
    { key: 'plan_name', width: 50 },
    { key: 'state',     width: 6 },
    { key: 'snp_type',  width: 8 },
    { key: 'zip',       width: 10 },
    { key: 'amount',    width: 15 },
    { key: 'freq',      width: 12 },
    { key: 'notes',     width: 60 },
    { key: 'who',       width: 30 },
    { key: 'db_status', width: 55 },
  ];

  const YELLOW: ExcelJS.FillPattern = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF59D' } };
  const HEADER_FILL: ExcelJS.FillPattern = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  const SUBHEADER_FILL: ExcelJS.FillPattern = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7EEF7' } };
  const CARRIER_ROW_FILL: ExcelJS.FillPattern = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F3F3' } };
  const GUIDE_FILL: ExcelJS.FillPattern = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9C4' } };

  // Title rows
  const r1 = ws.addRow(['D-SNP + C-SNP FOOD CARD CAPTURE — ROUND 2']);
  ws.mergeCells('A1:K1');
  r1.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  r1.fill = HEADER_FILL;
  r1.alignment = { vertical: 'middle', horizontal: 'left' };
  r1.height = 26;

  const r2 = ws.addRow(['Fill in yellow columns: Food Card $/mo (no $ sign) • Frequency (monthly/quarterly/annual) • Notes']);
  ws.mergeCells('A2:K2');
  r2.font = { italic: true, color: { argb: 'FF444444' } };
  r2.fill = SUBHEADER_FILL;

  const r3 = ws.addRow([
    `${gap.length} plans remaining • ` +
    `GA: ${byState['GA'] ?? 0} • NC: ${byState['NC'] ?? 0} • TX: ${byState['TX'] ?? 0} • ` +
    `D-SNP: ${bySnp['D-SNP'] ?? 0} • C-SNP: ${bySnp['C-SNP'] ?? 0} • ` +
    `Round 1 covered ${ROUND1_COVERED.size} plans`,
  ]);
  ws.mergeCells('A3:K3');
  r3.font = { size: 10, color: { argb: 'FF555555' } };
  r3.fill = SUBHEADER_FILL;

  ws.addRow([]); // row 4 blank

  // Column headers (row 5)
  const headerRow = ws.addRow([
    'Plan ID', 'Carrier', 'Plan Name', 'State', 'SNP Type', 'Sample ZIP',
    'Food Card $/mo', 'Frequency', 'Notes', 'Food in Card (who qualifies)',
    'Current DB Status',
  ]);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  headerRow.height = 28;
  for (let c = 1; c <= 11; c += 1) {
    const cell = headerRow.getCell(c);
    cell.fill = HEADER_FILL;
    cell.border = { bottom: { style: 'medium', color: { argb: 'FF000000' } } };
  }

  // ─── Data rows grouped by state → carrier ────────────────────────────
  let currentState = '';
  let currentCarrier = '';
  const carrierCounts = new Map<string, number>();
  for (const p of gap) {
    const key = `${p.state}|${p.carrier}`;
    carrierCounts.set(key, (carrierCounts.get(key) ?? 0) + 1);
  }

  const HEADER_ROW_INDEX = headerRow.number;

  for (const p of gap) {
    if (p.state !== currentState) {
      // Emit a state banner row
      const stateRow = ws.addRow([`${p.state}  (${byState[p.state] ?? 0} plans)`]);
      ws.mergeCells(`A${stateRow.number}:K${stateRow.number}`);
      stateRow.font = { bold: true, size: 12, color: { argb: 'FF1F4E79' } };
      stateRow.fill = SUBHEADER_FILL;
      stateRow.height = 22;
      currentState = p.state;
      currentCarrier = '';
    }
    if (p.carrier !== currentCarrier) {
      const count = carrierCounts.get(`${p.state}|${p.carrier}`) ?? 0;
      const carrierRow = ws.addRow([`    ${p.carrier}  (${count})`]);
      ws.mergeCells(`A${carrierRow.number}:K${carrierRow.number}`);
      carrierRow.font = { bold: true, italic: true, color: { argb: 'FF444444' } };
      carrierRow.fill = CARRIER_ROW_FILL;
      currentCarrier = p.carrier;
    }
    const row = ws.addRow([
      p.cp, p.carrier, p.plan_name, p.state, p.snp_type, p.sample_zip,
      '', '', '', '',        // capture columns to fill
      p.db_status,
    ]);
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(9).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(11).alignment = { wrapText: true, vertical: 'top' };
    // Yellow-fill G, H, I, J
    for (const c of [7, 8, 9, 10]) row.getCell(c).fill = YELLOW;
    row.getCell(11).font = { size: 10, color: { argb: 'FF666666' } };
  }

  // ─── Auto-filter on the header row (columns A..K) ────────────────────
  ws.autoFilter = {
    from: { row: HEADER_ROW_INDEX, column: 1 },
    to: { row: HEADER_ROW_INDEX, column: 11 },
  };

  // ─── Carrier Lookup Guide ────────────────────────────────────────────
  ws.addRow([]);
  const guideTitle = ws.addRow(['CARRIER LOOKUP GUIDE — where to find each carrier\'s food-card dollar amount']);
  ws.mergeCells(`A${guideTitle.number}:K${guideTitle.number}`);
  guideTitle.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
  guideTitle.fill = HEADER_FILL;
  guideTitle.height = 22;

  const guideHeader = ws.addRow(['Carrier', 'Benefit label to search for', '', '', '', '', '', '', 'Portal / URL', '', '']);
  guideHeader.font = { bold: true };
  ws.mergeCells(`B${guideHeader.number}:H${guideHeader.number}`);
  ws.mergeCells(`I${guideHeader.number}:K${guideHeader.number}`);
  guideHeader.getCell(1).fill = GUIDE_FILL;
  guideHeader.getCell(2).fill = GUIDE_FILL;
  guideHeader.getCell(9).fill = GUIDE_FILL;

  for (const g of CARRIER_GUIDE) {
    const gr = ws.addRow([g.carrier, g.brand, '', '', '', '', '', '', g.portal, '', '']);
    ws.mergeCells(`B${gr.number}:H${gr.number}`);
    ws.mergeCells(`I${gr.number}:K${gr.number}`);
    gr.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    gr.getCell(9).alignment = { wrapText: true, vertical: 'top' };
  }

  await wb.xlsx.writeFile(XLSX_PATH);
  console.log(`[round2] wrote ${XLSX_PATH}`);

  // ─── CSV (flat, no formatting) ───────────────────────────────────────
  function csvEscape(s: string): string {
    if (s == null) return '';
    const str = String(s);
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  }
  const csvLines: string[] = [
    'plan_id,carrier,plan_name,state,snp_type,sample_zip,food_card_amount,frequency,notes,who_qualifies,current_db_status',
  ];
  for (const p of gap) {
    csvLines.push([
      csvEscape(p.cp),
      csvEscape(p.carrier),
      csvEscape(p.plan_name),
      csvEscape(p.state),
      csvEscape(p.snp_type),
      csvEscape(p.sample_zip),
      '', '', '', '',
      csvEscape(p.db_status),
    ].join(','));
  }
  writeFileSync(CSV_PATH, csvLines.join('\n') + '\n');
  console.log(`[round2] wrote ${CSV_PATH}`);

  // ─── Print summary ───────────────────────────────────────────────────
  console.log('\n============ SUMMARY ============');
  console.log(`Total gap plans:    ${gap.length}`);
  console.log(`By state:           GA=${byState['GA'] ?? 0}  NC=${byState['NC'] ?? 0}  TX=${byState['TX'] ?? 0}`);
  console.log(`By SNP type:        D-SNP=${bySnp['D-SNP'] ?? 0}  C-SNP=${bySnp['C-SNP'] ?? 0}`);
  console.log(`Round 1 excluded:   ${ROUND1_COVERED.size}`);
  console.log('\nTop carriers by gap count:');
  for (const [name, n] of topCarriers) console.log(`  ${String(n).padStart(3)}  ${name}`);
})().catch((e) => { console.error(e); process.exit(1); });
