// scripts/tests/formulary-planyear-cache.test.ts
//
// The formulary module cache is shared across 7 files: the prime
// (bulkLookupFormulary) writes it, many reads (getCachedFormulary,
// incl. the brain-path planFilter) read it. They are keyed by plan_year.
// If a prime writes under 2026 and a read asks for 2027 — or vice-versa,
// or one side omits the year — the read SILENTLY misses and the brain's
// formulary elimination goes inert. These tests pin that isolation so a
// future caller can't half-thread the year without a red test.
//
//   npm run test:formulary-planyear-cache

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bulkLookupFormulary,
  getCachedFormulary,
  clearFormularyCache,
} from '../../src/lib/formularyLookup.js';

const ORIGINAL_FETCH = globalThis.fetch;

function stubFetch(capture: { body?: unknown }) {
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    capture.body = init?.body ? JSON.parse(init.body) : undefined;
    return {
      ok: true,
      json: async () => ({
        matches: [
          {
            rxcui: '99999',
            contract_id: 'H1234',
            plan_id: '567',
            contract_plan_id: 'H1234_567',
            drug_name: 'Testazole',
            tier: 2,
            copay: 10,
            coinsurance: null,
            prior_auth: false,
            step_therapy: false,
            quantity_limit: false,
            match_type: 'rxcui',
          },
        ],
      }),
    } as unknown as Response;
  }) as typeof fetch;
}

test('prime sends planYear and the read with the SAME year hits', async () => {
  clearFormularyCache();
  const cap: { body?: unknown } = {};
  stubFetch(cap);
  try {
    await bulkLookupFormulary(['H1234'], ['99999'], undefined, 2026);
    // the prime actually put plan_year on the wire
    assert.equal((cap.body as { planYear?: number })?.planYear, 2026);
    const hit = getCachedFormulary('H1234_567', '99999', 2026);
    assert.ok(hit, 'same-year read should hit the primed cache');
    assert.equal(hit?.tier, 2);
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
  }
});

test('a read for a DIFFERENT year misses (no cross-year leak)', async () => {
  clearFormularyCache();
  const cap: { body?: unknown } = {};
  stubFetch(cap);
  try {
    await bulkLookupFormulary(['H1234'], ['99999'], undefined, 2026);
    assert.equal(
      getCachedFormulary('H1234_567', '99999', 2027),
      null,
      '2027 read must not see the 2026-primed entry',
    );
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
  }
});

test('a year-less read does NOT collide with a year-keyed prime', async () => {
  clearFormularyCache();
  const cap: { body?: unknown } = {};
  stubFetch(cap);
  try {
    await bulkLookupFormulary(['H1234'], ['99999'], undefined, 2026);
    assert.equal(
      getCachedFormulary('H1234_567', '99999'),
      null,
      'omitting the year must miss a year-keyed entry — prime and read must agree',
    );
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
  }
});

test('legacy no-year prime/read still round-trips (back-compat)', async () => {
  clearFormularyCache();
  const cap: { body?: unknown } = {};
  stubFetch(cap);
  try {
    await bulkLookupFormulary(['H1234'], ['99999']); // no planYear
    assert.equal((cap.body as { planYear?: number })?.planYear, undefined);
    const hit = getCachedFormulary('H1234_567', '99999'); // no planYear
    assert.ok(hit, 'year-less prime + year-less read still works');
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
  }
});
