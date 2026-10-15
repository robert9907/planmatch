// Guard: every agent read of pm_provider_network_cache that feeds a doctor
// answer must filter to one plan year — a 2026 network answer must never
// stand in for a 2027 plan (contract-plan ids carry over between years).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function cacheQueries(file: string): string[] {
  const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  const out: string[] = [];
  const re = /\.from\('pm_provider_network_cache'\)([\s\S]{0,600}?)(?:\)\s*[,;]|\n\s*\n)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1]);
  return out;
}

for (const file of ['api/plan-brain-data.ts', 'src/lib/networkCheck.ts']) {
  test(`${file}: doctor-network read is year-scoped`, () => {
    const qs = cacheQueries(file);
    assert.ok(qs.length > 0, 'expected a pm_provider_network_cache read');
    for (const q of qs) assert.match(q, /\.eq\('plan_year',/);
  });
}

test('networkCheck library call passes the ?plan_year override', () => {
  const src = readFileSync(new URL('../../src/lib/networkCheck.ts', import.meta.url), 'utf8');
  assert.match(src, /plan_year: yearOverride/);
});
