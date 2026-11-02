// scripts/tests/bench-dsnp-population-filter.test.ts
//
// The auto-applied D-SNP population chip (e.g. "D-SNP:pop:QMB" for a QMB
// client) must not hide D-SNPs whose accepted populations are not on file.
// Regression: Juddith Eddins (Tarrant TX, QMB) — every 2027 Wellpoint
// D-SNP (H8849-021, H8849-024, H8849-025) was filtered off the bench and
// the board because their 2027 plan IDs had no population row, while the
// Carrier dropdown still counted them. Nov 2 2026.
//
//   npx tsx --test scripts/tests/bench-dsnp-population-filter.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passesSnpFilter } from '../../src/agent-v3/hooks/benchSnpFilter.js';

const qmbChip = new Set(['D-SNP:pop:QMB']);

const dsnp = (pops: string[] | null) => ({
  snpType: 'D-SNP',
  dsnpAcceptedPopulations: pops,
  dsnpPopulationsSource: (pops ? 'manual' : 'none') as 'manual' | 'none',
  dsnpIntegration: null,
  csnpCondition: null,
  isVa: false,
});

test('no SNP chip selected: every plan passes', () => {
  assert.equal(passesSnpFilter(dsnp(null), new Set()), true);
});

test('D-SNP that accepts QMB passes the QMB chip', () => {
  assert.equal(passesSnpFilter(dsnp(['QMB', 'FBDE']), qmbChip), true);
});

test('D-SNP that files populations excluding QMB is still hidden', () => {
  assert.equal(passesSnpFilter(dsnp(['SLMB', 'QI', 'QDWI']), qmbChip), false);
});

test('D-SNP with no populations on file passes (unknown is not "excluded")', () => {
  assert.equal(passesSnpFilter(dsnp(null), qmbChip), true);
});

test('non-D-SNP plans still fail a D-SNP population chip', () => {
  const mapd = { ...dsnp(null), snpType: null };
  assert.equal(passesSnpFilter(mapd, qmbChip), false);
});
