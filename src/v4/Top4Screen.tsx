// Top4Screen — consumer Plan Match entry point.
//
// Shows the top 4 finalist plans as cards, each with the full
// Prescription Drugs section + CalendarYearCost accordion. Tap a card
// to drill into PlanDetailView for that plan; tap "Compare all 4
// side-by-side" to drop into the QuoteDeliveryV4 column table.
//
// Replaces the previous QuotePage default (which mounted Step6QuoteDelivery
// directly into the side-by-side table). The user's first view is now
// per-plan cards — the comparison table is reachable but not the
// default surface.

import { useEffect, useMemo, useState } from 'react';
import type { Plan } from '@/types/plans';
import { useSession } from '@/hooks/useSession';
import { usePlanBrain, type ScoredPlan } from '@/hooks/usePlanBrain';
import { fetchPlansByIds } from '@/lib/planCatalog';
import { findPlan } from '@/lib/cmsPlans';
import { brainSlotToFormularyMap } from '@/lib/partDPhaseCalc';
import { PlanRxSection } from '@/components/PlanRxSection';

interface Props {
  onSelectPlan: (planId: string) => void;
  onCompare: () => void;
}

// Variant colors mirror the QuoteDeliveryV4 ribbon palette so a card
// labeled "Best Rx" on this screen visually matches the navy column
// the user sees later in the compare view.
const RIBBON_LABEL: Record<string, { title: string; color: string }> = {
  LOWEST_DRUG_COST: { title: 'Best Rx', color: '#0d2f5e' },
  BEST_OVERALL: { title: 'Best Overall', color: '#0d2f5e' },
  LOWEST_OOP: { title: 'Lowest OOP', color: '#0f6e56' },
  PART_B_SAVINGS: { title: 'Part B Giveback', color: '#3b6d11' },
};

function planRibbon(s: ScoredPlan): { title: string; color: string } {
  if (s.ribbon && RIBBON_LABEL[s.ribbon]) return RIBBON_LABEL[s.ribbon];
  return { title: 'Strong Match', color: '#0d2f5e' };
}

export function Top4Screen({ onSelectPlan, onCompare }: Props) {
  const client = useSession((s) => s.client);
  const medications = useSession((s) => s.medications);
  const providers = useSession((s) => s.providers);
  const finalistIds = useSession((s) => s.selectedFinalists);

  const [finalists, setFinalists] = useState<Plan[]>([]);
  const [loadingFinalists, setLoadingFinalists] = useState(false);

  useEffect(() => {
    if (finalistIds.length === 0) {
      setFinalists([]);
      return;
    }
    let cancelled = false;
    setLoadingFinalists(true);
    fetchPlansByIds(finalistIds)
      .then((plans) => {
        if (cancelled) return;
        if (plans.length > 0) {
          setFinalists(plans);
        } else {
          // Fallback to the static seed lookup so the screen still
          // renders if /api/plans is down (mirrors Step6 behavior).
          setFinalists(
            finalistIds
              .map((id) => findPlan(id))
              .filter((p): p is Plan => !!p),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingFinalists(false);
      });
    return () => {
      cancelled = true;
    };
  }, [finalistIds]);

  const { result, data: brainData, loading: brainLoading } = usePlanBrain({
    plans: finalists,
    client,
    medications,
    providers,
    userPriorities: [],
    conditionProfile: null,
    weightOverride: null,
  });

  const top4 = useMemo<ScoredPlan[]>(() => {
    if (!result) return [];
    return [...result.scored]
      .filter((s) => !s.disqualified)
      .sort((a, b) => b.composite - a.composite)
      .slice(0, 4);
  }, [result]);

  if (loadingFinalists || brainLoading) {
    return (
      <div className="t4-loading">Loading plans…</div>
    );
  }

  if (finalists.length === 0) {
    return (
      <div className="t4-empty">
        No finalists yet. Complete the earlier steps so the filter engine
        can narrow the plan pool.
      </div>
    );
  }

  if (top4.length === 0) {
    return (
      <div className="t4-empty">
        Brain still warming up. The ranking will appear shortly.
      </div>
    );
  }

  return (
    <div className="t4">
      <div className="t4-intro">
        <h2 className="t4-h">Your top {top4.length} plan{top4.length === 1 ? '' : 's'}</h2>
        <p className="t4-sub">
          Ranked by your medications, providers, and benefits. Tap a card
          to see the full plan, or compare all of them side-by-side.
        </p>
        <button type="button" className="btn pri" onClick={onCompare}>
          Compare all {top4.length} side-by-side →
        </button>
      </div>

      <div className="t4-cards">
        {top4.map((s, i) => {
          const cp = `${s.plan.contract_id}-${s.plan.plan_number}`;
          const formulary = brainSlotToFormularyMap(
            brainData?.formularyByContractPlan[cp],
          );
          const ribbon = planRibbon(s);
          const annual = s.realAnnualCost?.netAnnual ?? null;
          return (
            <article key={s.plan.id} className="t4-card">
              <header className="t4-card-hdr">
                <div className="t4-card-rank">#{i + 1}</div>
                <div className="t4-card-id">
                  <div className="t4-card-carrier">{s.plan.carrier}</div>
                  <div className="t4-card-name">{s.plan.plan_name}</div>
                </div>
                <span
                  className="t4-ribbon"
                  style={{ background: ribbon.color }}
                >
                  {ribbon.title}
                </span>
              </header>
              <div className="t4-card-kpis">
                <div className="t4-kpi">
                  <div className="t4-kpi-l">Monthly premium</div>
                  <div className="t4-kpi-v">${s.plan.premium}/mo</div>
                </div>
                <div className="t4-kpi">
                  <div className="t4-kpi-l">Annual MOOP</div>
                  <div className="t4-kpi-v">${s.plan.moop_in_network.toLocaleString()}</div>
                </div>
                <div className="t4-kpi">
                  <div className="t4-kpi-l">Star rating</div>
                  <div className="t4-kpi-v">{s.plan.star_rating} ★</div>
                </div>
                <div className="t4-kpi">
                  <div className="t4-kpi-l">Est. total / year</div>
                  <div className="t4-kpi-v">
                    {annual != null ? `$${Math.round(annual).toLocaleString()}` : '—'}
                  </div>
                </div>
              </div>

              <PlanRxSection
                plan={s.plan}
                medications={medications}
                formulary={formulary}
              />

              <footer className="t4-card-foot">
                <button
                  type="button"
                  className="btn out"
                  onClick={() => onSelectPlan(s.plan.id)}
                >
                  See full plan details →
                </button>
              </footer>
            </article>
          );
        })}
      </div>
    </div>
  );
}
