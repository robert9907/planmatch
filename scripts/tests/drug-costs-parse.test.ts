// Regression (Rob, 2026-10-20 — Janet Moses): medicare.gov's drug-cost
// response nests the plan under `plan` and the totals under
// `lowest_retail_total` / `lowest_mail_total` / `costs[].estimated_yearly_total`.
// The old parser read top-level `contract_id` / `annual_cost`, so every
// live result came back with contract_id "" and annual_cost null — no plan
// ever matched, and agent-v3 never showed a live drug cost.
//
// Fixture is a real 2027 response (H5141-063, H3291-003; oxycodone 5 MG
// tablet + Voquezna 20 MG, captured 2026-10-20).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractCosts } from '../../api/drug-costs';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/medicare-gov-drug-cost-2027.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

test('reads plan ids from the nested plan object', () => {
  const costs = extractCosts(fixture, false);
  assert.deepEqual(
    costs.map((c) => `${c.contract_id}-${c.plan_id}-${c.segment_id}`),
    ['H5141-063-0', 'H3291-003-0'],
  );
});

test('annual = lowest valid total (mail allowed), monthly = annual / 12', () => {
  const [a, b] = extractCosts(fixture, false);
  assert.equal(a.annual_cost, 10126.92);
  assert.equal(b.annual_cost, 10122.92);
  assert.ok(Math.abs((a.monthly_cost ?? 0) - 10126.92 / 12) < 0.001);
  assert.equal(a.deductible, 425);
  assert.equal(b.deductible, 350);
});

test('retail-only with no valid retail price → unknown (null), never $0', () => {
  const [a] = extractCosts(fixture, true);
  assert.equal(a.annual_cost, null);
  assert.equal(a.monthly_cost, null);
});

test('no priced drugs (unknown NDC) → unknown (null), never $0', () => {
  const empty = {
    plans: [{
      plan: { contract_id: 'H5141', plan_id: '063', segment_id: '0', contract_year: '2027' },
      costs: [{ drug_costs: [], estimated_yearly_total: 0, mail_order: true, phase_information: { deductible_amount: 0 } }],
      lowest_retail_total: 0, lowest_mail_total: 0, lowest_retail_valid: false, lowest_mail_valid: false,
    }],
  };
  const [a] = extractCosts(empty, false);
  assert.equal(a.contract_id, 'H5141');
  assert.equal(a.annual_cost, null);
});

// Regression (Rob, 2026-10-20 — Janet Moses): medicare.gov silently drops an
// NDC it doesn't recognize and reports the total WITHOUT that drug. Her first
// oxycodone NDC (00378611201) is one: H5216-154 read $0/yr instead of $98.40.
// A plan whose response is missing a requested drug has no real total.
import { swapUnpricedNdcs, type NdcSlot } from '../../api/drug-costs';

test('a requested drug missing from the response → total unknown, drug listed', () => {
  const [a] = extractCosts(fixture, false, ['00406055201', '81520020030', '00378611201']);
  assert.equal(a.annual_cost, null);
  assert.equal(a.monthly_cost, null);
  assert.deepEqual(a.unpriced_ndcs, ['00378611201']);
});

test('every requested drug priced → total kept', () => {
  const [a] = extractCosts(fixture, false, ['00406055201', '81520020030']);
  assert.equal(a.annual_cost, 10126.92);
  assert.deepEqual(a.unpriced_ndcs, []);
});

test('unpriced NDC is swapped for the next alternate; priced ones are left alone', () => {
  const slots: NdcSlot[] = [
    { ndc: '00904744761', alternates: ['11111111111'] },
    { ndc: '00378611201', alternates: ['00406055201', '00406055223'] },
  ];
  const changed = swapUnpricedNdcs(slots, new Set(['00904744761']));
  assert.equal(changed, true);
  assert.equal(slots[0].ndc, '00904744761');
  assert.equal(slots[1].ndc, '00406055201');
  assert.deepEqual(slots[1].alternates, ['00406055223']);
});

test('no alternates left → nothing to swap', () => {
  const slots: NdcSlot[] = [{ ndc: '00378611201', alternates: [] }];
  assert.equal(swapUnpricedNdcs(slots, new Set()), false);
  assert.equal(slots[0].ndc, '00378611201');
});

// Regression (2026-10-21 — Cynthia Kline): retail mode with no pharmacy
// priced nothing (medicare.gov needs an NPI for retail), and the alternate-
// NDC swap then replaced every NDC as if all were unrecognized.
test('nothing priced at all → no NDC is treated as unrecognized', () => {
  const slots: NdcSlot[] = [{ ndc: '00904744761', alternates: ['11111111111'] }];
  // The handler skips swapping when pricedNdcs() is empty; the helper itself
  // must still leave priced slots alone.
  assert.equal(swapUnpricedNdcs(slots, new Set(['00904744761'])), false);
  assert.equal(slots[0].ndc, '00904744761');
});
