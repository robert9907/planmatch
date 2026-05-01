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

// Verbatim from the reference jsx. Names align with what RxNav returns
// for the strength + form combos so useResolveRxcuis can fill rxcuis
// in the background — we don't hard-code rxcui values here so a future
// RxNav id change doesn't silently break the seed.
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
      strength: '1mg/0.75mL',
      dosageInstructions: 'Weekly',
      source: 'manual' as const,
    },
    {
      name: 'Lisinopril',
      strength: '20mg',
      dosageInstructions: 'Daily',
      source: 'manual' as const,
    },
    {
      name: 'Atorvastatin',
      strength: '40mg',
      dosageInstructions: 'Daily',
      source: 'manual' as const,
    },
    {
      name: 'Gabapentin',
      strength: '300mg',
      dosageInstructions: '2x Daily',
      source: 'manual' as const,
    },
  ],
  providers: [
    {
      name: 'Dr. Combats',
      specialty: 'PCP · Klein Internal Medicine',
      npi: '1234567890',
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
