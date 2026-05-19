// PlanComparisonScreen — Screen 2 of the redesign.
//
// Head-to-head view that launches from a Top 4 Compare button. The
// challenger is the plan the broker (or client) wants to evaluate; the
// "current" column is whatever lives in useSession.currentPlanId. The
// component ranks 10 benefits (3 client priorities + 7 medical copays),
// scores wins per side, and uses that count to pick a headline:
//
//   10/10  → "This plan is better in every way"
//   6-9    → "Stronger in N out of 10 benefits"
//   0-5    → "A close call — here's what's different"
//
// Win logic:
//   • Dental max, Vision allowance, OTC benefit  →  higher is better
//   • Specialist / Imaging / ER / Hospital / Urgent care / X-ray /
//     Estimated annual drug cost                  →  lower is better
//
// The challenger's win count drives both the headline and the
// challenger's "wins" pill (filled green). Ties don't count.
//
// The Compare-different link + X-close both flip the shell back to
// Top 4. The Enroll button (pulsing seafoam border) hands off to the
// existing 'enroll' screen via onEnroll.

import type { CSSProperties } from 'react';
import { useEffect } from 'react';
import type { Plan } from '@/types/plans';
import { costShareNumeric } from './planDisplay';

const NAVY = '#1a2744';
const SEAFOAM = '#5DCAA5';
const SEAFOAM_LIGHT = '#B8E6D4';
const SEAFOAM_DARK = '#0A6B52';
const GRADE_B_BLUE = '#85B7EB';
const WIN_GREEN = '#0A6B52';
const LOSE_RED = '#E24B4A';

interface Props {
  current: Plan;
  challenger: Plan;
  annualDrugByPlanId: Record<string, number | null>;
  /** Brain composite per plan (drives the grade circle A/B). */
  brainScoreByPlanId: Record<string, number>;
  onClose: () => void;
  /** Back arrow + "Compare a different plan" both go here. */
  onBackToTop4: () => void;
  /** Enroll button — wired to the shell's existing enroll screen. */
  onEnroll: () => void;
}

interface ComparisonRow {
  section: 'asked' | 'medical';
  label: string;
  currentDisplay: string;
  challengerDisplay: string;
  winner: 'current' | 'challenger' | 'tie';
}

