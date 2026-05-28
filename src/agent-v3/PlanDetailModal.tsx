// PlanDetailModal — single-plan detail view.
//
// Triggered by tap-on-card on the agent-v3 Plans screen (SwipeCard,
// NextUpRail, PinnedPlan). Renders the full 23 copay categories plus
// extras and provider network status for ONE plan — no vs-current
// comparison, so it works for every client (new-to-Medicare, SEP, IEP)
// regardless of whether currentPlan is set.
//
// Mirrors CompareScreen's row structure so the data shape is identical;
// the only difference is single-column display vs side-by-side.

import type { Plan } from '@/types/plans';
import type { Provider } from '@/types/session';
import { fmt } from './atoms';
import {
  annualEstimate,
  costShareNumeric,
  formatCostShare,
  formatPcp,
  formatPremium,
  formatSpecialist,
  planDisplay,
} from './planDisplay';

interface Props {
  plan: Plan;
  /** Annual drug-cost lookup keyed by Plan.id (already sanity-capped
   *  upstream). When missing, the annual-drugs row renders "—". */
  annualDrug: number | null;
  /** Brain composite (0-100) for this plan, when scored. */
  brainScore: number | null;
  brainReason: string | null;
  /** Session providers — render a per-provider network row showing
   *  in/out/unknown for this plan. */
  providers: Provider[];
  onClose: () => void;
}

interface DetailRow {
  l: string;
  v: string;
}

void costShareNumeric; // future use for "best in pool" tinting

export function PlanDetailModal({
  plan,
  annualDrug,
  brainScore,
  brainReason,
  providers,
  onClose,
}: Props) {
  const disp = planDisplay(plan);
  const ann = annualEstimate(plan, annualDrug).total;

  const headlineRows: DetailRow[] = [
    { l: 'Premium', v: `${formatPremium(plan)}/mo` },
    {
      l: 'Annual Drugs',
      v: annualDrug != null ? `${fmt(annualDrug)}/yr` : '—',
    },
    { l: 'Est. Annual Total', v: ann != null ? fmt(ann) : '—' },
    { l: 'MOOP', v: fmt(plan.moop_in_network) },
    { l: 'Part D Ded.', v: `$${plan.drug_deductible ?? 0}` },
    { l: 'PCP', v: formatPcp(plan) },
    { l: 'Specialist', v: formatSpecialist(plan) },
    { l: 'Stars', v: `${plan.star_rating} ★` },
  ];

  const medicalRows: DetailRow[] = [
    { l: 'Urgent Care', v: formatCostShare(plan.benefits.medical.urgent_care) },
    { l: 'Emergency', v: formatCostShare(plan.benefits.medical.emergency) },
    { l: 'Inpatient (per stay)', v: formatCostShare(plan.benefits.medical.inpatient) },
    { l: 'Outpatient surg. (hosp)', v: formatCostShare(plan.benefits.medical.outpatient_surgery_hospital) },
    { l: 'Outpatient surg. (ASC)', v: formatCostShare(plan.benefits.medical.outpatient_surgery_asc) },
    { l: 'Outpatient observation', v: formatCostShare(plan.benefits.medical.outpatient_observation) },
    { l: 'Lab services', v: formatCostShare(plan.benefits.medical.lab_services) },
    { l: 'Diagnostic procedures', v: formatCostShare(plan.benefits.medical.diagnostic_procedures) },
    { l: 'X-ray', v: formatCostShare(plan.benefits.medical.xray) },
    // Old diagnostic_radiology + therapeutic_radiology merged into the
    // single PBP-aligned advanced_imaging category.
    { l: 'Advanced imaging', v: formatCostShare(plan.benefits.medical.advanced_imaging) },
    { l: 'Mental health (indiv.)', v: formatCostShare(plan.benefits.medical.mental_health_individual) },
    { l: 'Mental health (group)', v: formatCostShare(plan.benefits.medical.mental_health_group) },
    { l: 'Physical / speech therapy', v: formatCostShare(plan.benefits.medical.physical_speech_therapy) },
    { l: 'Occupational therapy', v: formatCostShare(plan.benefits.medical.occupational_therapy) },
    { l: 'Telehealth', v: formatCostShare(plan.benefits.medical.telehealth) },
    { l: 'Ambulance', v: formatCostShare(plan.benefits.medical.ambulance) },
    { l: 'Air ambulance', v: formatCostShare(plan.benefits.medical.air_transportation) },
    { l: 'Chiropractic', v: formatCostShare(plan.benefits.medical.chiropractic) },
    { l: 'Acupuncture', v: formatCostShare(plan.benefits.medical.acupuncture) },
    { l: 'Podiatry', v: formatCostShare(plan.benefits.medical.podiatry) },
    { l: 'Substance abuse', v: formatCostShare(plan.benefits.medical.substance_abuse) },
    { l: 'DME / prosthetics', v: formatCostShare(plan.benefits.medical.dme_prosthetics) },
    { l: 'Part B drugs', v: formatCostShare(plan.benefits.medical.partb_drugs) },
    { l: 'Diabetic supplies', v: formatCostShare(plan.benefits.medical.diabetic_supplies) },
    { l: 'Part B insulin', v: formatCostShare(plan.benefits.medical.insulin) },
    { l: 'Home health', v: formatCostShare(plan.benefits.medical.home_health) },
    { l: 'Renal dialysis', v: formatCostShare(plan.benefits.medical.renal_dialysis) },
  ];

  const rxRows: DetailRow[] = [
    { l: 'Rx Tier 1', v: formatCostShare(plan.benefits.rx_tiers.tier_1) },
    { l: 'Rx Tier 2', v: formatCostShare(plan.benefits.rx_tiers.tier_2) },
    { l: 'Rx Tier 3', v: formatCostShare(plan.benefits.rx_tiers.tier_3) },
    { l: 'Rx Tier 4', v: formatCostShare(plan.benefits.rx_tiers.tier_4) },
    { l: 'Rx Tier 5', v: formatCostShare(plan.benefits.rx_tiers.tier_5) },
  ];

  const extrasRows: DetailRow[] = [
    { l: 'Dental', v: disp.dental },
    { l: 'Dental Max', v: disp.dentalMax },
    { l: 'Vision', v: disp.vision },
    { l: 'Vision $', v: disp.visionAllowance },
    { l: 'Hearing', v: disp.hearing },
    { l: 'OTC', v: disp.otcText },
    { l: 'Food card', v: disp.meals },
    { l: 'Transportation', v: disp.transport },
    { l: 'Fitness', v: disp.fitness },
  ];

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 300,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white',
          borderRadius: 16,
          maxWidth: 560,
          width: '100%',
          maxHeight: '90vh',
          overflow: 'auto',
          boxShadow: '0 20px 80px rgba(0,0,0,0.3)',
        }}
      >
        <div
          style={{
            background: 'linear-gradient(135deg,#0d2f5e,#1a4a8a)',
            padding: '16px 20px',
            borderRadius: '16px 16px 0 0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 14,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                color: '#83f0f9',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 1,
                textTransform: 'uppercase',
              }}
            >
              Plan Detail
            </div>
            <div
              style={{
                color: 'white',
                fontFamily: "'Fraunces', Georgia, serif",
                fontSize: 18,
                fontWeight: 700,
                lineHeight: 1.2,
              }}
            >
              {plan.carrier}
            </div>
            <div style={{ color: '#cbd5e1', fontSize: 12 }}>
              {plan.plan_name} · {plan.plan_type}
              {brainScore != null && (
                <span
                  style={{
                    marginLeft: 8,
                    background: 'rgba(131,240,249,0.2)',
                    color: '#83f0f9',
                    fontSize: 10,
                    fontWeight: 700,
                    padding: '2px 6px',
                    borderRadius: 4,
                  }}
                >
                  Brain {Math.round(brainScore)}/100
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'rgba(255,255,255,0.1)',
              border: 'none',
              color: 'white',
              cursor: 'pointer',
              fontSize: 18,
              padding: '4px 10px',
              borderRadius: 8,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {brainReason && (
          <div
            style={{
              background: 'rgba(13,47,94,0.04)',
              borderTop: '1px solid rgba(13,47,94,0.06)',
              padding: '10px 20px',
              fontSize: 12,
              color: '#334155',
            }}
          >
            🧠 {brainReason}
          </div>
        )}

        <DetailSection title="Headline" rows={headlineRows} />
        <DetailSection title="Medical copays (17)" rows={medicalRows} />
        <DetailSection title="Rx tiers" rows={rxRows} />
        <DetailSection title="Extras" rows={extrasRows} />
        <ProviderSection plan={plan} providers={providers} />
      </div>
    </div>
  );
}

