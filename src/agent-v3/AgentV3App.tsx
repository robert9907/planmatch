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
import { useCaptureSession } from '@/hooks/useCaptureSession';
import { usePlanBrain } from '@/hooks/usePlanBrain';
import { useResolveRxcuis } from '@/hooks/useResolveRxcuis';
import { useSession } from '@/hooks/useSession';
import { useScreenShareStore } from '@/hooks/useScreenShare';
import { fetchClientSession } from '@/lib/agentbase';
import { bulkLookupFormulary } from '@/lib/formularyLookup';
import { fetchPlansForClient } from '@/lib/planCatalog';
import { totalComplianceItems } from '@/lib/compliance';
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
import {
  buildAgentV3SyncInput,
  type ComplianceSnapshot,
  type AgentV3SessionSummary,
} from './agentbaseSync';
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

/** Explicit client fields the AgentBase "Quote in Plan Match" button
 *  packs into the URL so the Client screen lands fully populated before
 *  any async hydration resolves. All optional — only the keys that are
 *  present get applied. */
interface ClientFieldParams {
  name: string | null;
  dob: string | null;
  zip: string | null;
  county: string | null;
  state: StateCode | null;
  phone: string | null;
  email: string | null;
  currentPlanId: string | null;
  currentPlanName: string | null;
}

function getClientFieldParams(): ClientFieldParams {
  const empty: ClientFieldParams = {
    name: null,
    dob: null,
    zip: null,
    county: null,
    state: null,
    phone: null,
    email: null,
    currentPlanId: null,
    currentPlanName: null,
  };
  if (typeof window === 'undefined') return empty;
  const q = new URLSearchParams(window.location.search);
  const trim = (k: string): string | null => {
    const v = q.get(k);
    return v && v.trim() ? v.trim() : null;
  };
  const rawState = trim('state');
  const stateCode: StateCode | null =
    rawState && /^[A-Z]{2}$/i.test(rawState)
      ? (rawState.toUpperCase() as StateCode)
      : null;
  return {
    name: trim('name'),
    dob: trim('dob'),
    zip: trim('zip'),
    county: trim('county'),
    state: stateCode,
    phone: trim('phone'),
    email: trim('email'),
    currentPlanId: trim('current_plan_id'),
    currentPlanName: trim('current_plan_name'),
  };
}

function hasAnyClientFieldParam(p: ClientFieldParams): boolean {
  return Boolean(
    p.name ||
      p.dob ||
      p.zip ||
      p.county ||
      p.state ||
      p.phone ||
      p.email ||
      p.currentPlanId ||
      p.currentPlanName,
  );
}

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

// Default = nothing pre-toggled. With Gate 3's strict "must offer"
// elimination, a default-on dental + vision was eliminating every plan
// that didn't file BOTH benefits before the broker even saw the
// PrioritiesScreen. The broker now opts in explicitly to each extra
// the client cares about; empty = no Gate 3 filter at all.
const DEFAULT_PRIORITIES: PriorityKey[] = [];

