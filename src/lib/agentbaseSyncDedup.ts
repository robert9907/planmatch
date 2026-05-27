// agentbaseSyncDedup — collapse duplicate meds and providers before
// the AgentBase sync payload leaves the browser.
//
// Why this exists:
//   • The RxNorm resolver expands one user-typed drug ("Ozempic") into
//     multiple display variants (Semaglutide 0.25 MG Pen Injector,
//     Semaglutide 0.5 MG Pen Injector, …). All variants reach
//     QuoteDeliveryV4's medRows and would land in AgentBase as
//     separate client_medications rows without this step.
//   • Provider capture sometimes records the same MD twice with
//     different casing or honorifics ("Dr. Kombiz Klein, DO" vs
//     "KOMBIZ KLEIN, DO"). AgentBase's ac67d25 normalize fix prevents
//     new server-side duplicates, but the client should also collapse
//     the payload so the per-row upsert loop doesn't waste round
//     trips.
//
// Server-side dedup in api/agentbase-recommend.ts uses an EXACT
// (rxcui|dose) / (lower(name)|dose) key, so different doses of the
// same ingredient slip through. This helper groups by base ingredient
// name only — that's what the user typed; that's what they expect to
// see in the CRM.
//
// "Best" record per group:
//   medications → rxcui present > tier present > monthly_cost present
//   providers   → npi present
// Ties broken by original order so the highest-cost-first sort
// upstream (medRows) still reads correctly in AgentBase.

import { parseDrugName } from './parseDrugName';
import type { SyncInput } from '@/hooks/useAgentBaseRecommend';

type MedContext = SyncInput['medContext'][number];
type ProviderContext = SyncInput['providerContext'][number];

function medGroupKey(m: MedContext): string {
  // Some upstream callers send a clean ingredient ("Gabapentin"),
  // others send the raw RxNorm display ("gabapentin · 300 MG · Oral
  // Capsule"). parseDrugName handles both: segment 1 is the
  // ingredient. Lowercased so case variants collapse together.
  const parsed = parseDrugName(m.name);
  return (parsed.name || m.name || '').trim().toLowerCase();
}

function medScore(m: MedContext): number {
  let s = 0;
  if (m.rxcui) s += 4;
  if (m.tier_on_recommended_plan != null) s += 2;
  if (m.monthly_cost != null) s += 1;
  return s;
}

export function dedupeMedContext(meds: MedContext[]): MedContext[] {
  const best = new Map<string, MedContext>();
  const firstIdx = new Map<string, number>();
  meds.forEach((m, idx) => {
    const key = medGroupKey(m);
    if (!key) return;
    const cur = best.get(key);
    if (!cur) {
      best.set(key, m);
      firstIdx.set(key, idx);
      return;
    }
    if (medScore(m) > medScore(cur)) best.set(key, m);
  });
  return [...best.entries()]
    .sort((a, b) => (firstIdx.get(a[0]) ?? 0) - (firstIdx.get(b[0]) ?? 0))
    .map(([, m]) => m);
}

// Mirror of api/_lib/normalize.ts so the client-side dedup key
// matches the server-side dedup key — both layers collapse the same
// equivalence classes.
const HONORIFICS = /^(dr\.?|doctor|mr\.?|mrs\.?|ms\.?|prof\.?)\s+/i;
const SUFFIXES = /,?\s*(?:do|md|np|pa-c|pa|rn|crnp|dnp|phd|md-?phd|fnp(-bc)?|aprn|psyd)\.?\s*$/i;

function normalizeProviderName(raw: string | null | undefined): string {
  let s = (raw ?? '').trim();
  if (!s) return '';
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(HONORIFICS, '').trim();
    s = s.replace(SUFFIXES, '').trim();
  }
  return s.toLowerCase().replace(/\s+/g, ' ');
}

function providerScore(p: ProviderContext): number {
  return p.npi ? 1 : 0;
}

export function dedupeProviderContext(providers: ProviderContext[]): ProviderContext[] {
  const best = new Map<string, ProviderContext>();
  const firstIdx = new Map<string, number>();
  providers.forEach((p, idx) => {
    const npi = (p.npi ?? '').trim();
    const norm = normalizeProviderName(p.name);
    if (!npi && !norm) return;
    const key = npi ? `npi:${npi}` : `name:${norm}`;
    const cur = best.get(key);
    if (!cur) {
      best.set(key, p);
      firstIdx.set(key, idx);
      return;
    }
    if (providerScore(p) > providerScore(cur)) best.set(key, p);
  });
  return [...best.entries()]
    .sort((a, b) => (firstIdx.get(a[0]) ?? 0) - (firstIdx.get(b[0]) ?? 0))
    .map(([, p]) => p);
}
