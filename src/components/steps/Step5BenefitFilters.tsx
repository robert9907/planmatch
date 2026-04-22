import { useEffect, useMemo, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import { StepHeader } from './StepHeader';
import { findPlan } from '@/lib/cmsPlans';
import { fetchPlansForClient, lastPlanSource } from '@/lib/planCatalog';
import { computeFunnel, finalistIdsFromSnapshot } from '@/lib/planFilter';
import type { BenefitFilter, BenefitKey, CutTag, Plan } from '@/types/plans';

interface Step5Props {
  onAdvance: () => void;
}

interface BenefitConfig {
  key: BenefitKey;
  icon: string;
  label: string;
  subToggles: { key: string; label: string }[];
  tiers: { value: BenefitFilter['tier']; label: string; body: string }[];
}

const CONFIGS: BenefitConfig[] = [
  {
    key: 'dental',
    icon: '🦷',
    label: 'Dental',
    subToggles: [
      { key: 'comprehensive', label: 'Comprehensive coverage required' },
    ],
    tiers: [
      { value: 'any', label: 'Any', body: 'Preventive OK' },
      { value: 'enhanced', label: 'Enhanced', body: '≥ $1500 max' },
      { value: 'premium', label: 'Premium', body: '≥ $2500 max' },
    ],
  },
  {
    key: 'vision',
    icon: '👁',
    label: 'Vision',
    subToggles: [],
    tiers: [
      { value: 'any', label: 'Any', body: 'Exam covered' },
      { value: 'enhanced', label: 'Enhanced', body: '≥ $250 eyewear' },
      { value: 'premium', label: 'Premium', body: '≥ $350 eyewear' },
    ],
  },
  {
    key: 'hearing',
    icon: '👂',
    label: 'Hearing',
    subToggles: [],
    tiers: [
      { value: 'any', label: 'Any', body: 'Some allowance' },
      { value: 'enhanced', label: 'Enhanced', body: '≥ $1500 aids' },
      { value: 'premium', label: 'Premium', body: '≥ $2000 aids' },
    ],
  },
  {
    key: 'transportation',
    icon: '🚗',
    label: 'Transportation',
    subToggles: [],
    tiers: [
      { value: 'any', label: 'Any', body: '≥ 12 rides/yr' },
      { value: 'enhanced', label: 'Enhanced', body: '≥ 24 rides/yr' },
      { value: 'premium', label: 'Premium', body: '≥ 36 rides/yr' },
    ],
  },
  {
    key: 'otc',
    icon: '💊',
    label: 'OTC allowance',
    subToggles: [],
    tiers: [
      { value: 'any', label: 'Any', body: '≥ $50/qtr' },
      { value: 'enhanced', label: 'Enhanced', body: '≥ $150/qtr' },
      { value: 'premium', label: 'Premium', body: '≥ $200/qtr' },
    ],
  },
  {
    key: 'food_card',
    icon: '🥦',
    label: 'Food card',
    subToggles: [],
    tiers: [
      { value: 'any', label: 'Any', body: 'Any amount' },
      { value: 'enhanced', label: 'Enhanced', body: '≥ $100/mo' },
      { value: 'premium', label: 'Premium', body: '≥ $150/mo' },
    ],
  },
  {
    key: 'diabetic',
    icon: '🩸',
    label: 'Diabetic supplies',
    subToggles: [
      { key: 'onetouch', label: 'OneTouch preferred' },
      { key: 'accuchek', label: 'Accu-Chek preferred' },
    ],
    tiers: [
      { value: 'any', label: 'Any', body: 'Any brand' },
      { value: 'enhanced', label: 'Enhanced', body: 'Broad coverage' },
      { value: 'premium', label: 'Premium', body: 'All brands' },
    ],
  },
  {
    key: 'fitness',
    icon: '🏋',
    label: 'Fitness',
    subToggles: [
      { key: 'silversneakers', label: 'SilverSneakers' },
      { key: 'renew_active', label: 'Renew Active' },
    ],
    tiers: [
      { value: 'any', label: 'Any', body: 'Any program' },
      { value: 'enhanced', label: 'Enhanced', body: 'Popular programs' },
      { value: 'premium', label: 'Premium', body: 'Premium programs' },
    ],
  },
];

export function Step5BenefitFilters({ onAdvance }: Step5Props) {
  const client = useSession((s) => s.client);
  const medications = useSession((s) => s.medications);
  const providers = useSession((s) => s.providers);
  const benefitFilters = useSession((s) => s.benefitFilters);
  const setBenefitFilter = useSession((s) => s.setBenefitFilter);
  const resetBenefitFilters = useSession((s) => s.resetBenefitFilters);
  const setSelectedFinalists = useSession((s) => s.setSelectedFinalists);

  const [eligiblePlans, setEligiblePlans] = useState<Plan[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [planSource, setPlanSource] = useState<'pm_plans' | 'static_fallback' | null>(null);

  // Re-fetch pm_plans whenever the client's geo/plan-type narrows.
  // planCatalog.fetchPlansForClient() proxies /api/plans which joins
  // pm_plan_benefits so every plan in the result already carries its
  // dental / vision / hearing / premium / star shape. AbortController
  // ignores results from stale queries if the client types faster
  // than the network can return.
  useEffect(() => {
    let cancelled = false;
    setPlansLoading(true);
    fetchPlansForClient({
      state: client.state,
      county: client.county,
      planType: client.planType,
    })
      .then((plans) => {
        if (cancelled) return;
        setEligiblePlans(plans);
        setPlanSource(lastPlanSource());
      })
      .finally(() => {
        if (!cancelled) setPlansLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client.state, client.planType, client.county]);

  const snapshot = useMemo(
    () => computeFunnel({ plans: eligiblePlans, medications, providers, benefitFilters }),
    [eligiblePlans, medications, providers, benefitFilters],
  );

  const finalistIds = useMemo(
    () => finalistIdsFromSnapshot(eligiblePlans, snapshot),
    [eligiblePlans, snapshot],
  );

  useEffect(() => {
    setSelectedFinalists(finalistIds);
  }, [finalistIds, setSelectedFinalists]);

  return (
    <div className="flex flex-col gap-4">
      <StepHeader
        number={5}
        title="Benefit filters"
        subtitle="Toggle a benefit to make it a hard requirement. Plans failing the requirement get cut from the finalist pool — reasons shown below."
        right={
          <button type="button" onClick={resetBenefitFilters} className="pm-btn">
            Reset filters
          </button>
        }
      />

      <FunnelStrip snapshot={snapshot} loading={plansLoading} source={planSource} />

      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}
      >
        {CONFIGS.map((c) => (
          <BenefitCard
            key={c.key}
            config={c}
            state={benefitFilters[c.key]}
            onChange={(patch) => setBenefitFilter(c.key, patch)}
          />
        ))}
      </div>

      <CutTagsList cuts={snapshot.cuts} />

      <div className="flex items-center justify-between">
        <div style={{ color: 'var(--i3)', fontSize: 12 }}>
          {snapshot.finalists} finalist{snapshot.finalists === 1 ? '' : 's'} ready to quote
        </div>
        <button
          type="button"
          onClick={onAdvance}
          disabled={snapshot.finalists === 0}
          className="pm-btn pm-btn-primary"
          style={{ opacity: snapshot.finalists === 0 ? 0.5 : 1 }}
        >
          Continue to quote →
        </button>
      </div>
    </div>
  );
}

function FunnelStrip({
  snapshot,
  loading,
  source,
}: {
  snapshot: ReturnType<typeof computeFunnel>;
  loading: boolean;
  source: 'pm_plans' | 'static_fallback' | null;
}) {
  const steps = [
    { label: 'Total in area', value: snapshot.total, color: 'var(--i2)' },
    { label: 'Providers ✓', value: snapshot.after_providers, color: 'var(--blue)' },
    { label: 'Rx ✓', value: snapshot.after_formulary, color: 'var(--teal)' },
    { label: 'Finalists', value: snapshot.finalists, color: 'var(--sage)' },
  ];
  return (
    <div className="pm-surface" style={{ padding: 12 }}>
      <div className="flex items-center" style={{ gap: 8 }}>
        {steps.map((s, i) => (
          <span key={s.label} className="flex items-center gap-2" style={{ flex: 1 }}>
            <div style={{ flex: 1 }}>
              <div
                className="uppercase font-semibold"
                style={{ color: 'var(--i3)', fontSize: 10, letterSpacing: '0.06em' }}
              >
                {s.label}
              </div>
              <div
                style={{ color: s.color, fontSize: 22, fontWeight: 700, fontFamily: 'Lora, serif' }}
              >
                {loading ? '…' : s.value}
              </div>
            </div>
            {i < steps.length - 1 && (
              <span style={{ color: 'var(--i3)', fontSize: 18 }}>→</span>
            )}
          </span>
        ))}
      </div>
      {(source === 'static_fallback' || (source === 'pm_plans' && snapshot.total > 0)) && (
        <div
          style={{
            marginTop: 8,
            fontSize: 10,
            color: source === 'static_fallback' ? 'var(--amb)' : 'var(--i3)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          {source === 'static_fallback'
            ? '⚠ Static fallback — /api/plans errored. Results reflect 12-plan seed, not live landscape.'
            : 'Source: pm_plans · CMS CY2026 landscape'}
        </div>
      )}
    </div>
  );
}

function BenefitCard({
  config,
  state,
  onChange,
}: {
  config: BenefitConfig;
  state: BenefitFilter;
  onChange: (patch: Partial<BenefitFilter>) => void;
}) {
  const enabled = state.enabled;
  return (
    <div
      className="pm-surface"
      style={{
        padding: 12,
        borderColor: enabled ? 'var(--sage)' : 'var(--w2)',
        background: enabled ? 'var(--sl)' : 'var(--wh)',
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 22, lineHeight: 1 }}>{config.icon}</span>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{config.label}</span>
        </div>
        <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--i2)' }}>
            {enabled ? 'Required' : 'Optional'}
          </span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
            style={{ width: 18, height: 18, accentColor: 'var(--sage)' }}
          />
        </label>
      </div>

      <div
        style={{
          marginTop: 10,
          opacity: enabled ? 1 : 0.45,
          pointerEvents: enabled ? 'auto' : 'none',
          transition: 'opacity 120ms ease',
        }}
      >
        <div className="flex" style={{ gap: 4, marginBottom: 8 }}>
          {config.tiers.map((t) => {
            const active = state.tier === t.value;
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => onChange({ tier: t.value })}
                className="text-left"
                style={{
                  flex: 1,
                  padding: '6px 8px',
                  borderRadius: 7,
                  border: `1px solid ${active ? 'var(--sage)' : 'var(--w2)'}`,
                  background: active ? 'var(--sage)' : 'var(--wh)',
                  color: active ? '#fff' : 'var(--ink)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 700 }}>{t.label}</div>
                <div style={{ fontSize: 10, opacity: active ? 0.9 : 0.7 }}>{t.body}</div>
              </button>
            );
          })}
        </div>

        {config.subToggles.length > 0 && (
          <div className="flex flex-col gap-1">
            {config.subToggles.map((st) => (
              <label
                key={st.key}
                className="flex items-center gap-2"
                style={{
                  fontSize: 12,
                  padding: '4px 6px',
                  borderRadius: 6,
                  background: 'var(--warm)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={!!state.subToggles?.[st.key]}
                  onChange={(e) =>
                    onChange({ subToggles: { ...state.subToggles, [st.key]: e.target.checked } })
                  }
                  style={{ width: 14, height: 14, accentColor: 'var(--sage)' }}
                />
                {st.label}
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CutTagsList({ cuts }: { cuts: CutTag[] }) {
  if (cuts.length === 0) return null;
  const byPlan = new Map<string, CutTag[]>();
  for (const cut of cuts) {
    const list = byPlan.get(cut.plan_id) ?? [];
    list.push(cut);
    byPlan.set(cut.plan_id, list);
  }
  return (
    <div className="pm-surface" style={{ padding: 14 }}>
      <div
        className="uppercase font-semibold"
        style={{ color: 'var(--i3)', fontSize: 10, letterSpacing: '0.08em', marginBottom: 8 }}
      >
        Eliminated plans · {byPlan.size}
      </div>
      <div className="flex flex-wrap" style={{ gap: 6 }}>
        {Array.from(byPlan.entries()).map(([planId, planCuts]) => {
          const plan = findPlan(planId);
          return (
            <CutTagChip key={planId} plan={plan} cuts={planCuts} />
          );
        })}
      </div>
    </div>
  );
}

function CutTagChip({ plan, cuts }: { plan: Plan | null; cuts: CutTag[] }) {
  const primary = cuts[0];
  const reasonLabel: Record<string, string> = {
    benefit_filter: 'Benefits',
    formulary_gap: 'Formulary',
    provider_out_of_network: 'Provider',
    premium_too_high: 'Premium',
    wrong_state: 'State',
    wrong_plan_type: 'Plan type',
  };
  return (
    <div
      title={cuts.map((c) => c.detail).join('\n')}
      style={{
        padding: '6px 10px',
        borderRadius: 8,
        background: 'var(--rt)',
        border: '1px solid var(--red)',
        color: 'var(--red)',
        fontSize: 11,
        fontWeight: 600,
        maxWidth: 280,
      }}
    >
      <div style={{ color: 'var(--red)' }}>
        {plan ? `${plan.carrier} · ${plan.plan_number}` : primary.plan_id}
      </div>
      <div style={{ fontWeight: 500, fontSize: 10, marginTop: 2 }}>
        {cuts.map((c) => `${reasonLabel[c.reason] ?? c.reason}: ${c.detail}`).join(' · ')}
      </div>
    </div>
  );
}
