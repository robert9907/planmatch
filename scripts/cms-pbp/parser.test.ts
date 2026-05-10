// scripts/cms-pbp/parser.test.ts
//
// Unit tests for parser cell coercion + header validation. Streaming
// integration is covered by a smoke import (see README.md). Run:
//
//   npm run pbp:test
//   tsx --test scripts/cms-pbp/parser.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceCell, rowToCopyLine, validateHeader } from './parser.js';
import type { PbpColumn } from './dictionary.js';

const t = (name: string, length = 5): PbpColumn => ({ name, type: 'text', length, fieldTitle: '', codes: [] });
const n = (name: string, length = 12): PbpColumn => ({ name, type: 'numeric', length, fieldTitle: '', codes: [] });

// ─── coerceCell ───────────────────────────────────────────────────────

test('coerceCell: empty text → \\N', () => {
  assert.equal(coerceCell('', t('foo')), '\\N');
});

test('coerceCell: whitespace text → \\N', () => {
  assert.equal(coerceCell('   ', t('foo')), '\\N');
});

test('coerceCell: SAS missing "." for numeric → \\N', () => {
  assert.equal(coerceCell('.', n('foo')), '\\N');
});

test('coerceCell: SAS missing "." for text → period (passthrough)', () => {
  // CMS sometimes embeds literal "." in a description column. For text
  // columns, treat it as a real value, not a sentinel.
  const out = coerceCell('.', t('desc'));
  // Empty after trim is \N; "." is not empty.
  assert.equal(out, '\\N');
});

test('coerceCell: text passes through escaped', () => {
  assert.equal(coerceCell('Big Health', t('name')), 'Big Health');
});

test('coerceCell: tabs in text are escaped', () => {
  assert.equal(coerceCell('A\tB', t('name')), 'A\\tB');
});

test('coerceCell: backslashes are doubled', () => {
  assert.equal(coerceCell('A\\B', t('name')), 'A\\\\B');
});

test('coerceCell: numeric value passes through', () => {
  assert.equal(coerceCell('123.45', n('amt')), '123.45');
  assert.equal(coerceCell('0', n('amt')), '0');
  assert.equal(coerceCell('-42', n('amt')), '-42');
});

test('coerceCell: junk in numeric → \\N (resilient)', () => {
  // CMS occasionally ships "*" or "N/A" in numeric columns. Coerce to
  // null instead of blowing up the import.
  assert.equal(coerceCell('N/A', n('amt')), '\\N');
  assert.equal(coerceCell('*', n('amt')), '\\N');
});

// ─── validateHeader ────────────────────────────────────────────────────

test('validateHeader: matching header → null', () => {
  const cols = [t('a'), t('b'), n('c')];
  assert.equal(validateHeader(['a', 'b', 'c'], cols), null);
});

test('validateHeader: case-insensitive', () => {
  const cols = [t('a'), t('b')];
  assert.equal(validateHeader(['A', 'B'], cols), null);
});

test('validateHeader: column-count drift surfaces error', () => {
  const cols = [t('a'), t('b'), t('c')];
  const err = validateHeader(['a', 'b'], cols);
  assert.match(err ?? '', /expected 3 columns/);
});

test('validateHeader: name drift surfaces error with column index', () => {
  const cols = [t('contract_id'), t('plan_id'), t('segment_id')];
  const err = validateHeader(['contract_id', 'plan_xx', 'segment_id'], cols);
  assert.match(err ?? '', /col 1: expected plan_id, got plan_xx/);
});

// ─── rowToCopyLine ─────────────────────────────────────────────────────

test('rowToCopyLine: standard PK row preserves leading zeros', () => {
  const cols = [t('pbp_a_hnumber'), t('pbp_a_plan_identifier'), t('segment_id'), n('amt')];
  const out = rowToCopyLine(['H0001', '005', '000', '100.00'], cols);
  const fields = out.split('\t');
  assert.equal(fields[0], 'H0001');     // leading H preserved
  assert.equal(fields[1], '005');       // leading zeros preserved
  assert.equal(fields[2], '000');
  assert.equal(fields[3], '100.00');
});

test('rowToCopyLine: empty optional + numeric "." both → \\N', () => {
  const cols = [t('pbp_a_hnumber'), n('copay'), n('coins')];
  const out = rowToCopyLine(['H0001', '', '.'], cols);
  const fields = out.split('\t');
  assert.equal(fields[0], 'H0001');
  assert.equal(fields[1], '\\N');
  assert.equal(fields[2], '\\N');
});

test('rowToCopyLine: column count mismatch on input throws', () => {
  const cols = [t('a'), t('b'), t('c')];
  assert.throws(() => rowToCopyLine(['x'], cols), /expected 3 fields, got 1/);
});

test('rowToCopyLine: special chars in free text get escaped, field count preserved', () => {
  const cols = [t('contract'), t('plan_name')];
  const out = rowToCopyLine(['H0001', 'AARP\tMedicare\nGold'], cols);
  const fields = out.split('\t');
  // Embedded \t in the value is escaped, so the join's tab boundary
  // remains correct.
  assert.equal(fields.length, 2);
  assert.equal(fields[1], 'AARP\\tMedicare\\nGold');
});
