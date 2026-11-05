// Snap Link pills a day for two-step titration labels.
// Run: npx tsx --test scripts/tests/snap-refill-titration.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pillsPerDay, daysSupply, titrationRate } from '../../api/_lib/snapRefill';

const GABA = 'Take one capsule by mouth two times a day for 14 days then increase to 1 capsule 3 times a day';

test('Autumn Montgomery gabapentin titration → 3 a day, 94-day supply', () => {
  assert.equal(titrationRate(GABA), 3);
  assert.equal(pillsPerDay({ instructions: GABA, quantity: 270, form: 'capsule' }), 3);
  assert.equal(daysSupply({ instructions: GABA, quantity: 270, form: 'capsule' }), 94);
});

test('steady labels unchanged; open-ended tapers stay blank', () => {
  assert.equal(pillsPerDay({ instructions: 'TAKE 2 TABLETS BY MOUTH TWICE DAILY', quantity: 120, form: 'tablet' }), 4);
  assert.equal(pillsPerDay({ instructions: 'Take 1 tablet daily for 7 days then decrease to 1/2 tablet daily', quantity: 30, form: 'tablet' }), null);
  assert.equal(pillsPerDay({ instructions: 'Take 1 tablet every 6 hours as needed', quantity: 30, form: 'tablet' }), null);
});
