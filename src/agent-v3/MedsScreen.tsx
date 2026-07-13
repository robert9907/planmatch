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

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { UseCaptureSessionResult } from '@/hooks/useCaptureSession';
import { useDrugCosts } from '@/hooks/useDrugCosts';
import { useDrugSearch } from '@/hooks/useDrugSearch';
import { useSession } from '@/hooks/useSession';
import {
  bulkLookupFormulary,
  getCachedFormulary,
} from '@/lib/formularyLookup';
import { monthlyCostFromFormulary } from '@/lib/drugCosts';
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
import { SnapInbox } from './SnapInbox';
import { FADE_SLIDE_IN } from './styles';

interface Props {
  onNext: () => void;
  onBack: () => void;
  clientView: boolean;
  capture: UseCaptureSessionResult;
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

export function MedsScreen({ onNext, onBack, clientView, capture }: Props) {
  const client = useSession((s) => s.client);
  const medications = useSession((s) => s.medications);
  const addMedication = useSession((s) => s.addMedication);
  const removeMedication = useSession((s) => s.removeMedication);

  // Pre-fill for the AddMedPanel search input. Set when the broker
  // taps the yellow "couldn't match" warning on an unresolved
  // AgentBase-hydrated row — pre-fills the raw broker-typed name and
  // scrolls the search into view so a re-pick is one click away.
  const [presetQuery, setPresetQuery] = useState<string | null>(null);
  const addPanelRef = useRef<HTMLDivElement>(null);
  const handleRepick = (med: Medication) => {
    setPresetQuery(med.originalName || med.name);
    // Remove the unresolved row so a successful re-pick doesn't leave
    // a stale "couldn't match" card below the new resolved one.
    removeMedication(med.id);
    addPanelRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  };

  // Eligible plan set drives the formulary prime + the live total
  // drug-cost lookup. planType is null so the prime covers the full
  // county pool (MAPD + SNP + MA-only) — matches AgentV3App's catalog
  // fetch so bench D-SNP / C-SNP plans land with their formulary
  // already cached when the broker filters to them on CompareScreen.
  const [eligiblePlans, setEligiblePlans] = useState<Plan[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchPlansForClient({
      state: client.state,
      county: client.county,
      planType: null,
    }).then((plans) => {
      if (!cancelled) setEligiblePlans(plans);
    });
    return () => {
      cancelled = true;
    };
  }, [client.state, client.county]);

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
    // rxcui → broker-typed name, threaded to the consumer endpoint's
    // ingredient-stem fallback. Lets the fallback widen via the
    // user's label (e.g. "Pramipexole 1MG") even when the resolved
    // rxcui's pm_drug_ndc seed name doesn't carry the right stem.
    const names = Object.fromEntries(
      medications
        .filter((m) => m.rxcui && m.name)
        .map((m) => [m.rxcui as string, m.name]),
    );
    bulkLookupFormulary(contractIds, rxcuis, names).then(() => {
      if (!cancelled) setFormularyTick((t) => t + 1);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primeNonce]);

