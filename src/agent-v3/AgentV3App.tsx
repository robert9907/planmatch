// AgentV3App — top-level shell for the agent quoting flow.
//
// ════════════════════════════════════════════════════════════════════
// CANONICAL AGENT-V3 CODEBASE.
//
// This is THE active source of truth for the agent-facing Plan Match
// tool. The consumer repo (robert9907/plan-match,
// apps/web/src/pages/agent-v3/) used to carry a 7-week-old refactor
// stub; W3 Fix 7 redirected planmatch.generationhealth.me/agent-v3
// → planmatch.vercel.app/agent-v3 (this app), and W4 Fix 3 deleted
// the stale consumer directory entirely.
//
// When you make a compliance-bearing change here (SOA wording, TPMO
// language, fitness-program names, recording disclosure, etc.) it does
// NOT need to be mirrored to the consumer repo — that route now just
// renders the W3-Fix-7 redirect.
// ════════════════════════════════════════════════════════════════════
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
import { useRankedPlans } from '@/hooks/useRankedPlans';
import { normalizePlanId } from '@/lib/library-client';
import { checkNetworkBatch } from '@/lib/networkCheck';
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
// All PriorityKey values map 1:1 today; the Partial<Record> shape is
// kept so future non-extras toggles can be added without breaking the
// extras-derivation below.
const PRIORITY_TO_EXTRAS: Partial<Record<PriorityKey, string>> = {
  dental: 'dental',
  vision: 'vision',
  hearing: 'hearing',
  otc: 'otc',
  fitness: 'fitness',
  transportation: 'transportation',
  telehealth: 'telehealth',
  healthy_foods: 'healthy_foods',
  partb_giveback: 'partb_giveback',
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
  // If the right side shows ['dental','vision']
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
        // Parse tier and refillDays from the AgentBase text columns
        // into the numeric Medication shape. Tier carries "Tier N" today
        // and (post-migration) just "N" — both produce a clean digit
        // here. refill_days is always a numeric string. NaN falls back
        // to undefined so we don't pollute the store with bad values.
        const parseDigit = (s: string | null | undefined): number | undefined => {
          if (!s) return undefined;
          const n = parseInt(String(s).replace(/[^0-9]/g, ''), 10);
          return Number.isFinite(n) ? n : undefined;
        };
        store.addMedication({
          name: m.name,
          rxcui: m.rxcui || undefined,
          dose: m.dose || undefined,
          frequency: m.frequency || undefined,
          tier: parseDigit(m.tier),
          quantity: m.quantity || undefined,
          refillDays: parseDigit(m.refill_days),
          // Phase 4: form + broker-entry context now round-trip
          // through the store.
          form: m.form || undefined,
          pharmacyId: m.pharmacy_id ?? undefined,
          refillDate: m.refill_date || undefined,
          notes: m.notes || undefined,
          source: 'agentbase',
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
  // planType is intentionally null here — the broker workflow needs the
  // full county pool (MAPD + D-SNP + C-SNP + MA-only) on the compare
  // bench so the D-SNP / C-SNP / VA category filters can partition real
  // rows. Filtering by client.planType at the API would drop the SNP
  // buckets before they ever reach Bench. The brain's gates still cull
  // by client eligibility; this just widens the pool feeding them.
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
  const brain = usePlanBrain({
    plans: eligiblePlans,
    client,
    medications,
    providers,
    userPriorities: userPriorityKeys,
  });

  // Library-side ranking — the new source of truth for the compare
  // screen's plan list, gate results, ribbons, per-plan medication
  // coverage, and per-plan provider network status. Runs alongside
  // the legacy usePlanBrain() call: QuoteDeliveryV4 + AgentBase
  // recommend still consume `brain` (PlanBrainResult/PlanBrainData
  // shape) because the library doesn't yet expose archetype, weights,
  // applied broker rules, red flags, real-cost breakdown, or
  // structured formulary rows. Those callers move over once the
  // library response is expanded. Until then we pay one extra
  // ranking call per quote — temporary cost while the migration is
  // staged.
  const ranked = useRankedPlans({
    client,
    medications,
    providers,
    userPriorities: userPriorityKeys,
    csnpConditions: client.csnpConditions,
    currentPlanId,
    // When the broker flagged the client as dual-eligible on Intake,
    // pass it through so the library's filterPlanPool keeps D-SNPs in
    // the Top-4 candidate pool. When false/undefined, the bench still
    // surfaces every D-SNP (sourced from eligiblePlans), but Top 4
    // stays strict — broker can drag any D-SNP onto the board manually
    // if the situation warrants it.
    dsnpEligible: client.dsnpEligible,
  });

  // ── Provider network hydration: full-county direct call ───────────
  // Calls /api/library/provider-network (via checkNetworkBatch) for
  // every (NPI × eligiblePlan) pair so the broker sees in/out/unknown
  // across all ~34 county plans on ProvidersScreen — not just the
  // ~10-12 plans that survive rank-plans Gate 1. rank-plans drops any
  // plan where ANY provider is out-of-network from its response, so a
  // gate-1 hydration alone left the OON plans permanently "Unverified"
  // and the broker couldn't see why the carrier was filtered out.
  //
  // Safe to run alongside the rank-plans-driven hydration below: both
  // write to provider.networkStatus[planId] but pull from the same
  // pm_provider_network_cache + FHIR live source, so the values
  // agree. The rank-plans effect is kept because its fhir_live rows
  // can land slightly fresher (rank-plans calls provider-network
  // server-side as part of Gate 1) and idempotent overwrites are
  // harmless.
  //
  // Dependency key is the NPI list (joined string) rather than
  // `providers` itself, because we re-fire only when the set of NPIs
  // changes — not when networkStatus updates on each provider, which
  // would cause a write→read loop with updateProvider.
  const providerNpiKey = useMemo(
    () => providers.map((p) => p.npi ?? '').join('|'),
    [providers],
  );

  useEffect(() => {
    if (eligiblePlans.length === 0) return;
    if (!client.state || !client.county) return;
    const npis = providers
      .map((p) => ({ id: p.id, npi: p.npi }))
      .filter((p): p is { id: string; npi: string } => !!p.npi);
    if (npis.length === 0) return;

    let cancelled = false;
    const ctx = { state: client.state, county: client.county };

    for (const { id: providerId, npi } of npis) {
      checkNetworkBatch(npi, eligiblePlans, ctx)
        .then((map) => {
          if (cancelled) return;
          // Snapshot the freshest provider record before merging — the
          // closure-captured `providers` array may be stale by the
          // time the async response lands. Walk by id to find current.
          const current = providers.find((p) => p.id === providerId);
          const prev = current?.networkStatus ?? {};
          const next: Record<string, 'in' | 'out' | 'unknown'> = { ...prev };
          let changed = false;
          let inN = 0;
          let outN = 0;
          let unkN = 0;
          for (const [planId, result] of map) {
            if (next[planId] !== result.status) {
              next[planId] = result.status;
              changed = true;
            }
            if (result.status === 'in') inN += 1;
            else if (result.status === 'out') outN += 1;
            else unkN += 1;
          }
          console.log(
            `[agent-v3] full-county hydration npi=${npi}: ` +
              `eligible=${eligiblePlans.length} resolved=${map.size} ` +
              `→ in=${inN} out=${outN} unknown=${unkN} (changed=${changed})`,
          );
          if (changed) updateProvider(providerId, { networkStatus: next });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          console.warn(
            `[agent-v3] full-county hydration failed for npi=${npi}:`,
            err instanceof Error ? err.message : err,
          );
        });
    }
    return () => {
      cancelled = true;
    };
    // Intentionally tracks providerNpiKey, not `providers`. See note
    // above about the write→read loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligiblePlans, client.state, client.county, providerNpiKey]);

  // ── Provider network hydration: rank-plans confirmer ─────────────
  // Mirror the per-plan provider network status from the rank-plans
  // response into useSession.providers[*].networkStatus. This only
  // covers the Gate-1-survivor subset (typically 10-12 of 34 plans);
  // the full-county hydration above handles the rest.
  useEffect(() => {
    if (!ranked.result) return;
    const allPlans = [
      ...ranked.result.top_plans,
      ...ranked.result.bench_plans,
    ];
    // Resolve library triples to the agent's canonical Plan.id so the
    // networkStatus map keys match what ProvidersScreen iterates
    // (row.plan.id, from fetchPlansForClient). Without normalization
    // a library "H1234-005-0" wouldn't collide with the agent's
    // "H1234-005-000" and every row would render as "Unverified".
    const agentIdByNormalized = new Map<string, string>();
    for (const p of eligiblePlans) agentIdByNormalized.set(normalizePlanId(p.id), p.id);
    for (const provider of providers) {
      if (!provider.npi) continue;
      const next: Record<string, 'in' | 'out' | 'unknown'> = {
        ...(provider.networkStatus ?? {}),
      };
      let changed = false;
      let foundInLibrary = 0;
      let inN = 0;
      let outN = 0;
      let unkN = 0;
      for (const lp of allPlans) {
        const agentPlanId = agentIdByNormalized.get(normalizePlanId(lp.plan_id));
        if (!agentPlanId) continue;
        const row = lp.providers.find((pr) => pr.npi === provider.npi);
        if (!row) continue;
        foundInLibrary += 1;
        const status: 'in' | 'out' | 'unknown' =
          row.in_network === true
            ? 'in'
            : row.in_network === false
              ? 'out'
              : 'unknown';
        if (status === 'in') inN += 1;
        else if (status === 'out') outN += 1;
        else unkN += 1;
        if (next[agentPlanId] !== status) {
          next[agentPlanId] = status;
          changed = true;
        }
      }
      console.log(
        `[agent-v3] rank-plans hydration npi=${provider.npi}: ` +
          `library-plans=${allPlans.length} found=${foundInLibrary} ` +
          `→ in=${inN} out=${outN} unknown=${unkN} ` +
          `(changed=${changed})`,
      );
      if (changed) updateProvider(provider.id, { networkStatus: next });
    }
    // Intentionally not depending on `providers` — we only react to
    // library result refreshes. Re-running on every providers update
    // would create a write→read loop with updateProvider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranked.result, eligiblePlans]);

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

  // ── Brain derivatives, sourced from the library result ─────────
  // The library's rank-plans response carries per-plan medications,
  // gate_results, ribbons, and totals. We adapt back into the side
  // maps + Plan[] shape CompareScreen already consumes so the screen
  // stays untouched while the underlying pipeline collapses to one
  // HTTP call. Plan objects come from `eligiblePlans` (the county
  // catalog) keyed by the library's `plan_id` triple.
  type DrugRow = {
    rxcui: string;
    name: string;
    covered: boolean;
    tier: number | null;
    monthlyCopay: number | null;
    annualCost: number;
  };

  // planById is keyed by the normalized triple form so the agent's
  // Plan.id ("H1234-005-000" — /api/plans pads empty segments) collides
  // with the library's raw triple ("H1234-005-0" — pm_plans.segment_id
  // emitted as-is). Without normalization the lookups silently miss and
  // CompareScreen falls into the "Brain ranking hasn't returned any
  // plans yet" empty state even when the library returned real plans.
  const planById = useMemo(() => {
    const m = new Map<string, Plan>();
    for (const p of eligiblePlans) m.set(normalizePlanId(p.id), p);
    return m;
  }, [eligiblePlans]);

  // One-shot diagnostic the first time the library returns plans —
  // prints both id formats side-by-side so future format drift surfaces
  // immediately in the console instead of silently emptying the deck.
  useEffect(() => {
    if (!ranked.result || eligiblePlans.length === 0) return;
    const agentSample = eligiblePlans.slice(0, 3).map((p) => p.id);
    const librarySample = ranked.result.top_plans
      .slice(0, 3)
      .map((lp) => lp.plan_id);
    const hits = ranked.result.top_plans.filter((lp) =>
      planById.has(normalizePlanId(lp.plan_id)),
    ).length;
    console.log(
      '[agent-v3 planById] agent.id sample=',
      agentSample,
      'library.plan_id sample=',
      librarySample,
      `top_plans hit-rate=${hits}/${ranked.result.top_plans.length}`,
    );
  }, [ranked.result, eligiblePlans, planById]);

  const scoredPlans = useMemo<Plan[]>(() => {
    if (!ranked.result) return [];
    return ranked.result.top_plans
      .map((lp) => planById.get(normalizePlanId(lp.plan_id)))
      .filter((p): p is Plan => p != null);
  }, [ranked.result, planById]);

  // Bench = the broker's workspace, not the brain's runners-up. The
  // brain's filterPlanPool strips D-SNPs from clients flagged
  // dsnpEligible !== true and MA-only plans from clients with meds —
  // correct for the strict Top-4 board (don't recommend D-SNPs to non-
  // dual clients) but wrong for the bench, where the broker needs to
  // see and drag ANY county plan onto the board to compare. So we
  // source bench from the FULL /api/plans response (eligiblePlans,
  // fetched with planType=null) minus whatever's already in Top 4.
  // Plans the brain didn't score won't have annualDrug / ribbon / gate
  // entries; CompareScreen already renders "—" for those, which reads
  // correctly as "unscored candidate."
  const benchPlans = useMemo<Plan[]>(() => {
    if (eligiblePlans.length === 0) return [];
    const topIds = new Set(scoredPlans.map((p) => p.id));
    const out = eligiblePlans.filter((p) => !topIds.has(p.id));
    if (ranked.result) {
      console.log(
        '[agent-v3] bench:',
        out.length,
        'of',
        eligiblePlans.length,
        'county plans (Top 4:',
        scoredPlans.length,
        'brain-ranked:',
        ranked.result.top_plans.length + ranked.result.bench_plans.length,
        ')',
      );
    }
    return out;
  }, [eligiblePlans, scoredPlans, ranked.result]);

  // The by-plan-id maps below are keyed by the agent's Plan.id (NOT the
  // library's lp.plan_id) because CompareScreen looks them up as
  // `annualDrugByPlanId[plan.id]` where plan came from fetchPlansForClient.
  // Routing each library row through planById first guarantees the
  // keys line up with what the consumer reads.
  const annualDrugByPlanId = useMemo<Record<string, number | null>>(() => {
    if (!ranked.result) return {};
    const out: Record<string, number | null> = {};
    for (const lp of ranked.result.top_plans) {
      const p = planById.get(normalizePlanId(lp.plan_id));
      if (p) out[p.id] = lp.total_annual_drug_cost;
    }
    for (const lp of ranked.result.bench_plans) {
      const p = planById.get(normalizePlanId(lp.plan_id));
      if (p) out[p.id] = lp.total_annual_drug_cost;
    }
    return out;
  }, [ranked.result, planById]);

  const benchGateResultsByPlanId = useMemo<
    Record<string, { gate1_passed: boolean; gate2_passed: boolean; gate3_passed: boolean }>
  >(() => {
    if (!ranked.result) return {};
    const out: Record<string, { gate1_passed: boolean; gate2_passed: boolean; gate3_passed: boolean }> = {};
    for (const lp of ranked.result.bench_plans) {
      const p = planById.get(normalizePlanId(lp.plan_id));
      if (p) out[p.id] = lp.gate_results;
    }
    return out;
  }, [ranked.result, planById]);

  const rankedPlanIds = useMemo<string[]>(
    () => scoredPlans.map((p) => p.id),
    [scoredPlans],
  );

  const ribbonByPlanId = useMemo<Record<string, string | null>>(() => {
    if (!ranked.result) return {};
    const out: Record<string, string | null> = {};
    for (const lp of ranked.result.top_plans) {
      const p = planById.get(normalizePlanId(lp.plan_id));
      if (p) out[p.id] = lp.ribbon;
    }
    return out;
  }, [ranked.result, planById]);

  // The library's strict Gate 2 elimination means no plan in top_plans
  // or bench_plans carries an "unknown drug coverage" disclaimer; the
  // brain either confirmed covered or eliminated. Kept as a stub map
  // for CompareScreen prop compatibility.
  const drugCoverageUnknownByPlanId = useMemo<Record<string, boolean>>(
    () => ({}),
    [],
  );

  const drugsCoveredByPlanId = useMemo<Record<string, number>>(() => {
    if (!ranked.result) return {};
    const out: Record<string, number> = {};
    for (const lp of ranked.result.top_plans) {
      const p = planById.get(normalizePlanId(lp.plan_id));
      if (p) out[p.id] = lp.meds_covered;
    }
    for (const lp of ranked.result.bench_plans) {
      const p = planById.get(normalizePlanId(lp.plan_id));
      if (p) out[p.id] = lp.meds_covered;
    }
    return out;
  }, [ranked.result, planById]);

  const drugsTotalByPlanId = useMemo<Record<string, number>>(() => {
    if (!ranked.result) return {};
    const out: Record<string, number> = {};
    for (const lp of ranked.result.top_plans) {
      const p = planById.get(normalizePlanId(lp.plan_id));
      if (p) out[p.id] = lp.meds_total;
    }
    for (const lp of ranked.result.bench_plans) {
      const p = planById.get(normalizePlanId(lp.plan_id));
      if (p) out[p.id] = lp.meds_total;
    }
    return out;
  }, [ranked.result, planById]);

  const drugBreakdownByPlanId = useMemo<
    Record<string, ReadonlyArray<DrugRow>>
  >(() => {
    if (!ranked.result) return {};
    const out: Record<string, ReadonlyArray<DrugRow>> = {};
    const adapt = (
      meds: ReadonlyArray<{
        rxcui: string;
        name: string;
        covered: boolean;
        tier: number | null;
        copay: number | null;
        annual_cost: number;
      }>,
    ): DrugRow[] =>
      meds.map((m) => ({
        rxcui: m.rxcui,
        name: m.name,
        covered: m.covered,
        tier: m.tier,
        monthlyCopay: m.copay,
        annualCost: m.annual_cost,
      }));
    for (const lp of ranked.result.top_plans) {
      const p = planById.get(normalizePlanId(lp.plan_id));
      if (p) out[p.id] = adapt(lp.medications);
    }
    for (const lp of ranked.result.bench_plans) {
      const p = planById.get(normalizePlanId(lp.plan_id));
      if (p) out[p.id] = adapt(lp.medications);
    }
    return out;
  }, [ranked.result, planById]);

  // ── Per-plan gate explanations (CompareScreen "Why this plan" pills) ─
  // Sourced from the LOCAL brain (usePlanBrain), not the library response.
  // The library's LibraryRankPlan shape doesn't yet carry gate_explanations
  // — it has gate_results booleans only. usePlanBrain produces the same
  // BrainScore.explanations strings the consumer Results screen renders
  // (packages/brain/src/plan-brain.ts), so reading them off `brain.result`
  // by plan_id keeps the two surfaces phrasing-identical without waiting
  // on a library-server change. Walks both scored + bench so every county
  // plan in CompareScreen's grid + bench has a "Why this plan" expander.
  const explanationsByPlanId = useMemo<
    Record<
      string,
      {
        gate1: ReadonlyArray<string>;
        gate2: ReadonlyArray<string>;
        gate3: ReadonlyArray<string>;
        gate4: string;
      }
    >
  >(() => {
    if (!brain.result) return {};
    const out: Record<
      string,
      {
        gate1: ReadonlyArray<string>;
        gate2: ReadonlyArray<string>;
        gate3: ReadonlyArray<string>;
        gate4: string;
      }
    > = {};
    for (const sp of brain.result.scored) out[sp.plan.id] = sp.explanations;
    for (const sp of brain.result.bench) out[sp.plan.id] = sp.explanations;
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

  // Pick order drives Gate 3 relax order on the brain side (bottom of
  // the list relaxes first when no county plans satisfy every pick).
  function movePriority(key: PriorityKey, direction: 'up' | 'down') {
    setPriorities((curr) => {
      const i = curr.indexOf(key);
      if (i < 0) return curr;
      const swapWith = direction === 'up' ? i - 1 : i + 1;
      if (swapWith < 0 || swapWith >= curr.length) return curr;
      const next = [...curr];
      [next[i], next[swapWith]] = [next[swapWith], next[i]];
      return next;
    });
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
      {/* Library rank-plans failure. Fires on any error — first-load
          (no previous result) or stale (last result still rendered)
          alike. Without this, a 5xx / AbortError on cold start leaves
          providers as "⚠ Unverified" with no plans rendered and no
          on-screen explanation. */}
      {ranked.error && (
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
          ⚠ Plan ranking failed ({ranked.error}).
          {ranked.result
            ? ' Showing the last successful result — refresh to retry.'
            : ' Refresh to retry, or check the Library API logs.'}
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
            onMove={movePriority}
            onBack={() => setScreen('providers')}
            onNext={() => setScreen('compare')}
          />
        )}
        {screen === 'compare' && (
          <CompareScreen
            current={currentPlan}
            scoredPlans={scoredPlans}
            benchPlans={benchPlans}
            benchGateResultsByPlanId={benchGateResultsByPlanId}
            ribbonByPlanId={ribbonByPlanId}
            annualDrugByPlanId={annualDrugByPlanId}
            drugCoverageUnknownByPlanId={drugCoverageUnknownByPlanId}
            drugsCoveredByPlanId={drugsCoveredByPlanId}
            drugsTotalByPlanId={drugsTotalByPlanId}
            drugBreakdownByPlanId={drugBreakdownByPlanId}
            explanationsByPlanId={explanationsByPlanId}
            rankedPlans={
              ranked.result
                ? [...ranked.result.top_plans, ...ranked.result.bench_plans]
                : undefined
            }
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

      {/* Bottom-left tag so reviewers know which build they're in,
          with the broker / CMS-not-reviewed disclaimer beneath. Agent
          v3 is internal broker tooling, not a consumer surface, but
          screen-shares + recordings expose the chrome to consumers so
          the marketing-attribution + CMS-not-reviewed clause carries
          through. */}
      <div
        style={{
          position: 'fixed',
          bottom: 12,
          left: 12,
          maxWidth: 320,
          color: 'rgba(13,47,94,0.6)',
          background: 'rgba(255,255,255,0.78)',
          backdropFilter: 'blur(4px)',
          padding: '6px 10px',
          borderRadius: 6,
          border: '1px solid rgba(13,47,94,0.08)',
          fontFamily:
            'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 1,
            textTransform: 'uppercase',
            color: 'rgba(13,47,94,0.5)',
          }}
        >
          Agent v3 · review build
        </div>
        <div style={{ fontSize: 9, lineHeight: 1.4, marginTop: 4 }}>
          GenerationHealth.me · NPN 10447418. Plan data is sourced from
          CMS public files and has not been reviewed by CMS or any
          Medicare plan. Official info: Medicare.gov or
          1-800-MEDICARE (TTY 1-877-486-2048).
        </div>
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
