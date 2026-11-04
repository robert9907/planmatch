// Snap Link: put each bottle's prescriber onto its medication row.
//
// capture-submit already adds every label prescriber to the client's
// Linked Providers, but the med rows themselves were left with a blank
// prescriber_id — so the AgentBase Medications table showed "Set" on every
// row and the client's default prescriber stayed "Not set" even though the
// doctor was right there on the bottle.
//
// This pass runs after the providers are linked:
//   1. Each med whose label named a prescriber gets that linked provider
//      (matched by last name, the same rule planPrescribers uses to merge
//      readings). Blanks only — a prescriber already on the row, or a row
//      the broker pointed at a specialist (prescriber_override), wins.
//   2. If the client has no default prescriber yet, the doctor who wrote
//      the most of these bottles becomes the default, and every remaining
//      blank, non-overridden med takes it — the same seeding AgentBase does
//      after its own imports (lib/med-defaults.js reconcileDefaultsAfterImport).
//
// clearDeclinedPrescriber() undoes step 1/2 for a doctor the client tapped
// "Not my doctor" on in the confirm step.

import type { agentbaseSupabase } from './agentbaseSupabase.js';
import { parseDrugName } from './normalize.js';
import { parsePrescriber, sameLast, type PrescriberName } from './snapPrescriber.js';

type Ab = ReturnType<typeof agentbaseSupabase>;

export interface MedPrescriberPair {
  /** Drug name as it was handed to upsertMedicationsForClient. */
  medName: string;
  /** Prescriber exactly as printed on that bottle. */
  prescriber: string;
}

export interface MedPrescriberSummary {
  meds_stamped: number;
  default_set: number | null;
  default_filled: number;
}

type Linked = { providerId: number; parts: PrescriberName };

async function linkedDoctors(ab: Ab, clientId: number): Promise<Linked[]> {
  const { data } = await ab
    .from('client_providers')
    .select('provider_id, provider:providers(id, name)')
    .eq('client_id', clientId);
  const out: Linked[] = [];
  for (const r of (data ?? []) as unknown as Array<{ provider_id: number; provider: { name: string | null } | null }>) {
    const parts = parsePrescriber(r.provider?.name ?? '');
    if (parts?.last) out.push({ providerId: r.provider_id, parts });
  }
  return out;
}

// One linked provider for this reading, or null when it's ambiguous.
function matchLinked(linked: Linked[], want: PrescriberName): number | null {
  const byLast = linked.filter((l) => sameLast(l.parts, want));
  const ids = new Set(byLast.map((l) => l.providerId));
  if (ids.size === 1) return byLast[0].providerId;
  if (ids.size > 1 && want.first) {
    const initial = want.first.charAt(0).toLowerCase();
    const byFirst = byLast.filter((l) => (l.parts.first ?? '').charAt(0).toLowerCase() === initial);
    const firstIds = new Set(byFirst.map((l) => l.providerId));
    if (firstIds.size === 1) return byFirst[0].providerId;
  }
  return null;
}

export async function stampMedPrescribers(
  ab: Ab,
  clientId: number,
  pairs: MedPrescriberPair[],
): Promise<MedPrescriberSummary> {
  const summary: MedPrescriberSummary = { meds_stamped: 0, default_set: null, default_filled: 0 };
  const usable = pairs.filter((p) => p.medName.trim() && p.prescriber.trim());
  if (usable.length === 0) return summary;

  const linked = await linkedDoctors(ab, clientId);
  if (linked.length === 0) return summary;

  const tally = new Map<number, number>();
  for (const pair of usable) {
    const want = parsePrescriber(pair.prescriber);
    if (!want) continue;
    const providerId = matchLinked(linked, want);
    if (providerId == null) continue;
    tally.set(providerId, (tally.get(providerId) ?? 0) + 1);

    const name = parseDrugName(pair.medName).name || pair.medName;
    const { data: rows } = await ab
      .from('client_medications')
      .update({ prescriber_id: providerId })
      .eq('client_id', clientId)
      .ilike('name', name)
      .is('deleted_at', null)
      .is('prescriber_id', null)
      .or('prescriber_override.is.null,prescriber_override.eq.false')
      .select('id');
    summary.meds_stamped += (rows ?? []).length;
  }

  // Seed the client default from the doctor on the most bottles. A tie
  // between two doctors seeds nothing — the broker picks.
  const { data: client } = await ab
    .from('clients')
    .select('default_prescriber_id')
    .eq('id', clientId)
    .maybeSingle();
  const current = (client as { default_prescriber_id: number | null } | null)?.default_prescriber_id ?? null;
  if (current == null && tally.size > 0) {
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length === 1 || ranked[0][1] > ranked[1][1]) {
      const defaultId = ranked[0][0];
      const { error } = await ab
        .from('clients')
        .update({ default_prescriber_id: defaultId })
        .eq('id', clientId)
        .is('default_prescriber_id', null);
      if (!error) {
        summary.default_set = defaultId;
        const { data: filled } = await ab
          .from('client_medications')
          .update({ prescriber_id: defaultId })
          .eq('client_id', clientId)
          .is('deleted_at', null)
          .is('prescriber_id', null)
          .or('prescriber_override.is.null,prescriber_override.eq.false')
          .select('id');
        summary.default_filled = (filled ?? []).length;
      }
    }
  }
  return summary;
}

// "Not my doctor": take that doctor back off any unverified med and off
// the client default. providerIds are only the unverified Snap links the
// confirm step just removed, so a broker-chosen doctor is never touched.
export async function clearDeclinedPrescriber(
  ab: Ab,
  clientId: number,
  providerIds: number[],
): Promise<number> {
  if (providerIds.length === 0) return 0;
  const { data: rows } = await ab
    .from('client_medications')
    .update({ prescriber_id: null })
    .eq('client_id', clientId)
    .in('prescriber_id', providerIds)
    .is('verified_at', null)
    .or('prescriber_override.is.null,prescriber_override.eq.false')
    .select('id');
  await ab
    .from('clients')
    .update({ default_prescriber_id: null })
    .eq('id', clientId)
    .in('default_prescriber_id', providerIds);
  return (rows ?? []).length;
}
