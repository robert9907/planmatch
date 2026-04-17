import { useMemo, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import { StepHeader } from './StepHeader';
import { findPlan, formularyTierFor, lookupByHNumber } from '@/lib/cmsPlans';
import { BROKER } from '@/lib/constants';
import { ComplianceChecklist } from '@/components/compliance/ComplianceChecklist';
import { SaveSessionButton } from '@/components/sync/SaveSessionButton';
import { DISCLAIMERS, allComplianceItemIds } from '@/lib/compliance';
import type { Plan, FormularyTier } from '@/types/plans';
import type { SessionMode } from '@/types/session';

export function Step6QuoteDelivery() {
  const mode = useSession((s) => s.mode);
  const setMode = useSession((s) => s.setMode);

  return (
    <div className="flex flex-col gap-4">
      <StepHeader
        number={6}
        title="Quote & delivery"
        subtitle="Side-by-side finalists, client-ready card, and broker actions. Annual review mode loads the client's current plan and shows a delta against finalists."
        right={<ModeToggle mode={mode} onChange={setMode} />}
      />

      {mode === 'new_quote' ? <NewQuoteMode /> : <AnnualReviewMode />}

      <SaveSessionButton />
    </div>
  );
}

// ──────────────── Mode Toggle ────────────────

function ModeToggle({ mode, onChange }: { mode: SessionMode; onChange: (m: SessionMode) => void }) {
  return (
    <div
      className="flex"
      style={{
        borderRadius: 10,
        background: 'var(--w2)',
        padding: 3,
      }}
    >
      {(['new_quote', 'annual_review'] as const).map((m) => {
        const active = mode === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            style={{
              padding: '6px 12px',
              borderRadius: 7,
              border: 'none',
              background: active ? 'var(--wh)' : 'transparent',
              color: active ? 'var(--ink)' : 'var(--i2)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
            }}
          >
            {m === 'new_quote' ? 'New quote' : 'Annual review 2027'}
          </button>
        );
      })}
    </div>
  );
}

// ──────────────── New Quote Mode ────────────────

