import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import { StepHeader } from './StepHeader';
import { CaptureButton } from '@/components/capture/CaptureButton';
import { CapturePanel } from '@/components/capture/CapturePanel';
import type { UseCaptureSessionResult } from '@/hooks/useCaptureSession';
import { searchDrug, type RxNormDrug } from '@/lib/rxnorm';
import { fetchPlansForClient } from '@/lib/planCatalog';
import { bulkLookupFormulary, getCachedFormulary } from '@/lib/formularyLookup';
import type { FormularyTier } from '@/types/plans';

// 'loading' covers the gap between "bulk prime dispatched" and
// "bulk prime resolved" — a cache miss during that window is not the
// same as "not covered" and must not render as a red badge.
type FormularyCell = FormularyTier | null | 'loading';

interface Step3Props {
  capture: UseCaptureSessionResult;
  onAdvance: () => void;
}

export function Step3Medications({ capture, onAdvance }: Step3Props) {
  const client = useSession((s) => s.client);
  const medications = useSession((s) => s.medications);
  const addMedication = useSession((s) => s.addMedication);
  const removeMedication = useSession((s) => s.removeMedication);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RxNormDrug[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    if (query.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);

    const timer = setTimeout(async () => {
      try {
        const list = await searchDrug(query, controller.signal);
        if (!controller.signal.aborted) setResults(list);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Search failed');
        setResults([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  // Live plan catalog instead of the 12-plan static seed. Step 3 only
  // needs the plans to render per-plan formulary badges, so we cap to
  // the first ~15 to keep the badge row legible; the real funnel runs
  // against the full set in Step 5.
  const [eligiblePlans, setEligiblePlans] = useState<import('@/types/plans').Plan[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchPlansForClient({
      state: client.state,
      county: client.county,
      planType: client.planType,
    }).then((plans) => {
      if (!cancelled) setEligiblePlans(plans.slice(0, 15));
    });
    return () => {
      cancelled = true;
    };
  }, [client.state, client.planType, client.county]);

  // Bulk-prime the formulary cache for every (plan × med) pairing so
  // MedicationRow's per-plan lookups hit memory synchronously. We track
  // the completion tick as real state and thread it into the row's
  // useMemo deps — without that, the memo captures the empty-cache
  // result on first render and never recomputes when the bulk response
  // lands, leaving every badge stuck on "not covered".
  const [formularyTick, setFormularyTick] = useState(0);
  const formularyPrimeNonce = useMemo(
    () => `${eligiblePlans.length}:${medications.length}`,
    [eligiblePlans, medications],
  );
  useEffect(() => {
    if (eligiblePlans.length === 0 || medications.length === 0) return;
    let cancelled = false;
    const contractIds = [...new Set(eligiblePlans.map((p) => p.contract_id))];
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
  }, [formularyPrimeNonce]);
  const primed = formularyTick > 0;

  function onSelectDrug(d: RxNormDrug) {
    addMedication({
      rxcui: d.rxcui,
      name: d.name,
      source: 'manual',
    });
    setQuery('');
    setResults([]);
  }

  return (
    <div className="flex flex-col gap-4">
      <StepHeader
        number={3}
        title="Medications"
        subtitle="Search RxNorm or photograph bottles. Each med is cross-referenced against every plan's formulary — missing drugs cut plans from the finalist pool."
        right={
          <div style={{ color: 'var(--i3)', fontSize: 11, textAlign: 'right' }}>
            {medications.length} med{medications.length === 1 ? '' : 's'} added
            <br />
            {eligiblePlans.length} eligible plan{eligiblePlans.length === 1 ? '' : 's'}
          </div>
        }
      />

      <div className="pm-surface" style={{ padding: 14 }}>
        <CaptureButton capture={capture} />
      </div>

      {capture.token && (
        <CapturePanel capture={capture} accept="medication" />
      )}

      <div className="pm-surface" style={{ padding: 14 }}>
        <div
          className="flex items-center gap-2"
          style={{
            height: 40,
            padding: '0 12px',
            borderRadius: 10,
            background: 'var(--warm)',
            border: '1px solid var(--w2)',
          }}
        >
          <PillIcon />
          <input
            type="search"
            placeholder="Search RxNorm — gabapentin, metformin, atorvastatin…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
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
          {loading && <span style={{ color: 'var(--i3)', fontSize: 11 }}>searching…</span>}
        </div>

        {error && (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              background: 'var(--rt)',
              color: 'var(--red)',
              fontSize: 12,
              borderRadius: 8,
            }}
          >
            RxNorm error: {error}
          </div>
        )}

        {results.length > 0 && (
          <div className="flex flex-col gap-1" style={{ marginTop: 10 }}>
            {results.map((d) => (
              <button
                key={d.rxcui}
                type="button"
                onClick={() => onSelectDrug(d)}
                className="text-left"
                style={{
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--w2)',
                  background: 'var(--wh)',
                  cursor: 'pointer',
                  color: 'var(--ink)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <span>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{d.name}</span>
                  {d.synonym && (
                    <span style={{ fontSize: 12, color: 'var(--i2)', marginLeft: 6 }}>
                      · {d.synonym}
                    </span>
                  )}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--i3)',
                  }}
                >
                  {d.tty} · rxcui {d.rxcui}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="pm-surface" style={{ padding: 14 }}>
        <div
          className="uppercase font-semibold"
          style={{ color: 'var(--i3)', fontSize: 10, letterSpacing: '0.08em', marginBottom: 8 }}
        >
          Added medications
        </div>

        {medications.length === 0 ? (
          <div style={{ color: 'var(--i3)', fontSize: 13, padding: '6px 0' }}>
            None yet. Search above, or send a photo-capture link to read bottle labels.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {medications.map((med) => (
              <MedicationRow
                key={med.id}
                med={med}
                plans={eligiblePlans}
                primed={primed}
                onRemove={() => removeMedication(med.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <button type="button" onClick={onAdvance} className="pm-btn pm-btn-primary">
          Continue to providers →
        </button>
      </div>
    </div>
  );
}

function MedicationRow({
  med,
  plans,
  primed,
  onRemove,
}: {
  med: import('@/types/session').Medication;
  plans: import('@/types/plans').Plan[];
  primed: boolean;
  onRemove: () => void;
}) {
  // Read each (plan, rxcui) tier from the primed formulary cache
  // populated by bulkLookupFormulary in the parent. `primed` tells us
  // whether the bulk response has landed — before it has, a cache miss
  // is "still loading", not "not covered". After it has, a cache miss
  // is authoritative: pm_formulary has no row for any of the rxcui's
  // related SCD/SBD forms on this plan, so the drug really isn't on
  // this plan's formulary. Meds without an rxcui (captured by photo
  // but never matched to RxNorm) get treated as not-covered since we
  // can't authoritatively look them up.
  const planStatuses = useMemo(
    () =>
      plans.map((p) => {
        let tier: FormularyCell;
        if (!med.rxcui) {
          tier = null;
        } else {
          const contractPlanId = `${p.contract_id}_${p.plan_number}`;
          const hit = getCachedFormulary(contractPlanId, med.rxcui);
          if (hit) {
            tier = hit.tier === 'not_covered' ? null : (hit.tier as FormularyTier);
          } else {
            tier = primed ? null : 'loading';
          }
        }
        return { plan: p, tier };
      }),
    [plans, med.name, med.rxcui, primed],
  );

  const covered = planStatuses.filter(
    (s) => s.tier !== null && s.tier !== 'excluded' && s.tier !== 'loading',
  );
  const missing = planStatuses.filter((s) => s.tier === null || s.tier === 'excluded');
  const stillLoading = planStatuses.filter((s) => s.tier === 'loading').length;

  return (
    <div
      style={{
        padding: 12,
        borderRadius: 10,
        border: '1px solid var(--w2)',
        background: 'var(--wh)',
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            {med.name}
            {med.strength ? ` · ${med.strength}` : ''}
            {med.form ? ` · ${med.form}` : ''}
          </div>
          {med.dosageInstructions && (
            <div style={{ fontSize: 12, color: 'var(--i2)', marginTop: 2 }}>
              {med.dosageInstructions}
            </div>
          )}
          {med.prescribingPhysician && (
            <div style={{ fontSize: 12, color: 'var(--i2)' }}>
              Prescribed by {med.prescribingPhysician}
            </div>
          )}
          <div
            className="flex items-center gap-2"
            style={{ marginTop: 4, fontSize: 11, color: 'var(--i3)' }}
          >
            <SourceBadge source={med.source} />
            {med.rxcui && <span>rxcui {med.rxcui}</span>}
            {med.confidence && <span>· {med.confidence} conf.</span>}
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="pm-btn"
          style={{ height: 26, padding: '0 8px' }}
        >
          Remove
        </button>
      </div>

      <div style={{ marginTop: 10 }}>
        <div
          className="uppercase font-semibold"
          style={{ color: 'var(--i3)', fontSize: 10, letterSpacing: '0.06em', marginBottom: 4 }}
        >
          Formulary status · {covered.length}/{planStatuses.length} plans
          {stillLoading > 0 && ` · checking ${stillLoading}…`}
        </div>
        <div className="flex flex-wrap" style={{ gap: 4 }}>
          {planStatuses.map((s) => (
            <FormularyBadge key={s.plan.id} plan={s.plan} tier={s.tier} />
          ))}
        </div>
        {missing.length > 0 && (
          <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 6 }}>
            ⚠ Not on formulary for: {missing.map((m) => m.plan.carrier).join(', ')}
          </div>
        )}
      </div>
    </div>
  );
}

function FormularyBadge({
  plan,
  tier,
}: {
  plan: import('@/types/plans').Plan;
  tier: FormularyCell;
}) {
  const meta = tierMeta(tier);
  const titleTier =
    tier === 'loading'
      ? 'checking formulary…'
      : tier === null
        ? 'not covered'
        : tier === 'excluded'
          ? 'excluded'
          : `tier ${tier}`;
  return (
    <span
      title={`${plan.carrier} · ${plan.plan_name} · ${titleTier}`}
      style={{
        fontSize: 10,
        fontWeight: 600,
        padding: '3px 7px',
        borderRadius: 999,
        background: meta.bg,
        color: meta.fg,
        border: `1px solid ${meta.border}`,
        whiteSpace: 'nowrap',
      }}
    >
      {plan.carrier.split(/\s+/)[0]}: {meta.label}
    </span>
  );
}

function tierMeta(tier: FormularyCell): { bg: string; fg: string; border: string; label: string } {
  if (tier === 'loading') return { bg: 'var(--w2)', fg: 'var(--i3)', border: 'var(--w3)', label: '…' };
  if (tier === null) return { bg: 'var(--w2)', fg: 'var(--i2)', border: 'var(--w3)', label: '—' };
  if (tier === 'excluded') return { bg: 'var(--rt)', fg: 'var(--red)', border: 'var(--red)', label: 'excl' };
  if (tier === 1) return { bg: 'var(--sl)', fg: 'var(--sage)', border: 'var(--sage)', label: 'T1' };
  if (tier === 2) return { bg: 'var(--tl)', fg: 'var(--teal)', border: 'var(--teal)', label: 'T2' };
  if (tier === 3) return { bg: 'var(--bt)', fg: 'var(--blue)', border: 'var(--blue)', label: 'T3' };
  if (tier === 4) return { bg: 'var(--at)', fg: 'var(--amb)', border: 'var(--amb)', label: 'T4' };
  return { bg: 'var(--pt)', fg: 'var(--pur)', border: 'var(--pur)', label: 'T5' };
}

function SourceBadge({ source }: { source: 'manual' | 'capture' }) {
  const isPhoto = source === 'capture';
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        padding: '1px 5px',
        borderRadius: 4,
        background: isPhoto ? 'var(--pt)' : 'var(--w2)',
        color: isPhoto ? 'var(--pur)' : 'var(--i2)',
      }}
    >
      {isPhoto ? '📷 photo' : 'manual'}
    </span>
  );
}

function PillIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--i2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z" />
      <path d="m8.5 8.5 7 7" />
    </svg>
  );
}
