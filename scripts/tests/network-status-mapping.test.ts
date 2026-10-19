// agent-v3 maps the consumer endpoint's 6-state provider-network status
// (PR #105) to its own 3-state model. The Gate-1-relevant invariant: a
// not_listed (NPI absent from the carrier's MA directory) must ELIMINATE like
// out_of_network, while no_data / error stay unknown (KEPT, "call to confirm").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { libStatusToNetwork } from '../../src/lib/networkCheck';

test('in_network → in', () => {
  assert.equal(libStatusToNetwork('in_network'), 'in');
});

test('out_of_network and not_listed both → out (trusted negatives, eliminate)', () => {
  assert.equal(libStatusToNetwork('out_of_network'), 'out');
  assert.equal(libStatusToNetwork('not_listed'), 'out');
});

test('no_data / error / unknown → unknown (kept at Gate 1)', () => {
  assert.equal(libStatusToNetwork('no_data'), 'unknown');
  assert.equal(libStatusToNetwork('error'), 'unknown');
  assert.equal(libStatusToNetwork('unknown'), 'unknown');
  // forward-compat: an unrecognized value is never treated as a negative
  assert.equal(libStatusToNetwork('something_new'), 'unknown');
});
