// PlanDetailView — single-plan deep-dive reachable from Top4Screen.
//
// Layout (under the v4 phdr/cnt chrome):
//   • Plan header (carrier · plan name · star)
//   • KPI strip (premium / MOOP / drug deductible / annual cost)
//   • PlanRxSection (drug deductible, tier table, meds, CalendarYearCost)
//   • Medical copays summary
//   • Extra benefits chips
//   • Back / Compare-side-by-side actions
//
// Like Top4Screen, this component owns its own usePlanBrain call. We
// accept that the underlying /api/plan-brain-data hits the network when
// the user transitions between views — the data is keyed by the same
// (plans, client, meds, providers) tuple as Top4Screen so the request
// is short and the brain cache server-side will return the same payload.

import { useEffect, useMemo, useState } from 'react';
import type { Plan } from '@/types/plans';
import { useSession } from '@/hooks/useSession';
import { usePlanBrain } from '@/hooks/usePlanBrain';
import { fetchPlansByIds } from '@/lib/planCatalog';
import { findPlan } from '@/lib/cmsPlans';
import { brainSlotToFormularyMap } from '@/lib/partDPhaseCalc';
import { PlanRxSection } from '@/components/PlanRxSection';
import {
  formatDental,
  formatVision,
  formatHearing,
  formatOtc,
  formatFoodCard,
} from '@/lib/extractBenefitValue';

interface Props {
  planId: string;
  onBack: () => void;
  onCompare: () => void;
}

interface CopayLine {
  label: string;
  value: string;
}

function copayCell(share: { copay: number | null; coinsurance: number | null } | undefined): string {
  if (!share) return '—';
  if (typeof share.copay === 'number') return `$${share.copay}`;
  if (typeof share.coinsurance === 'number' && share.coinsurance > 0) {
    return `${Math.round(share.coinsurance > 1 ? share.coinsurance : share.coinsurance * 100)}%`;
  }
  return '—';
}

