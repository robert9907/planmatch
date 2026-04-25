// scripts/drug-baskets.ts
//
// Curated drug baskets used to prime caches and run regression tests
// against the Plan Brain drug-cost pipeline.
//
// A "basket" is a representative set of medications a typical client
// in a given condition profile would be on. Running these through the
// drug-cost cache (api/drug-costs.ts) populates pm_drug_cost_cache with
// realistic per-plan-per-drug totals so the agent quote table doesn't
// fall back to formulary-only estimates for the most common Rx profiles.
//
// rxcuis are RxNorm SCD/SBD ingredient+strength concept ids — the same
// canonical id Medicare.gov's plan-compare/plan-detail uses.
//
// Usage from a script:
//   import { DRUG_BASKETS, BASKETS_BY_CONDITION } from './drug-baskets';
//   for (const drug of DRUG_BASKETS.diabetes) { ... }

export interface BasketDrug {
  rxcui: string;
  name: string;        // canonical generic + brand for log readability
  brand?: string;
  strength: string;    // matches the SCD label
  form: 'tablet' | 'capsule' | 'injection' | 'inhaler' | 'liquid';
  daily_quantity_30: number;   // typical 30-day fill quantity for cost calc
  notes?: string;
}

// ─── Diabetes ────────────────────────────────────────────────────────
// Covers oral biguanides (metformin), SGLT-2s (Jardiance, Farxiga), GLP-1s
// (Trulicity, Ozempic, Rybelsus, Victoza), insulins (Lantus, Humalog,
// Novolog), and the dual GIP/GLP-1 tirzepatide pair (Mounjaro for
// diabetes, Zepbound for weight). Tirzepatide split into two rxcuis —
// CMS plans formulate them separately because Mounjaro is on most MA
// plans while Zepbound is anti-obesity (Part D excludes weight-loss
// indications, so it almost always lands non-covered or excluded).
const diabetes: BasketDrug[] = [
  { rxcui: '861007',  name: 'Metformin 500 MG',     strength: '500 mg',  form: 'tablet',    daily_quantity_30: 60 },
  { rxcui: '1545658', name: 'Jardiance 25 MG',      brand: 'Jardiance',  strength: '25 mg',  form: 'tablet',    daily_quantity_30: 30 },
  { rxcui: '1551300', name: 'Trulicity 1.5 MG',     brand: 'Trulicity',  strength: '1.5 mg', form: 'injection', daily_quantity_30: 4 },
  { rxcui: '1991306', name: 'Ozempic 1 MG',         brand: 'Ozempic',    strength: '1 mg',   form: 'injection', daily_quantity_30: 4 },
  { rxcui: '2117357', name: 'Rybelsus 14 MG',       brand: 'Rybelsus',   strength: '14 mg',  form: 'tablet',    daily_quantity_30: 30 },
  { rxcui: '1373462', name: 'Victoza 1.8 MG',       brand: 'Victoza',    strength: '1.8 mg', form: 'injection', daily_quantity_30: 4 },
  { rxcui: '1601839', name: 'Farxiga 10 MG',        brand: 'Farxiga',    strength: '10 mg',  form: 'tablet',    daily_quantity_30: 30 },
  { rxcui: '849338',  name: 'Lantus 100 UNIT/ML',   brand: 'Lantus',     strength: '100 unit/ml', form: 'injection', daily_quantity_30: 30 },
  { rxcui: '865098',  name: 'Humalog 100 UNIT/ML',  brand: 'Humalog',    strength: '100 unit/ml', form: 'injection', daily_quantity_30: 30 },
  { rxcui: '847232',  name: 'Novolog 100 UNIT/ML',  brand: 'Novolog',    strength: '100 unit/ml', form: 'injection', daily_quantity_30: 30 },
  // Tirzepatide (dual GIP/GLP-1).
  // Mounjaro is the diabetes label — generally Part D covered, often
  // tier 3 with prior auth.
  { rxcui: '2570625', name: 'Mounjaro 5 MG',        brand: 'Mounjaro',   strength: '5 mg',   form: 'injection', daily_quantity_30: 4 },
  // Zepbound is the chronic-weight-management label — Part D plans
  // routinely list as excluded or not_covered (Section 1860D-2(e)(2)
  // excludes drugs for weight loss). The basket includes it on purpose
  // so the assistance layer surfaces PAP options for the client.
  { rxcui: '2605373', name: 'Zepbound 5 MG',        brand: 'Zepbound',   strength: '5 mg',   form: 'injection', daily_quantity_30: 4,
    notes: 'Anti-obesity — Part D often excludes; surface manufacturer assistance.' },
];

// ─── Cardiac (CHF + AFib) ────────────────────────────────────────────
const cardiac: BasketDrug[] = [
  { rxcui: '858813',  name: 'Lisinopril 10 MG',     strength: '10 mg',  form: 'tablet',    daily_quantity_30: 30 },
  { rxcui: '316049',  name: 'Atorvastatin 20 MG',   strength: '20 mg',  form: 'tablet',    daily_quantity_30: 30 },
  { rxcui: '1364430', name: 'Eliquis 5 MG',         brand: 'Eliquis',   strength: '5 mg',   form: 'tablet',    daily_quantity_30: 60 },
  { rxcui: '1114195', name: 'Xarelto 20 MG',        brand: 'Xarelto',   strength: '20 mg',  form: 'tablet',    daily_quantity_30: 30 },
  { rxcui: '1656325', name: 'Entresto 49-51 MG',    brand: 'Entresto',  strength: '49-51 mg', form: 'tablet',  daily_quantity_30: 60 },
];

// ─── COPD / Asthma ───────────────────────────────────────────────────
const respiratory: BasketDrug[] = [
  { rxcui: '746910',  name: 'Symbicort 160-4.5',    brand: 'Symbicort', strength: '160-4.5 mcg', form: 'inhaler', daily_quantity_30: 1 },
  { rxcui: '1543349', name: 'Spiriva 18 MCG',       brand: 'Spiriva',   strength: '18 mcg', form: 'inhaler',   daily_quantity_30: 1 },
  { rxcui: '1424878', name: 'Breo Ellipta 100-25',  brand: 'Breo Ellipta', strength: '100-25 mcg', form: 'inhaler', daily_quantity_30: 1 },
];

// ─── Acute / antiviral ───────────────────────────────────────────────
const acute: BasketDrug[] = [
  { rxcui: '2587896', name: 'Paxlovid 150-100 MG',  brand: 'Paxlovid',  strength: '150-100 mg', form: 'tablet', daily_quantity_30: 30 },
];

// ─── Hyperlipidemia (high-cost biologics) ────────────────────────────
const cholesterol: BasketDrug[] = [
  { rxcui: '1659149', name: 'Repatha 140 MG',       brand: 'Repatha',   strength: '140 mg', form: 'injection', daily_quantity_30: 2 },
];

export const DRUG_BASKETS = {
  diabetes,
  cardiac,
  respiratory,
  acute,
  cholesterol,
} as const;

export type ConditionBasket = keyof typeof DRUG_BASKETS;

export const BASKETS_BY_CONDITION: Record<ConditionBasket, BasketDrug[]> = DRUG_BASKETS;
