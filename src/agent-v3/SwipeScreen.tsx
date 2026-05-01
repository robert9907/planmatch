// SwipeScreen — agent-v3 screen 5.
//
// Mockup intent: pin the current plan (red) and the brain pick
// (seafoam) at the top, then deal a tinder-style stack of the
// remaining county plans, sorted by brain composite. Swipe right keeps
// (cap of 3 keeps + 1 brain pick = 4 finalists). Swipe left eliminates.
// The lowest-Rx plan in the pool gets a gold border. A footer rail
// shows the kept and eliminated piles with per-plan capsules.
//
// Live wires:
//   • current plan         → useSession.currentPlanId, looked up
//                            against the eligible plan list. When
//                            noCurrentPlan === true, the rail collapses
//                            and the cap stays at 4 (just brain + 3 kept,
//                            no current rail).
//   • brain pick + ranking → usePlanBrain.scored ([0] = pick, [1..] = pool)
//   • drug costs           → useDrugCosts.byPlanId — used to pick the
//                            lowest-Rx plan for the gold border AND
//                            to render the per-card "/mo drugs" metric.
//   • kept / eliminated    → state lives in the shell so
//                            the AgentBar finalist counter, the
//                            CompareScreen, and the EnrollScreen all
//                            read the same selection without
//                            re-deriving.
//
// Provider status per plan: derived from useSession.providers[0]
// .networkStatus (set by ProvidersScreen).

import type { Plan } from '@/types/plans';
import { useSession } from '@/hooks/useSession';
import { Container, Nav } from './atoms';
import { PinnedPlan } from './PinnedPlan';
import { SwipeCard } from './SwipeCard';
import { FINALIST_CAP } from './AgentBar';
import { FADE_SLIDE_IN } from './styles';

interface Props {
  current: Plan | null;
  brainPick: Plan | null;
  pool: Plan[];                 // remaining plans, sorted by brain rank
  kept: Plan[];
  eliminated: Plan[];
  onKeep: (plan: Plan) => void;
  onEliminate: (plan: Plan) => void;
  onCompare: (plan: Plan) => void;
  onNext: () => void;
  onBack: () => void;
  /** rxcui-aware annual + monthly drug cost lookups. */
  annualDrugByPlanId: Record<string, number | null>;
  monthlyDrugByPlanId: Record<string, number | null>;
  /** Brain composite per plan (0-100). */
  brainScoreByPlanId: Record<string, number>;
  /** Brain reason copy per plan. */
  brainReasonByPlanId: Record<string, string>;
  brainReady: boolean;
  /** Plan id that gets the gold "Lowest Rx" border. Computed in the
   *  shell off the full ranked list so the highlight doesn't move as
   *  plans are kept / eliminated. */
  goldPlanId: string | null;
}