function NewQuoteMode() {
  const finalistIds = useSession((s) => s.selectedFinalists);
  const recommendation = useSession((s) => s.recommendation);
  const setRecommendation = useSession((s) => s.setRecommendation);

  const finalists = useMemo(
    () =>
      finalistIds
        .map((id) => findPlan(id))
        .filter((p): p is Plan => !!p),
    [finalistIds],
  );

  if (finalists.length === 0) {
    return (
      <div
        className="pm-surface"
        style={{
          padding: 24,
          textAlign: 'center',
          color: 'var(--i2)',
          fontSize: 13,
        }}
      >
        No finalists yet. Complete Steps 2–5 so the filter engine can narrow the plan pool.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <SideBySideTable
        finalists={finalists}
        recommendation={recommendation}
        onRecommend={setRecommendation}
      />
      <ClientDeliveryCard finalists={finalists} recommendation={recommendation} />
      <ComplianceChecklist />
      <BrokerActions recommendation={recommendation} />
    </div>
  );
}

function useComplianceReady(): boolean {
  const complianceChecked = useSession((s) => s.complianceChecked);
  const disclaimersConfirmed = useSession((s) => s.disclaimersConfirmed);
  const allIds = useMemo(allComplianceItemIds, []);
  const itemsDone = allIds.every((id) => complianceChecked.includes(id));
  const disclaimersDone = DISCLAIMERS.every((d) => disclaimersConfirmed.includes(d.id));
  return itemsDone && disclaimersDone;
}

function SideBySideTable({
  finalists,
  recommendation,
  onRecommend,
}: {
  finalists: Plan[];
  recommendation: string | null;
  onRecommend: (id: string | null) => void;
}) {
  const medications = useSession((s) => s.medications);

  const rows: { label: string; render: (p: Plan) => React.ReactNode }[] = [
    { label: 'Plan ID', render: (p) => `${p.contract_id}-${p.plan_number}` },
    {
      label: 'Premium',
      render: (p) => (
        <span style={{ fontWeight: 700 }}>
          {p.premium === 0 ? '$0' : `$${p.premium.toFixed(2)}/mo`}
        </span>
      ),
    },
    {
      label: 'MOOP in-network',
      render: (p) => `$${p.moop_in_network.toLocaleString()}`,
    },
    {
      label: 'Star rating',
      render: (p) => `${p.star_rating} ★`,
    },
    {
      label: 'Dental',
      render: (p) =>
        `$${p.benefits.dental.annual_max}/yr${p.benefits.dental.comprehensive ? ' · comp.' : ''}`,
    },
    {
      label: 'Vision eyewear',
      render: (p) => `$${p.benefits.vision.eyewear_allowance_year}/yr`,
    },
    {
      label: 'Hearing aids',
      render: (p) => `$${p.benefits.hearing.aid_allowance_year}/yr`,
    },
    {
      label: 'Transportation',
      render: (p) =>
        p.benefits.transportation.rides_per_year
          ? `${p.benefits.transportation.rides_per_year} rides`
          : '—',
    },
    {
      label: 'OTC / qtr',
      render: (p) => `$${p.benefits.otc.allowance_per_quarter}`,
    },
    {
      label: 'Food card / mo',
      render: (p) =>
        p.benefits.food_card.allowance_per_month
          ? `$${p.benefits.food_card.allowance_per_month}`
          : '—',
    },
    {
      label: 'Fitness',
      render: (p) => p.benefits.fitness.program ?? '—',
    },
  ];

  if (medications.length > 0) {
    rows.push({
      label: `Rx coverage (${medications.length})`,
      render: (plan) => (
        <span className="flex flex-wrap" style={{ gap: 3 }}>
          {medications.map((m) => (
            <MedTier key={m.id} tier={formularyTierFor(plan, m.name)} label={m.name} />
          ))}
        </span>
      ),
    });
  }

  return (
    <div className="pm-surface" style={{ padding: 0, overflowX: 'auto' }}>
      <table
        style={{
          width: '100%',
          borderCollapse: 'separate',
          borderSpacing: 0,
          fontSize: 12,
        }}
      >
        <thead>
          <tr>
            <th style={headerCellStyle}>Feature</th>
            {finalists.map((p) => {
              const recommended = recommendation === p.id;
              return (
                <th
                  key={p.id}
                  style={{
                    ...headerCellStyle,
                    background: recommended ? 'var(--sl)' : 'var(--wh)',
                    borderBottom: `2px solid ${recommended ? 'var(--sage)' : 'var(--w2)'}`,
                    minWidth: 190,
                    verticalAlign: 'top',
                  }}
                >
                  <div style={{ fontSize: 11, color: 'var(--i2)', fontWeight: 500 }}>
                    {p.carrier}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginTop: 2 }}>
                    {p.plan_name}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--i3)', marginTop: 2 }}>
                    {p.plan_type} · {p.state}
                  </div>
                  <button
                    type="button"
                    onClick={() => onRecommend(recommended ? null : p.id)}
                    className="pm-btn"
                    style={{
                      marginTop: 6,
                      width: '100%',
                      height: 26,
                      fontSize: 11,
                      background: recommended ? 'var(--sage)' : 'var(--wh)',
                      color: recommended ? '#fff' : 'var(--ink)',
                      borderColor: recommended ? 'var(--sage)' : 'var(--w2)',
                    }}
                  >
                    {recommended ? '★ Recommended' : 'Recommend'}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.label}>
              <td
                style={{
                  ...bodyCellStyle,
                  fontWeight: 600,
                  color: 'var(--i2)',
                  background: i % 2 === 0 ? 'var(--warm)' : 'var(--wh)',
                  position: 'sticky',
                  left: 0,
                }}
              >
                {row.label}
              </td>
              {finalists.map((p) => (
                <td
                  key={p.id}
                  style={{
                    ...bodyCellStyle,
                    background:
                      recommendation === p.id
                        ? 'var(--sl)'
                        : i % 2 === 0
                          ? 'var(--warm)'
                          : 'var(--wh)',
                  }}
                >
                  {row.render(p)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MedTier({ tier, label }: { tier: FormularyTier | null; label: string }) {
  const bg =
    tier === null
      ? 'var(--rt)'
      : tier === 'excluded'
        ? 'var(--rt)'
        : tier === 1
          ? 'var(--sl)'
          : tier === 2
            ? 'var(--tl)'
            : tier === 3
              ? 'var(--bt)'
              : 'var(--at)';
  const fg =
    tier === null || tier === 'excluded'
      ? 'var(--red)'
      : tier === 1
        ? 'var(--sage)'
        : tier === 2
          ? 'var(--teal)'
          : tier === 3
            ? 'var(--blue)'
            : 'var(--amb)';
  const text =
    tier === null ? 'NO' : tier === 'excluded' ? 'EX' : `T${tier}`;
  return (
    <span
      title={label}
      style={{
        fontSize: 9,
        fontWeight: 700,
        padding: '1px 5px',
        borderRadius: 4,
        background: bg,
        color: fg,
      }}
    >
      {text}
    </span>
  );
}

function ClientDeliveryCard({
  finalists,
  recommendation,
}: {
  finalists: Plan[];
  recommendation: string | null;
}) {
  const client = useSession((s) => s.client);
  const recommended = recommendation
    ? finalists.find((p) => p.id === recommendation)
    : finalists[0];

  if (!recommended) return null;

  return (
    <div
      className="pm-surface"
      style={{
        padding: 18,
        background: 'linear-gradient(135deg, var(--sl), var(--warm))',
        borderColor: 'var(--sage)',
      }}
    >
      <div
        className="uppercase font-semibold"
        style={{ color: 'var(--sage)', fontSize: 10, letterSpacing: '0.08em' }}
      >
        Client delivery · what Dorothy sees
      </div>
      <h2 className="font-lora" style={{ fontSize: 22, marginTop: 6, color: 'var(--ink)' }}>
        Let's figure out what's right for you, {client.name.split(/\s+/)[0] || 'Dorothy'}.
      </h2>
      <p style={{ color: 'var(--i2)', fontSize: 14, marginTop: 6, lineHeight: 1.5 }}>
        Based on what you told me — your medications, your doctor, and the benefits that matter most —
        I recommend:
      </p>

      <div
        className="pm-surface"
        style={{
          padding: 14,
          marginTop: 10,
          background: 'var(--wh)',
          borderColor: 'var(--sm)',
        }}
      >
        <div style={{ fontSize: 11, color: 'var(--i2)', fontWeight: 600 }}>
          {recommended.carrier.toUpperCase()}
        </div>
        <div className="font-lora" style={{ fontSize: 18, marginTop: 2 }}>
          {recommended.plan_name}
        </div>
        <div
          className="flex flex-wrap"
          style={{ gap: 6, marginTop: 10 }}
        >
          <Pill label={`$${recommended.premium}/mo premium`} />
          <Pill label={`$${recommended.benefits.dental.annual_max}/yr dental`} />
          <Pill label={`$${recommended.benefits.otc.allowance_per_quarter}/qtr OTC`} />
          {recommended.benefits.food_card.allowance_per_month > 0 && (
            <Pill label={`$${recommended.benefits.food_card.allowance_per_month}/mo food card`} />
          )}
          <Pill label={`${recommended.star_rating} ★`} />
        </div>
      </div>

      <div
        style={{
          marginTop: 12,
          padding: 10,
          borderRadius: 8,
          background: 'var(--wh)',
          border: '1px dashed var(--w2)',
          fontSize: 12,
          color: 'var(--i2)',
          lineHeight: 1.5,
        }}
      >
        {BROKER.name} · {BROKER.license} · {BROKER.phone}
        <br />
        We do not offer every plan available in your area. Please contact Medicare.gov,
        1-800-MEDICARE (TTY 1-877-486-2048), or your local SHIP to get information on all
        of your options.
      </div>
    </div>
  );
}

function Pill({ label }: { label: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: '4px 10px',
        borderRadius: 999,
        background: 'var(--sl)',
        color: 'var(--sage)',
        border: '1px solid var(--sm)',
      }}
    >
      {label}
    </span>
  );
}

function BrokerActions({ recommendation }: { recommendation: string | null }) {
  const client = useSession((s) => s.client);
  const complianceReady = useComplianceReady();
  const hasRec = !!recommendation;
  const sendDisabled = !hasRec || !client.phone;
  const enrollDisabled = !hasRec || !complianceReady;

  function enrollClick() {
    if (enrollDisabled) return;
    window.open(BROKER.sunfire, '_blank', 'noopener');
  }

  return (
    <div className="pm-surface" style={{ padding: 14 }}>
      <div
        className="uppercase font-semibold"
        style={{ color: 'var(--i3)', fontSize: 10, letterSpacing: '0.08em', marginBottom: 10 }}
      >
        Broker actions
      </div>
      <div className="flex flex-wrap" style={{ gap: 8 }}>
        <button
          type="button"
          className="pm-btn"
          disabled={sendDisabled}
          style={{ flex: 1, minWidth: 160, height: 40, opacity: sendDisabled ? 0.5 : 1 }}
        >
          📱 Send text
        </button>
        <button
          type="button"
          className="pm-btn"
          disabled={sendDisabled}
          style={{ flex: 1, minWidth: 160, height: 40, opacity: sendDisabled ? 0.5 : 1 }}
        >
          ✉️ Send email
        </button>
        <button
          type="button"
          onClick={enrollClick}
          disabled={enrollDisabled}
          style={{
            flex: 1,
            minWidth: 160,
            height: 40,
            padding: '0 14px',
            borderRadius: 8,
            border: `1px solid ${enrollDisabled ? 'var(--w2)' : 'var(--enroll)'}`,
            background: enrollDisabled ? 'var(--w2)' : 'var(--enroll)',
            color: enrollDisabled ? 'var(--i3)' : '#fff',
            fontWeight: 700,
            fontSize: 13,
            cursor: enrollDisabled ? 'not-allowed' : 'pointer',
          }}
        >
          ✓ Enroll now
        </button>
      </div>
      {(!hasRec || !complianceReady) && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--i3)' }}>
          {!hasRec && 'Recommend a plan above. '}
          {!complianceReady &&
            'Enroll unlocks once the 16-item compliance checklist above is complete. '}
          {!client.phone && hasRec && 'Client phone required to send text or email.'}
        </div>
      )}
    </div>
  );
}

// ──────────────── Annual Review Mode ────────────────

function AnnualReviewMode() {
  const currentPlanId = useSession((s) => s.currentPlanId);
  const setCurrentPlanId = useSession((s) => s.setCurrentPlanId);
  const finalistIds = useSession((s) => s.selectedFinalists);

  const current = currentPlanId ? findPlan(currentPlanId) : null;
  const finalists = finalistIds
    .map((id) => findPlan(id))
    .filter((p): p is Plan => !!p);

  const [method, setMethod] = useState<'cms_import' | 'h_lookup' | null>(currentPlanId ? 'h_lookup' : null);

  if (!current) {
    return (
      <MethodSelector
        method={method}
        setMethod={setMethod}
        onPlanFound={(plan) => setCurrentPlanId(plan.id)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <CurrentPlanHeader
        plan={current}
        onChange={() => setCurrentPlanId(null)}
      />
      <StayVsSwitchBanner current={current} finalists={finalists} />
      <PremiumStrip current={current} finalists={finalists} />
      <KeyChangesPanel current={current} />
      <DeltaComparisonTable current={current} finalists={finalists} />
    </div>
  );
}

function MethodSelector({
  method,
  setMethod,
  onPlanFound,
}: {
  method: 'cms_import' | 'h_lookup' | null;
  setMethod: (m: 'cms_import' | 'h_lookup' | null) => void;
  onPlanFound: (plan: Plan) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}
      >
        <MethodCard
          active={method === 'cms_import'}
          onClick={() => setMethod('cms_import')}
          icon="📥"
          title="CMS import"
          body="Paste from Medicare.gov's Plan Finder. Fastest when Dorothy has her current year materials."
        />
        <MethodCard
          active={method === 'h_lookup'}
          onClick={() => setMethod('h_lookup')}
          icon="🔎"
          title="H-number lookup"
          body="Type the H-number from Dorothy's current plan card (e.g. H5253-041)."
        />
      </div>

      {method === 'h_lookup' && <PlanIdLookup onPlanFound={onPlanFound} />}
      {method === 'cms_import' && <CmsImportPanel onPlanFound={onPlanFound} />}
    </div>
  );
}

function MethodCard({
  active,
  onClick,
  icon,
  title,
  body,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left pm-surface"
      style={{
        padding: 14,
        cursor: 'pointer',
        borderColor: active ? 'var(--sage)' : 'var(--w2)',
        background: active ? 'var(--sl)' : 'var(--wh)',
      }}
    >
      <div style={{ fontSize: 24 }}>{icon}</div>
      <div style={{ fontSize: 14, fontWeight: 600, marginTop: 6 }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--i2)', marginTop: 4, lineHeight: 1.4 }}>
        {body}
      </div>
    </button>
  );
}

function PlanIdLookup({ onPlanFound }: { onPlanFound: (plan: Plan) => void }) {
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState(false);
  const [showManual, setShowManual] = useState(false);

  const match = useMemo(() => (query.trim() ? lookupByHNumber(query) : null), [query]);

  return (
    <div className="pm-surface" style={{ padding: 14 }}>
      <div
        className="uppercase font-semibold"
        style={{ color: 'var(--i3)', fontSize: 10, letterSpacing: '0.08em' }}
      >
        H-number lookup
      </div>
      <div
        className="flex items-center gap-2 mt-2"
        style={{
          height: 40,
          padding: '0 12px',
          borderRadius: 10,
          background: 'var(--warm)',
          border: '1px solid var(--w2)',
        }}
      >
        <input
          type="text"
          placeholder="e.g. H5253-041 or H5253041"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSearched(true);
          }}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontSize: 14,
            color: 'var(--ink)',
            fontFamily: 'inherit',
          }}
        />
      </div>

      {searched && match && (
        <div
          className="pm-surface mt-2 flex items-center justify-between"
          style={{ padding: 12, background: 'var(--sl)', borderColor: 'var(--sm)' }}
        >
          <div>
            <div style={{ fontSize: 11, color: 'var(--sage)', fontWeight: 700 }}>Found</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{match.plan_name}</div>
            <div style={{ fontSize: 12, color: 'var(--i2)' }}>
              {match.carrier} · {match.state} · {match.plan_type}
            </div>
          </div>
          <button
            type="button"
            className="pm-btn pm-btn-primary"
            onClick={() => onPlanFound(match)}
          >
            Use this plan
          </button>
        </div>
      )}

      {searched && !match && query.trim() && (
        <div
          className="pm-surface mt-2"
          style={{ padding: 12, background: 'var(--at)', borderColor: 'var(--amb)' }}
        >
          <div style={{ fontSize: 13, color: 'var(--amb)', fontWeight: 700 }}>Not found</div>
          <div style={{ fontSize: 12, color: 'var(--i2)', marginTop: 4 }}>
            No plan matches "{query}" in our CMS dataset. Try a different format (with or without the
            dash) or enter the plan manually.
          </div>
          <button
            type="button"
            onClick={() => setShowManual(true)}
            className="pm-btn mt-2"
            style={{ height: 30 }}
          >
            Enter manually
          </button>
        </div>
      )}

      {showManual && (
        <div
          className="pm-surface mt-2"
          style={{ padding: 12, borderColor: 'var(--w2)' }}
        >
          <div style={{ fontSize: 12, color: 'var(--i2)' }}>
            Manual-entry fallback: capture carrier + plan name + premium from Dorothy's card.
            Full annual-review comparison requires our CMS dataset to include the plan — for now
            we'll flag this and defer the delta table until Phase 2 loads the full CMS landscape.
          </div>
        </div>
      )}
    </div>
  );
}

