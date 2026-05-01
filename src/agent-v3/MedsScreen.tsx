// MedsScreen — agent-v3 screen 2.
//
// Mockup intent: each medication renders as a row with an icon, name,
// dosage / frequency, tier badge, and a per-row "best annual cost"
// that resolves from a spinner. A footer Broker Brain insight calls
// out the cost driver drug.
//
// Live wires:
//   • Medications come from useSession.medications (hydrated by
//     LandingPage / photo capture / manual add).
//   • Eligible plan set comes from fetchPlansForClient (pm_plans for
//     state/county/plan-type).
//   • bulkLookupFormulary primes pm_formulary tier+copay for every
//     (contract, rxcui) pair → getCachedFormulary feeds the per-row
//     tier badge and the per-row "best monthly copay" → annual estimate.
//   • useDrugCosts hits /api/drug-costs (pm_drug_cost_cache, populated
//     from Medicare.gov via the Playwright server) for total annual
//     drug spend per plan. We surface the absolute-best total in the
//     footer insight so the broker can frame the savings without
//     leaving the screen.
//
// What's deliberately NOT here yet:
//   • Per-drug-per-plan annual from pm_drug_cost_cache — the cache is
//     keyed by plan+NDC bundle, not single-NDC, so per-drug split
//     would need a new endpoint or many parallel calls. The per-row
//     number we show today is copay × 12 (monthly copay annualized),
//     which is what the formulary actually files. Documented inline
//     so a future split is one place to change.
//   • RxNorm typeahead / photo capture / Add buttons — the v4
//     MedsPage already owns those flows; we add them once the v3
//     navigation lands so we can decide whether to keep the v4
//     implementation as-is or restyle.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useDrugCosts } from '@/hooks/useDrugCosts';
import { useSession } from '@/hooks/useSession';
import {
  bulkLookupFormulary,
  getCachedFormulary,
} from '@/lib/formularyLookup';
import { fetchPlansForClient } from '@/lib/planCatalog';
import type { Plan } from '@/types/plans';
import type { Medication } from '@/types/session';
import {
  AgentInsight,
  Card,
  Container,
  Header,
  MedIcon,
  Nav,
  TierBadge,
  fmt,
} from './atoms';
import { FADE_SLIDE_IN } from './styles';

interface Props {
  onNext: () => void;
  onBack: () => void;
  clientView: boolean;
}

// Pure-visual icon picker — falls back to a generic capsule if nothing
// looks like an injector. The mockup hand-picks emoji per drug; we
// don't have that metadata, so name-pattern matching is the closest
// honest substitute.
function iconForMed(med: Medication): string {
  const name = med.name.toLowerCase();
  if (/inject|pen|ozempic|trulicity|mounjaro|wegovy|insulin|humira/.test(name)) {
    return '💉';
  }
  if (/inhaler|albuterol|symbicort|advair/.test(name)) return '😮‍💨';
  if (/cream|ointment|gel|patch/.test(name)) return '🧴';
  return '💊';
}

