// seed.ts — test-fixture loader for /agent-v3?seed=robert
//
// Mirrors the CLIENT/MEDS/PROVIDERS payload baked into
// reference/plan-match-agent-full.jsx so we can demo the full flow
// against real Durham-County data (pm_plans + pm_formulary +
// pm_provider_network_cache + pm_drug_cost_cache).
//
// Only fires when the URL carries `?seed=robert` AND the session is
// otherwise empty. Re-loading the page replays the seed because the
// session store only persists `notes` (intentional — see session.ts).

import type { useSession } from '@/hooks/useSession';
import type { Plan } from '@/types/plans';

type Store = ReturnType<typeof useSession.getState>;

// Verbatim from the reference jsx, with rxcuis pinned to the
// strength-correct concepts that pm_formulary indexes. The pinning
// matters because:
//
//   • RxNav's parsed-strength field on injectables uses volume notation
//     ("3 ML", "0.25 MG") that doesn't match user-friendly "1mg/0.75mL"
//     — useResolveRxcuis can't fall back to a strength-match for
//     Ozempic Pen Injector, only for SCD oral tablets.
//   • rerankByCoverage in /api/rxnorm-search probes pm_formulary with
//     a single .in() call capped at PostgREST's 1000-row page; sibling
//     rxcuis on the same ingredient tree (e.g. lisinopril 40 MG vs
//     lisinopril 20 MG) get truncated unevenly. The "covered" bucket
//     can omit the strength-correct rxcui and the resolver picks the
//     wrong one.
//
// Pinning here insulates the demo from both classes of resolution
// noise. Rxcuis verified against pm_formulary via /api/plan-brain-data
// — every entry has at least one tier+copay row across Durham-NC plans.
//
// Updates (May 2026): if RxNav reassigns or pm_formulary rotates the
// canonical rxcui, refresh by querying:
//   /api/plan-brain-data?ids=<plan-ids>&rxcuis=<candidate>
// and confirming a row comes back.
export const ROBERT_SEED = {
  client: {
    name: 'Robert Johnson',
    phone: '(919) 555-0147',
    dob: '1958-03-15',
    zip: '27713',
    county: 'Durham',
    state: 'NC' as const,
    planType: 'MAPD' as const,
    medicaidConfirmed: false,
    email: 'rjohnson58@gmail.com',
    mbi: '1EG4TE5MK72',
  },
  medications: [
    {
      name: 'Ozempic',
      dose: '1mg/0.75mL',
      frequency: 'Weekly',
      source: 'manual' as const,
      // 3 ML semaglutide 1.34 MG/ML Pen Injector [Ozempic] — delivers
      // 1 MG per dose at the maintenance strength. pm_formulary
      // typically files this at Tier 3 with prior auth.
      rxcui: '2398842',
    },
    {
      name: 'Lisinopril',
      dose: '20mg',
      frequency: 'Daily',
      source: 'manual' as const,
      rxcui: '314077', // lisinopril 20 MG Oral Tablet — Tier 1 / $0
    },
    {
      name: 'Atorvastatin',
      dose: '40mg',
      frequency: 'Daily',
      source: 'manual' as const,
      rxcui: '617311', // atorvastatin 40 MG Oral Tablet — Tier 1 / $0
    },
    {
      name: 'Gabapentin',
      dose: '300mg',
      frequency: '2x Daily',
      source: 'manual' as const,
      rxcui: '197321', // gabapentin 300 MG Oral Capsule — Tier 2-3
    },
  ],
  providers: [
    {
      // Spec-faithful display name + group, but the NPI is swapped from
      // the mockup's fake 1234567890 to a real cached Klein-named
      // internist (Kombiz Klein, NPI 1619976297) so
      // pm_provider_network_cache returns hit/miss rows for Durham
      // plans instead of all "?". 13 rows, in-network on 7 of 13
      // Durham contract-plans as of May 2026.
      name: 'Dr. Combats',
      specialty: 'PCP · Klein Internal Medicine',
      npi: '1619976297',
      source: 'manual' as const,
    },
  ],
};

/** Returns true when the page was opened with the seed param. */
export function isSeedRequested(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('seed') === 'robert';
}

/** Populate client / meds / providers if the session is empty. Does not
 *  touch currentPlanId — that needs the plan list to be loaded first;
 *  the shell sets it in a separate effect. */
export function applyClientSeed(store: Store): boolean {
  if (store.client.name) return false; // already seeded / hydrated
  store.updateClient(ROBERT_SEED.client);
  for (const med of ROBERT_SEED.medications) store.addMedication(med);
  for (const prov of ROBERT_SEED.providers) store.addProvider(prov);
  return true;
}

/** Pick a plausible "current plan" from the eligible-plan list. The
 *  reference uses Aetna PPO MAPD; we prefer the closest match in this
 *  precedence order:
 *    1. Aetna PPO whose name contains "Eagle" (best match for the spec)
 *    2. Any Aetna PPO MAPD
 *    3. Any Aetna MAPD
 *    4. The lowest-ranked plan (so the brain pick is naturally a step up)
 */
export function pickCurrentPlanForSeed(plans: Plan[]): Plan | null {
  if (plans.length === 0) return null;
  const aetnaEagle = plans.find(
    (p) => /aetna/i.test(p.carrier) && /eagle/i.test(p.plan_name),
  );
  if (aetnaEagle) return aetnaEagle;
  const aetnaPpo = plans.find(
    (p) => /aetna/i.test(p.carrier) && p.plan_type === 'MAPD' && /ppo/i.test(p.plan_name),
  );
  if (aetnaPpo) return aetnaPpo;
  const aetna = plans.find(
    (p) => /aetna/i.test(p.carrier) && p.plan_type === 'MAPD',
  );
  if (aetna) return aetna;
  // Fallback — pick a high-premium plan so the brain pick has obvious
  // savings. premium DESC gives us the worst-value plan, mirroring the
  // spec's $42/mo current vs $0/mo brain pick.
  return [...plans].sort((a, b) => b.premium - a.premium)[0] ?? null;
}