function CmsImportPanel({ onPlanFound: _ }: { onPlanFound: (plan: Plan) => void }) {
  void _;
  return (
    <div className="pm-surface" style={{ padding: 14 }}>
      <div
        className="uppercase font-semibold"
        style={{ color: 'var(--i3)', fontSize: 10, letterSpacing: '0.08em' }}
      >
        CMS import
      </div>
      <textarea
        placeholder="Paste the Plan Finder export here…"
        rows={4}
        style={{
          width: '100%',
          marginTop: 8,
          padding: 10,
          borderRadius: 8,
          border: '1px solid var(--w2)',
          background: 'var(--warm)',
          color: 'var(--ink)',
          fontSize: 13,
          fontFamily: 'inherit',
          resize: 'vertical',
          outline: 'none',
        }}
      />
      <div style={{ fontSize: 11, color: 'var(--i3)', marginTop: 6 }}>
        Phase 2 will parse this automatically. For now, use H-number lookup →
      </div>
    </div>
  );
}

function CurrentPlanHeader({ plan, onChange }: { plan: Plan; onChange: () => void }) {
  return (
    <div
      className="pm-surface flex items-center justify-between"
      style={{ padding: 14 }}
    >
      <div>
        <div
          className="uppercase font-semibold"
          style={{ color: 'var(--i3)', fontSize: 10, letterSpacing: '0.08em' }}
        >
          Current plan · 2026
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>
          {plan.carrier} · {plan.plan_name}
        </div>
        <div style={{ fontSize: 12, color: 'var(--i2)' }}>
          H-number {plan.contract_id}-{plan.plan_number} · ${plan.premium}/mo
        </div>
      </div>
      <button type="button" onClick={onChange} className="pm-btn">
        Change plan
      </button>
    </div>
  );
}