export function PlanComparisonScreen({
  current,
  challenger,
  annualDrugByPlanId,
  brainScoreByPlanId,
  onClose,
  onBackToTop4,
  onEnroll,
}: Props) {
  // Install the pulse keyframe once. Inline <style> keeps the component
  // self-contained — the agent-v3 stylesheet already supplies generic
  // pma3-pulse, but the spec asks for a softer box-shadow pulse that
  // doesn't fit pma3-pulse's opacity ramp.
  useEffect(() => {
    if (document.getElementById('pmc-enroll-pulse')) return;
    const style = document.createElement('style');
    style.id = 'pmc-enroll-pulse';
    style.textContent = `
      @keyframes pmc-enroll-glow {
        0%, 100% { box-shadow: 0 0 0 0 rgba(93,202,165,0.0), 0 6px 12px rgba(93,202,165,0.15); }
        50%      { box-shadow: 0 0 0 0 rgba(93,202,165,0.0), 0 8px 18px rgba(93,202,165,0.25); }
      }
    `;
    document.head.appendChild(style);
  }, []);

  const rows = buildRows(current, challenger, annualDrugByPlanId);
  const challengerWins = rows.filter((r) => r.winner === 'challenger').length;
  const currentWins = rows.filter((r) => r.winner === 'current').length;
  const headline = pickHeadline(challengerWins);
  // When the challenger only wins 0-2 of 10, we don't want to nudge a
  // bad switch — flip the Enroll CTA to a muted "Keep your current
  // plan" affordance with no pulse glow. The "Compare a different
  // plan" link below remains the primary action.
  const keepCurrent = challengerWins <= 2;

  return (
    <div style={SCREEN_ROOT}>
      <ScreenHeader onClose={onClose} />

      <div style={NAV_ROW}>
        <button type="button" onClick={onBackToTop4} style={NAV_BACK_BTN}>
          <span aria-hidden style={{ fontSize: 16 }}>←</span>
          <span style={{ fontSize: 16, color: 'white', fontWeight: 600 }}>
            Plan comparison
          </span>
        </button>
      </div>

      <div style={{ maxWidth: 520, margin: '0 auto', padding: '0 18px 12px' }}>
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <div
            style={{
              color: SEAFOAM,
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: 1.4,
              textTransform: 'uppercase',
            }}
          >
            Our recommendation
          </div>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: 'white',
              margin: '8px 0 6px',
              lineHeight: 1.25,
            }}
          >
            {headline}
          </h1>
          <div
            style={{
              fontSize: 14,
              color: 'rgba(255,255,255,0.65)',
            }}
          >
            We compared 10 benefits that matter most to you
          </div>
        </div>

        <div style={PLAN_HEADER_ROW}>
          <PlanHeaderCard
            plan={current}
            tone="dim"
            tagText="Your current plan"
            tagTone="dim"
            gradeScore={brainScoreByPlanId[current.id]}
          />
          <PlanHeaderCard
            plan={challenger}
            tone="bright"
            tagText="Strongest match"
            tagTone="bright"
            gradeScore={brainScoreByPlanId[challenger.id]}
          />
        </div>

        <div style={SCORE_STRIP}>
          <WinsPill count={currentWins} tone="dim" />
          <WinsPill count={challengerWins} tone="bright" />
        </div>
      </div>

      <div style={WHITE_PANEL}>
        <BreakdownSection
          title="What you asked for"
          color={WIN_GREEN}
          rows={rows.filter((r) => r.section === 'asked')}
        />
        <BreakdownSection
          title="Medical copays"
          color="#6B7280"
          rows={rows.filter((r) => r.section === 'medical')}
        />

        <div style={ENROLL_BLOCK}>
          <div style={keepCurrent ? KEEP_WRAP : ENROLL_WRAP}>
            <button
              type="button"
              onClick={keepCurrent ? onClose : onEnroll}
              style={keepCurrent ? KEEP_BTN : ENROLL_BTN}
            >
              {keepCurrent
                ? 'Keep your current plan'
                : 'Switch to better coverage today'}
            </button>
          </div>
          {!keepCurrent && (
            <div style={ENROLL_TAGLINE}>
              Free to enroll. No cost to switch.
            </div>
          )}
        </div>

        <div style={{ textAlign: 'center', padding: '4px 0 24px' }}>
          <button
            type="button"
            onClick={onBackToTop4}
            style={COMPARE_DIFFERENT_BTN}
          >
            <span aria-hidden style={{ fontSize: 14 }}>←</span>
            Compare a different plan
          </button>
        </div>
      </div>
    </div>
  );
}

function ScreenHeader({ onClose }: { onClose: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 18px 0',
      }}
    >
      <span
        style={{
          fontFamily: "'Fraunces', Georgia, serif",
          fontSize: 18,
          fontWeight: 700,
          color: SEAFOAM_LIGHT,
          letterSpacing: 0.2,
        }}
      >
        GenerationHealth.me
      </span>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        style={{
          background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.18)',
          color: 'white',
          width: 36,
          height: 36,
          borderRadius: 18,
          fontSize: 16,
          fontWeight: 600,
          cursor: 'pointer',
          lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}