function DetailSection({ title, rows }: { title: string; rows: DetailRow[] }) {
  return (
    <div style={{ borderBottom: '1px solid #e2e8f0' }}>
      <div
        style={{
          padding: '12px 20px 6px',
          fontSize: 10,
          fontWeight: 700,
          color: '#64748b',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
        }}
      >
        {title}
      </div>
      {rows.map((r, i) => (
        <div
          key={r.l}
          style={{
            display: 'grid',
            gridTemplateColumns: '180px 1fr',
            padding: '7px 20px',
            background: i % 2 === 0 ? '#f8fafc' : 'white',
            fontSize: 12,
          }}
        >
          <div style={{ color: '#475569', fontWeight: 600 }}>{r.l}</div>
          <div style={{ color: '#0d2f5e', fontWeight: 700 }}>{r.v}</div>
        </div>
      ))}
    </div>
  );
}

function ProviderSection({
  plan,
  providers,
}: {
  plan: Plan;
  providers: Provider[];
}) {
  if (providers.length === 0) return null;
  return (
    <div>
      <div
        style={{
          padding: '12px 20px 6px',
          fontSize: 10,
          fontWeight: 700,
          color: '#64748b',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
        }}
      >
        Providers ({providers.length})
      </div>
      {providers.map((prov, i) => {
        const status =
          (prov.networkStatus?.[plan.id] as 'in' | 'out' | 'unknown') ?? 'unknown';
        return (
          <div
            key={prov.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 110px',
              padding: '7px 20px',
              background: i % 2 === 0 ? '#f8fafc' : 'white',
              fontSize: 12,
            }}
          >
            <div style={{ color: '#0d2f5e', fontWeight: 700, minWidth: 0 }}>
              {prov.name}
              {prov.specialty && (
                <span style={{ color: '#64748b', fontWeight: 400, marginLeft: 6 }}>
                  · {prov.specialty}
                </span>
              )}
            </div>
            <div
              style={{
                textAlign: 'right',
                color:
                  status === 'in'
                    ? '#059669'
                    : status === 'out'
                      ? '#a32d2d'
                      : '#94a3b8',
                fontWeight: 700,
              }}
            >
              {status === 'in' ? '✓ In-Network' : status === 'out' ? '✕ Out' : '? Unknown'}
            </div>
          </div>
        );
      })}
    </div>
  );
}