function StayVsSwitchBanner({ current, finalists }: { current: Plan; finalists: Plan[] }) {
  const bestAlt = finalists.find((f) => f.id !== current.id);
  const currentRemainsFinalist = finalists.some((f) => f.id === current.id);

  const stay = currentRemainsFinalist && (!bestAlt || rankPlan(current) >= rankPlan(bestAlt) - 1);

  return (
    <div
      className="pm-surface flex items-center gap-3"
      style={{
        padding: 16,
        background: stay ? 'var(--sl)' : 'var(--at)',
        borderColor: stay ? 'var(--sage)' : 'var(--amb)',
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 999,
          background: stay ? 'var(--sage)' : 'var(--amb)',
          color: '#fff',
          display: 'grid',
          placeItems: 'center',
          fontSize: 20,
        }}
      >
        {stay ? '✓' : '→'}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>
          {stay ? 'Recommend: stay on current plan' : 'Recommend: switch plans for 2027'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--i2)', marginTop: 2 }}>
          {stay
            ? `${current.carrier} still wins on the filters that matter to Dorothy.`
            : bestAlt
              ? `${bestAlt.carrier} · ${bestAlt.plan_name} beats the current plan on key benefits for 2027.`
              : 'Current plan no longer meets the filter requirements — review the delta below.'}
        </div>
      </div>
    </div>
  );
}