export function PlanDetailView({ planId, onBack, onCompare }: Props) {
  const client = useSession((s) => s.client);
  const medications = useSession((s) => s.medications);
  const providers = useSession((s) => s.providers);
  const finalistIds = useSession((s) => s.selectedFinalists);

  // Resolve the plan + the full finalist set (the brain still needs all
  // finalists as input so its ranking is consistent with Top4Screen).
  const [finalists, setFinalists] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ids = Array.from(new Set([planId, ...finalistIds]));
    if (ids.length === 0) return;
    let cancelled = false;
    setLoading(true);
    fetchPlansByIds(ids)
      .then((plans) => {
        if (cancelled) return;
        if (plans.length > 0) setFinalists(plans);
        else {
          setFinalists(ids.map((id) => findPlan(id)).filter((p): p is Plan => !!p));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [planId, finalistIds]);

  const { data: brainData, loading: brainLoading } = usePlanBrain({
    plans: finalists,
    client,
    medications,
    providers,
    userPriorities: [],
    conditionProfile: null,
    weightOverride: null,
  });

  const plan = useMemo(() => finalists.find((p) => p.id === planId) ?? null, [finalists, planId]);

  const medicalRows = useMemo<CopayLine[]>(() => {
    if (!plan) return [];
    const m = plan.benefits.medical;
    return [
      { label: 'Primary care', value: copayCell(m.primary_care) },
      { label: 'Specialist', value: copayCell(m.specialist) },
      { label: 'Urgent care', value: copayCell(m.urgent_care) },
      { label: 'Emergency room', value: copayCell(m.emergency) },
      { label: 'Inpatient hospital (day 1)', value: copayCell(m.inpatient) },
      { label: 'Skilled nursing (day 1)', value: copayCell(m.snf) },
      { label: 'Outpatient surgery (hospital)', value: copayCell(m.outpatient_surgery_hospital) },
      { label: 'Outpatient surgery (ASC)', value: copayCell(m.outpatient_surgery_asc) },
      { label: 'Outpatient observation', value: copayCell(m.outpatient_observation) },
      { label: 'Lab services', value: copayCell(m.lab_services) },
      { label: 'X-ray', value: copayCell(m.xray) },
      { label: 'Mental health (individual)', value: copayCell(m.mental_health_individual) },
      { label: 'Mental health (group)', value: copayCell(m.mental_health_group) },
      { label: 'Telehealth', value: copayCell(m.telehealth) },
    ];
  }, [plan]);

  if (loading || brainLoading) {
    return <div className="t4-loading">Loading plan details…</div>;
  }

  if (!plan) {
    return (
      <div className="t4-empty">
        Plan not found. <button type="button" className="btn out" onClick={onBack}>← Back</button>
      </div>
    );
  }

  const cp = `${plan.contract_id}-${plan.plan_number}`;
  const formulary = brainSlotToFormularyMap(brainData?.formularyByContractPlan[cp]);
  const deductibleLabel = plan.drug_deductible == null || plan.drug_deductible === 0
    ? '$0'
    : `$${plan.drug_deductible}`;

  return (
    <div className="pdv">
      <div className="pdv-bar">
        <button type="button" className="btn out" onClick={onBack}>← Back to Top {finalistIds.length}</button>
        <button type="button" className="btn pri" onClick={onCompare}>Compare side-by-side →</button>
      </div>

      <header className="pdv-hdr">
        <div className="pdv-hdr-l">
          <div className="pdv-carrier">{plan.carrier}</div>
          <h2 className="pdv-name">{plan.plan_name}</h2>
          <div className="pdv-meta">
            {plan.plan_type} · {plan.star_rating} ★ · {client.county || plan.counties[0]}, {plan.state}
          </div>
        </div>
      </header>

      <div className="pdv-kpis">
        <div className="pdv-kpi">
          <div className="pdv-kpi-l">Monthly premium</div>
          <div className="pdv-kpi-v">${plan.premium}<small>/mo</small></div>
        </div>
        <div className="pdv-kpi">
          <div className="pdv-kpi-l">Annual MOOP (in-network)</div>
          <div className="pdv-kpi-v">${plan.moop_in_network.toLocaleString()}</div>
        </div>
        <div className="pdv-kpi">
          <div className="pdv-kpi-l">Drug deductible</div>
          <div className="pdv-kpi-v">{deductibleLabel}</div>
        </div>
        <div className="pdv-kpi">
          <div className="pdv-kpi-l">Part B giveback</div>
          <div className="pdv-kpi-v">
            {(plan.part_b_giveback ?? 0) > 0 ? `$${plan.part_b_giveback}/mo` : '—'}
          </div>
        </div>
      </div>

      <PlanRxSection
        plan={plan}
        medications={medications}
        formulary={formulary}
        calendarYearCostDefaultOpen
      />

      <section className="pdv-section">
        <h3 className="pdv-section-h">Medical Copays</h3>
        <div className="pdv-copay-grid">
          {medicalRows.map((r) => (
            <div key={r.label} className="pdv-copay">
              <div className="pdv-copay-l">{r.label}</div>
              <div className="pdv-copay-v">{r.value}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="pdv-section">
        <h3 className="pdv-section-h">Extra Benefits</h3>
        <div className="pdv-extras">
          <div className="pdv-extra">
            <div className="pdv-extra-l">Dental</div>
            <div className="pdv-extra-v">
              {formatDental(plan.benefits.dental.annual_max, plan.benefits.dental.description)}
            </div>
          </div>
          <div className="pdv-extra">
            <div className="pdv-extra-l">Vision</div>
            <div className="pdv-extra-v">
              {formatVision(
                plan.benefits.vision.eyewear_allowance_year,
                plan.benefits.vision.exam,
                plan.benefits.vision.description,
              )}
            </div>
          </div>
          <div className="pdv-extra">
            <div className="pdv-extra-l">Hearing</div>
            <div className="pdv-extra-v">
              {formatHearing(
                plan.benefits.hearing.aid_allowance_year,
                plan.benefits.hearing.exam,
                plan.benefits.hearing.description,
              )}
            </div>
          </div>
          <div className="pdv-extra">
            <div className="pdv-extra-l">OTC</div>
            <div className="pdv-extra-v">
              {formatOtc(plan.benefits.otc.allowance_per_quarter, plan.benefits.otc.description)}
            </div>
          </div>
          <div className="pdv-extra">
            <div className="pdv-extra-l">Food Card</div>
            <div className="pdv-extra-v">
              {formatFoodCard(
                plan.benefits.food_card.allowance_per_month,
                plan.benefits.food_card.description,
              )}
            </div>
          </div>
          <div className="pdv-extra">
            <div className="pdv-extra-l">Fitness</div>
            <div className="pdv-extra-v">
              {plan.benefits.fitness.enabled
                ? plan.benefits.fitness.program ?? 'Included'
                : '—'}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