  // Bounded re-prime safety net. If the first prime completed but every
  // drug still has zero cache hits across every eligible plan, the bulk
  // POST likely failed transparently (cold-start abort, network blip,
  // chunked retries that all rejected). Without this the rows sit at
  // "No formulary data" until a hard reload — see commit referencing
  // bulkLookupFormulary silent-failure recurrence. One retry per
  // primeNonce; if it stays empty after the retry, we accept the result.
  const reprimeRef = useRef<Record<string, number>>({});
  useEffect(() => {
    if (formularyTick === 0) return;
    if (eligiblePlans.length === 0 || medications.length === 0) return;
    const rxcuis = medications
      .map((m) => m.rxcui)
      .filter((s): s is string => !!s);
    if (rxcuis.length === 0) return;
    const allDry = rxcuis.every(
      (rxcui) =>
        !eligiblePlans.some((p) =>
          getCachedFormulary(`${p.contract_id}_${p.plan_number}`, rxcui),
        ),
    );
    if (!allDry) return;
    if ((reprimeRef.current[primeNonce] ?? 0) >= 1) return;
    reprimeRef.current[primeNonce] = 1;
    let cancelled = false;
    const contractIds = [...new Set(eligiblePlans.map((p) => p.contract_id))];
    const names = Object.fromEntries(
      medications
        .filter((m) => m.rxcui && m.name)
        .map((m) => [m.rxcui as string, m.name]),
    );
    bulkLookupFormulary(contractIds, rxcuis, names).then(() => {
      if (!cancelled) setFormularyTick((t) => t + 1);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formularyTick, primeNonce]);

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

      <SnapInbox capture={capture} accept="medication" />

      <AddMedPanel
        panelRef={addPanelRef}
        presetQuery={presetQuery}
        onPresetConsumed={() => setPresetQuery(null)}
        excludeRxcuis={medications
          .map((m) => m.rxcui)
          .filter((r): r is string => !!r)}
        onAdd={(r) => {
          addMedication({
            name: r.displayName,
            rxcui: r.rxcui,
            dose: r.strength ?? undefined,
            form: r.dose_form ?? undefined,
            source: 'manual',
            isBrand: r.is_brand,
          });
        }}
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
            Search above to add medications — tier and live annual cost
            populate per row once each med has an RxNorm match.
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
            onRemove={() => removeMedication(med.id)}
            onRepick={() => handleRepick(med)}
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
  // Tier count map → drives modal-tier selection. Showing the LOWEST
  // tier across the pool used to surface Tier 1 for Ozempic in
  // counties with I-SNP / D-SNP plans (Longevity, PruittHealth, Liberty
  // file Ozempic at Tier 1 because their dual / institutional residents
  // pay Medicaid-floor copays regardless of tier). A broker quoting a
  // standard MAPD would then see "T1" on the meds screen and expect
  // cheap Ozempic, when in reality it's Tier 3 / 25% coinsurance on
  // 666 of 681 Durham plans (98%). Modal (most-common) tier is the
  // honest broker-aligned answer; the rare SNP override no longer
  // poisons the badge.
  const tierCounts = new Map<number, number>();
  let covered = 0;
  let anyHit = false;
  for (const p of plans) {
    const hit = getCachedFormulary(`${p.contract_id}_${p.plan_number}`, med.rxcui);
    if (!hit) continue;
    anyHit = true;
    if (hit.tier === 'not_covered' || hit.tier === 'excluded') continue;
    covered += 1;
    const tierNum = typeof hit.tier === 'number' ? hit.tier : null;
    if (tierNum != null) {
      tierCounts.set(tierNum, (tierCounts.get(tierNum) ?? 0) + 1);
    }
    // Per-fill cost: flat copay when filed, else coinsurance × tier
    // notional retail. Without the coinsurance branch a Tier 3 25%
    // coinsurance row (Ozempic on most NC plans) rendered as null and
    // the row showed "copay TBD" with no estimate.
    //
    // Rx-tier fallback: ~20-30% of Tier 1-2 drugs land on plans whose
    // SPUF formulary extract carries the tier but not the dollar value
    // (atorvastatin, lisinopril, metformin — covered on 60-90% of NC
    // plans but copay=null in pm_formulary on every matching row). The
    // plan's per-tier cost-share table (Plan.benefits.rx_tiers.tier_N,
    // sourced from pbp_mrx_tier.txt) DOES carry the dollar value. When
    // the formulary hit is empty on both copay + coinsurance, look up
    // the plan's rx_tier_N for the matched tier and use that instead.
    // Turns "copay TBD" into "$X" on every plan where the tier table
    // is populated; falls back to monthly=0 (existing behavior) when
    // the plan didn't file rx_tier_N either.
    let copayUse = hit.copay;
    let coinsUse = hit.coinsurance;
    if (copayUse == null && coinsUse == null && tierNum != null) {
      const tierKey = `tier_${tierNum}` as keyof typeof p.benefits.rx_tiers;
      const planTier = p.benefits.rx_tiers[tierKey];
      if (planTier) {
        copayUse = planTier.copay;
        coinsUse = planTier.coinsurance;
      }
    }
    const monthly = monthlyCostFromFormulary({
      tier: tierNum,
      copay: copayUse,
      coinsurance: coinsUse,
    });
    if (monthly > 0 && (minCopay == null || monthly < minCopay)) {
      minCopay = monthly;
    }
  }
  // Modal tier — most common across the pool. Ties broken by tier
  // number ascending (so a 50/50 T1/T3 split prefers T1, surfacing
  // the broker-relevant lower number when populations actually align).
  let bestTier: number | null = null;
  let modalCount = 0;
  for (const [tier, count] of [...tierCounts.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > modalCount) {
      modalCount = count;
      bestTier = tier;
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
  onRemove,
  onRepick,
}: {
  med: Medication;
  index: number;
  plans: Plan[];
  tick: number;
  onRemove: () => void;
  onRepick: () => void;
}) {
  const stats = useMemo(() => perDrugBest(med, plans, tick), [med, plans, tick]);
  const tierForIcon = stats.bestTier ?? 0;
  const dosage = [med.dose, med.frequency].filter(Boolean).join(' • ');

  // Cap the Checking spinner at 12s. If the formulary prime returns
  // empty for this rxcui (or the resolver stalled before ever assigning
  // one), fall through to a soft "No formulary data" message instead of
  // spinning forever — better signal for the broker than perpetual
  // motion. Resets on rxcui/ready/tick so a late-arriving prime still
  // promotes the row to the real stats render.
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (stats.ready) return;
    const id = setTimeout(() => setTimedOut(true), 12000);
    return () => clearTimeout(id);
  }, [med.rxcui, stats.ready, tick]);
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
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${med.name}`}
        style={{
          background: 'transparent',
          border: 'none',
          color: '#94a3b8',
          cursor: 'pointer',
          fontSize: 14,
          padding: '0 4px',
          lineHeight: 1,
        }}
      >
        ✕
      </button>
      <div style={{ textAlign: 'right', minWidth: 95 }}>
        {!med.rxcui ? (
          // Yellow "couldn't match to formulary" warning. Tap fires
          // onRepick, which pre-fills the AddMedPanel search with the
          // original broker-typed name so a re-search is one click.
          // The row itself gets removed on repick so a successful
          // re-pick doesn't leave the stale warning row below the new
          // resolved card.
          <button
            type="button"
            onClick={onRepick}
            aria-label={`Re-search ${med.originalName || med.name}`}
            style={{
              background: '#fef3c7',
              border: '1px solid #f59e0b',
              borderRadius: 8,
              padding: '6px 8px',
              cursor: 'pointer',
              textAlign: 'right',
              lineHeight: 1.25,
            }}
          >
            <div style={{ fontSize: 10, color: '#92400e', fontWeight: 700 }}>
              Could not match to formulary
            </div>
            <div style={{ fontSize: 9, color: '#b45309', fontWeight: 600 }}>
              tap to re-search
            </div>
          </button>
        ) : !stats.ready ? (
          timedOut ? (
            <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600 }}>
              No formulary data
            </div>
          ) : (
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
          )
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

function AddMedPanel({
  excludeRxcuis,
  onAdd,
  panelRef,
  presetQuery,
  onPresetConsumed,
}: {
  excludeRxcuis: readonly string[];
  onAdd: (r: {
    rxcui: string;
    displayName: string;
    strength: string | null;
    dose_form: string | null;
    is_brand: boolean;
  }) => void;
  panelRef?: RefObject<HTMLDivElement>;
  presetQuery?: string | null;
  onPresetConsumed?: () => void;
}) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const search = useDrugSearch(query, excludeRxcuis);

  // Sync presetQuery → local input state. Fires when the broker taps
  // a yellow "couldn't match" warning on an unresolved med row.
  // Consumes the preset immediately so a subsequent manual clear
  // doesn't get overridden if the parent hasn't updated state yet.
  useEffect(() => {
    if (presetQuery == null) return;
    setQuery(presetQuery);
    inputRef.current?.focus();
    onPresetConsumed?.();
  }, [presetQuery, onPresetConsumed]);

  return (
    <div ref={panelRef}>
    <Card style={{ marginBottom: 12, padding: '16px 20px' }}>
      <label
        style={{
          display: 'block',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: '#64748b',
          marginBottom: 6,
        }}
      >
        Add medication
      </label>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Type a drug name (e.g. metformin, ozempic)"
        style={{
          width: '100%',
          padding: '10px 12px',
          borderRadius: 10,
          border: '1px solid rgba(13,47,94,0.12)',
          fontSize: 14,
          color: '#0d2f5e',
          outline: 'none',
          background: '#f8fafc',
          boxSizing: 'border-box',
        }}
      />
      {search.loading && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#64748b' }}>
          Searching pm_drugs…
        </div>
      )}
      {search.error && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#a32d2d' }}>
          {search.error}
        </div>
      )}
      {search.results.length > 0 && (
        <ul
          style={{
            listStyle: 'none',
            margin: '8px 0 0',
            padding: 0,
            border: '1px solid rgba(13,47,94,0.08)',
            borderRadius: 10,
            overflow: 'hidden',
            background: 'white',
          }}
        >
          {search.results.map((r) => (
            <li
              key={r.rxcui}
              style={{ borderBottom: '1px solid rgba(13,47,94,0.04)' }}
            >
              <button
                type="button"
                onClick={() => {
                  onAdd({
                    rxcui: r.rxcui,
                    displayName: r.displayName,
                    strength: r.strength,
                    dose_form: r.dose_form,
                    is_brand: r.is_brand,
                  });
                  setQuery('');
                }}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 12px',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                  fontSize: 13,
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 700, color: '#0d2f5e' }}>
                    {r.displayName}
                  </span>
                  {r.strength && (
                    <span style={{ marginLeft: 8, fontSize: 11, color: '#64748b' }}>
                      {r.strength}
                    </span>
                  )}
                  {r.dose_form && (
                    <span style={{ marginLeft: 4, fontSize: 11, color: '#94a3b8' }}>
                      · {r.dose_form}
                    </span>
                  )}
                </span>
                <span style={{ fontSize: 11, color: '#0071e3', fontWeight: 700 }}>
                  Add
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
    </div>
  );
}