function PlanHeaderCard({
  plan,
  tone,
  tagText,
  tagTone,
  gradeScore,
}: {
  plan: Plan;
  tone: 'dim' | 'bright';
  tagText: string;
  tagTone: 'dim' | 'bright';
  gradeScore: number | undefined;
}) {
  const dim = tone === 'dim';
  const grade: 'A' | 'B' = gradeScore != null && gradeScore >= 75 ? 'A' : 'B';
  const gradeColor = dim
    ? 'rgba(255,255,255,0.4)'
    : grade === 'A'
      ? SEAFOAM
      : GRADE_B_BLUE;

  return (
    <div
      style={{
        flex: 1,
        background: dim ? 'rgba(255,255,255,0.03)' : 'rgba(93,202,165,0.08)',
        border: dim
          ? '1px solid rgba(255,255,255,0.12)'
          : `1px solid ${SEAFOAM}`,
        borderRadius: 14,
        padding: '12px 12px 14px',
        minWidth: 0,
        boxShadow: dim ? 'none' : '0 0 0 3px rgba(93,202,165,0.08)',
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          background: dim
            ? 'rgba(255,255,255,0.05)'
            : `${gradeColor}33`,
          border: `2px solid ${gradeColor}`,
          color: gradeColor,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: "'Fraunces', Georgia, serif",
          fontWeight: 800,
          fontSize: 18,
          marginBottom: 8,
        }}
      >
        {grade}
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: dim ? 'rgba(255,255,255,0.5)' : 'white',
          lineHeight: 1.25,
          overflowWrap: 'break-word',
          wordBreak: 'break-word',
        }}
      >
        {plan.plan_name}
      </div>
      <div
        style={{
          fontSize: 12,
          color: dim ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.75)',
          marginTop: 2,
        }}
      >
        {plan.carrier}
      </div>
      <div
        style={{
          marginTop: 10,
          display: 'inline-block',
          padding: '3px 9px',
          borderRadius: 10,
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: 1,
          textTransform: 'uppercase',
          background:
            tagTone === 'bright'
              ? `${SEAFOAM}1a`
              : 'rgba(255,255,255,0.06)',
          color:
            tagTone === 'bright' ? SEAFOAM : 'rgba(255,255,255,0.5)',
          border:
            tagTone === 'bright'
              ? `1px solid ${SEAFOAM}55`
              : '1px solid rgba(255,255,255,0.12)',
        }}
      >
        {tagText}
      </div>
    </div>
  );
}

function WinsPill({ count, tone }: { count: number; tone: 'dim' | 'bright' }) {
  return (
    <span
      style={{
        background:
          tone === 'bright' ? SEAFOAM_DARK : 'rgba(255,255,255,0.06)',
        color: 'white',
        border:
          tone === 'bright'
            ? `1px solid ${SEAFOAM}`
            : '1px solid rgba(255,255,255,0.18)',
        borderRadius: 999,
        padding: '7px 14px',
        fontSize: 14,
        fontWeight: 700,
      }}
    >
      {count} win{count === 1 ? '' : 's'}
    </span>
  );
}

function BreakdownSection({
  title,
  color,
  rows,
}: {
  title: string;
  color: string;
  rows: ComparisonRow[];
}) {
  return (
    <div style={{ padding: '4px 4px 8px' }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 1.4,
          textTransform: 'uppercase',
          color,
          padding: '14px 14px 8px',
        }}
      >
        {title}
      </div>
      <div>
        {rows.map((r) => (
          <BreakdownRow key={r.label} row={r} />
        ))}
      </div>
    </div>
  );
}

function BreakdownRow({ row }: { row: ComparisonRow }) {
  const challengerWon = row.winner === 'challenger';
  const currentWon = row.winner === 'current';
  return (
    <div
      style={{
        padding: '10px 14px',
        borderTop: '1px solid rgba(13,47,94,0.06)',
      }}
    >
      <div
        style={{
          fontSize: 13,
          color: '#475569',
          marginBottom: 6,
        }}
      >
        {row.label}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 14px 1fr',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <ValueCell text={row.currentDisplay} state={cellState(row, 'current')} />
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            background: row.winner === 'tie' ? 'transparent' : WIN_GREEN,
            justifySelf:
              currentWon ? 'start' : challengerWon ? 'end' : 'center',
          }}
        />
        <ValueCell
          text={row.challengerDisplay}
          state={cellState(row, 'challenger')}
        />
      </div>
    </div>
  );
}

type CellState = 'winner' | 'loser' | 'neutral';

function cellState(row: ComparisonRow, side: 'current' | 'challenger'): CellState {
  if (row.winner === 'tie') return 'neutral';
  return row.winner === side ? 'winner' : 'loser';
}

function ValueCell({ text, state }: { text: string; state: CellState }) {
  const isLoser = state === 'loser';
  const isWinner = state === 'winner';
  return (
    <span
      style={{
        fontSize: 14,
        fontWeight: 700,
        color: isWinner ? WIN_GREEN : '#0F172A',
        opacity: isLoser ? 0.85 : 1,
        textDecoration: isLoser ? 'line-through' : 'none',
        textDecorationColor: isLoser ? LOSE_RED : undefined,
        textDecorationThickness: isLoser ? 2 : undefined,
        textAlign: 'center',
        overflowWrap: 'break-word',
        wordBreak: 'break-word',
        minWidth: 0,
      }}
    >
      {text}
    </span>
  );
}

