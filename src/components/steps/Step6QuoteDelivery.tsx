import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import { StepHeader } from './StepHeader';
import { findPlan, lookupByHNumber } from '@/lib/cmsPlans';
import { fetchPlansByIds } from '@/lib/planCatalog';
import { bulkLookupFormulary } from '@/lib/formularyLookup';
import { BROKER } from '@/lib/constants';
import { ComplianceChecklist } from '@/components/compliance/ComplianceChecklist';
import { SaveSessionButton } from '@/components/sync/SaveSessionButton';
import { DISCLAIMERS, allComplianceItemIds } from '@/lib/compliance';
import { buildClientInfoText, buildSunfireRecommendationText } from '@/lib/clipboardFormat';
import { fipsForCounty } from '@/lib/ncFips';
import type { Plan } from '@/types/plans';
import type { SessionMode } from '@/types/session';
import { QuoteDeliveryV4 } from './QuoteDeliveryV4';
import { useDrugCosts } from '@/hooks/useDrugCosts';
import type { PharmacyMode } from '@/lib/drugCosts';

// ─── Display helpers ────────────────────────────────────────────────
// The PBP structured extract carries a benefit row for many
// dental / vision / hearing plans without an annual dollar cap (the
// allowance is printed in the free-text SoB, not the structured file).
// The importer marks those rows with coverage_amount = 1 — the
// "offered" marker (see buildBenefits in api/plans.ts) — which earlier
// code rendered as literal "$1" or "$0". These helpers distinguish
// "offered but no dollar cap" from a real dollar allowance so the card
// reads naturally ("Included" / "$X/yr" / "—").

