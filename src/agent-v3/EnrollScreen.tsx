// EnrollScreen — agent-v3 screen 8.
//
// Final summary of the recommended plan plus the SunFire deep link
// CTA. Pre-populates SunFire's "Open Quote" URL with as much of the
// session payload as possible (carrier, plan id, ZIP, etc.). The
// link itself is a placeholder; the live deep-link contract sits in
// scripts/sunfire-deeplink.md (or wherever ops drops it) — wire that
// up by replacing buildSunFireLink().

import type { Plan } from '@/types/plans';
import { useSession } from '@/hooks/useSession';
import { Card, Container, Header, Nav, fmt } from './atoms';
import { annualEstimate } from './planDisplay';

interface Props {
  current: Plan | null;
  /** Full brain-ranked plan list, descending by composite score. */
  scoredPlans: Plan[];
  annualDrugByPlanId: Record<string, number | null>;
  /** Fire-and-forget AgentBase write-back. Called when broker clicks
   *  Open SunFire so the CRM has the final enrollment plan synced
   *  before the broker leaves the tab. The hook is idempotent for
   *  same-plan re-clicks; the SunFire link still opens immediately. */
  onRecommend?: (plan: Plan) => void;
  onBack: () => void;
}

export function EnrollScreen({
  current,
  scoredPlans,
  annualDrugByPlanId,
  onRecommend,
  onBack,
}: Props) {
  const client = useSession((s) => s.client);
  const providers = useSession((s) => s.providers);
  const medications = useSession((s) => s.medications);

  // Top brain-ranked plan that isn't the client's current — falls
  // back to scoredPlans[0] when there's no current on file (e.g.
  // an AEP shopper with no incumbent).
  const recommendedPlan: Plan | null =
    scoredPlans.find((p) => p.id !== current?.id) ?? scoredPlans[0] ?? null;

  if (!recommendedPlan) {
    return (
      <Container>
        <Header
          title="Pick a finalist first"
          sub="Run the Compare screen to surface a recommendation."
        />
        <Nav onBack={onBack} />
      </Container>
    );
  }

  const candAnnual = annualEstimate(recommendedPlan, annualDrugByPlanId[recommendedPlan.id] ?? null).total;
  const curAnnual = current
    ? annualEstimate(current, annualDrugByPlanId[current.id] ?? null).total
    : null;
  const saved = candAnnual != null && curAnnual != null ? curAnnual - candAnnual : null;

  return (
    <Container>
      <Header
        title="Enrollment confirmed"
        sub="All compliance items verified. Ready for SunFire submission."
      />
      <Card style={{ border: '2px solid #059669' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 14,
            gap: 12,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 9,
                fontWeight: 700,
                color: '#64748b',
                textTransform: 'uppercase',
              }}
            >
              {recommendedPlan.carrier}
            </div>
            <div
              style={{
                fontFamily: "'Fraunces', Georgia, serif",
                fontSize: 18,
                fontWeight: 700,
                color: '#0d2f5e',
              }}
            >
              {recommendedPlan.plan_name}
            </div>
          </div>
          <span
            style={{
              background: 'linear-gradient(135deg,#059669,#047857)',
              color: 'white',
              fontWeight: 800,
              fontSize: 9,
              padding: '3px 10px',
              borderRadius: 5,
            }}
          >
            ★ Recommended
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 8,
            marginBottom: 14,
          }}
        >
          <Stat label="Premium" value={recommendedPlan.premium === 0 ? '$0' : `$${recommendedPlan.premium}`} green={recommendedPlan.premium === 0} />
          <Stat
            label="Est. Annual Drugs"
            value={
              annualDrugByPlanId[recommendedPlan.id] != null
                ? fmt(annualDrugByPlanId[recommendedPlan.id]!)
                : '—'
            }
          />
          <Stat
            label="Annual Savings"
            value={saved != null && saved > 0 ? fmt(saved) : '—'}
            green={saved != null && saved > 0}
          />
        </div>

        <div
          style={{
            borderTop: '1px solid #e2e8f0',
            paddingTop: 12,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 6,
            fontSize: 11,
          }}
        >
          <div>
            <span style={{ color: '#64748b' }}>Client:</span>{' '}
            <strong>{client.name || '—'}</strong>
          </div>
          <div>
            <span style={{ color: '#64748b' }}>County:</span>{' '}
            <strong>
              {client.county ? `${client.county}, ${client.state}` : '—'}
            </strong>
          </div>
          <div>
            <span style={{ color: '#64748b' }}>Provider:</span>{' '}
            <strong>{providers[0]?.name ?? '—'}</strong>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <span style={{ color: '#64748b' }}>Meds:</span>{' '}
            <strong>{medications.map((m) => m.name).join(', ') || '—'}</strong>
          </div>
        </div>
      </Card>

      <div style={{ textAlign: 'center', marginTop: 20 }}>
        <a
          href={buildSunFireLink({
            client,
            plan: recommendedPlan,
          })}
          target="_blank"
          rel="noreferrer"
          onClick={() => {
            // Fire-and-forget AgentBase write-back before SunFire opens.
            // The new tab loads in parallel; sync runs on the original
            // tab and posts its 1-2s round-trip in the background.
            onRecommend?.(recommendedPlan);
          }}
          style={{
            display: 'inline-block',
            background: 'linear-gradient(135deg, #059669, #047857)',
            color: 'white',
            border: 'none',
            borderRadius: 13,
            padding: '16px 50px',
            fontSize: 16,
            fontWeight: 800,
            cursor: 'pointer',
            boxShadow: '0 8px 30px rgba(5,150,105,0.3)',
            letterSpacing: 0.5,
            textDecoration: 'none',
          }}
        >
          Open SunFire Matrix — Submit Enrollment →
        </a>
        <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 6 }}>
          Pre-populated · NPN 10447418
        </div>
      </div>

      <Nav onBack={onBack} />
    </Container>
  );
}

function Stat({
  label,
  value,
  green,
}: {
  label: string;
  value: string;
  green?: boolean;
}) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div
        style={{
          fontSize: 9,
          color: '#64748b',
          fontWeight: 600,
          textTransform: 'uppercase',
          marginBottom: 3,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "'Fraunces', Georgia, serif",
          fontSize: 20,
          fontWeight: 800,
          color: green ? '#059669' : '#0d2f5e',
        }}
      >
        {value}
      </div>
    </div>
  );
}

// Pre-populates the SunFire Matrix quote URL with the client + plan
// payload. The exact querystring contract isn't documented in this
// repo yet; this function intentionally encodes everything we know so
// when ops finalizes the deep-link spec, the only place to update is
// the hostname / param-name remapping below.
function buildSunFireLink({
  client,
  plan,
}: {
  client: ReturnType<typeof useSession.getState>['client'];
  plan: Plan;
}): string {
  const qs = new URLSearchParams();
  qs.set('npn', '10447418');
  qs.set('plan_id', plan.id);
  qs.set('contract', plan.contract_id);
  qs.set('plan_no', plan.plan_number);
  qs.set('carrier', plan.carrier);
  if (client.zip) qs.set('zip', client.zip);
  if (client.dob) qs.set('dob', client.dob);
  if (client.name) qs.set('name', client.name);
  if (client.phone) qs.set('phone', client.phone);
  if (client.email) qs.set('email', client.email);
  return `https://sunfirematrix.com/quote/start?${qs.toString()}`;
}
