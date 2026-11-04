// Snap Link PILLS/DAY (Rob, 2026-11-04): bottle-scanned meds landed in
// AgentBase with a blank pills-per-day. Label wording is from a real scan
// (Johnnie Wiggins's bottles).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pillsPerDay, unitsPerDay } from '../../api/_lib/snapRefill';

test('label directions give pills per day', () => {
  assert.equal(pillsPerDay({ instructions: 'TAKE 1 TABLET BY MOUTH ONCE DAILY', form: 'tablet', quantity: 90 }), 1);
  assert.equal(pillsPerDay({ instructions: 'TAKE 1 TABLET BY MOUTH NIGHTLY', form: 'tablet', quantity: 90 }), 1);
  assert.equal(pillsPerDay({ instructions: 'Take 2 tablets by mouth once with evening meals', form: 'tablet', quantity: 180 }), 2);
  assert.equal(pillsPerDay({ instructions: 'Take 1 tablet twice daily', form: 'tablet', quantity: 60 }), 2);
});

test('unclear directions fall back to printed quantity ÷ days supply, clean numbers only', () => {
  assert.equal(pillsPerDay({ instructions: 'TAKE 1 TABLET BY MOUTH', form: 'tablet', quantity: 90, printedDaysSupply: 90 }), 1);
  assert.equal(pillsPerDay({ instructions: 'TAKE 1 TABLET', form: 'tablet', quantity: 90, printedDaysSupply: 45 }), 2);
  // 100 ÷ 90 isn't a whole or half pill — leave it for the broker.
  assert.equal(pillsPerDay({ instructions: 'TAKE 1 TABLET BY MOUTH', form: 'tablet', quantity: 100, printedDaysSupply: 90 }), null);
  // No days' supply printed → stays blank rather than guessing.
  assert.equal(pillsPerDay({ instructions: 'TAKE 1 TABLET BY MOUTH', form: 'tablet', quantity: 90 }), null);
});

test('inhalers, tubes and as-needed meds get no pill count', () => {
  assert.equal(pillsPerDay({ instructions: 'INHALE 2 PUFFS BY MOUTH EVERY 4 HOURS AS NEEDED', form: 'inhaler', quantity: '8.5 g' }), null);
  assert.equal(pillsPerDay({ instructions: 'Take 1 tablet every 6 hours as needed for pain', form: 'tablet', quantity: 30, printedDaysSupply: 30 }), null);
  assert.equal(pillsPerDay({ instructions: 'Apply twice daily', quantity: '30 g' }), null);
});

test('weekly and titration labels are still refused', () => {
  assert.equal(unitsPerDay('Take 1 tablet once a week'), null);
  assert.equal(pillsPerDay({ instructions: 'Take 1 tablet once weekly', form: 'tablet', quantity: 4, printedDaysSupply: 28 }), null);
  assert.equal(pillsPerDay({ instructions: 'Take 1 tablet daily for 7 days then 2 tablets daily', form: 'tablet', quantity: 60 }), null);
});
