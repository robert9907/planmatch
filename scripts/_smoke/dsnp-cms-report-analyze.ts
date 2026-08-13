// Analyze CMS SNP Comprehensive Report — no writes.
import * as XLSX from 'xlsx';
import { readFileSync } from 'node:fs';

const XLSX_PATH = '/tmp/snp-2026-07/SNP_2026_07/SNP_2026_07.xlsx';

const wb = XLSX.read(readFileSync(XLSX_PATH), { type: 'buffer' });
console.log('Sheets in SNP_2026_07.xlsx:');
for (const s of wb.SheetNames) console.log(`  - ${s}`);

const ws = wb.Sheets['SNP_REPORT_PART_17'];
if (!ws) { console.error('SNP_REPORT_PART_17 missing'); process.exit(1); }
const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);
console.log(`\nSNP_REPORT_PART_17: ${rows.length} rows`);
if (rows[0]) console.log('  columns:', Object.keys(rows[0]).map(c => JSON.stringify(c)).join(', '));

// Distinct values in dual-related columns
const dualCols = Object.keys(rows[0] ?? {}).filter(c => /dual|special|integration/i.test(c));
console.log('\nDual/integration-related columns:', dualCols);

for (const col of dualCols) {
  const dist = new Map<string, number>();
  for (const r of rows) {
    const v = String(r[col] ?? '(null)').trim();
    dist.set(v, (dist.get(v) ?? 0) + 1);
  }
  console.log(`\n  Column: ${JSON.stringify(col)}`);
  for (const [v, n] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${JSON.stringify(v).padEnd(30)} n=${n}`);
  }
}

// Raw rows for ground-truth plans
console.log('\n═══ Raw CMS row for H1036-307, H5525-072, H4073-003 ═══');
const targets = [['H1036','307'], ['H5525','072'], ['H4073','003'], ['H5296','004'], ['H5253','041']];
for (const [c, p] of targets) {
  const matches = rows.filter(r => String(r['Contract Number']).trim() === c && String(r['Plan ID']).trim().padStart(3,'0') === p);
  console.log(`\n  ${c}-${p}: ${matches.length} rows`);
  for (const r of matches.slice(0, 3)) {
    // Only show dual-relevant + identifying cols
    const summary: Record<string, unknown> = {};
    for (const k of ['Contract Number', 'Plan ID', 'SEGMENT_ID', 'State(s)', 'Special Needs Plan Type', 'Integration Status', 'Partial Dual', 'DSNP Only Contract']) {
      if (k in r) summary[k] = r[k];
    }
    console.log('    ', JSON.stringify(summary));
  }
}

// Also: get distinct Special Needs Plan Type
const snpTypeDist = new Map<string, number>();
for (const r of rows) {
  const v = String(r['Special Needs Plan Type'] ?? '(null)').trim();
  snpTypeDist.set(v, (snpTypeDist.get(v) ?? 0) + 1);
}
console.log('\n  Special Needs Plan Type distribution:');
for (const [v, n] of snpTypeDist.entries()) console.log(`    ${JSON.stringify(v)}: ${n}`);

// Only look at D-SNP for Partial Dual dist
console.log('\n═══ D-SNP-only: Partial Dual x Integration Status cross-tab ═══');
const dsnp = rows.filter(r => String(r['Special Needs Plan Type'] ?? '').trim() === 'Dual-Eligible');
console.log(`  Total D-SNP rows: ${dsnp.length}`);
const cross = new Map<string, number>();
for (const r of dsnp) {
  const pd = String(r['Partial Dual'] ?? '(null)').trim();
  const int = String(r['Integration Status'] ?? '(null)').trim();
  const k = `${pd} | ${int}`;
  cross.set(k, (cross.get(k) ?? 0) + 1);
}
for (const [k, n] of [...cross.entries()].sort((a,b) => b[1] - a[1])) console.log(`    ${k}: ${n}`);
