// Regression (2026-10-21 — Cynthia Kline): the per-drug formulary fallback
// fired every drug at once (~24 queries) and starved rank-plans. It must
// never have more than two requests in flight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleWithConcurrency } from '../../src/lib/concurrency';

test('at most 2 in flight, every item settled in order', async () => {
  let inFlight = 0;
  let peak = 0;
  const res = await settleWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (n === 4) throw new Error('boom');
    return n * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(res.map((r) => (r.status === 'fulfilled' ? r.value : 'x')), [10, 20, 30, 'x', 50, 60]);
});
