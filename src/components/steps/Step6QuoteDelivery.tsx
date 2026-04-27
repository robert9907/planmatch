import { useEffect, useMemo, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import { StepHeader } from './StepHeader';
import { findPlan } from '@/lib/cmsPlans';
import { fetchPlansByIds } from '@/lib/planCatalog';
import { BROKER } from '@/lib/constants';
import { ComplianceChecklist } from '@/components/compliance/ComplianceChecklist';
import { SaveSessionButton } from '@/components/sync/SaveSessionButton';
import { DISCLAIMERS, allComplianceItemIds } from '@/lib/compliance';
import type { Plan } from '@/types/plans';
import { QuoteDeliveryV4 } from './QuoteDeliveryV4';

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
  const isAnnualReview = useSession((s) => s.isAnnualReview);
  const setIsAnnualReview = useSession((s) => s.setIsAnnualReview);

  return (
    <div className="flex flex-col gap-4">
      <StepHeader
        number={6}
        title="Quote & delivery"
        subtitle={
          isAnnualReview
            ? 'Annual review for AEP — current plan is pinned as the benchmark column; deltas show what changes if the client switches.'
            : 'Side-by-side finalists, client-ready card, and broker actions.'
        }
        right={<AnnualReviewToggle on={isAnnualReview} onChange={setIsAnnualReview} />}
      />

      <NewQuoteMode />

      <SaveSessionButton />
    </div>
  );
}

// ──────────────── Annual Review Toggle ────────────────
// Flips session.isAnnualReview. The body that renders is always the
// same QuoteDeliveryV4 — the toggle just changes copy + verdict logic
// inside that table. Replaces the old ModeToggle which swapped two
// completely different bodies.

function AnnualReviewToggle({ on, onChange }: { on: boolean; onChange: (flag: boolean) => void }) {
  return (
    <div
      className="flex"
      style={{
        borderRadius: 10,
        background: 'var(--w2)',
        padding: 3,
      }}
    >
      {([
        { key: false, label: 'New quote' },
        { key: true, label: 'Annual review 2027' },
      ] as const).map((opt) => {
        const active = on === opt.key;
        return (
          <button
            key={String(opt.key)}
            type="button"
            onClick={() => onChange(opt.key)}
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
            {opt.label}
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
  const setGivebackPlanEnrolled = useSession((s) => s.setGivebackPlanEnrolled);
  const client = useSession((s) => s.client);
  const medications = useSession((s) => s.medications);
  const providers = useSession((s) => s.providers);

  // Refetch the finalist set from pm_plans so the side-by-side renders
  // live benefit/premium/star data instead of the stale Plan shape
  // that was built in Step 5. Falls back to the static cmsPlans lookup
  // by id when /api/plans errors, so Rob can still demo offline.
  const [finalists, setFinalists] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(false);

  // Derive the giveback flag from the recommended plan whenever either
  // the recommendation or the loaded finalist data changes. Clears to
  // false when no recommendation is set.
  useEffect(() => {
    if (!recommendation) {
      setGivebackPlanEnrolled(false);
      return;
    }
    const rec = finalists.find((p) => p.id === recommendation);
    setGivebackPlanEnrolled((rec?.part_b_giveback ?? 0) > 0);
  }, [recommendation, finalists, setGivebackPlanEnrolled]);

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

  return (
    <div className="flex flex-col gap-4">
      <QuoteDeliveryV4
        finalists={finalists}
        client={client}
        medications={medications}
        providers={providers}
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
          {(recommended.carrier ?? '').toUpperCase()}
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

