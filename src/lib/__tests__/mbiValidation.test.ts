// Test-vector table for the MBI validator — agent-app copy.
//
// This table MUST match the one in:
//   • ~/Code/plan-match/apps/web/src/lib/__tests__/mbiValidation.test.ts
//   • ~/Code/plan-match/api/_lib/mbi.ts (source; no dedicated test file)
// Anyone editing the regex in one repo must update all vector tables
// and see all test suites still pass.
//
// All MBI values here are synthetic — never commit a real MBI.

import { describe, expect, it } from 'vitest';
import { isValidMbi, maskMbi, normalizeMbi } from '../mbiValidation';

// Canonical vector table from the Phase 1 spec.
// [input, expected isValidMbi, note]
const VECTORS: Array<[unknown, boolean, string]> = [
  ['1EG4TE5MK73',    true,  'baseline valid'],
  ['1U04U67UU12',    true,  'REGRESSION: U must be legal in alpha positions'],
  ['1EG4-TE5-MK73',  true,  'dashes stripped'],
  ['1eg4te5mk73',    true,  'lowercase uppercased'],
  [' 1EG4TE5MK73 ',  true,  'surrounding whitespace stripped'],
  ['1SG4TE5MK73',    false, 'S at C2 forbidden'],
  ['1EG4TE5MK7O',    false, 'O at C11 (also non-numeric — either reason rejects)'],
  ['0EG4TE5MK73',    false, 'leading zero at C1'],
  ['1EG4TE5MK7',     false, '10 chars — too short'],
  ['123456789A',     false, 'legacy HICN shape'],
  ['',               false, 'empty string'],
  [null,             false, 'null input'],
  [undefined,        false, 'undefined input'],
];

describe('isValidMbi — canonical vector table', () => {
  it.each(VECTORS)('%p → %p (%s)', (input, expected) => {
    expect(isValidMbi(input)).toBe(expected);
  });
});

describe('normalizeMbi', () => {
  it('strips non-alphanumeric and uppercases', () => {
    expect(normalizeMbi('1EG4-TE5-MK73')).toBe('1EG4TE5MK73');
    expect(normalizeMbi('1eg4 te5 mk73')).toBe('1EG4TE5MK73');
    expect(normalizeMbi('  1eg4te5mk73  ')).toBe('1EG4TE5MK73');
  });

  it('returns null for empty / non-string / whitespace-only', () => {
    expect(normalizeMbi('')).toBeNull();
    expect(normalizeMbi('   ')).toBeNull();
    expect(normalizeMbi('---')).toBeNull();
    expect(normalizeMbi(null)).toBeNull();
    expect(normalizeMbi(undefined)).toBeNull();
    expect(normalizeMbi(42)).toBeNull();
    expect(normalizeMbi({})).toBeNull();
  });
});

describe('maskMbi', () => {
  it('returns eight bullets + last 2 chars for a valid MBI', () => {
    expect(maskMbi('1EG4TE5MK73')).toBe('••••••••73');
  });

  it('normalizes before masking', () => {
    expect(maskMbi('1eg4-te5-mk73')).toBe('••••••••73');
  });

  it('returns empty string for null / undefined / empty', () => {
    expect(maskMbi(null)).toBe('');
    expect(maskMbi(undefined)).toBe('');
    expect(maskMbi('')).toBe('');
  });

  it('handles short inputs without crashing', () => {
    expect(maskMbi('A')).toBe('••••••••');
  });
});
