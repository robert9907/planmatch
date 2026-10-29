// Head to Head winner (Rob, 2026-10-28): one winner on the whole plan —
// gates first (drugs covered, no doctor confirmed out of network), then the
// lower premium + drugs − giveback + expected medical copays. No tie window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickH2HWinner } from '../../src/agent-v3/h2hWinner';


const plan = (id: string, premium = 0) => ({ id, premium } as { id: string; premium: number });
const base = plan('H5299-002-000');
const ch = plan('H1036-318-000');
const common = {
  annualDrugByPlanId: {},
  drugsCoveredByPlanId: { [base.id]: 4, [ch.id]: 4 },
  drugsTotalByPlanId: { [base.id]: 4, [ch.id]: 4 },
  providers: [],
};

test('lower whole-plan cost wins, by any amount', () => {
  const w = pickH2HWinner({ ...common, baseline: base, challenger: ch, wholeCostByPlanId: { [base.id]: 2000, [ch.id]: 1995 } });
  assert.deepEqual(w, { winnerId: ch.id, savings: 5 });
  const w2 = pickH2HWinner({ ...common, baseline: base, challenger: ch, wholeCostByPlanId: { [base.id]: 900, [ch.id]: 3900 } });
  assert.deepEqual(w2, { winnerId: base.id, savings: 3000 });
});

test('a plan missing one of her drugs cannot win, even if cheaper', () => {
  const w = pickH2HWinner({
    ...common,
    drugsCoveredByPlanId: { [base.id]: 4, [ch.id]: 3 },
    baseline: base, challenger: ch, wholeCostByPlanId: { [base.id]: 2000, [ch.id]: 500 },
  });
  assert.equal(w.winnerId, base.id);
  assert.equal(w.savings, 0);
});

test('a doctor confirmed out of network loses; unknown does not', () => {
  const out = pickH2HWinner({
    ...common,
    providers: [{ networkStatus: { [ch.id]: 'out', [base.id]: 'in' } }],
    baseline: base, challenger: ch, wholeCostByPlanId: { [base.id]: 2000, [ch.id]: 500 },
  });
  assert.equal(out.winnerId, base.id);
  const unknown = pickH2HWinner({
    ...common,
    providers: [{ networkStatus: { [ch.id]: 'unknown', [base.id]: 'in' } }],
    baseline: base, challenger: ch, wholeCostByPlanId: { [base.id]: 2000, [ch.id]: 500 },
  });
  assert.equal(unknown.winnerId, ch.id);
});

test('exact tie keeps the baseline', () => {
  const w = pickH2HWinner({ ...common, baseline: base, challenger: ch, wholeCostByPlanId: { [base.id]: 1000, [ch.id]: 1000 } });
  assert.deepEqual(w, { winnerId: base.id, savings: 0 });
});
