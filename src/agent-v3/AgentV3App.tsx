// AgentV3App — top-level shell for the agent quoting flow.
//
// 7-screen flow: intake → meds → providers → priorities → compare →
// compliance → enroll. The Plans/Swipe deck collapsed into Compare,
// which now seeds slots directly from the brain's ranked scoring
// (current + top 3 brain-ranked, bench = the rest).
//
// State that lives at this layer (lifted out of individual screens so
// downstream screens stay coherent):
//   • screen           — current page id
//   • clientView       — Agent vs Client display toggle
//   • eligiblePlans    — county/state plan catalog (one fetch)
//   • brainResult      — usePlanBrain output (one ranking)
//   • priorities       — 8-toggle output from PrioritiesScreen
//
// Compliance progress derives off useSession in render.
//
// Voice calls are not handled here — the broker dials from AgentBase
// (the AgentBar "Call" button is now a deep-link to the CRM). PlanMatch
// owns screen sharing only; AgentBase owns the call. Two apps, one
// session.

import { useEffect, useMemo, useState } from 'react';
import { usePlanBrain } from '@/hooks/usePlanBrain';
import { useResolveRxcuis } from '@/hooks/useResolveRxcuis';
import { useSession } from '@/hooks/useSession';
import { useScreenShareStore } from '@/hooks/useScreenShare';
import { fetchClientSession } from '@/lib/agentbase';
import { bulkLookupFormulary, getCachedFormulary } from '@/lib/formularyLookup';
import { fetchPlansForClient } from '@/lib/planCatalog';
import { totalComplianceItems } from '@/lib/compliance';
import { monthlyCostFromFormulary } from '@/lib/drugCosts';
import type { Plan } from '@/types/plans';
import type { StateCode } from '@/types/session';
import { useAgentBaseRecommend } from '@/hooks/useAgentBaseRecommend';
import { AgentBar, type ScreenId } from './AgentBar';
import { ComplianceScreen } from './ComplianceScreen';
import { CompareScreen } from './CompareScreen';
import { DisclaimersScreen } from './DisclaimersScreen';
import { EnrollScreen } from './EnrollScreen';
import { IntakeScreen } from './IntakeScreen';
import { MedsScreen } from './MedsScreen';
import { buildAgentV3SyncInput } from './agentbaseSync';
import { PrioritiesScreen, type PriorityKey } from './PrioritiesScreen';
import { ProvidersScreen } from './ProvidersScreen';
import {
  applyClientSeed,
  isSeedRequested,
  pickCurrentPlanForSeed,
} from './seed';
import { AGENT_V3_CSS } from './styles';

/** Returns the AgentBase clients.id passed in via ?clientId=… or null
 *  when the parameter is absent / blank. The AgentBase CRM links to
 *  /agent-v3?clientId=<id> so the broker lands in the quote with the
 *  right client already loaded. */
function getClientIdParam(): string | null {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get('clientId');
  return v && v.trim() ? v.trim() : null;
}

// Annual-cost ceiling per Part D tier — used by the sanity layer over
// pm_drug_cost_cache. Module-scope so it isn't re-created every render
// (would invalidate the annualDrugByPlanId memo).
const TIER_ANNUAL_CEILING: Record<number, number> = {
  1: 360,    // Tier 1 generics — $30/mo upper bound (most are $0-$10)
  2: 720,    // Tier 2 preferred generics — $60/mo
  3: 1800,   // Tier 3 preferred brands — $150/mo
  4: 4800,   // Tier 4 non-preferred — $400/mo
  5: 18000,  // Tier 5 specialty — coinsurance on high-priced biologics
};

type HydrationState =
  | { kind: 'idle' }       // no clientId in URL — seed mode or empty
  | { kind: 'loading'; clientId: string }
  | { kind: 'ready'; clientId: string; clientName: string }
  | { kind: 'error'; clientId: string; message: string };