export function SwipeScreen({
  current,
  brainPick,
  pool,
  kept,
  eliminated,
  onKeep,
  onEliminate,
  onCompare,
  onNext,
  onBack,
  annualDrugByPlanId,
  monthlyDrugByPlanId,
  brainScoreByPlanId,
  brainReasonByPlanId,
  brainReady,
  goldPlanId,
}: Props) {
  // Brain pick + up to 3 kept = FINALIST_CAP. Capped at 3 user keeps.
  const MAX_KEEPS = FINALIST_CAP - 1;
  const cur = pool[0] ?? null;
  const capped = kept.length >= MAX_KEEPS;
  const allDone = !cur || capped;

  // First provider's per-plan status comes from useSession (written by
  // ProvidersScreen). We only show the first provider's slot in the
  // pinned cards / swipe cards — multi-provider summaries are a future
  // enhancement.
  const providers = useSession((s) => s.providers);
  const firstProv = providers[0] ?? null;
  const providerLabel = firstProv?.name?.split(' ').slice(0, 2).join(' ') ?? 'Doctor';
  const statusFor = (planId: string): 'in' | 'out' | 'unknown' => {
    if (!firstProv) return 'unknown';
    return (firstProv.networkStatus?.[planId] as 'in' | 'out' | 'unknown') ?? 'unknown';
  };

  // Gold border is on the lowest-Rx plan in the brain pool — provided
  // by the shell so the highlight stays put as plans are swiped.
  const goldId = goldPlanId;

  if (!brainReady) {
    return (
      <Container wide>
        <div
          style={{
            textAlign: 'center',
            padding: '60px 16px',
            color: '#64748b',
          }}
        >
          <div className="pma3-spinner" style={{ width: 28, height: 28, margin: '0 auto 12px' }} />
          Brain ranking plans for your county…
        </div>
      </Container>
    );
  }

  return (
    <Container wide>
      {current && (
        <PinnedPlan
          plan={current}
          label="Your Current Plan"
          borderColor="#ef4444"
          providerStatus={statusFor(current.id)}
          providerLabel={providerLabel}
          monthlyDrugCost={monthlyDrugByPlanId[current.id] ?? null}
          annualDrugCost={annualDrugByPlanId[current.id] ?? null}
          onCompare={onCompare}
          compact
        />
      )}
      {brainPick && (
        <div style={{ marginTop: current ? 8 : 0 }}>
          <PinnedPlan
            plan={brainPick}
            label="★ Brain's Top Pick"
            borderColor="#83f0f9"
            brainScore={brainScoreByPlanId[brainPick.id] ?? null}
            providerStatus={statusFor(brainPick.id)}
            providerLabel={providerLabel}
            monthlyDrugCost={monthlyDrugByPlanId[brainPick.id] ?? null}
            annualDrugCost={annualDrugByPlanId[brainPick.id] ?? null}
            reason={brainReasonByPlanId[brainPick.id] ?? null}
            onCompare={onCompare}
          />
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          margin: '18px 0 14px',
        }}
      >
        <div style={{ flex: 1, height: 1, background: '#e2e8f0' }} />
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: capped || allDone ? '#059669' : '#64748b',
            letterSpacing: 1,
            textTransform: 'uppercase',
          }}
        >
          {capped
            ? `${FINALIST_CAP} finalists selected — ready to compare`
            : allDone
              ? 'All plans reviewed'
              : `Swipe through ${pool.length} more · ${MAX_KEEPS - kept.length} keep${MAX_KEEPS - kept.length === 1 ? '' : 's'} left`}
        </span>
        <div style={{ flex: 1, height: 1, background: '#e2e8f0' }} />
      </div>

      {!allDone && cur && current && (
        <SwipeCard
          plan={cur}
          current={current}
          onLeft={() => onEliminate(cur)}
          onRight={() => onKeep(cur)}
          onCompare={onCompare}
          idx={
            // Original-pool count = eliminated + kept + pool, minus the
            // brain pick which sits separately.
            eliminated.length + kept.length
          }
          total={eliminated.length + kept.length + pool.length}
          capReached={capped}
          brainScore={brainScoreByPlanId[cur.id] ?? null}
          brainReason={brainReasonByPlanId[cur.id] ?? null}
          annualDrugByPlanId={annualDrugByPlanId}
          monthlyDrugByPlanId={monthlyDrugByPlanId}
          providerStatus={statusFor(cur.id)}
          providerLabel={providerLabel}
          isGold={cur.id === goldId}
        />
      )}

      {/* When current is missing the SwipeCard can't render (it
          benchmarks against current). Surface a hint so the broker
          knows to set the current plan upstream. */}
      {!current && cur && (
        <div
          style={{
            background: '#fffbeb',
            border: '1px solid #f59e0b',
            borderRadius: 10,
            padding: '14px 18px',
            color: '#92400e',
            fontSize: 13,
            textAlign: 'center',
          }}
        >
          Set the client's current plan on the v4 Quote screen first —
          the swipe cards benchmark against it.
        </div>
      )}

      {allDone && (
        <div
          style={{
            textAlign: 'center',
            padding: '32px 16px',
            animation: `${FADE_SLIDE_IN} 0.5s ease`,
          }}
        >
          <div style={{ fontSize: 48, marginBottom: 10 }}>🎯</div>
          <div
            style={{
              fontFamily: "'Fraunces', Georgia, serif",
              fontSize: 22,
              fontWeight: 700,
              color: '#0d2f5e',
              marginBottom: 6,
            }}
          >
            {capped
              ? 'Your 4 finalists are locked in'
              : `All ${eliminated.length + kept.length} plans reviewed`}
          </div>
          <div style={{ color: '#64748b', fontSize: 13, marginBottom: 16 }}>
            {kept.length + (brainPick ? 1 : 0)} plans (Brain Pick + {kept.length} you chose).{' '}
            {eliminated.length} eliminated.
          </div>
          <button
            type="button"
            onClick={onNext}
            style={{
              background: 'linear-gradient(135deg, #059669, #047857)',
              color: 'white',
              border: 'none',
              borderRadius: 11,
              padding: '14px 36px',
              fontSize: 15,
              fontWeight: 700,
              cursor: 'pointer',
              boxShadow: '0 6px 24px rgba(5,150,105,0.3)',
            }}
          >
            Compare {kept.length + (brainPick ? 1 : 0)} Finalists →
          </button>
        </div>
      )}

      {(kept.length > 0 || eliminated.length > 0) && (
        <div style={{ display: 'flex', gap: 14, marginTop: 18 }}>
          <Pile
            title="✓ Kept"
            color="#059669"
            tint="rgba(5,150,105,0.04)"
            border="rgba(5,150,105,0.1)"
            chipBg="#d1fae5"
            chipFg="#065f46"
            count={kept.length}
            plans={kept}
            renderRight={(plan) => (
              <button
                type="button"
                onClick={() => onCompare(plan)}
                style={{
                  background: 'none',
                  border: '1px solid #059669',
                  borderRadius: 4,
                  padding: '2px 6px',
                  fontSize: 9,
                  color: '#059669',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Compare
              </button>
            )}
            sub={(plan) =>
              monthlyDrugByPlanId[plan.id] != null
                ? `$${monthlyDrugByPlanId[plan.id]}/mo drugs`
                : `$${plan.premium}/mo premium`
            }
          />
          <Pile
            title="✕ Eliminated"
            color="#ef4444"
            tint="rgba(239,68,68,0.02)"
            border="rgba(239,68,68,0.06)"
            chipBg="#fee2e2"
            chipFg="#991b1b"
            count={eliminated.length}
            plans={eliminated}
            sub={(plan) =>
              brainReasonByPlanId[plan.id]?.split('.')[0] ?? plan.plan_name
            }
            strikethrough
          />
        </div>
      )}

      <Nav onBack={onBack} />
    </Container>
  );
}

