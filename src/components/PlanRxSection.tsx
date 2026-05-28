// PlanRxSection — reusable "Prescription Drugs and Cost Protection"
// block. Renders for a single plan: drug deductible, tier copay table
// (T1–T5+ extras), the user's medications with per-plan tier + monthly
// cost, and the CalendarYearCost accordion below it.
//
// Shared by Top4Screen, PlanDetailView, and (eventually) any other
// single-plan render surface that wants the full Rx story. Pure
// presentational: parent owns the data lookups.

import type { Medication } from '@/types/session';
import type { Plan, FormularyTier } from '@/types/plans';
import type { FormularyHit } from '@/lib/formularyLookup';
import { monthlyCostFromFormulary } from '@/lib/drugCosts';
import { CalendarYearCost } from './CalendarYearCost';

interface Props {
  plan: Plan;
  medications: Medication[];
  formulary: Record<string, FormularyHit>;
  /** Pre-computed monthly retail/$ cost per drug (e.g. from /api/drug-costs).
   *  When omitted we fall back to tier-derived estimates. */
  monthlyByRxcui?: Record<string, number>;
  /** Pass-through to the CalendarYearCost child. */
  calendarYearCostDefaultOpen?: boolean;
}

const TIER_LABELS: { tier: number; key: keyof Plan['benefits']['rx_tiers']; name: string }[] = [
  { tier: 1, key: 'tier_1', name: 'Preferred Generic' },
  { tier: 2, key: 'tier_2', name: 'Generic' },
  { tier: 3, key: 'tier_3', name: 'Preferred Brand' },
  { tier: 4, key: 'tier_4', name: 'Non-Preferred Brand' },
  { tier: 5, key: 'tier_5', name: 'Specialty' },
];

function tierShareLabel(share: Plan['benefits']['rx_tiers']['tier_1'] | undefined): string {
  if (!share) return '—';
  if (typeof share.copay === 'number') return `$${share.copay}`;
  if (typeof share.coinsurance === 'number' && share.coinsurance > 0) {
    return `${Math.round(share.coinsurance > 1 ? share.coinsurance : share.coinsurance * 100)}%`;
  }
  return '—';
}

function medTier(hit: FormularyHit | undefined): {
  tier: FormularyTier | 'not_covered';
  label: string;
  color: string;
} {
  const t = hit?.tier ?? 'not_covered';
  if (t === 'not_covered' || t === 'excluded') {
    return { tier: 'not_covered', label: 'Not on formulary', color: '#d63031' };
  }
  return { tier: t, label: `Tier ${t}`, color: '#0d2f5e' };
}

function medMonthly(
  hit: FormularyHit | undefined,
  override: number | undefined,
): { value: string; estimate: boolean } {
  if (typeof override === 'number') {
    return { value: `$${override}`, estimate: false };
  }
  if (!hit || hit.tier === 'not_covered' || hit.tier === 'excluded') {
    return { value: '—', estimate: false };
  }
  if (typeof hit.copay === 'number') {
    return { value: `$${hit.copay}`, estimate: false };
  }
  const tierNum = typeof hit.tier === 'number' ? hit.tier : 0;
  const est = monthlyCostFromFormulary({
    tier: tierNum,
    copay: null,
    coinsurance: hit.coinsurance,
  });
  if (est > 0) return { value: `est. $${est}`, estimate: true };
  return { value: '$0', estimate: false };
}

export function PlanRxSection({
  plan,
  medications,
  formulary,
  monthlyByRxcui,
  calendarYearCostDefaultOpen,
}: Props) {
  const deductibleLabel = plan.drug_deductible == null || plan.drug_deductible === 0
    ? '$0'
    : `$${plan.drug_deductible}`;

  return (
    <section className="prx">
      <header className="prx-hdr">
        <h3 className="prx-title">Prescription Drugs and Cost Protection</h3>
        <div className="prx-ded">
          <span className="prx-ded-l">Drug deductible</span>
          <span className="prx-ded-v">{deductibleLabel}</span>
        </div>
      </header>

      <div className="prx-tier-grid">
        {TIER_LABELS.map((t) => {
          const share = plan.benefits.rx_tiers[t.key];
          return (
            <div key={t.key} className="prx-tier">
              <div className="prx-tier-n">Tier {t.tier}</div>
              <div className="prx-tier-name">{t.name}</div>
              <div className="prx-tier-v">{tierShareLabel(share)}</div>
            </div>
          );
        })}
      </div>

      {medications.length > 0 && (
        <div className="prx-meds">
          <div className="prx-meds-hdr">Your Medications on this plan</div>
          {medications.map((med) => {
            const hit = med.rxcui ? formulary[med.rxcui] : undefined;
            const tInfo = medTier(hit);
            const cost = medMonthly(hit, med.rxcui ? monthlyByRxcui?.[med.rxcui] : undefined);
            const notes: string[] = [];
            if (hit?.prior_auth) notes.push('Prior auth');
            if (hit?.step_therapy) notes.push('Step therapy');
            if (hit?.quantity_limit) notes.push('Quantity limit');
            return (
              <div key={med.id} className="prx-med">
                <div className="prx-med-info">
                  <div className="prx-med-n">{med.name}</div>
                  {med.strength && (
                    <div className="prx-med-d">{med.strength}{med.form ? ` · ${med.form}` : ''}</div>
                  )}
                  {notes.length > 0 && (
                    <div className="prx-med-warn">{notes.join(' · ')}</div>
                  )}
                </div>
                <div className="prx-med-tier">
                  <span
                    className="prx-tier-pill"
                    style={{ background: tInfo.color }}
                  >
                    {tInfo.label}
                  </span>
                </div>
                <div className={`prx-med-cost${cost.estimate ? ' est' : ''}`}>
                  {cost.value}
                  {cost.estimate && <span className="prx-med-cost-sub"> /mo</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <CalendarYearCost
        medications={medications}
        plan={plan}
        formulary={formulary}
        defaultOpen={calendarYearCostDefaultOpen}
      />
    </section>
  );
}
