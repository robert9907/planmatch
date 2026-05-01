// AgentV3App — top-level shell for the agent quoting flow.
//
// Screen list and chrome track reference/plan-match-agent-full.jsx
// (8 screens: intake → meds → providers → priorities → swipe →
// compare → compliance → enroll).
//
// State that lives at this layer (lifted out of individual screens so
// the AgentBar counters and downstream screens stay coherent):
//   • screen           — current page id
//   • clientView       — Agent vs Client display toggle
//   • phoneOpen        — softphone panel visibility
//   • eligiblePlans    — county/state plan catalog (one fetch)
//   • brainResult      — usePlanBrain output (one ranking)
//   • drugCosts        — useDrugCosts output (one prime)
//   • priorities       — 8-toggle output from PrioritiesScreen
//   • kept[] / eliminated[] — swipe selections (drives Compare + Enroll)
//   • compareTarget    — currently-open CompareModal candidate
//
// Compliance progress + finalist counter are derived (not stored) off
// the same useSession + local state the screens read, so the AgentBar
// chrome stays in sync without an extra reducer.

import { useEffect, useMemo, useState } from 'react';
import { usePlanBrain } from '@/hooks/usePlanBrain';
import { useResolveRxcuis } from '@/hooks/useResolveRxcuis';
import { useSession } from '@/hooks/useSession';
import { useSoftphone } from '@/hooks/useSoftphone';
import { useScreenShareStore } from '@/hooks/useScreenShare';
import { fetchPlansForClient } from '@/lib/planCatalog';
import { totalComplianceItems } from '@/lib/compliance';
import type { Plan } from '@/types/plans';
import { AgentBar, FINALIST_CAP, type ScreenId } from './AgentBar';
import { CompareModal } from './CompareModal';
import { ComplianceScreen } from './ComplianceScreen';
import { CompareScreen } from './CompareScreen';
import { EnrollScreen } from './EnrollScreen';
import { IntakeScreen } from './IntakeScreen';
import { MedsScreen } from './MedsScreen';
import { PhonePanel } from './PhonePanel';
import { PrioritiesScreen, type PriorityKey } from './PrioritiesScreen';
import { ProvidersScreen } from './ProvidersScreen';
import { SwipeScreen } from './SwipeScreen';
import {
  applyClientSeed,
  isSeedRequested,
  pickCurrentPlanForSeed,
} from './seed';
import { AGENT_V3_CSS } from './styles';

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
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [priorities, setPriorities] = useState<PriorityKey[]>(DEFAULT_PRIORITIES);
  const [kept, setKept] = useState<Plan[]>([]);
  const [eliminated, setEliminated] = useState<Plan[]>([]);
  const [compareTarget, setCompareTarget] = useState<Plan | null>(null);

  const client = useSession((s) => s.client);
  const medications = useSession((s) => s.medications);
  const providers = useSession((s) => s.providers);
  const currentPlanId = useSession((s) => s.currentPlanId);
  const setCurrentPlanId = useSession((s) => s.setCurrentPlanId);
  const updateProvider = useSession((s) => s.updateProvider);
  const checked = useSession((s) => s.complianceChecked);
  const confirmed = useSession((s) => s.disclaimersConfirmed);

  // Backfill rxcuis on any seeded / hydrated meds that lack one — the
  // formulary + drug-cost lookups all key on rxcui, so without this hook
  // the seed payload renders red badges across the board.
  useResolveRxcuis();

  // ── Test-fixture seed (?seed=robert) ────────────────────────────
  // Fires once on mount; the second-stage current-plan pick happens
  // inside the eligiblePlans effect below.
  useEffect(() => {
    if (!isSeedRequested()) return;
    applyClientSeed(useSession.getState());
  }, []);

  // Single softphone instance for the whole shell.
  const phone = useSoftphone({ enabled: true });

  // Screen-share store — collapses the spec's three-way cycle to start/stop.
  const shareActive = useScreenShareStore((s) => Boolean(s.active));
  const shareStarting = useScreenShareStore((s) => s.starting);
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
  // already chose a current plan, or (c) the catalog is still loading.
  useEffect(() => {
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
  // Plans with no cached rows render "—" gracefully (the swipe card
  // and pinned plan both already handle that).
  const annualDrugByPlanId = useMemo<Record<string, number | null>>(() => {
    const out: Record<string, number | null> = {};
    if (!brain.data) return out;
    for (const [planId, ndcMap] of Object.entries(brain.data.drugCostCache)) {
      let total = 0;
      let any = false;
      for (const row of Object.values(ndcMap)) {
        if (typeof row.estimated_yearly_total === 'number') {
          total += row.estimated_yearly_total;
          any = true;
        }
      }
      out[planId] = any ? total : null;
    }
    return out;
  }, [brain.data]);
  const monthlyDrugByPlanId = useMemo<Record<string, number | null>>(() => {
    const out: Record<string, number | null> = {};
    for (const [planId, annual] of Object.entries(annualDrugByPlanId)) {
      out[planId] = annual != null ? Math.round(annual / 12) : null;
    }
    return out;
  }, [annualDrugByPlanId]);

  // ── Brain rank derivatives ───────────────────────────────────────
  // Brain pick = highest-ranked plan that ISN'T the client's current
  // plan. If the brain happens to rank the current plan #1 the user
  // would see "Brain pick = your current plan" which is meaningless;
  // falling to rank #2 surfaces an actual switch recommendation.
  const brainPick: Plan | null = useMemo(() => {
    if (!brain.result) return null;
    return (
      brain.result.scored.find((s) => s.plan.id !== currentPlanId)?.plan ?? null
    );
  }, [brain.result, currentPlanId]);

  const swipePool: Plan[] = useMemo(() => {
    if (!brain.result) return [];
    const eliminatedIds = new Set(eliminated.map((p) => p.id));
    const keptIds = new Set(kept.map((p) => p.id));
    return brain.result.scored
      .map((s) => s.plan)
      .filter(
        (p) =>
          p.id !== currentPlanId &&
          p.id !== brainPick?.id &&
          !eliminatedIds.has(p.id) &&
          !keptIds.has(p.id),
      );
  }, [brain.result, brainPick, eliminated, kept, currentPlanId]);

  // Lowest-Rx plan in the swipe-eligible set (excludes current + brain
  // pick). Computed once over the full ranked list — not the live
  // pool — so the gold border doesn't shift as the broker keeps /
  // eliminates plans. Stays null until useDrugCosts has populated the
  // monthly map.
  const goldPlanId: string | null = useMemo(() => {
    if (!brain.result || !brainPick) return null;
    const candidates = brain.result.scored
      .map((s) => s.plan)
      .filter((p) => p.id !== currentPlanId && p.id !== brainPick.id);
    let best: { id: string; cost: number } | null = null;
    for (const p of candidates) {
      const c = monthlyDrugByPlanId[p.id];
      if (c == null) continue;
      if (!best || c < best.cost) best = { id: p.id, cost: c };
    }
    return best?.id ?? null;
  }, [brain.result, brainPick, currentPlanId, monthlyDrugByPlanId]);

  const brainScoreByPlanId = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    if (!brain.result) return out;
    for (const s of brain.result.scored) out[s.plan.id] = s.composite;
    return out;
  }, [brain.result]);
  const brainReasonByPlanId = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    if (!brain.result) return out;
    for (const s of brain.result.scored) out[s.plan.id] = s.whySwitchCopy;
    return out;
  }, [brain.result]);
  const rankedPlanIds = useMemo<string[]>(() => {
    if (!brain.result) return [];
    return brain.result.scored.map((s) => s.plan.id);
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

  // ── Finalist counter ─────────────────────────────────────────────
  // Brain pick (when present) + each user-kept plan, capped at 4.
  const finalistCount = Math.min(
    (brainPick ? 1 : 0) + kept.length,
    FINALIST_CAP,
  );

  function onCycleShare() {
    if (shareStarting) return;
    if (shareActive) {
      void stopShare('agent-v3 share toggle');
    } else {
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

  function keepPlan(plan: Plan) {
    setKept((k) => (k.find((p) => p.id === plan.id) ? k : [...k, plan]));
  }
  function eliminatePlan(plan: Plan) {
    setEliminated((e) =>
      e.find((p) => p.id === plan.id) ? e : [...e, plan],
    );
  }

  return (
    <div className="pma3">
      <style>{AGENT_V3_CSS}</style>

      <AgentBar
        screen={screen}
        onNav={setScreen}
        clientView={clientView}
        onToggleView={() => setClientView((v) => !v)}
        phoneActive={phoneOpen}
        phoneState={phone.state}
        onTogglePhone={() => setPhoneOpen((o) => !o)}
        shareOn={shareActive}
        shareStarting={shareStarting}
        onCycleShare={onCycleShare}
        complianceProgress={complianceProgress}
        finalistCount={finalistCount}
      />

      <PhonePanel
        active={phoneOpen}
        onClose={() => setPhoneOpen(false)}
        clientName={client.name}
        clientPhone={client.phone}
        state={phone.state}
        duration={phone.duration}
        muted={phone.muted}
        error={phone.error}
        call={phone.call}
        hangup={phone.hangup}
        toggleMute={phone.toggleMute}
        toggleHold={phone.toggleHold}
        sendDtmf={phone.sendDtmf}
      />

      <div
        style={{
          marginRight: phoneOpen ? 300 : 0,
          transition: 'margin-right 0.3s',
        }}
      >
        {screen === 'intake' && (
          <IntakeScreen onNext={() => setScreen('meds')} />
        )}
        {screen === 'meds' && (
          <MedsScreen
            clientView={clientView}
            onBack={() => setScreen('intake')}
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
            onNext={() => setScreen('swipe')}
          />
        )}
        {screen === 'swipe' && (
          <SwipeScreen
            current={currentPlan}
            brainPick={brainPick}
            pool={swipePool}
            kept={kept}
            eliminated={eliminated}
            onKeep={keepPlan}
            onEliminate={eliminatePlan}
            onCompare={setCompareTarget}
            onNext={() => setScreen('compare')}
            onBack={() => setScreen('priorities')}
            annualDrugByPlanId={annualDrugByPlanId}
            monthlyDrugByPlanId={monthlyDrugByPlanId}
            brainScoreByPlanId={brainScoreByPlanId}
            brainReasonByPlanId={brainReasonByPlanId}
            brainReady={brain.ready}
            goldPlanId={goldPlanId}
          />
        )}
        {screen === 'compare' && (
          <CompareScreen
            current={currentPlan}
            brainPick={brainPick}
            kept={kept}
            annualDrugByPlanId={annualDrugByPlanId}
            onBack={() => setScreen('swipe')}
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
            brainPick={brainPick}
            annualDrugByPlanId={annualDrugByPlanId}
            onBack={() => setScreen('compliance')}
          />
        )}
      </div>

      {compareTarget && currentPlan && (
        <CompareModal
          current={currentPlan}
          candidate={compareTarget}
          annualDrugByPlanId={annualDrugByPlanId}
          onClose={() => setCompareTarget(null)}
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