function rankPlan(p: Plan): number {
  return (
    p.star_rating * 2 +
    p.benefits.dental.annual_max / 1000 +
    p.benefits.otc.allowance_per_quarter / 50 +
    p.benefits.food_card.allowance_per_month / 50 -
    p.premium / 20
  );
}

function PremiumStrip({ current, finalists }: { current: Plan; finalists: Plan[] }) {
  const bestAlt = finalists.find((f) => f.id !== current.id);

  return (
    <div className="pm-surface flex items-center" style={{ padding: 12, gap: 8 }}>
      <PremiumBlock
        label="2026 current"
        value={`$${current.premium}/mo`}
        color="var(--i2)"
      />
      <span style={{ color: 'var(--i3)', fontSize: 18 }}>→</span>
      <PremiumBlock
        label={`2027 ${current.carrier}`}
        value={`$${current.premium}/mo`}
        color="var(--ink)"
        note="Same carrier, 2027"
      />
      {bestAlt && (
        <>
          <span style={{ color: 'var(--i3)', fontSize: 18 }}>vs</span>
          <PremiumBlock
            label={`2027 ${bestAlt.carrier}`}
            value={`$${bestAlt.premium}/mo`}
            color="var(--sage)"
            note="Recommended"
          />
        </>
      )}
    </div>
  );
}

