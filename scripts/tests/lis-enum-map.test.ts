// Regression: the medicare.gov /drugs/cost LIS enum map must match the
// consumer's empirically-pinned per-drug-copay mapping (verified 2026-10-26,
// Eliquis tier-3 brand on H5302-022, real in-network chain NPI, 2027):
//   LIS_LEVEL_2  → $5.00 brand  = full LIS ≤100% FPL / FBDE community (full_low)
//   LIS_LEVEL_1A → $14.40       = full LIS higher-FPL                 (full_high)
//   LIS_LEVEL_3  → $0           = institutional                      (full_institutional)
//   LIS_NO_HELP  → non-LIS                                           (none)
// The prior agent map had full_institutional→1A and full_high→3 (backwards),
// an inference from a 2026-07-22 premium-only PDP probe. Sending the wrong
// level made the agent's own /drugs/cost queries return the wrong LIS copays.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIS_ENUM_MAP } from '../../src/lib/drugCosts';

test('LIS enum map matches the pinned consumer mapping', () => {
  assert.equal(LIS_ENUM_MAP.none, 'LIS_NO_HELP');
  assert.equal(LIS_ENUM_MAP.full_low, 'LIS_LEVEL_2');        // $5 brand, ≤100% FPL
  assert.equal(LIS_ENUM_MAP.full_high, 'LIS_LEVEL_1A');      // $14.40, higher-FPL
  assert.equal(LIS_ENUM_MAP.full_institutional, 'LIS_LEVEL_3'); // $0, institutional
});

test('full_high no longer maps to the $0 institutional level', () => {
  // The old bug sent full_high → LIS_LEVEL_3 ($0), zeroing a member who
  // actually pays the $14.40 brand copay.
  assert.notEqual(LIS_ENUM_MAP.full_high, 'LIS_LEVEL_3');
  assert.notEqual(LIS_ENUM_MAP.full_institutional, 'LIS_LEVEL_1A');
});
