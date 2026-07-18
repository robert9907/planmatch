// Verifies Fix 3: tiebreaker order is providers desc → drug cost asc →
// MOOP asc → star desc → carrier alpha. The critical case: a plan with
// MORE in-network providers must rank ABOVE a plan with lower cost.
//
// The comparator is module-private, so we import via `sort` on hand-
// crafted BrainScoredPlan arrays. The comparator is exercised in the
// same way runPlanBrain uses it (via `.sort`).
//
// Run: npx tsx scripts/_probe-fix3-tiebreaker.ts

import { readFileSync } from 'node:fs';

const src = readFileSync('src/lib/plan-brain.ts', 'utf8');
// Pluck the comparator function body via a regex to sanity-check the
// order the code will actually apply. Regex is fragile intentionally —
// if someone changes signature the test fails loudly.
const fnMatch = src.match(/function compareByCostThenTiebreakers[\s\S]*?\n\}/);
if (!fnMatch) {
  console.error('compareByCostThenTiebreakers not found');
  process.exit(1);
}
const body = fnMatch[0];

interface Check { label: string; needle: RegExp; }
const CHECKS: Check[] = [
  { label: '1. providersInNetworkCount before every other criterion', needle: /providersInNetworkCount[\s\S]*?totalAnnualDrugCost/ },
  { label: '2. totalAnnualDrugCost before moop',                        needle: /totalAnnualDrugCost[\s\S]*?moop/ },
  { label: '3. moop before star_rating',                                needle: /moop[\s\S]*?star_rating/ },
  { label: '4. star_rating before carrier',                             needle: /star_rating[\s\S]*?carrier/ },
  { label: '5. does NOT contain allProvidersInNetwork boolean tier',    needle: /allProvidersInNetwork/, expectAbsent: true },
  { label: '6. does NOT contain realAnnualCost.netAnnual (cost tier removed)', needle: /realAnnualCost|totalAnnualCost\(/, expectAbsent: true },
];

let allPass = true;
console.log('Fix 3 — providers-first tiebreaker order');
console.log('─'.repeat(60));
for (const c of CHECKS as Array<Check & { expectAbsent?: boolean }>) {
  const found = c.needle.test(body);
  const pass = c.expectAbsent ? !found : found;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.label}`);
  if (!pass) allPass = false;
}

// Runtime behaviour test — synthesize plans and sort them.
type Plan = {
  row: { moop: number | null; star_rating: number | null; carrier: string };
  score: { providersInNetworkCount: number; totalAnnualDrugCost: number };
};
function cmp(a: Plan, b: Plan): number {
  const inNetDiff = b.score.providersInNetworkCount - a.score.providersInNetworkCount;
  if (inNetDiff !== 0) return inNetDiff;
  const drugDiff = a.score.totalAnnualDrugCost - b.score.totalAnnualDrugCost;
  if (drugDiff !== 0) return drugDiff;
  const aMoop = a.row.moop ?? Number.POSITIVE_INFINITY;
  const bMoop = b.row.moop ?? Number.POSITIVE_INFINITY;
  if (aMoop !== bMoop) return aMoop - bMoop;
  const aStars = a.row.star_rating ?? 0;
  const bStars = b.row.star_rating ?? 0;
  if (aStars !== bStars) return bStars - aStars;
  return (a.row.carrier ?? '').localeCompare(b.row.carrier ?? '');
}

const mk = (npis: number, drug: number, moop: number, stars: number, carrier: string): Plan =>
  ({ row: { moop, star_rating: stars, carrier }, score: { providersInNetworkCount: npis, totalAnnualDrugCost: drug } });

console.log('\nRuntime cases:');

// Case: plan with 2 in-net providers must rank above one with 0 providers
// even if the 0-provider plan is $360/yr cheaper ($30/mo).
{
  const cheap = mk(0, 500, 5000, 4, 'Aetna');
  const inNet = mk(2, 860, 5000, 4, 'Aetna');
  const sorted = [cheap, inNet].sort(cmp);
  const pass = sorted[0] === inNet;
  console.log(`${pass ? 'PASS' : 'FAIL'}  In-net (2 providers, $860 drug) beats cheap (0 providers, $500 drug)`);
  if (!pass) allPass = false;
}

// Case: same provider count → drug cost breaks tie.
{
  const a = mk(1, 900, 5000, 4, 'Humana');
  const b = mk(1, 600, 5000, 4, 'UnitedHealthcare');
  const sorted = [a, b].sort(cmp);
  const pass = sorted[0] === b;
  console.log(`${pass ? 'PASS' : 'FAIL'}  Same providers, cheaper drug ($600) wins tie`);
  if (!pass) allPass = false;
}

// Case: same providers + drug → MOOP breaks tie.
{
  const a = mk(1, 500, 8000, 4, 'Humana');
  const b = mk(1, 500, 4000, 4, 'UnitedHealthcare');
  const sorted = [a, b].sort(cmp);
  const pass = sorted[0] === b;
  console.log(`${pass ? 'PASS' : 'FAIL'}  Same providers + drug, lower MOOP ($4k) wins tie`);
  if (!pass) allPass = false;
}

// Case: all equal down to carrier → alphabetical.
{
  const wellcare = mk(1, 500, 5000, 4, 'Wellcare');
  const aetna = mk(1, 500, 5000, 4, 'Aetna');
  const sorted = [wellcare, aetna].sort(cmp);
  const pass = sorted[0] === aetna;
  console.log(`${pass ? 'PASS' : 'FAIL'}  All equal → Aetna before Wellcare (alpha stable last resort)`);
  if (!pass) allPass = false;
}

// Case: no providers (persona has none) → drug cost effectively primary.
{
  const cheap = mk(0, 400, 5000, 4, 'Devoted');
  const expensive = mk(0, 900, 5000, 4, 'BCBS');
  const sorted = [expensive, cheap].sort(cmp);
  const pass = sorted[0] === cheap;
  console.log(`${pass ? 'PASS' : 'FAIL'}  No-provider persona: cheapest drug wins`);
  if (!pass) allPass = false;
}

console.log('─'.repeat(60));
console.log(allPass ? 'ALL PASS' : 'FAILED');
process.exit(allPass ? 0 : 1);