interface PileProps {
  title: string;
  color: string;
  tint: string;
  border: string;
  chipBg: string;
  chipFg: string;
  count: number;
  plans: Plan[];
  sub: (plan: Plan) => string;
  renderRight?: (plan: Plan) => React.ReactNode;
  strikethrough?: boolean;
}

function Pile({
  title,
  color,
  tint,
  border,
  chipBg,
  chipFg,
  count,
  plans,
  sub,
  renderRight,
  strikethrough,
}: PileProps) {
  return (
    <div style={{ flex: 1 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color,
          letterSpacing: 1,
          textTransform: 'uppercase',
          marginBottom: 6,
        }}
      >
        {title}{' '}
        <span
          style={{
            background: chipBg,
            color: chipFg,
            borderRadius: 8,
            padding: '1px 6px',
            fontSize: 9,
          }}
        >
          {count}
        </span>
      </div>
      {plans.map((plan) => (
        <div
          key={plan.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 10px',
            borderRadius: 7,
            marginBottom: 3,
            background: tint,
            border: `1px solid ${border}`,
            opacity: strikethrough ? 0.6 : 1,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: strikethrough ? '#64748b' : '#0d2f5e',
                textDecoration: strikethrough ? 'line-through' : 'none',
              }}
            >
              {plan.carrier} — {plan.plan_name}
            </div>
            <div style={{ fontSize: 9, color: '#94a3b8' }}>{sub(plan)}</div>
          </div>
          {renderRight?.(plan)}
        </div>
      ))}
    </div>
  );
}

