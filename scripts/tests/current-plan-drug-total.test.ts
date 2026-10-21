// Regression (2026-10-21, Cynthia Kline #394): the current plan is priced
// outside top/bench (`current_plan`) — its drug total must reach the map so
// the current-plan card isn't "not priced".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentV3LisMaps } from '../../src/lib/lis-cap-agent-v3';

test('current_plan drug total reaches annualDrugByPlanId', () => {
  const plan = { id: 'H2001-090-000', plan_type: 'PPO' };
  const lp = { plan_id: 'H2001-090-0', medications: [], total_annual_drug_cost: 1500 };
  const { annualDrugByPlanId } = buildAgentV3LisMaps({
    ranked: { top_plans: [], bench_plans: [], current_plan: lp } as never,
    planById: new Map([['H2001-090-0', plan]]) as never,
    normalizePlanId: (id: string) => id,
    client: {},
  });
  assert.equal(annualDrugByPlanId['H2001-090-000'], 1500);
});
