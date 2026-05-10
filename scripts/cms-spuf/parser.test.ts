// scripts/cms-spuf/parser.test.ts
//
// Unit tests for the parser's per-row coercion and header validation.
// Streaming integration is covered separately by a smoke import (see
// scripts/cms-spuf/README.md). Run:
//
//   npm run formulary:test
//   tsx --test scripts/cms-spuf/parser.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rowToCopyLine,
  validateHeader,
} from './parser.js';
import {
  PLAN_INFORMATION,
  BASIC_DRUGS,
  BENEFICIARY_COST,
  PHARMACY_NETWORK,
  EXCLUDED_DRUGS,
  INSULIN_BENEFICIARY_COST,
  type CmsFileSpec,
} from './schema.js';

// ─── Header validation ────────────────────────────────────────────────

test('validateHeader: accepts canonical CMS header for plan_information', () => {
  const hdr = PLAN_INFORMATION.columns.map((c) => c.cms);
  assert.doesNotThrow(() => validateHeader(hdr, PLAN_INFORMATION));
});

test('validateHeader: case-insensitive match', () => {
  const hdr = PLAN_INFORMATION.columns.map((c) => c.cms.toLowerCase());
  assert.doesNotThrow(() => validateHeader(hdr, PLAN_INFORMATION));
});

test('validateHeader: rejects column-count drift', () => {
  const hdr = PLAN_INFORMATION.columns.slice(0, -1).map((c) => c.cms);
  assert.throws(() => validateHeader(hdr, PLAN_INFORMATION), /expected 14 columns/);
});

test('validateHeader: rejects renamed column', () => {
  const hdr = PLAN_INFORMATION.columns.map((c, i) => (i === 5 ? 'FORMULARYID' : c.cms));
  assert.throws(() => validateHeader(hdr, PLAN_INFORMATION), /header mismatch/);
});

test('validateHeader: catches the PRIOR_AUTH_YN vs PRIOR_AUTHORIZATION_YN gotcha', () => {
  // basic_drugs uses PRIOR_AUTHORIZATION_YN; excluded_drugs uses
  // PRIOR_AUTH_YN. Swapping them must fail.
  const hdrFromExcluded = EXCLUDED_DRUGS.columns.map((c) => c.cms);
  assert.throws(() => validateHeader(hdrFromExcluded, BASIC_DRUGS), /header mismatch|expected/);
});

// ─── Row coercion ─────────────────────────────────────────────────────

function lineOf(spec: CmsFileSpec, values: string[]): string {
  return rowToCopyLine(values, spec, 1);
}

test('rowToCopyLine: plan_information happy path', () => {
  const out = lineOf(PLAN_INFORMATION, [
    'H1234',                                  // CONTRACT_ID
    '005',                                    // PLAN_ID
    '000',                                    // SEGMENT_ID
    'Big Health Co',                          // CONTRACT_NAME
    'BlueValue HMO',                          // PLAN_NAME
    'F12345',                                 // FORMULARY_ID
    '0.00',                                   // PREMIUM
    '590.00',                                 // DEDUCTIBLE
    // ICL removed in 2025+
    '',                                       // MA_REGION_CODE
    '',                                       // PDP_REGION_CODE
    'NC',                                     // STATE
    '37001',                                  // COUNTY_CODE
    '0',                                      // SNP
    'N',                                      // PLAN_SUPPRESSED_YN
  ]);
  const fields = out.split('\t');
  assert.equal(fields.length, PLAN_INFORMATION.columns.length);
  assert.equal(fields[0], 'H1234');
  assert.equal(fields[6], '0.00');
  assert.equal(fields[8], '\\N');             // empty optional MA_REGION_CODE → null
  assert.equal(fields[9], '\\N');             // empty optional PDP_REGION_CODE → null
  assert.equal(fields[10], 'NC');
});