export function AgentV3App() {
  const [screen, setScreen] = useState<ScreenId>('intake');
  const [clientView, setClientView] = useState(false);
  const [priorities, setPriorities] = useState<PriorityKey[]>(DEFAULT_PRIORITIES);

  // Bundle-version probe — visible in the browser console on first
  // mount so we can tell at a glance whether the loaded JS has the
  // empty-default fix or a cached older bundle. Expect:
  //   [agent-v3 init] DEFAULT_PRIORITIES=[] initialPriorities=[]
  // If the right side shows ['low_rx','keep_doctor','dental','vision']
  // the browser is on a stale bundle — hard-refresh.
  useEffect(() => {
    console.log(
      '[agent-v3 init] DEFAULT_PRIORITIES=',
      DEFAULT_PRIORITIES,
      'initialPriorities=',
      priorities,
    );
    // Mount-only — we don't want to log on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Snap-to-Session: shared capture session for the whole agent-v3
  // shell. Hoisted here so IntakeScreen (trigger), MedsScreen (med
  // inbox) and ProvidersScreen (provider inbox) all observe the same
  // queue. The hook is a no-op until SnapTrigger calls capture.start().
  const capture = useCaptureSession();

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

  // Carrier-prefixed plan label captured from ?current_plan_name=… on
  // mount. Used by IntakeScreen as a fallback render while the eligible
  // plan catalog is still loading — so the broker sees the plan
  // pre-selected instantly instead of an empty picker that fills in a
  // second later. Cleared once eligiblePlans resolves the real Plan row.
  const [presetCurrentPlanLabel, setPresetCurrentPlanLabel] = useState<
    string | null
  >(null);

  // Apply URL-passed client field params synchronously on first render
  // so the Client screen renders fully populated. AgentBase's "Quote in
  // Plan Match" button packs every field it has — name, dob, zip,
  // county, state, phone, email, current_plan_id, current_plan_name —
  // and the broker should land on intake with nothing left to type.
  //
  // Runs BEFORE the async clientId fetch below so we never flash an
  // empty form. The clientId fetch then layers meds + providers on top;
  // since it writes the same client fields, the values are unchanged.
  //
  // Using useState's lazy initializer guarantees this fires exactly
  // once, before paint — useEffect would let an empty form render
  // first.
  useState(() => {
    const fields = getClientFieldParams();
    if (!hasAnyClientFieldParam(fields)) return undefined;
    const store = useSession.getState();
    const patch: Parameters<typeof store.updateClient>[0] = {};
    if (fields.name) patch.name = fields.name;
    if (fields.dob) patch.dob = fields.dob;
    if (fields.zip) patch.zip = fields.zip;
    if (fields.county) patch.county = fields.county;
    if (fields.state) patch.state = fields.state;
    if (fields.phone) patch.phone = fields.phone;
    if (fields.email) patch.email = fields.email;
    // Default planType when the deep-link path runs without a clientId
    // fetch — without it the eligible-plan catalog never fires (the
    // fetch is gated on state+county+planType). 'MAPD' mirrors the
    // clientId hydration's same fallback below.
    if (!store.client.planType) patch.planType = 'MAPD';
    if (Object.keys(patch).length > 0) store.updateClient(patch);
    if (fields.currentPlanId) {
      store.setCurrentPlanId(fields.currentPlanId);
    }
    if (fields.currentPlanName) {
      setPresetCurrentPlanLabel(fields.currentPlanName);
    }
    return undefined;
  });

  useEffect(() => {
    const clientId = getClientIdParam();
    if (!clientId) {
      // No CRM hydration requested — fall through to the seed path.
      // (URL-passed field params were applied above, before render.)
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
        if (!m.name.trim()) continue;
        store.addMedication({
          name: m.name,
          rxcui: m.rxcui || undefined,
          dosageInstructions:
            [m.dose, m.frequency].filter(Boolean).join(' · ') || undefined,
          tier: m.tier || undefined,
          quantity: m.quantity || undefined,
          refillDays: m.refill_days || undefined,
          source: 'manual',
          confidence: 'high',
        });
      }
      for (const p of detail.providers) {
        if (!p.name.trim()) continue;
        // Pre-seed networkStatus for the plan the CRM last verified
        // against, so the Providers screen renders that row as the
        // resolved status instead of flashing Checking → Verified again.
        const seededStatus: Record<string, 'in' | 'out' | 'unknown'> = {};
        if (p.last_known_plan_id && p.last_known_network_status) {
          seededStatus[p.last_known_plan_id] = p.last_known_network_status;
        }
        store.addProvider({
          name: p.name,
          specialty: p.specialty || undefined,
          npi: p.npi || undefined,
          address: p.address || undefined,
          phone: p.phone || undefined,
          source: 'manual',
          networkStatus: seededStatus,
        });
      }
      console.info(
        `[agent-v3] hydrated from AgentBase: ${detail.medications.length} meds, ${detail.providers.length} providers`,
      );

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

  // ── Drug-cost map sourced from the brain (P5 fix) ────────────────
  // The brain's score.totalAnnualDrugCost is the authoritative number:
  // it uses RxNav-expanded rxcuis to match sibling formulary entries,
  // applies tier ceilings, handles insulin caps, and falls back to
  // formulary copay × 12 when pm_drug_cost_cache misses. The old
  // per-plan loop here used ORIGINAL rxcuis via getCachedFormulary and
  // diverged from the brain — the brain said "covered, $X" while this
  // map said "null" → UI rendered "Not available" on plans the brain
  // had already cleared Gate 2 with. Now they agree.
  //
  // Plans not in brain.result.scored (eliminated, or never reached
  // Gate 4) don't get an entry — UI fallback (?? null) renders em-dash.
  const annualDrugByPlanId = useMemo<Record<string, number | null>>(() => {
    if (!brain.result) return {};
    const out: Record<string, number | null> = {};
    for (const s of brain.result.scored) {
      out[s.plan.id] = Math.round(s.totalAnnualDrugCost);
    }
    return out;
  }, [brain.result]);
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

  // drugCoverageUnknown per plan id. After Gate 2's strict elimination
  // every plan in scored has drugCoverageUnknown=false — the disclaimer
  // never fires for Top 4 picks. Kept for compat with CompareScreen
  // signature.
  const drugCoverageUnknownByPlanId = useMemo<Record<string, boolean>>(() => {
    if (!brain.result) return {};
    const out: Record<string, boolean> = {};
    for (const s of brain.result.scored) {
      out[s.plan.id] = s.drugCoverageUnknown;
    }
    return out;
  }, [brain.result]);

  // ── Drug-coverage display from brain (P1 fix) ────────────────────
  // CompareScreen used to call coveredCount(plan, rxcuis), reading
  // plan.formulary[rxcui]. But /api/plans.ts returns formulary={}
  // (populated lazily via /api/formulary, and nothing in agent-v3
  // hydrates back onto the Plan object) so the old code always rendered
  // "0/N covered" for every plan, including the ones the brain knew
  // were fully covered. Source-of-truth is now BrainScore.coveredCount
  // / totalCount, surfaced through the adapter on ScoredPlan.
  const drugsCoveredByPlanId = useMemo<Record<string, number>>(() => {
    if (!brain.result) return {};
    const out: Record<string, number> = {};
    for (const s of brain.result.scored) out[s.plan.id] = s.drugsCovered;
    return out;
  }, [brain.result]);
  const drugsTotalByPlanId = useMemo<Record<string, number>>(() => {
    if (!brain.result) return {};
    const out: Record<string, number> = {};
    for (const s of brain.result.scored) out[s.plan.id] = s.drugsTotal;
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

  // AgentBase write-back. CompareScreen fires this fire-and-forget;
  // EnrollScreen awaits the returned promise so it can show a toast
  // and only open SunFire on a 2xx. The endpoint is idempotent for
  // same-plan re-clicks (handled inside useAgentBaseRecommend.sync).
  //
  // When the optional snapshot is passed (EnrollScreen path), the
  // compliance + sessionSummary fields flow through to the recommend
  // endpoint, which stamps clients.soa_confirmed_at /
  // call_recording_disclosed_at and inserts a planmatch_activity_log
  // row for the CMS audit trail.
  async function onRecommend(
    plan: Plan,
    snapshot?: {
      compliance?: ComplianceSnapshot;
      sessionSummary?: AgentV3SessionSummary;
    },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const idParam = getClientIdParam();
    const agentbaseClientId =
      idParam && /^\d+$/.test(idParam) ? Number(idParam) : null;
    const input = buildAgentV3SyncInput({
      plan,
      client,
      medications,
      providers,
      brainResult: brain.result,
      sessionId,
      startedAt,
      agentbaseClientId,
      compliance: snapshot?.compliance,
      sessionSummary: snapshot?.sessionSummary,
    });
    if (!input) {
      console.warn(
        '[agent-v3] recommend skipped — brain.result not ready or plan not in scored set',
      );
      return { ok: false, error: 'Brain ranking not ready — try again in a moment.' };
    }
    const r = await agentbaseSync.sync(input);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
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

      {brain.error && (
        <div
          style={{
            margin: '8px 0',
            padding: '10px 12px',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 8,
            color: '#7f1d1d',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          ⚠ Plan Brain data unavailable ({brain.error}). The ranking would be
          unreliable without network/formulary/benefit data, so it is not
          shown. Refresh or check the API logs.
        </div>
      )}
      {brain.unresolvedProviderNames.length > 0 && (
        <div
          style={{
            margin: '8px 0',
            padding: '10px 12px',
            background: '#fff8e1',
            border: '1px solid #f5d479',
            borderRadius: 8,
            color: '#7a5b00',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          ⚠ Provider NPI could not be resolved for:{' '}
          {brain.unresolvedProviderNames.join(', ')} — network status unknown
          for all plans. Re-pick from the Providers search or add an NPI so
          Gate 1 can run against the real network.
        </div>
      )}

      <div>
        {screen === 'intake' && (
          <IntakeScreen
            eligiblePlans={eligiblePlans}
            presetCurrentPlanLabel={presetCurrentPlanLabel}
            capture={capture}
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
            capture={capture}
            onBack={() => setScreen('disclaimers')}
            onNext={() => setScreen('providers')}
          />
        )}
        {screen === 'providers' && (
          <ProvidersScreen
            clientView={clientView}
            rankedPlanIds={rankedPlanIds}
            capture={capture}
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
            drugCoverageUnknownByPlanId={drugCoverageUnknownByPlanId}
            drugsCoveredByPlanId={drugsCoveredByPlanId}
            drugsTotalByPlanId={drugsTotalByPlanId}
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