// ── headline + row builders ──────────────────────────────────────────

function pickHeadline(challengerWins: number): string {
  if (challengerWins >= 10) return 'This plan is better in every way';
  if (challengerWins >= 6)
    return `Stronger in ${challengerWins} out of 10 benefits`;
  if (challengerWins <= 2) return 'Your current plan is the stronger choice';
  return 'A close call — here’s what’s different';
}

function buildRows(
  current: Plan,
  challenger: Plan,
  annualDrugByPlanId: Record<string, number | null>,
): ComparisonRow[] {
  const cur = current.benefits;
  const ch = challenger.benefits;
  const curDrug = annualDrugByPlanId[current.id] ?? null;
  const chDrug = annualDrugByPlanId[challenger.id] ?? null;

  const rows: ComparisonRow[] = [];

  // ── What you asked for (higher is better) ──────────────────────────
  rows.push(
    higherIsBetterRow({
      section: 'asked',
      label: 'Dental max',
      currentNum: cur.dental.annual_max,
      challengerNum: ch.dental.annual_max,
      formatter: (n) => (n > 0 ? `$${n.toLocaleString()} per year` : 'None'),
    }),
  );
  rows.push(
    higherIsBetterRow({
      section: 'asked',
      label: 'Vision allowance',
      currentNum: cur.vision.eyewear_allowance_year,
      challengerNum: ch.vision.eyewear_allowance_year,
      formatter: (n) => (n > 0 ? `$${n.toLocaleString()}` : 'None'),
    }),
  );
  rows.push(
    higherIsBetterRow({
      section: 'asked',
      label: 'OTC benefit',
      currentNum: Math.round(cur.otc.allowance_per_quarter / 3),
      challengerNum: Math.round(ch.otc.allowance_per_quarter / 3),
      formatter: (n) => (n > 0 ? `$${n} per month` : 'None'),
    }),
  );

  // ── Medical copays (lower is better) ───────────────────────────────
  rows.push(
    lowerIsBetterRow({
      section: 'medical',
      label: 'Specialist',
      current: cur.medical.specialist,
      challenger: ch.medical.specialist,
    }),
  );
  rows.push(
    lowerIsBetterRow({
      section: 'medical',
      label: 'Imaging',
      current: cur.medical.diagnostic_radiology,
      challenger: ch.medical.diagnostic_radiology,
    }),
  );
  rows.push(
    lowerIsBetterRow({
      section: 'medical',
      label: 'Emergency room',
      current: cur.medical.emergency,
      challenger: ch.medical.emergency,
    }),
  );
  rows.push(
    lowerIsBetterRow({
      section: 'medical',
      label: 'Hospital per day',
      current: cur.medical.inpatient,
      challenger: ch.medical.inpatient,
      copaySuffix: ' per day',
    }),
  );
  rows.push(
    lowerIsBetterRow({
      section: 'medical',
      label: 'Urgent care',
      current: cur.medical.urgent_care,
      challenger: ch.medical.urgent_care,
    }),
  );
  rows.push(
    lowerIsBetterRow({
      section: 'medical',
      label: 'X-ray',
      current: cur.medical.xray,
      challenger: ch.medical.xray,
    }),
  );
  rows.push({
    section: 'medical',
    label: 'Estimated annual drug cost',
    currentDisplay:
      curDrug != null ? `$${curDrug.toLocaleString()} per year` : '—',
    challengerDisplay:
      chDrug != null ? `$${chDrug.toLocaleString()} per year` : '—',
    winner:
      curDrug == null || chDrug == null
        ? 'tie'
        : chDrug < curDrug
          ? 'challenger'
          : chDrug > curDrug
            ? 'current'
            : 'tie',
  });

  return rows;
}

function higherIsBetterRow({
  section,
  label,
  currentNum,
  challengerNum,
  formatter,
}: {
  section: 'asked' | 'medical';
  label: string;
  currentNum: number;
  challengerNum: number;
  formatter: (n: number) => string;
}): ComparisonRow {
  return {
    section,
    label,
    currentDisplay: formatter(currentNum),
    challengerDisplay: formatter(challengerNum),
    winner:
      challengerNum > currentNum
        ? 'challenger'
        : challengerNum < currentNum
          ? 'current'
          : 'tie',
  };
}

