// Bottle-scan quantity (Rob, 2026-10-27): a 30 g tube or 16 mL spray must
// reach the CRM with its unit, not as a bare "30" that reads like 30 pills,
// and the pill math must never run on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantityText, daysSupply } from '../../api/_lib/snapRefill';
import { fillQuantity } from '../../src/lib/drugCosts';

test('quantity keeps its unit for creams and sprays, plain number for pills', () => {
  assert.equal(quantityText('30 g'), '30 g');
  assert.equal(quantityText('16 mL'), '16 mL');
  assert.equal(quantityText('120 sprays'), '120 sprays');
  assert.equal(quantityText(90), '90');
  assert.equal(quantityText('90 tablets'), '90');
});

test('no pills-per-day math on a tube, even with no form read', () => {
  assert.equal(daysSupply({ quantity: '30 g', instructions: 'Take 1 tablet twice daily' }), null);
  assert.equal(daysSupply({ quantity: '60', instructions: 'Take 1 tablet twice daily', form: 'tablet' }), 30);
  assert.equal(daysSupply({ quantity: '16 g', form: 'nasal spray', printedDaysSupply: 30 }), 30);
});

test('medicare.gov fill quantity: 30-day amount, tripled for 90-day mail', () => {
  assert.equal(fillQuantity(1, 'retail'), 1);
  assert.equal(fillQuantity(1, 'mail'), 3);
  assert.equal(fillQuantity(60, 'mail'), 180);
});
