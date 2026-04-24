// Extras & Filters — v4 redesign of Step 5.
//
// 3-column grid of benefit filter cards with on/off toggles, tier
// selector, value display, and per-filter plan impact count. Each
// required filter gets the seafoam border. Filter Pipeline summary
// card below shows the full funnel (plans → meds pass → providers
// pass → each filter → finalists).
//
// Uses the existing planFilter / benefitFilters session state and
// computeFunnel so the funnel math is identical to the legacy Step 5.

import { useEffect, useMemo, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import { fetchPlansForClient } from '@/lib/planCatalog';
import { computeFunnel, finalistIdsFromSnapshot } from '@/lib/planFilter';
import { bulkLookupFormulary } from '@/lib/formularyLookup';
import type { BenefitFilter, BenefitKey, Plan } from '@/types/plans';

interface Props {
  onBack: () => void;
  onContinue: () => void;
}

interface FilterConfig {
  key: BenefitKey;
  label: string;
  subtitle: string;
  tiers: { value: BenefitFilter['tier']; label: string }[];
  // Read the current value from a plan for display on the card
  formatValue: (plans: Plan[]) => string;
}

const CONFIGS: FilterConfig[] = [
  {
    key: 'dental', label: 'Dental',
    subtitle: 'Preventive + Comprehensive',
    tiers: [
      { value: 'any', label: 'Any' },
      { value: 'enhanced', label: '$1,500+' },
      { value: 'premium', label: '$2,500+' },
    ],
    formatValue: (plans) => {
      const max = Math.max(0, ...plans.map((p) => p.benefits.dental.annual_max));
      return max > 0 ? `$${max.toLocaleString()}/yr` : '—';
    },
  },
  {
    key: 'vision', label: 'Vision',
    subtitle: 'Exam + Eyewear',
    tiers: [
      { value: 'any', label: 'Any' },
      { value: 'enhanced', label: '$200+' },
      { value: 'premium', label: '$350+' },
    ],
    formatValue: (plans) => {
      const max = Math.max(0, ...plans.map((p) => p.benefits.vision.eyewear_allowance_year));
      return max > 0 ? `$${max}/yr` : '—';
    },
  },
  {
    key: 'hearing', label: 'Hearing',
    subtitle: 'Hearing aids + exams',
    tiers: [
      { value: 'any', label: 'Any' },
      { value: 'enhanced', label: '$1,500+' },
      { value: 'premium', label: '$2,000+' },
    ],
    formatValue: (plans) => {
      const max = Math.max(0, ...plans.map((p) => p.benefits.hearing.aid_allowance_year));
      return max > 0 ? `$${max}/yr` : '—';
    },
  },
  {
    key: 'otc', label: 'OTC',
    subtitle: 'Quarterly OTC credit',
    tiers: [
      { value: 'any', label: 'Any' },
      { value: 'enhanced', label: '$150/qtr+' },
      { value: 'premium', label: '$300/qtr+' },
    ],
    formatValue: (plans) => {
      const max = Math.max(0, ...plans.map((p) => p.benefits.otc.allowance_per_quarter));
      return max > 0 ? `$${max}/qtr` : '—';
    },
  },
  {
    key: 'food_card', label: 'Food Card',
    subtitle: 'Monthly grocery benefit',
    tiers: [
      { value: 'any', label: 'Any' },
      { value: 'enhanced', label: '$50/mo+' },
      { value: 'premium', label: '$100/mo+' },
    ],
    formatValue: (plans) => {
      const max = Math.max(0, ...plans.map((p) => p.benefits.food_card.allowance_per_month));
      return max > 0 ? `$${max}/mo` : '—';
    },
  },
  {
    key: 'transportation', label: 'Transport',
    subtitle: 'Non-emergency trips',
    tiers: [
      { value: 'any', label: 'Any' },
      { value: 'enhanced', label: '24+/yr' },
      { value: 'premium', label: '36+/yr' },
    ],
    formatValue: (plans) => {
      const max = Math.max(0, ...plans.map((p) => p.benefits.transportation.rides_per_year));
      return max > 0 ? `${max} trips/yr` : '—';
    },
  },
  {
    key: 'fitness', label: 'Fitness',
    subtitle: 'Gym program',
    tiers: [
      { value: 'any', label: 'Any' },
      { value: 'enhanced', label: 'SilverSneakers' },
      { value: 'premium', label: 'Renew Active' },
    ],
    formatValue: (plans) => {
      const anyFitness = plans.some((p) => p.benefits.fitness.enabled);
      return anyFitness ? 'Included' : '—';
    },
  },
  {
    key: 'diabetic', label: 'Diabetic',
    subtitle: 'Test strips + monitors',
    tiers: [
      { value: 'any', label: 'Any' },
      { value: 'enhanced', label: 'Broad' },
      { value: 'premium', label: 'All brands' },
    ],
    formatValue: (plans) => {
      const anyDiab = plans.some((p) => p.benefits.diabetic.covered);
      return anyDiab ? 'Included' : '—';
    },
  },
];

export function ExtrasPage({ onBack, onContinue }: Props) {
  const client = useSession((s) => s.client);
  const medications = useSession((s) => s.medications);
  const providers = useSession((s) => s.providers);
  const benefitFilters = useSession((s) => s.benefitFilters);
  const setBenefitFilter = useSession((s) => s.setBenefitFilter);
  const setSelectedFinalists = useSession((s) => s.setSelectedFinalists);

  const [eligiblePlans, setEligiblePlans] = useState<Plan[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchPlansForClient({
      state: client.state,
      county: client.county,
      planType: client.planType,
    }).then((plans) => { if (!cancelled) setEligiblePlans(plans); });
    return () => { cancelled = true; };
  }, [client.state, client.planType, client.county]);

  // Prime formulary for the funnel's Rx-coverage cut.
  const [formularyTick, setFormularyTick] = useState(0);
  useEffect(() => {
    if (eligiblePlans.length === 0 || medications.length === 0) return;
    let cancelled = false;
    const rxcuis = medications.map((m) => m.rxcui).filter((s): s is string => !!s);
    if (rxcuis.length === 0) return;
    const contractIds = [...new Set(eligiblePlans.map((p) => p.contract_id))];
    bulkLookupFormulary(contractIds, rxcuis).then(() => {
      if (!cancelled) setFormularyTick((t) => t + 1);
    });
    return () => { cancelled = true; };
  }, [eligiblePlans, medications]);

  const snapshot = useMemo(
    () => computeFunnel({ plans: eligiblePlans, medications, providers, benefitFilters }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eligiblePlans, medications, providers, benefitFilters, formularyTick],
  );
  const finalistIds = useMemo(
    () => finalistIdsFromSnapshot(eligiblePlans, snapshot),
    [eligiblePlans, snapshot],
  );
  useEffect(() => { setSelectedFinalists(finalistIds); }, [finalistIds, setSelectedFinalists]);

  // Per-filter pass count. Temporarily enable each filter in isolation
  // to see how many plans pass — matches the mockup's "48/54 pass".
  const perFilterPassCount = useMemo(() => {
    const out: Record<BenefitKey, { pass: number; total: number }> = {} as any;
    const total = snapshot.after_providers;
    for (const cfg of CONFIGS) {
      const current = benefitFilters[cfg.key];
      const soloFilters = { ...benefitFilters };
      for (const k of Object.keys(soloFilters) as BenefitKey[]) {
        soloFilters[k] = { ...soloFilters[k], enabled: k === cfg.key && current.enabled };
      }
      const soloSnap = computeFunnel({ plans: eligiblePlans, medications, providers, benefitFilters: soloFilters });
      out[cfg.key] = { pass: soloSnap.finalists, total };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligiblePlans, medications, providers, benefitFilters, formularyTick, snapshot.after_providers]);

  return (
    <>
      <div className="scroll">
        <div className="phdr">
          <div className="ptitle">Extra Benefits &amp; Filters</div>
          <div className="psub">Toggle benefits to filter. Required cuts plans. Optional sorts.</div>
          {client.name && (
            <div className="pclient">
              <strong>{client.name}</strong>
              {client.county ? ` · ${client.county}, ${client.state}` : ''}
              {client.planType ? ` · ${client.planType}` : ''}
            </div>
          )}
        </div>
        <div className="cnt">
          <div className="funnel">
            <div className="fs"><div className="fsn">{snapshot.after_providers}</div><div className="fsl">After Provs</div></div>
            <div className="fa">→</div>
            <div className="fs"><div className="fsn">{snapshot.finalists}</div><div className="fsl">Pass Filters</div></div>
            <div className="fa">→</div>
            <div className="fs act"><div className="fsn">{finalistIds.length}</div><div className="fsl">Finalists</div></div>
          </div>

          <div className="exg">
            {CONFIGS.map((cfg) => {
              const f = benefitFilters[cfg.key];
              const pass = perFilterPassCount[cfg.key];
              return (
                <div key={cfg.key} className={`exc${f.enabled ? ' req' : ''}`}>
                  <div className="ect">
                    <div className="ecn">{cfg.label}</div>
                    <button
                      type="button"
                      aria-label={`Toggle ${cfg.label} filter`}
                      className={`ectg ${f.enabled ? 'on' : 'off'}`}
                      onClick={() => setBenefitFilter(cfg.key, { enabled: !f.enabled })}
                    />
                  </div>
                  <div className="ectrs">
                    {cfg.tiers.map((t) => (
                      <button
                        key={t.value}
                        type="button"
                        className={`ectr${f.tier === t.value ? ' a' : ''}`}
                        onClick={() => setBenefitFilter(cfg.key, { tier: t.value })}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  <div className={`ecv${!f.enabled ? ' muted' : ''}`}>
                    {f.enabled ? cfg.formatValue(eligiblePlans) : '—'}
                  </div>
                  <div className="ecd">{cfg.subtitle}</div>
                  <div className="eci">
                    Plans: <strong>{pass.pass}/{pass.total}</strong>{pass.pass === pass.total ? '' : ' pass'}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="fsm">
            <div className="fst">Filter Pipeline</div>
            <div className="fsr"><div className="fsc p">✓</div><div className="fsx"><strong>{snapshot.total}</strong> plan{snapshot.total === 1 ? '' : 's'} in {client.county || 'county'}</div></div>
            <div className="fsr"><div className="fsc p">✓</div><div className="fsx"><strong>{snapshot.after_formulary}</strong> cover all {medications.length} med{medications.length === 1 ? '' : 's'}</div></div>
            <div className="fsr"><div className="fsc p">✓</div><div className="fsx"><strong>{snapshot.after_providers}</strong> in-network for {providers.length} provider{providers.length === 1 ? '' : 's'}</div></div>
            {CONFIGS.filter((c) => benefitFilters[c.key].enabled).map((c) => (
              <div key={c.key} className="fsr">
                <div className={`fsc ${perFilterPassCount[c.key].pass > 0 ? 'p' : 'f'}`}>{perFilterPassCount[c.key].pass > 0 ? '✓' : '✗'}</div>
                <div className="fsx"><strong>{perFilterPassCount[c.key].pass}</strong> pass {c.label}</div>
              </div>
            ))}
            <div className="fsr"><div className="fsc p">✓</div><div className="fsx"><strong>{finalistIds.length}</strong> finalist{finalistIds.length === 1 ? '' : 's'}</div></div>
          </div>
        </div>
      </div>
      <div className="bbar">
        <div className="bbar-info">
          <strong>{finalistIds.length}</strong> finalist{finalistIds.length === 1 ? '' : 's'} · {snapshot.total} → {finalistIds.length} plans
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn out" onClick={onBack}>← Back</button>
          <button type="button" className="btn sea" disabled={finalistIds.length === 0} onClick={onContinue}>
            Continue to Quote →
          </button>
        </div>
      </div>
    </>
  );
}
