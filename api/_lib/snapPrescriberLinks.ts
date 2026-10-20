// Label prescribers → this client's Linked Providers (AgentBase).
// Shared by capture-submit (each photo) and capture-confirm (the whole
// visit, so "Robin Arlene Edwards" on one bottle and "Edwards FNP" on
// another resolve together).

import type { agentbaseSupabase } from './agentbaseSupabase.js';
import type { IncomingProvider } from './agentbaseDedup.js';
import { mergeParts, parsePrescriber, resolveParts, sameLast, type PrescriberName, type PrescriberNear } from './snapPrescriber.js';

type ExistingLink = {
  linkId: number;
  verified: boolean;
  providerId: number;
  npi: string | null;
  parts: PrescriberName;
};

// Decide which prescribers become new Linked Provider cards. Merges
// same-last-name readings, finishes an existing unverified Snap card when
// the new reading makes it resolvable (re-points that card at the full
// registry record), and never adds a second card for someone already there.
export async function planPrescribers(
  ab: ReturnType<typeof agentbaseSupabase>,
  clientId: number,
  rawNames: string[],
  state: string | null,
  near?: PrescriberNear,
): Promise<IncomingProvider[]> {
  // Merge this photo's readings by last name.
  const batch: PrescriberName[] = [];
  for (const raw of rawNames) {
    const p = parsePrescriber(raw);
    if (!p) continue;
    const i = batch.findIndex((x) => sameLast(x, p));
    if (i >= 0) batch[i] = mergeParts(batch[i], p);
    else batch.push(p);
  }
  if (batch.length === 0) return [];

  const { data: linkRows } = await ab
    .from('client_providers')
    .select('id, provider_id, verified_at, provider:providers(id, name, npi)')
    .eq('client_id', clientId);
  const existing: ExistingLink[] = [];
  for (const r of (linkRows ?? []) as unknown as Array<{
    id: number;
    provider_id: number;
    verified_at: string | null;
    provider: { id: number; name: string | null; npi: string | null } | null;
  }>) {
    const parts = parsePrescriber(r.provider?.name ?? '');
    if (parts) {
      existing.push({
        linkId: r.id,
        verified: r.verified_at != null,
        providerId: r.provider_id,
        npi: r.provider?.npi ?? null,
        parts,
      });
    }
  }

  const out: IncomingProvider[] = [];
  for (const p of batch) {
    const match = existing.find((e) => sameLast(e.parts, p));
    if (!match) {
      const r = await resolveParts(p, state, near);
      out.push({ name: r.name, npi: r.npi, specialty: r.specialty, phone: r.phone, address: r.address });
      continue;
    }
    // Already on the card. Only an unverified card without an NPI can be
    // improved; anything else is left exactly as the broker has it.
    if (match.npi || match.verified) continue;
    const merged = mergeParts(match.parts, p);
    const r = await resolveParts(merged, state, near);
    if (!r.npi) continue; // still not certain — keep the one card as is
    try {
      // Find or create the full registry record, then point this client's
      // existing card at it (no new card, nothing deleted).
      let providerId: number | null = null;
      const { data: byNpi } = await ab.from('providers').select('id').eq('npi', r.npi).limit(1).maybeSingle();
      if (byNpi) providerId = (byNpi as { id: number }).id;
      else {
        const { data: ins, error } = await ab
          .from('providers')
          .insert({ name: r.name, npi: r.npi, specialty: r.specialty, phone: r.phone, address: r.address })
          .select('id')
          .single();
        if (error) throw error;
        providerId = (ins as { id: number }).id;
      }
      const { data: dup } = await ab
        .from('client_providers')
        .select('id')
        .eq('client_id', clientId)
        .eq('provider_id', providerId)
        .limit(1)
        .maybeSingle();
      if (!dup) {
        const { error: updErr } = await ab
          .from('client_providers')
          .update({ provider_id: providerId })
          .eq('id', match.linkId);
        if (updErr) throw updErr;
      }
    } catch (err) {
      console.warn('[capture-submit] prescriber upgrade failed', {
        clientId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