test('rowToCopyLine: empty optional numeric → null', () => {
  const out = lineOf(BENEFICIARY_COST, [
    'H1234', '005', '000',                    // ids
    '1',                                      // COVERAGE_LEVEL
    '3',                                      // TIER
    '1',                                      // DAYS_SUPPLY
    '1',                                      // COST_TYPE_PREF
    '47.00',                                  // COST_AMT_PREF
    '',                                       // COST_MIN_AMT_PREF (text, optional)
    '',                                       // COST_MAX_AMT_PREF
    '0',                                      // COST_TYPE_NONPREF
    '', '', '',                               // nonpref amts
    '0', '', '', '',                          // mail_pref
    '0', '', '', '',                          // mail_nonpref
    'N',                                      // TIER_SPECIALTY_YN
    'Y',                                      // DED_APPLIES_YN
    // GAP_COV_TIER removed post-IRA
  ]);
  const fields = out.split('\t');
  assert.equal(fields.length, BENEFICIARY_COST.columns.length);
  assert.equal(fields[7], '47.00');           // cost_amt_pref present
  assert.equal(fields[8], '\\N');             // cost_min_amt_pref empty → null
  assert.equal(fields[9], '\\N');
});

test('rowToCopyLine: rejects non-integer in smallint column', () => {
  // basic_drugs TIER_LEVEL_VALUE is smallint NOT NULL.
  const values = [
    'F12345', 'V01', '2026', '105028', '12345678901',
    'three',       // ← bad TIER_LEVEL_VALUE
    'N', '', '', 'N', 'N', '',
  ];
  assert.throws(() => lineOf(BASIC_DRUGS, values), /not an integer/);
});

test('rowToCopyLine: rejects non-numeric in numeric column', () => {
  const full = [
    'H1234', '005', '000', 'Big Health', 'BlueValue', 'F00001',
    '0.00',
    'free',                                   // ← DEDUCTIBLE bad
    '', '', 'NC', '37001', '0', 'N',
  ];
  assert.throws(() => lineOf(PLAN_INFORMATION, full), /not numeric/);
});

test('rowToCopyLine: escapes special chars in text', () => {
  const out = lineOf(PLAN_INFORMATION, [
    'H1234', '005', '000',
    'Big\tHealth\\Co\nNewline', 'Plan with\rCR',
    'F00001', '0.00', '590.99',
    '', '', 'NC', '37001', '0', 'N',
  ]);
  const fields = out.split('\t');
  // Tab/newline/CR/backslash inside a value must be escaped so the
  // field count stays correct after the join.
  assert.equal(fields.length, PLAN_INFORMATION.columns.length);
  assert.equal(fields[3], 'Big\\tHealth\\\\Co\\nNewline');
  assert.equal(fields[4], 'Plan with\\rCR');
});

test('rowToCopyLine: pharmacy_number leading-zero NPI preserved', () => {
  const out = lineOf(PHARMACY_NETWORK, [
    'H1234', '005', '000',
    '101234567890',                           // PHARMACY_NUMBER (12 chars)
    '27713',
    'Y', 'N', 'Y', 'N',
    '1',
    '', '', '', '', '', '',
  ]);
  const fields = out.split('\t');
  assert.equal(fields[3], '101234567890');   // verbatim, leading zeros kept
});

test('rowToCopyLine: column count mismatch on input throws', () => {
  assert.throws(
    () => lineOf(BASIC_DRUGS, ['F1', 'V01', '2026']),
    /expected 12 fields, got 3/,
  );
});

test('rowToCopyLine: SAS missing-numeric sentinel "." → NULL', () => {
  // CMS ships "." for missing numeric fields (SAS convention) — e.g.
  // insulin_beneficiary_cost TIER for plans with no tiered insulin benefit.
  const out = lineOf(INSULIN_BENEFICIARY_COST, [
    'H1234', '005', '000',
    '.',                                      // TIER as SAS missing
    '1',                                      // DAYS_SUPPLY
    '35.00', '35.00', '35.00', '35.00',
    '', '', '', '',
  ]);
  const fields = out.split('\t');
  assert.equal(fields[3], '\\N');
});

test('rowToCopyLine: insulin tier may be empty (defined-standard plans)', () => {
  const out = lineOf(INSULIN_BENEFICIARY_COST, [
    'H1234', '005', '000',
    '',                                       // TIER empty (defined-standard)
    '1',                                      // DAYS_SUPPLY
    '35.00', '35.00', '35.00', '35.00',       // 4 copay variants
    '', '', '', '',                            // 4 coinsurance variants (post-IRA)
  ]);
  const fields = out.split('\t');
  assert.equal(fields.length, INSULIN_BENEFICIARY_COST.columns.length);
  assert.equal(fields[3], '\\N');
});
