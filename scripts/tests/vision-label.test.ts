// FIX 3 (pressure-test run 1, H3449-027): a vision row that is only a copay
// with no eyewear allowance is the routine eye-exam copay, not a supplemental
// vision benefit — it must not read as an extra.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBenefits } from '../../api/plans.ts';

const row = (o: Record<string, unknown>) => ({ benefit_category: 'vision', ...o }) as never;

test('copay-only vision → labelled as eye exam, not a plain extra', () => {
  const b = buildBenefits([row({ copay: 25 })]);
  assert.equal(b.vision.eyewear_allowance_year, 0);
  assert.match(b.vision.description ?? '', /Eye exam.*\(no supplemental eyewear\)/);
});

test('eyewear allowance present → real supplemental vision', () => {
  const b = buildBenefits([row({ coverage_amount: 200, max_coverage: 200, benefit_description: 'Routine eye exam + eyewear · $200 eyewear allowance' })]);
  assert.equal(b.vision.eyewear_allowance_year, 200);
  assert.match(b.vision.description ?? '', /eyewear allowance/);
});

test('prefers the allowance row over a copay-only row', () => {
  const b = buildBenefits([row({ copay: 25 }), row({ coverage_amount: 150, max_coverage: 150 })]);
  assert.equal(b.vision.eyewear_allowance_year, 150);
  assert.doesNotMatch(b.vision.description ?? '', /Eye exam ·/);
});
