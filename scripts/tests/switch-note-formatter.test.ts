// formatSwitchNote — the single shared copy string for the "ask your doctor
// about switching" note rendered on all three agent surfaces (Compare grid,
// Head-to-Head drug calendar, QuoteDeliveryV4 Rx cell). The consumer
// rank-plans endpoint attaches a `switch_suggestion` to an UNCOVERED drug when
// the plan files a clean covered brand↔generic equivalent; this formatter is
// the only place that turns it into prose, so the three surfaces stay
// word-for-word identical.
//
// Rules under test (Rob's spec):
//   • "Generic" when is_generic, "Brand" otherwise.
//   • copay present → ", $Y/mo".
//   • copay null but coinsurance present → " (~Z% coinsurance)".
//   • neither → omit the cost clause entirely.
//   • tier null → omit " at Tier X".
//   • null/absent suggestion, or a suggestion with no name → null (true no-op).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSwitchNote } from '../../src/lib/library-client.js';

test('generic equivalent with tier + copay', () => {
  assert.equal(
    formatSwitchNote({ is_generic: true, name: 'atorvastatin', tier: 1, copay: 4, coinsurance: null }),
    'Generic atorvastatin is covered on this plan at Tier 1, $4/mo — ask your doctor about switching.',
  );
});

test('brand equivalent when is_generic is false', () => {
  assert.equal(
    formatSwitchNote({ is_generic: false, name: 'Eliquis', tier: 3, copay: 47, coinsurance: null }),
    'Brand Eliquis is covered on this plan at Tier 3, $47/mo — ask your doctor about switching.',
  );
});

test('coinsurance clause when copay is null', () => {
  assert.equal(
    formatSwitchNote({ is_generic: true, name: 'adalimumab', tier: 5, copay: null, coinsurance: 25 }),
    'Generic adalimumab is covered on this plan at Tier 5 (~25% coinsurance) — ask your doctor about switching.',
  );
});

test('copay wins over coinsurance when both present', () => {
  assert.equal(
    formatSwitchNote({ is_generic: true, name: 'metformin', tier: 1, copay: 0, coinsurance: 25 }),
    'Generic metformin is covered on this plan at Tier 1, $0/mo — ask your doctor about switching.',
  );
});

test('no cost clause when neither copay nor coinsurance', () => {
  assert.equal(
    formatSwitchNote({ is_generic: false, name: 'Ozempic', tier: 2, copay: null, coinsurance: null }),
    'Brand Ozempic is covered on this plan at Tier 2 — ask your doctor about switching.',
  );
});

test('no tier clause when tier is null', () => {
  assert.equal(
    formatSwitchNote({ is_generic: true, name: 'losartan', tier: null, copay: 8, coinsurance: null }),
    'Generic losartan is covered on this plan, $8/mo — ask your doctor about switching.',
  );
});

test('no tier and no cost', () => {
  assert.equal(
    formatSwitchNote({ is_generic: true, name: 'lisinopril', tier: null, copay: null, coinsurance: null }),
    'Generic lisinopril is covered on this plan — ask your doctor about switching.',
  );
});

test('null / absent / nameless suggestion is a no-op', () => {
  assert.equal(formatSwitchNote(null), null);
  assert.equal(formatSwitchNote(undefined), null);
  assert.equal(
    formatSwitchNote({ is_generic: true, name: null, tier: 1, copay: 4, coinsurance: null }),
    null,
  );
});
