// scripts/tests/cost-share-zero.test.ts
//
// A filed ZERO cost-share is a real, quotable value — a $0 PCP/specialist
// is a selling point, not "unknown". Two shapes reach the formatters:
//   • copay = 0            → already rendered "$0"
//   • coinsurance = 0, copay = null  → the member pays 0% = $0, but this
//     was rendering "0% coinsurance", which reads as a cost, not the $0
//     selling point. CMS files a $0 PCP either way depending on carrier;
//     both must surface as "$0".
//
// Guard: a genuine RANGE whose low end is 0 (e.g. "0%–20%") is NOT a flat
// zero and must keep rendering as the range, never collapse to "$0".
//
//   npx tsx --test scripts/tests/cost-share-zero.test.ts
//   (run via TSX_TSCONFIG_PATH=./tsconfig.scripts.json so @/ resolves)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCostShare, formatCostShareWithRange } from '../../src/agent-v3/planDisplay.js';

test('formatCostShare: filed $0 copay renders $0', () => {
  assert.equal(formatCostShare({ copay: 0, coinsurance: null }), '$0');
});

test('formatCostShare: filed 0% coinsurance (no copay) renders $0, not 0%', () => {
  assert.equal(formatCostShare({ copay: null, coinsurance: 0 }), '$0');
});

test('formatCostShare: 0% coinsurance beats description fallback', () => {
  assert.equal(
    formatCostShare({ copay: null, coinsurance: 0, description: 'In-network PCP · 0% coinsurance' }),
    '$0',
  );
});

test('formatCostShare: real coinsurance still renders percent', () => {
  assert.equal(formatCostShare({ copay: null, coinsurance: 20 }), '20%');
});

test('formatCostShare: both null, no description → em-dash', () => {
  assert.equal(formatCostShare({ copay: null, coinsurance: null }), '—');
});

test('formatCostShareWithRange: filed $0 copay renders $0', () => {
  assert.equal(
    formatCostShareWithRange({ copay: 0, coinsurance: null, description: null }),
    '$0',
  );
});

test('formatCostShareWithRange: flat 0% coinsurance renders $0', () => {
  assert.equal(
    formatCostShareWithRange({
      copay: null, coinsurance: 0, description: null,
      coinsurance_low: 0, coinsurance_high: 0,
    }),
    '$0',
  );
});

test('formatCostShareWithRange: 0%–20% RANGE stays a range (not $0)', () => {
  assert.equal(
    formatCostShareWithRange({
      copay: null, coinsurance: 0, description: null,
      coinsurance_low: 0, coinsurance_high: 20,
    }),
    '0%–20%',
  );
});

test('formatCostShareWithRange: $0–$50 copay RANGE stays a range (not $0)', () => {
  assert.equal(
    formatCostShareWithRange({
      copay: 0, coinsurance: null, description: null,
      copay_low: 0, copay_high: 50,
    }),
    '$0–$50',
  );
});