function PremiumBlock({
  label,
  value,
  color,
  note,
}: {
  label: string;
  value: string;
  color: string;
  note?: string;
}) {
  return (
    <div style={{ flex: 1 }}>
      <div
        className="uppercase font-semibold"
        style={{ color: 'var(--i3)', fontSize: 9, letterSpacing: '0.08em' }}
      >
        {label}
      </div>
      <div style={{ color, fontSize: 22, fontWeight: 700, fontFamily: 'Lora, serif' }}>
        {value}
      </div>
      {note && <div style={{ fontSize: 10, color: 'var(--i3)' }}>{note}</div>}
    </div>
  );
}

function KeyChangesPanel({ current }: { current: Plan }) {
  // Phase 4 uses a static informational panel derived from the 2027 Medicare numbers.
  // Phase 2 will populate real 2027 plan deltas from CMS.
  return (
    <div className="pm-surface" style={{ padding: 14 }}>
      <div
        className="uppercase font-semibold"
        style={{ color: 'var(--i3)', fontSize: 10, letterSpacing: '0.08em', marginBottom: 8 }}
      >
        Key 2027 changes affecting this plan
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--i2)', lineHeight: 1.6 }}>
        <li>
          Part D OOP cap stays at <strong>$2,100</strong> (2026 carryover) — affects all Rx tiers.
        </li>
        <li>
          MA OOP max remains <strong>$9,350</strong> in-network.
        </li>
        <li>
          Insulin cap holds at <strong>$35</strong>/month for covered insulins.
        </li>
        <li>
          {current.carrier}'s food-card benefit restricted to Medicaid-eligible dual members
          (verify Dorothy's Medicaid card is still active).
        </li>
      </ul>
    </div>
  );
}