function formatAnnualAllowance(amount: number, offered: boolean): string {
  if (amount > 1) return `$${amount.toLocaleString()}/yr`;
  if (offered || amount === 1) return 'Included';
  return '—';
}
function formatMonthlyAmount(amount: number): string {
  if (amount > 1) return `$${amount}/mo`;
  if (amount === 1) return 'Included';
  return '—';
}
function formatQuarterlyAmount(amount: number): string {
  if (amount > 1) return `$${amount}/qtr`;
  if (amount === 1) return 'Included';
  return '—';
}
function clientFirstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}


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
  const client = useSession((s) => s.client);
  const medications = useSession((s) => s.medications);
  const providers = useSession((s) => s.providers);
  const [toastMsg, showToast] = useToast();

  // Refetch the finalist set from pm_plans so the side-by-side renders
  // live benefit/premium/star data instead of the stale Plan shape
  // that was built in Step 5. Falls back to the static cmsPlans lookup
  // by id when /api/plans errors, so Rob can still demo offline.
  const [finalists, setFinalists] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (finalistIds.length === 0) {
      setFinalists([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchPlansByIds(finalistIds)
      .then((plans) => {
        if (cancelled) return;
        if (plans.length > 0) {
          setFinalists(plans);
        } else {
          // Last-ditch static fallback — the Plan TS type is stable so
          // this keeps the table rendering if the server errors *and*
          // the cmsPlans seed happens to contain the id.
          const fallback = finalistIds
            .map((id) => findPlan(id))
            .filter((p): p is Plan => !!p);
          setFinalists(fallback);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [finalistIds]);

  if (loading && finalists.length === 0) {
    return (
      <div
        className="pm-surface"
        style={{ padding: 24, textAlign: 'center', color: 'var(--i2)', fontSize: 13 }}
      >
        Loading plans from CMS landscape…
      </div>
    );
  }

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

  async function handleCopy(plan: Plan) {
    const text = buildClientInfoText({ client, plan, medications, providers });
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied to clipboard');
    } catch {
      showToast('Copy failed — check browser permissions');
    }
  }

  function handleOpenSunfire(plan: Plan) {
    const fips = fipsForCounty(client.county);
    if (!client.zip || !fips) {
      const missing = !client.zip ? 'ZIP' : `FIPS for county "${client.county}"`;
      showToast(`Need ${missing} to open SunFire`);
      return;
    }
    // Per spec the segment after FIPS is always literal "MAPD" — that's
    // the SunFire route for Medicare Advantage. The plan id is appended
    // as a query param; SunFire's hash router ignores unknown params if
    // the deep-link form changes, so this stays safe to send.
    const planId = `${plan.contract_id}-${plan.plan_number}`;
    const url =
      `https://www.sunfirematrix.com/app/agent/medicareadvocates` +
      `/#/plans/${client.zip}/${fips}/MAPD?planId=${encodeURIComponent(planId)}`;
    window.open(url, '_blank', 'noopener');
  }

  async function handleRecommendCopy({
    plan,
    totalRxAnnual,
    totalAnnualValue,
    whySwitch,
  }: {
    plan: Plan;
    totalRxAnnual: number;
    totalAnnualValue: number;
    whySwitch: string;
  }) {
    const text = buildSunfireRecommendationText({
      client,
      plan,
      totalRxAnnual,
      totalAnnualValue,
      whySwitch,
    });
    try {
      await navigator.clipboard.writeText(text);
      showToast('Client info copied for SunFire');
    } catch {
      showToast('Copy failed — check browser permissions');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <V4TableWithPrime
        finalists={finalists}
        currentPlan={null}
        medications={medications}
        providers={providers}
        recommendation={recommendation}
        onRecommend={setRecommendation}
        onRecommendCopy={handleRecommendCopy}
        onCopy={handleCopy}
        onOpenSunfire={handleOpenSunfire}
        clientPhone={client.phone}
        clientFirstName={clientFirstName(client.name)}
        brokerName={BROKER.name}
      />
      <ClientDeliveryCard finalists={finalists} recommendation={recommendation} />
      <ComplianceChecklist />
      <BrokerActions recommendation={recommendation} />
      <Toast message={toastMsg} />
    </div>
  );
}

// Primes the per-(plan, rxcui) formulary cache before handing off to the
// v4 table. Owns a tick so the V4 cell closures re-read the cache after
// each bulk response lands. Same pattern as Steps 3 & 5.
function V4TableWithPrime({
  finalists,
  currentPlan,
  medications,
  providers,
  recommendation,
  onRecommend,
  onRecommendCopy,
  onCopy,
  onOpenSunfire,
  clientPhone,
  clientFirstName,
  brokerName,
}: {
  finalists: Plan[];
  currentPlan: Plan | null;
  medications: import('@/types/session').Medication[];
  providers: import('@/types/session').Provider[];
  recommendation: string | null;
  onRecommend: (id: string | null) => void;
  onRecommendCopy?: (args: {
    plan: Plan;
    totalRxAnnual: number;
    totalAnnualValue: number;
    whySwitch: string;
  }) => void;
  onCopy: (plan: Plan) => void;
  onOpenSunfire: (plan: Plan) => void;
  clientPhone?: string;
  clientFirstName?: string;
  brokerName?: string;
}) {
  const [formularyTick, setFormularyTick] = useState(0);
  const [pharmacyMode, setPharmacyMode] = useState<PharmacyMode>('retail');
  const primeNonce = useMemo(
    () =>
      `${finalists.length}:${medications
        .map((m) => m.rxcui ?? '')
        .sort()
        .join(',')}`,
    [finalists, medications],
  );
  useEffect(() => {
    if (finalists.length === 0 || medications.length === 0) return;
    let cancelled = false;
    const contractIds = [...new Set(finalists.map((p) => p.contract_id))];
    const rxcuis = medications
      .map((m) => m.rxcui)
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (rxcuis.length === 0) return;
    bulkLookupFormulary(contractIds, rxcuis).then(() => {
      if (!cancelled) setFormularyTick((t) => t + 1);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primeNonce]);

  const drugCosts = useDrugCosts(finalists, medications, pharmacyMode);

  return (
    <QuoteDeliveryV4
      finalists={finalists}
      currentPlan={currentPlan}
      medications={medications}
      providers={providers}
      recommendation={recommendation}
      onRecommend={onRecommend}
      onRecommendCopy={onRecommendCopy}
      onCopy={onCopy}
      onOpenSunfire={onOpenSunfire}
      formularyTick={formularyTick}
      clientPhone={clientPhone}
      clientFirstName={clientFirstName}
      brokerName={brokerName}
      planDrugCosts={drugCosts.byPlanId}
      pharmacyMode={pharmacyMode}
      onPharmacyModeChange={setPharmacyMode}
      drugCostsLoading={drugCosts.loading}
      drugCostsSource={drugCosts.source}
      drugCostsError={drugCosts.error}
    />
  );
}

function useToast(): [string | null, (msg: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  function show(next: string) {
    setMsg(next);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setMsg(null), 1800);
  }
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );
  return [msg, show];
}

function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '10px 16px',
        borderRadius: 999,
        background: 'var(--ink)',
        color: 'var(--wh)',
        fontSize: 13,
        fontWeight: 600,
        boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
        zIndex: 50,
      }}
    >
      {message}
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

  const firstName = clientFirstName(client.name);
  const dental = recommended.benefits.dental;
  const otc = recommended.benefits.otc;
  const food = recommended.benefits.food_card;

  const dentalPill = formatAnnualAllowance(dental.annual_max, dental.preventive);
  const otcPill = formatQuarterlyAmount(otc.allowance_per_quarter);
  const foodPill = formatMonthlyAmount(food.allowance_per_month);

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
        Client delivery · {firstName ? `what ${firstName} sees` : 'what your client sees'}
      </div>
      <h2 className="font-lora" style={{ fontSize: 22, marginTop: 6, color: 'var(--ink)' }}>
        {firstName
          ? `Let's figure out what's right for you, ${firstName}.`
          : `Let's figure out what's right for you.`}
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
          {dentalPill !== '—' && (
            <Pill label={dentalPill === 'Included' ? 'Dental included' : `${dentalPill} dental`} />
          )}
          {otcPill !== '—' && (
            <Pill label={otcPill === 'Included' ? 'OTC included' : `${otcPill} OTC`} />
          )}
          {foodPill !== '—' && (
            <Pill label={foodPill === 'Included' ? 'Food card included' : `${foodPill} food card`} />
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