export function MedsScreen({ onNext, onBack, clientView }: Props) {
  const client = useSession((s) => s.client);
  const medications = useSession((s) => s.medications);

  // Eligible plan set drives the formulary prime + the live total
  // drug-cost lookup. Same call shape the v4 MedsPage uses so the
  // pm_plans path is shared.
  const [eligiblePlans, setEligiblePlans] = useState<Plan[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchPlansForClient({
      state: client.state,
      county: client.county,
      planType: client.planType,
    }).then((plans) => {
      if (!cancelled) setEligiblePlans(plans);
    });
    return () => {
      cancelled = true;
    };
  }, [client.state, client.county, client.planType]);

  // Bulk-prime pm_formulary so getCachedFormulary returns hits in the
  // per-row render. Re-fires whenever the (plans × rxcuis) tuple
  // changes — same nonce trick the v4 page uses.
  const [formularyTick, setFormularyTick] = useState(0);
  const primeNonce = useMemo(
    () =>
      `${eligiblePlans.length}:${medications
        .map((m) => m.rxcui ?? '')
        .sort()
        .join(',')}`,
    [eligiblePlans, medications],
  );
  const lastPrimedRef = useRef<string>('');
  useEffect(() => {
    if (eligiblePlans.length === 0 || medications.length === 0) return;
    if (lastPrimedRef.current === primeNonce) return;
    const rxcuis = medications
      .map((m) => m.rxcui)
      .filter((s): s is string => !!s);
    if (rxcuis.length === 0) return;
    lastPrimedRef.current = primeNonce;
    let cancelled = false;
    const contractIds = [...new Set(eligiblePlans.map((p) => p.contract_id))];
    bulkLookupFormulary(contractIds, rxcuis).then(() => {
      if (!cancelled) setFormularyTick((t) => t + 1);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primeNonce]);

  // Live pm_drug_cost_cache totals per plan. Used in the footer
  // AgentInsight to surface the absolute-best annual drug spend.
  const drugCosts = useDrugCosts(eligiblePlans, medications, 'retail');

  const bestAnnualTotal = useMemo(() => {
    const totals = Object.values(drugCosts.byPlanId)
      .map((c) => c.annual_cost)
      .filter((n): n is number => typeof n === 'number' && n > 0);
    if (totals.length === 0) return null;
    return Math.min(...totals);
  }, [drugCosts.byPlanId]);

  // Identify the cost-driver drug — the one with the highest min copay
  // across covered plans. Surface it in the AgentInsight.
  const costDriver = useMemo(() => {
    let driver: { name: string; minMonthly: number } | null = null;
    for (const med of medications) {
      const stats = perDrugBest(med, eligiblePlans, formularyTick);
      if (stats.minMonthlyCopay == null) continue;
      if (!driver || stats.minMonthlyCopay > driver.minMonthly) {
        driver = { name: med.name, minMonthly: stats.minMonthlyCopay };
      }
    }
    return driver;
  }, [medications, eligiblePlans, formularyTick]);

  return (
    <Container>
      <Header
        title="Your medications"
        sub="Checking coverage and costs across all plans…"
      />

      {medications.length === 0 ? (
        <Card>
          <div
            style={{
              padding: 12,
              fontSize: 13,
              color: '#64748b',
              textAlign: 'center',
            }}
          >
            No medications captured yet. Use the existing Medications
            workflow to add drugs (RxNorm search or photo capture), then
            return here to see live coverage.
          </div>
        </Card>
      ) : (
        medications.map((med, i) => (
          <MedRow
            key={med.id}
            med={med}
            index={i}
            plans={eligiblePlans}
            tick={formularyTick}
          />
        ))
      )}

      {!clientView && medications.length > 0 && (
        <AgentInsight>
          {costDriver ? (
            <>
              ⚠️ <b>{costDriver.name} is the cost driver.</b> Lowest copay
              across covered plans is ${costDriver.minMonthly}/mo. Frame the
              quote around this drug.
              <br />
            </>
          ) : (
            <>
              💡 Costs resolving — once formulary lookups land, the cost
              driver will surface here.
              <br />
            </>
          )}
          {bestAnnualTotal != null ? (
            <>
              💰 Best total annual drug spend across plans:{' '}
              <b>{fmt(bestAnnualTotal)}/yr</b>{' '}
              <span style={{ opacity: 0.6 }}>
                (live from pm_drug_cost_cache)
              </span>
            </>
          ) : drugCosts.loading ? (
            <>💰 Calculating live total annual drug spend…</>
          ) : drugCosts.source === 'no_meds' || drugCosts.source === 'no_ndcs' ? (
            <>
              💰 No NDCs resolved yet — totals will appear once each med
              has an RxNorm match.
            </>
          ) : null}
        </AgentInsight>
      )}

      <Nav onBack={onBack} onNext={onNext} />
    </Container>
  );
}

interface PerDrugStats {
  minMonthlyCopay: number | null;
  bestTier: number | null;
  coveredPlans: number;
  totalPlans: number;
  ready: boolean;
}

function perDrugBest(
  med: Medication,
  plans: Plan[],
  // tick is intentionally read so React re-renders pick up newly
  // primed formulary hits. The function signature lets the parent
  // memo bust on tick change without exposing the cache implementation.
  _tick: number,
): PerDrugStats {
  if (!med.rxcui || plans.length === 0) {
    return {
      minMonthlyCopay: null,
      bestTier: null,
      coveredPlans: 0,
      totalPlans: plans.length,
      ready: false,
    };
  }
  let minCopay: number | null = null;
  let bestTier: number | null = null;
  let covered = 0;
  let anyHit = false;
  for (const p of plans) {
    const hit = getCachedFormulary(`${p.contract_id}_${p.plan_number}`, med.rxcui);
    if (!hit) continue;
    anyHit = true;
    if (hit.tier === 'not_covered' || hit.tier === 'excluded') continue;
    covered += 1;
    const tierNum = typeof hit.tier === 'number' ? hit.tier : null;
    if (tierNum != null && (bestTier == null || tierNum < bestTier)) {
      bestTier = tierNum;
    }
    if (typeof hit.copay === 'number') {
      if (minCopay == null || hit.copay < minCopay) minCopay = hit.copay;
    }
  }
  return {
    minMonthlyCopay: minCopay,
    bestTier,
    coveredPlans: covered,
    totalPlans: plans.length,
    ready: anyHit,
  };
}

function MedRow({
  med,
  index,
  plans,
  tick,
}: {
  med: Medication;
  index: number;
  plans: Plan[];
  tick: number;
}) {
  const stats = useMemo(() => perDrugBest(med, plans, tick), [med, plans, tick]);
  const tierForIcon = stats.bestTier ?? 0;
  const dosage = [med.strength, med.dosageInstructions].filter(Boolean).join(' • ');
  // Annualized estimate = monthly copay × 12. We label it "est" so
  // nobody mistakes it for a Medicare.gov-sourced annual; the live
  // total in the footer AgentInsight is the real per-plan annual.
  const estAnnual =
    stats.minMonthlyCopay != null ? stats.minMonthlyCopay * 12 : null;

  return (
    <Card
      style={{
        padding: '16px 20px',
        marginBottom: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        animation: `${FADE_SLIDE_IN} 0.4s ease ${index * 0.08}s both`,
      }}
    >
      <MedIcon tier={tierForIcon}>{iconForMed(med)}</MedIcon>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontWeight: 700,
            fontSize: 15,
            color: '#0d2f5e',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {med.name}
        </div>
        <div style={{ color: '#64748b', fontSize: 11 }}>
          {dosage || (med.rxcui ? `rxcui ${med.rxcui}` : 'no dosage on file')}
        </div>
      </div>
      <TierBadge tier={stats.bestTier} />
      <div style={{ textAlign: 'right', minWidth: 95 }}>
        {!med.rxcui ? (
          <div style={{ fontSize: 10, color: '#a32d2d', fontWeight: 600 }}>
            No RxNorm match
          </div>
        ) : !stats.ready ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              justifyContent: 'flex-end',
            }}
          >
            <div className="pma3-spinner" style={{ width: 12, height: 12 }} />
            <span style={{ fontSize: 10, color: '#94a3b8' }}>Checking</span>
          </div>
        ) : stats.coveredPlans === 0 ? (
          <div style={{ fontSize: 10, color: '#a32d2d', fontWeight: 600 }}>
            Not covered
          </div>
        ) : (
          <div style={{ animation: `${FADE_SLIDE_IN} 0.3s ease` }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: '#0d2f5e' }}>
              {estAnnual != null ? (
                <>
                  {fmt(estAnnual)}
                  <span style={{ fontSize: 10, color: '#94a3b8' }}>/yr est</span>
                </>
              ) : (
                <span style={{ fontSize: 11, color: '#64748b' }}>copay TBD</span>
              )}
            </div>
            <div style={{ fontSize: 9, color: '#059669', fontWeight: 600 }}>
              Covered on {stats.coveredPlans}/{stats.totalPlans} plans
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