function lowerIsBetterRow({
  section,
  label,
  current,
  challenger,
  copaySuffix = '',
}: {
  section: 'asked' | 'medical';
  label: string;
  current: { copay: number | null; coinsurance: number | null };
  challenger: { copay: number | null; coinsurance: number | null };
  copaySuffix?: string;
}): ComparisonRow {
  const curN = costShareNumeric(current);
  const chN = costShareNumeric(challenger);
  const curDisplay = formatShareLong(current, copaySuffix);
  const chDisplay = formatShareLong(challenger, copaySuffix);
  let winner: ComparisonRow['winner'];
  if (curN == null || chN == null) {
    winner = 'tie';
  } else if (chN < curN) {
    winner = 'challenger';
  } else if (chN > curN) {
    winner = 'current';
  } else {
    winner = 'tie';
  }
  return {
    section,
    label,
    currentDisplay: curDisplay,
    challengerDisplay: chDisplay,
    winner,
  };
}

function formatShareLong(
  cs: { copay: number | null; coinsurance: number | null },
  copaySuffix: string,
): string {
  if (cs.copay != null) return `$${cs.copay}${copaySuffix}`;
  if (cs.coinsurance != null) return `${cs.coinsurance}%`;
  return '—';
}

// ── style atoms ─────────────────────────────────────────────────────

const SCREEN_ROOT: CSSProperties = {
  minHeight: '100vh',
  background: NAVY,
  color: 'white',
  margin: 0,
};

const NAV_ROW: CSSProperties = {
  maxWidth: 520,
  margin: '0 auto',
  padding: '10px 18px 0',
};

const NAV_BACK_BTN: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  background: 'transparent',
  border: 'none',
  color: 'white',
  cursor: 'pointer',
  padding: 0,
};

const PLAN_HEADER_ROW: CSSProperties = {
  display: 'flex',
  gap: 12,
  marginTop: 16,
};

const SCORE_STRIP: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  marginTop: 14,
  marginBottom: 18,
};

const WHITE_PANEL: CSSProperties = {
  background: 'white',
  color: '#0F172A',
  borderRadius: '20px 20px 0 0',
  padding: '8px 0 0',
  minHeight: 400,
};

const ENROLL_BLOCK: CSSProperties = {
  padding: '22px 18px 14px',
  textAlign: 'center',
};

const ENROLL_WRAP: CSSProperties = {
  background: `linear-gradient(135deg, ${SEAFOAM}, ${WIN_GREEN})`,
  borderRadius: 16,
  padding: 2,
  animation: 'pmc-enroll-glow 3s ease-in-out infinite',
};

const ENROLL_BTN: CSSProperties = {
  width: '100%',
  minHeight: 56,
  borderRadius: 14,
  border: 'none',
  background: SEAFOAM_DARK,
  color: 'white',
  fontSize: 18,
  fontWeight: 700,
  cursor: 'pointer',
  letterSpacing: 0.2,
};

// Muted variant used when challengerWins ≤ 2 — same shape, no pulsing
// gradient halo, gray fill, "Keep your current plan" copy. Click here
// closes the comparison (returns to whichever screen launched it).
const KEEP_WRAP: CSSProperties = {
  background: 'transparent',
  borderRadius: 16,
  padding: 0,
};

const KEEP_BTN: CSSProperties = {
  width: '100%',
  minHeight: 56,
  borderRadius: 14,
  border: '1px solid #CBD5E1',
  background: '#E2E8F0',
  color: '#475569',
  fontSize: 18,
  fontWeight: 700,
  cursor: 'pointer',
  letterSpacing: 0.2,
};

const ENROLL_TAGLINE: CSSProperties = {
  marginTop: 10,
  fontSize: 13,
  color: SEAFOAM_LIGHT,
};

const COMPARE_DIFFERENT_BTN: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  background: 'transparent',
  border: 'none',
  color: '#0F172A',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  textDecoration: 'underline',
  padding: '8px 12px',
};