// Priority keys that map directly to extras-axis benefit_type strings.
// "low_rx", "low_premium", "keep_doctor" are weight knobs handled
// elsewhere — they don't get forwarded as userPriorities.
const PRIORITY_TO_EXTRAS: Partial<Record<PriorityKey, string>> = {
  dental: 'dental',
  vision: 'vision',
  hearing: 'hearing',
  otc: 'otc',
  fitness: 'fitness',
  transportation: 'transportation',
};

// Default selection mirrors the spec ("Low Rx, Keep doctor, Dental,
// Vision" pre-toggled). Three of these don't drive userPriorities but
// keeping them on by default is the right starting point for the
// weight overrides.
const DEFAULT_PRIORITIES: PriorityKey[] = [
  'low_rx',
  'keep_doctor',
  'dental',
  'vision',
];

export function AgentV3App() {
  const [screen, setScreen] = useState<ScreenId>('intake');
  const [clientView, setClientView] = useState(false);
  const [priorities, setPriorities] = useState<PriorityKey[]>(DEFAULT_PRIORITIES);

  const client = useSession((s) => s.client);
  const medications = useSession((s) => s.medications);
  const providers = useSession((s) => s.providers);
  const currentPlanId = useSession((s) => s.currentPlanId);
  const setCurrentPlanId = useSession((s) => s.setCurrentPlanId);
  const updateProvider = useSession((s) => s.updateProvider);
  const checked = useSession((s) => s.complianceChecked);
  const confirmed = useSession((s) => s.disclaimersConfirmed);
  const sessionId = useSession((s) => s.sessionId);
  const startedAt = useSession((s) => s.startedAt);

  // AgentBase write-back. Fires from CompareScreen's Enroll buttons
  // and EnrollScreen's SunFire CTA. Hook handles idempotent same-plan
  // re-clicks + auto-retry; UI never blocks waiting for it.
  const agentbaseSync = useAgentBaseRecommend();

  // Backfill rxcuis on any seeded / hydrated meds that lack one — the
  // formulary + drug-cost lookups all key on rxcui, so without this hook
  // the seed payload renders red badges across the board.
  useResolveRxcuis();

  // ── Hydration: AgentBase clientId vs test-fixture seed ──────────
  // Order matters: clientId wins. AgentBase deep-links the broker via
  //   /agent-v3?clientId=<numeric AgentBase clients.id>
  // and we replace any seed/persisted data with the real CRM record
  // (clients × client_medications × client_providers) so the broker
  // doesn't have to re-key Robert's fictitious phone over their actual
  // client mid-call.
  //
  // ?seed=robert remains for demos. Both are skipped when neither URL
  // param is present — the broker can hand-key data into IntakeScreen
  // exactly as before.
  const [hydration, setHydration] = useState<HydrationState>({ kind: 'idle' });

  useEffect(() => {
    const clientId = getClientIdParam();
    if (!clientId) {
      // No CRM hydration requested — fall through to the seed path.
      if (isSeedRequested()) applyClientSeed(useSession.getState());
      return;
    }

    setHydration({ kind: 'loading', clientId });
    const ctl = new AbortController();
    void (async () => {
      const { detail, error } = await fetchClientSession(clientId, ctl.signal);
      if (ctl.signal.aborted) return;

      if (!detail) {
        setHydration({
          kind: 'error',
          clientId,
          message: error ?? 'Client not found in AgentBase.',
        });
        return;
      }

      // Wipe any stale meds / providers from a prior client before
      // pasting the new ones in — same guard the LandingPage picker
      // uses so we never mix two clients' data.
      const store = useSession.getState();
      for (const m of store.medications) store.removeMedication(m.id);
      for (const p of store.providers) store.removeProvider(p.id);

      const c = detail.client;
      const stateCode: StateCode | null =
        c.state && /^[A-Z]{2}$/i.test(c.state)
          ? (c.state.toUpperCase() as StateCode)
          : null;
      // plan_type isn't on the AgentBase clients table; fall back to
      // MAPD (the dominant Medicare-Advantage bucket the broker quotes
      // most). Preserve whatever the LandingPage picker would have
      // inferred by reading the same plan / lead_source heuristic via
      // the agentbase lib's deriveSummary — but to avoid pulling that
      // path in here, MAPD is a safe default the broker can switch on
      // the IntakeScreen.
      const planType = 'MAPD';

      store.updateClient({
        name: c.name,
        phone: c.phone,
        dob: c.dob,
        zip: c.zip,
        county: c.county,
        state: stateCode,
        planType,
        medicaidConfirmed: false,
        email: c.email || undefined,
        mbi: c.medicare_id || undefined,
      });
      // current_plan_id seeds the swipe deck's benchmark column when the
      // CRM has it; otherwise IntakeScreen's CurrentPlanPicker handles
      // it later. Skip annual-review auto-flip here — agent-v3 doesn't
      // surface that mode the way v4 does.
      if (c.plan_id) store.setCurrentPlanId(c.plan_id);

      for (const m of detail.medications) {
        store.addMedication({
          name: m.name,
          rxcui: m.rxcui || undefined,
          dosageInstructions:
            [m.dose, m.frequency].filter(Boolean).join(' · ') || undefined,
          source: 'manual',
          confidence: 'high',
        });
      }
      for (const p of detail.providers) {
        store.addProvider({
          name: p.name,
          specialty: p.specialty || undefined,
          npi: p.npi || undefined,
          address: p.address || undefined,
          phone: p.phone || undefined,
          source: 'manual',
        });
      }

      setHydration({ kind: 'ready', clientId, clientName: c.name });
    })();

    return () => ctl.abort();
  }, []);

  // Screen-share store — collapses the spec's three-way cycle to start/stop.
  const shareActive = useScreenShareStore((s) => Boolean(s.active));
  const shareStarting = useScreenShareStore((s) => s.starting);
  const shareError = useScreenShareStore((s) => s.error);
  const shareResult = useScreenShareStore((s) => s.result);
  const startShare = useScreenShareStore((s) => s.start);
  const stopShare = useScreenShareStore((s) => s.stop);

  // ── Eligible plan catalog ────────────────────────────────────────
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

  // Phase 2 of the test seed — once eligiblePlans has landed, pick a
  // plausible current plan so the swipe deck has something to benchmark
  // against. Skips when (a) ?seed=robert isn't set, (b) the broker
  // already chose a current plan, (c) the catalog is still loading, or
  // (d) we're hydrating from AgentBase — the CRM's plan_id wins, and
  // even if it's blank we'd rather show CurrentPlanPicker than slap a
  // demo Aetna pick onto a real client.
  useEffect(() => {
    if (getClientIdParam()) return;
    if (!isSeedRequested()) return;
    if (currentPlanId) return;
    if (eligiblePlans.length === 0) return;
    const pick = pickCurrentPlanForSeed(eligiblePlans);
    if (pick) setCurrentPlanId(pick.id);
  }, [eligiblePlans, currentPlanId, setCurrentPlanId]);

  // ── Plan Brain ranking (single pass for the whole shell) ─────────
  const userPriorityKeys = useMemo(
    () =>
      priorities
        .map((p) => PRIORITY_TO_EXTRAS[p])
        .filter((s): s is string => !!s),
    [priorities],
  );
  const weightOverride = useMemo(() => {
    const set = new Set(priorities);
    // "low_rx" doubles drug weight; "low_premium" doubles oop weight
    // (premium is the dominant lever inside the OOP axis). Both are
    // proportional rebalances — applyOverride() inside plan-brain
    // re-normalizes so the three axes still sum to 1.0.
    if (set.has('low_rx') && set.has('low_premium')) {
      return { drug: 0.55, oop: 0.35, extras: 0.1 };
    }
    if (set.has('low_rx')) return { drug: 0.6, oop: 0.25, extras: 0.15 };
    if (set.has('low_premium')) return { oop: 0.45, drug: 0.4, extras: 0.15 };
    return null;
  }, [priorities]);

  const brain = usePlanBrain({
    plans: eligiblePlans,
    client,
    medications,
    providers,
    userPriorities: userPriorityKeys,
    weightOverride,
  });

  // ── Provider network hydration ────────────────────────────────────
  // brain.data.networkByPlan already carries pm_provider_network_cache
  // rows for every (plan, npi) pair — it's part of the same Supabase
  // payload the brain itself uses. Mirror those rows into
  // useSession.providers[*].networkStatus so PinnedPlan + SwipeCard
  // (which read provider.networkStatus[plan.id]) light up immediately,
  // without requiring a visit to the Providers screen first. The
  // Providers screen still runs its own checkNetworkBatch on mount
  // for the staggered Queued → Checking → Verified animation; that's
  // additive — same data source, just animated.
  useEffect(() => {
    if (!brain.data) return;
    const networkByPlan = brain.data.networkByPlan;
    for (const provider of providers) {
      if (!provider.npi) continue;
      const next: Record<string, 'in' | 'out' | 'unknown'> = {
        ...(provider.networkStatus ?? {}),
      };
      let changed = false;
      for (const [planTriple, byNpi] of Object.entries(networkByPlan)) {
        const row = byNpi[provider.npi];
        if (!row) continue;
        const status: 'in' | 'out' | 'unknown' =
          row.covered === true ? 'in' : row.covered === false ? 'out' : 'unknown';
        if (next[planTriple] !== status) {
          next[planTriple] = status;
          changed = true;
        }
      }
      if (changed) updateProvider(provider.id, { networkStatus: next });
    }
    // Intentionally not depending on `providers` — we only react to
    // brain.data refreshes. Re-running on every providers update would
    // create a write→read loop with updateProvider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brain.data]);

  // ── Formulary cache prime (shell-level) ──────────────────────────
  // MedsScreen primes pm_formulary entries for eligiblePlans × user
  // rxcuis, but that screen may be skipped (AgentBase hydration lands
  // directly on swipe, ?seed flows, etc.). Re-prime here so the
  // formulary-based sanity layer below has the data it needs to
  // override implausible pm_drug_cost_cache values.
  useEffect(() => {
    if (eligiblePlans.length === 0 || medications.length === 0) return;
    const rxcuis = medications
      .map((m) => m.rxcui)
      .filter((s): s is string => !!s);
    if (rxcuis.length === 0) return;
    const contractIds = [...new Set(eligiblePlans.map((p) => p.contract_id))];
    void bulkLookupFormulary(contractIds, rxcuis);
  }, [eligiblePlans, medications]);

  // ── Drug-cost map sourced from pm_drug_cost_cache ────────────────
  // Earlier versions threaded useDrugCosts → /api/drug-costs, which
  // does a Playwright scrape of medicare.gov. Akamai now blocks the
  // scrape (POST .../drugs/cost times out at 30s on Vercel) and the
  // stale error gets cached for 5 min, so the swipe deck never sees
  // costs.
  //
  // /api/plan-brain-data already returns the structured pm_drug_cost_cache
  // slice (per-plan, per-NDC yearly totals) from Supabase — same source
  // the scrape would write to on a hit. We aggregate per plan: sum
  // estimated_yearly_total across NDCs, divide by 12 for monthly.
  //
  // Sanity layer: pm_drug_cost_cache occasionally carries bad rows
  // (full retail markup landed instead of plan-discounted cost — the
  // Wellcare Simple HMO-POS gabapentin row had estimated_yearly_total
  // = $15,378 against a Tier 1-2 generic that should be $0-$120/yr).
  // For each plan we compute a per-rxcui tier ceiling from the primed
  // formulary cache and use it as a soft cap. The cached value wins
  // when it sits inside the ceiling band; when it exceeds the band by
  // a wide margin we fall back to copay × 12 from the formulary tier.
  // Drugs marked 'not_covered' in formulary skip the ceiling — full
  // retail there is legitimate.
  const annualDrugByPlanId = useMemo<Record<string, number | null>>(() => {
    const out: Record<string, number | null> = {};
    if (!brain.data) return out;
    const rxcuis = medications
      .map((m) => m.rxcui)
      .filter((s): s is string => !!s);

    for (const plan of eligiblePlans) {
      const contractPlan = `${plan.contract_id}-${plan.plan_number}`;
      const ndcMap = brain.data.drugCostCache[plan.id] ?? {};
      let cacheTotal = 0;
      let anyCache = false;
      for (const row of Object.values(ndcMap)) {
        if (typeof row.estimated_yearly_total === 'number') {
          cacheTotal += row.estimated_yearly_total;
          anyCache = true;
        }
      }

      // Build the formulary-derived sane total + sane ceiling.
      let formularyTotal = 0;
      let ceilingTotal = 0;
      let allCovered = true;
      for (const rxcui of rxcuis) {
        const hit = getCachedFormulary(contractPlan, rxcui);
        if (!hit) {
          // No formulary data — can't bound, fall back to cache.
          allCovered = false;
          continue;
        }
        if (hit.tier === 'not_covered' || hit.tier === 'excluded') {
          // Drug isn't on formulary — patient pays retail, cache is
          // authoritative. Skip ceiling for this drug.
          allCovered = false;
          continue;
        }
        const tierNum = typeof hit.tier === 'number' ? hit.tier : null;
        if (tierNum != null) {
          ceilingTotal += TIER_ANNUAL_CEILING[tierNum] ?? 1800;
        }
        // Per-fill cost: flat copay when filed, else coinsurance × tier
        // notional retail. Pre-fix, the coinsurance branch was missing
        // and Ozempic (Tier 3, ~25% coinsurance on most NC plans) added
        // $0 to formularyTotal, surfacing as "Annual Drugs $0/yr" on
        // Compare when pm_drug_cost_cache had no row for the plan.
        const monthly = monthlyCostFromFormulary({
          tier: tierNum,
          copay: hit.copay,
          coinsurance: hit.coinsurance,
        });
        formularyTotal += monthly * 12;
      }

      if (!anyCache) {
        out[plan.id] = allCovered && rxcuis.length > 0 ? formularyTotal : null;
        continue;
      }

      // Override threshold: cache > 1.5× ceiling and ceiling > 0
      // means the cache is implausibly high vs. what the plan's
      // formulary filing says it should be. Use the formulary total
      // (or ceiling if formulary copay is null) instead.
      if (allCovered && ceilingTotal > 0 && cacheTotal > ceilingTotal * 1.5) {
        const replacement = formularyTotal > 0 ? formularyTotal : ceilingTotal;
        if (typeof console !== 'undefined' && console.warn) {
          console.warn(
            `[drug-cost-sanity] ${plan.contract_id}-${plan.plan_number}: ` +
              `cache=$${cacheTotal} → $${replacement} ` +
              `(tier ceiling $${ceilingTotal}, formulary copay × 12 = $${formularyTotal})`,
          );
        }
        out[plan.id] = replacement;
        continue;
      }

      out[plan.id] = cacheTotal;
    }
    return out;
  }, [brain.data, eligiblePlans, medications]);
  // ── Brain rank derivatives ───────────────────────────────────────
  // scoredPlans = the brain's ranked plan list (descending by composite
  // score). CompareScreen consumes this directly to seed slot 0 with
  // `current` (or the top plan as fallback) and slots 1–3 with the top
  // challengers. ProvidersScreen still wants the id-only list.
  const scoredPlans = useMemo<Plan[]>(() => {
    if (!brain.result) return [];
    return brain.result.scored.map((s) => s.plan);
  }, [brain.result]);
  const rankedPlanIds = useMemo<string[]>(
    () => scoredPlans.map((p) => p.id),
    [scoredPlans],
  );
  // Ribbon assignment per plan id (LOWEST_DRUG_COST, BEST_EXTRAS, etc.).
  // Brain's ribbon pass decorates only category leaders; most plans get
  // null. CompareScreen surfaces these as colored chips on bench cards.
  const ribbonByPlanId = useMemo<Record<string, string | null>>(() => {
    if (!brain.result) return {};
    const out: Record<string, string | null> = {};
    for (const s of brain.result.scored) {
      out[s.plan.id] = (s.ribbon as string | null) ?? null;
    }
    return out;
  }, [brain.result]);

  // ── Current plan lookup ──────────────────────────────────────────
  const currentPlan = useMemo<Plan | null>(() => {
    if (!currentPlanId) return null;
    return eligiblePlans.find((p) => p.id === currentPlanId) ?? null;
  }, [currentPlanId, eligiblePlans]);

  // ── Compliance progress (real, against canonical 16) ─────────────
  const complianceTotal = totalComplianceItems();
  const complianceDone = new Set(checked).size + new Set(confirmed).size;
  const complianceProgress = (complianceDone / complianceTotal) * 100;

  function onCycleShare() {
    if (shareStarting) return;
    if (shareActive) {
      void stopShare('agent-v3 share toggle');
    } else {
      // Fail fast when the broker hasn't captured a phone yet — the API
      // would 400 with "clientPhone required" and the UI would silently
      // surface no SMS. Surfacing an alert is intentionally crude:
      // share is a deliberate, in-call action, not a background hum.
      if (!client.phone || client.phone.trim() === '') {
        window.alert('Add a client phone on the Client screen first — the SMS link can\'t go anywhere without it.');
        return;
      }
      void startShare({
        clientPhone: client.phone,
        clientFirstName: client.name.split(' ')[0] || undefined,
      });
    }
  }

  function togglePriority(key: PriorityKey) {
    setPriorities((curr) =>
      curr.includes(key) ? curr.filter((k) => k !== key) : [...curr, key],
    );
  }

  // Fire-and-forget AgentBase write-back. Called from CompareScreen's
  // Enroll buttons (card + summary bar) and from EnrollScreen's
  // SunFire CTA. The hook is idempotent for same-plan re-clicks and
  // auto-retries on first failure — UI never waits on it.
  function onRecommend(plan: Plan) {
    const input = buildAgentV3SyncInput({
      plan,
      client,
      medications,
      providers,
      brainResult: brain.result,
      sessionId,
      startedAt,
    });
    if (!input) {
      console.warn(
        '[agent-v3] recommend skipped — brain.result not ready or plan not in scored set',
      );
      return;
    }
    void agentbaseSync.sync(input);
  }

  return (
    <div className="pma3">
      <style>{AGENT_V3_CSS}</style>

      <AgentBar
        screen={screen}
        onNav={setScreen}
        clientView={clientView}
        onToggleView={() => setClientView((v) => !v)}
        shareOn={shareActive}
        shareStarting={shareStarting}
        shareSmsFailed={Boolean(shareResult?.smsFailed)}
        shareSmsTo={shareResult?.smsTo ?? null}
        shareError={shareError}
        shareLink={shareResult?.link ?? null}
        onCycleShare={onCycleShare}
        complianceProgress={complianceProgress}
      />

      <div>
        {screen === 'intake' && (
          <IntakeScreen
            eligiblePlans={eligiblePlans}
            onNext={() => setScreen('disclaimers')}
          />
        )}
        {screen === 'disclaimers' && (
          <DisclaimersScreen
            eligiblePlans={eligiblePlans}
            onBack={() => setScreen('intake')}
            onNext={() => setScreen('meds')}
          />
        )}
        {screen === 'meds' && (
          <MedsScreen
            clientView={clientView}
            onBack={() => setScreen('disclaimers')}
            onNext={() => setScreen('providers')}
          />
        )}
        {screen === 'providers' && (
          <ProvidersScreen
            clientView={clientView}
            rankedPlanIds={rankedPlanIds}
            onBack={() => setScreen('meds')}
            onNext={() => setScreen('priorities')}
          />
        )}
        {screen === 'priorities' && (
          <PrioritiesScreen
            selected={priorities}
            onToggle={togglePriority}
            onBack={() => setScreen('providers')}
            onNext={() => setScreen('compare')}
          />
        )}
        {screen === 'compare' && (
          <CompareScreen
            current={currentPlan}
            scoredPlans={scoredPlans}
            ribbonByPlanId={ribbonByPlanId}
            annualDrugByPlanId={annualDrugByPlanId}
            onRecommend={onRecommend}
            onBack={() => setScreen('priorities')}
            onNext={() => setScreen('compliance')}
          />
        )}
        {screen === 'compliance' && (
          <ComplianceScreen
            onBack={() => setScreen('compare')}
            onNext={() => setScreen('enroll')}
          />
        )}
        {screen === 'enroll' && (
          <EnrollScreen
            current={currentPlan}
            onRecommend={onRecommend}
            scoredPlans={scoredPlans}
            annualDrugByPlanId={annualDrugByPlanId}
            onBack={() => setScreen('compliance')}
          />
        )}
      </div>

      {/* AgentBase hydration banner — only renders for clientId loads.
          Loading: faint top-right toast. Error: red, sticky until the
          broker dismisses (manual close = "I'll keep going without
          CRM data"). Ready state stays mounted as a small "loaded
          from AgentBase · <name>" badge so the broker can confirm
          they're looking at the right person. */}
      {hydration.kind !== 'idle' && (
        <HydrationToast
          state={hydration}
          onDismiss={() => setHydration({ kind: 'idle' })}
        />
      )}

      {/* Bottom-left tag so reviewers know which build they're in. */}
      <div
        style={{
          position: 'fixed',
          bottom: 12,
          left: 12,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 1,
          textTransform: 'uppercase',
          color: 'rgba(13,47,94,0.5)',
          background: 'rgba(255,255,255,0.7)',
          backdropFilter: 'blur(4px)',
          padding: '4px 8px',
          borderRadius: 6,
          border: '1px solid rgba(13,47,94,0.08)',
        }}
      >
        Agent v3 · review build
      </div>
    </div>
  );
}

interface HydrationToastProps {
  state: Exclude<HydrationState, { kind: 'idle' }>;
  onDismiss: () => void;
}

function HydrationToast({ state, onDismiss }: HydrationToastProps) {
  const base = {
    position: 'fixed' as const,
    top: 12,
    right: 12,
    zIndex: 200,
    padding: '8px 12px',
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    maxWidth: 360,
  };
  if (state.kind === 'loading') {
    return (
      <div
        style={{
          ...base,
          background: 'rgba(13,47,94,0.92)',
          color: '#83f0f9',
          border: '1px solid rgba(131,240,249,0.3)',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: '#83f0f9',
            animation: 'pma3-pulse 1.2s ease-in-out infinite',
          }}
        />
        Loading client #{state.clientId} from AgentBase…
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div
        role="alert"
        style={{
          ...base,
          background: '#7f1d1d',
          color: '#fecaca',
          border: '1px solid #ef4444',
          flexDirection: 'column',
          alignItems: 'flex-start',
        }}
      >
        <div>
          <strong>AgentBase load failed</strong> for client #{state.clientId}.
        </div>
        <div style={{ fontWeight: 400, opacity: 0.85 }}>{state.message}</div>
        <button
          type="button"
          onClick={onDismiss}
          style={{
            background: 'rgba(255,255,255,0.15)',
            border: '1px solid rgba(255,255,255,0.3)',
            borderRadius: 4,
            padding: '2px 10px',
            fontSize: 11,
            fontWeight: 700,
            color: 'inherit',
            cursor: 'pointer',
            alignSelf: 'flex-end',
          }}
        >
          Dismiss
        </button>
      </div>
    );
  }
  // ready
  return (
    <div
      style={{
        ...base,
        background: 'rgba(6,78,59,0.92)',
        color: '#a7f3d0',
        border: '1px solid #34d399',
      }}
    >
      <span aria-hidden>✓</span>
      Loaded {state.clientName} from AgentBase
      <button
        type="button"
        onClick={onDismiss}
        title="Dismiss"
        style={{
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: 14,
          lineHeight: 1,
          padding: 0,
          marginLeft: 4,
        }}
      >
        ✕
      </button>
    </div>
  );
}
