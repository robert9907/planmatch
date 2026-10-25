import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMeaningfulCopayStructure } from '../../src/lib/plan-brain-utils.js';

// Mirror of robert9907/plan-match's cp10-cheap-generic-copay guard. A cheap
// tier-1 generic's cache row reports initial_cost ≈ full_cost (≈ its own $5
// price, scraped standalone); that is NOT a filed plan copay, so the override
// must not fire — the plan's filed $0 tier-1 copay wins. A real brand flat
// copay (Xarelto $45 vs $636) is materially below full_cost and DOES override.

test('cheap generic whose phase cost ≈ full price is NOT a copay structure', () => {
  assert.equal(isMeaningfulCopayStructure(5.0, 5.04), false);
});

test('brand flat copay well below the negotiated price IS a copay structure', () => {
  assert.equal(isMeaningfulCopayStructure(45, 636.99), true);
  assert.equal(isMeaningfulCopayStructure(23.22, 136.61), true);
});

test('null full_cost keeps legacy behavior', () => {
  assert.equal(isMeaningfulCopayStructure(5, null), true);
});