function DeltaComparisonTable({ current, finalists }: { current: Plan; finalists: Plan[] }) {
  const alternatives = finalists.filter((f) => f.id !== current.id).slice(0, 3);

  const rows: { label: string; val: (p: Plan) => string | number; fmt?: (v: unknown) => string }[] = [
    { label: 'Premium', val: (p) => p.premium, fmt: (v) => `$${v}/mo` },
    { label: 'MOOP', val: (p) => p.moop_in_network, fmt: (v) => `$${(v as number).toLocaleString()}` },
    { label: 'Dental max', val: (p) => p.benefits.dental.annual_max, fmt: (v) => `$${v}` },
    { label: 'Vision eyewear', val: (p) => p.benefits.vision.eyewear_allowance_year, fmt: (v) => `$${v}` },
    { label: 'Hearing aids', val: (p) => p.benefits.hearing.aid_allowance_year, fmt: (v) => `$${v}` },
    { label: 'OTC / qtr', val: (p) => p.benefits.otc.allowance_per_quarter, fmt: (v) => `$${v}` },
    { label: 'Food card / mo', val: (p) => p.benefits.food_card.allowance_per_month, fmt: (v) => (v ? `$${v}` : '—') },
    { label: 'Star rating', val: (p) => p.star_rating, fmt: (v) => `${v} ★` },
  ];

  return (
    <div className="pm-surface" style={{ padding: 0, overflowX: 'auto' }}>
      <div
        className="uppercase font-semibold"
        style={{
          color: 'var(--i3)',
          fontSize: 10,
          letterSpacing: '0.08em',
          padding: '12px 14px',
          borderBottom: '1px solid var(--w2)',
        }}
      >
        2026 vs 2027 delta
      </div>
      <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 12 }}>
        <thead>
          <tr>
            <th style={headerCellStyle}>Feature</th>
            <th style={{ ...headerCellStyle, background: 'var(--w2)' }}>
              <div style={{ fontSize: 11, color: 'var(--i2)' }}>Current (2026)</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>
                {current.carrier}
              </div>
            </th>
            {alternatives.map((p) => (
              <th key={p.id} style={headerCellStyle}>
                <div style={{ fontSize: 11, color: 'var(--i2)' }}>2027 alt</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>
                  {p.carrier}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const currentVal = row.val(current);
            return (
              <tr key={row.label}>
                <td
                  style={{
                    ...bodyCellStyle,
                    fontWeight: 600,
                    color: 'var(--i2)',
                    background: i % 2 === 0 ? 'var(--warm)' : 'var(--wh)',
                  }}
                >
                  {row.label}
                </td>
                <td
                  style={{
                    ...bodyCellStyle,
                    background: i % 2 === 0 ? 'var(--warm)' : 'var(--wh)',
                    fontWeight: 600,
                  }}
                >
                  {row.fmt ? row.fmt(currentVal) : currentVal}
                </td>
                {alternatives.map((p) => {
                  const v = row.val(p);
                  const better = typeof v === 'number' && typeof currentVal === 'number'
                    ? row.label === 'Premium' || row.label === 'MOOP'
                      ? v < currentVal
                      : v > currentVal
                    : false;
                  const worse = typeof v === 'number' && typeof currentVal === 'number' && !better && v !== currentVal;
                  return (
                    <td
                      key={p.id}
                      style={{
                        ...bodyCellStyle,
                        background: i % 2 === 0 ? 'var(--warm)' : 'var(--wh)',
                        color: better ? 'var(--sage)' : worse ? 'var(--red)' : 'var(--ink)',
                        fontWeight: better || worse ? 700 : 400,
                      }}
                    >
                      {row.fmt ? row.fmt(v) : v}
                      {better && ' ▲'}
                      {worse && ' ▼'}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const headerCellStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 14px',
  background: 'var(--wh)',
  borderBottom: '1px solid var(--w2)',
  color: 'var(--ink)',
  fontSize: 11,
  fontWeight: 600,
  position: 'sticky',
  top: 0,
};

const bodyCellStyle: React.CSSProperties = {
  padding: '10px 14px',
  fontSize: 12,
  borderBottom: '1px solid var(--w2)',
  color: 'var(--ink)',
  verticalAlign: 'top',
};
