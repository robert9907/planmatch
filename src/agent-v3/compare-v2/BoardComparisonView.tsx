// BoardComparisonView — the 4-up scored comparison drawer opened from
// board SlotCells. Replaces the single-plan SummaryOfBenefitsDrawer as
// the "Summary of benefits" click target. Purpose: broker scans every
// plan currently on the board (2-4 columns), sees at a glance which
// wins on each line via green/red chips, gets a tally, and can take
// the leading plan straight into Head-to-Head.
//
// Rules (per feat/four-up-scored-comparison spec):
//   • COSTS lower = green; ALLOWANCES higher = green.
//   • Inpatient ladders scored on TOTAL EXPOSURE (Σ copay × days per
//     tier), not day-1 rate. Total is shown next to the ladder so the
//     math is visible.
//   • Non-numeric benefits (SilverSneakers, "24 trips/yr", "$500/yr
//     aids") score on the embedded number when one exists, else
//     present=green / absent=red.
//   • Missing values render red — never a dash.
//   • Ties: all tied plans go green. If ALL plans tie, no plan gets a
//     point (still visually green — the row just doesn't sway the
//     tally).
//   • MEDICATION COST rows only: "Cost pending" is neutral (not
//     scored, not counted) — CMS filing gap, not a plan weakness.
//
// Data source: aggregated Plan.benefits from api/plans.ts buildBenefits
// (post-Option-A). Same helpers as the QuickPreview / former SoB drawer
// (planDisplay, formatCostShareWithRange, formatInpatientLadder,
// formatOtc, formatPcp/Specialist) so display strings stay identical
// where they overlap — the only additions are score parsing + coloring.
//
// Explicitly out of scope: Head-to-Head. Take-to-H2H button just
// invokes the parent-supplied handler; H2HView itself is untouched.

import { useState, type CSSProperties } from 'react';
import type { Plan, PlanBenefits } from '@/types/plans';
import { TOKENS as T, FONT as F } from './tokens';
import { PreviewDrawerShell } from './QuickPreviewDrawer';
import {
  planDisplay,
  formatCostShareWithRange,
  formatPcp,
  formatSpecialist,
  formatPremium,
  annualEstimate,
} from '../planDisplay';
import {
  formatInpatientLadder,
  parseInpatientTiers,
} from '@/lib/inpatient-format';
import { formatOtc } from '@/lib/extractBenefitValue';

// Mirror the DrugRow shape from CompareScreen. Kept local so this
// module doesn't reach up into the parent for a type.
interface DrugRow {
  rxcui: string;
  name: string;
  covered: boolean;
  tier: number | null;
  monthlyCopay: number | null;
  annualCost: number;
}

export interface BoardComparisonViewProps {
  /** Plans currently on the board (2-4). Filtered upstream — no null
   *  slots reach here. */
  plans: ReadonlyArray<Plan>;
  /** Per-plan drug breakdown from the brain, keyed by plan.id. Null
   *  when the client has no captured meds. */
  drugBreakdownByPlanId: Record<string, ReadonlyArray<DrugRow>> | null | undefined;
  /** Per-plan annual drug cost for the est-annual-cost row. */
  annualDrugByPlanId: Record<string, number | null>;
  /** Per-plan flag from the brain: true when at least one user drug on
   *  this plan has no cache row AND isn't on the formulary — the annual
   *  drug estimate is unknown. Est. annual cost renders "Cost pending"
   *  (neutral, not scored) instead of showing premium-only as if it
   *  were a real $0-drug total. */
  drugCoverageUnknownByPlanId?: Record<string, boolean>;
  onClose: () => void;
  /** Take-to-H2H invocation on the leader. Wired to the parent's
   *  existing openH2H(plan) — H2HView itself is not modified. */
  onTakeToH2H: (plan: Plan) => void;
  /** The baseline plan on the board — used to disable Take-to-H2H when
   *  the leader IS the baseline (H2H is meaningful only vs the
   *  baseline, so leader=baseline has nothing to challenge). */
  baselineId?: string | null;
}

export function BoardComparisonView(props: BoardComparisonViewProps) {
  const { plans, drugBreakdownByPlanId, annualDrugByPlanId, drugCoverageUnknownByPlanId, onClose, onTakeToH2H, baselineId } = props;

  // "Differences only" — hides rows where every plan on the board has
  // the same value (rowScore.differentiates === false). Default off so
  // the full ladder is visible on first open; brokers who want to cut
  // ties for a fast scan flip it on. Section headers also hide when
  // every row in the section is hidden.
  const [differencesOnly, setDifferencesOnly] = useState(false);

  if (plans.length === 0) return null;

  // ── Row descriptors + scoring pass ──────────────────────────────
  const sections = buildSections(plans, annualDrugByPlanId, drugCoverageUnknownByPlanId ?? {})
    // Drop entirely-empty sections. A section can have zero rows when
    // every row in it was gated by "at least one plan has data" and
    // none of the plans on the board file the field (e.g. Diagnostics
    // for a pool of plans that only filed inpatient copays).
    .filter((s) => s.rows.length > 0);

  // Tally: greens vs reds per plan, only counting rows that differentiate.
  const tally: PlanTally[] = plans.map(() => ({ greens: 0, reds: 0 }));
  const rowScores: Map<string, RowScore> = new Map();
  for (const section of sections) {
    for (const row of section.rows) {
      const scored = scoreRow(row, plans);
      rowScores.set(rowKey(section.title, row.label), scored);
      if (!scored.differentiates) continue;
      scored.colors.forEach((c, i) => {
        if (c === 'green') tally[i].greens += 1;
        else if (c === 'red') tally[i].reds += 1;
      });
    }
  }

  // Medication cost breakdown section: per-drug row + monthly / annual
  // totals. Scored independently — "Cost pending" is neutral (not
  // counted) per the spec exception. Only rendered when there are meds.
  const drugSection = buildDrugSection(plans, drugBreakdownByPlanId);
  if (drugSection) {
    for (const row of drugSection.rows) {
      const scored = scoreRow(row, plans);
      rowScores.set(rowKey(drugSection.title, row.label), scored);
      if (!scored.differentiates) continue;
      scored.colors.forEach((c, i) => {
        if (c === 'green') tally[i].greens += 1;
        else if (c === 'red') tally[i].reds += 1;
      });
    }
  }

  // Leader = plan with the most greens. Ties broken by fewest reds,
  // then leftmost slot (stable). All plans get a badge; leader gets
  // the Take-to-H2H button.
  const leaderIdx = tally.reduce((bestI, cur, i) => {
    const best = tally[bestI];
    if (cur.greens > best.greens) return i;
    if (cur.greens === best.greens && cur.reds < best.reds) return i;
    return bestI;
  }, 0);
  const leaderTiedWithSomeone =
    tally.filter((t) => t.greens === tally[leaderIdx].greens && t.reds === tally[leaderIdx].reds)
      .length > 1;

  const gridCols = `minmax(140px, 180px) repeat(${plans.length}, minmax(0, 1fr))`;

  return (
    <PreviewDrawerShell
      title={`Compare board · ${plans.length} plan${plans.length === 1 ? '' : 's'}`}
      subtitle="Scored side-by-side across every plan currently on the board — green wins, red loses, ties go green without swaying the tally"
      contractLabel={null}
      sbfUrl={null}
      onClose={onClose}
      footer={null}
    >
      {/* "Differences only" toggle — hides rows where every plan
          shares the same value. Section headers hide when all their
          rows would be filtered out. */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          padding: '10px 18px 6px',
          borderBottom: `1px solid ${T.navyLine}`,
        }}
      >
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
            fontFamily: F.label,
            fontSize: 11,
            fontWeight: 600,
            color: differencesOnly ? T.mintOnDark : T.navyTextDim,
            letterSpacing: 0.3,
            textTransform: 'uppercase',
          }}
        >
          <input
            type="checkbox"
            checked={differencesOnly}
            onChange={(e) => setDifferencesOnly(e.target.checked)}
            style={{ accentColor: T.mint600, margin: 0 }}
          />
          Differences only
        </label>
      </div>

      {/* Plan-column header row — no fills, no column borders. A single
          hairline separates it from the body. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: gridCols,
          borderBottom: `1px solid rgba(255,255,255,0.08)`,
        }}
      >
        <div style={CELL_HEADER_LABEL} />
        {plans.map((p) => (
          <div key={p.id} style={CELL_HEADER_PLAN}>
            <div
              style={{
                color: T.mintOnDark,
                fontFamily: F.label,
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: 0.6,
                textTransform: 'uppercase',
              }}
            >
              {p.carrier}
            </div>
            <div
              style={{
                color: '#FFFFFF',
                fontFamily: F.label,
                fontSize: 13,
                fontWeight: 500,
                lineHeight: 1.3,
                marginTop: 3,
              }}
            >
              {planCleanName(p)}
            </div>
            <div style={{ color: T.navyTextMuted, fontFamily: F.num, fontSize: 11, marginTop: 4 }}>
              {planContract(p)}
            </div>
          </div>
        ))}
      </div>

      {/* Sections */}
      {sections.map((section) => (
        <Section
          key={section.title}
          title={section.title}
          rows={section.rows}
          plans={plans}
          rowScores={rowScores}
          gridCols={gridCols}
          differencesOnly={differencesOnly}
        />
      ))}

      {drugSection && (
        <Section
          key={drugSection.title}
          title={drugSection.title}
          rows={drugSection.rows}
          plans={plans}
          rowScores={rowScores}
          gridCols={gridCols}
          differencesOnly={differencesOnly}
        />
      )}

      {/* Tally scoreboard — restraint treatment: big mono counts, no
          pills, no filled background. Leader gets a single mint accent
          bar above their column, not a block. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: gridCols,
          borderTop: `1px solid rgba(255,255,255,0.08)`,
          marginTop: 4,
        }}
      >
        <div
          style={{
            ...CELL_LABEL,
            fontSize: 12,
            color: T.navyTextMuted,
            padding: '20px 16px',
          }}
        >
          Scoreboard
        </div>
        {plans.map((p, i) => {
          const isLeader = i === leaderIdx;
          const t = tally[i];
          const canTakeToH2H = isLeader && baselineId !== p.id;
          return (
            <div
              key={p.id}
              style={{
                padding: '18px 14px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                alignItems: 'flex-start',
                position: 'relative',
              }}
            >
              {isLeader && (
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 14,
                    right: 14,
                    height: 2,
                    background: T.mintOnDark,
                    borderRadius: 2,
                  }}
                  aria-hidden
                />
              )}
              <div style={{ display: 'flex', gap: 14, alignItems: 'baseline' }}>
                <span style={{ color: SCORE_GREEN_FG, fontFamily: F.num, fontSize: 26, fontWeight: 500, lineHeight: 1 }}>
                  {t.greens}
                </span>
                <span style={{ color: T.navyTextMuted, fontFamily: F.label, fontSize: 11 }}>
                  wins
                </span>
                {t.reds > 0 && (
                  <>
                    <span style={{ color: SCORE_RED_FG, fontFamily: F.num, fontSize: 20, fontWeight: 500, marginLeft: 6, lineHeight: 1 }}>
                      {t.reds}
                    </span>
                    <span style={{ color: T.navyTextMuted, fontFamily: F.label, fontSize: 11 }}>
                      missing
                    </span>
                  </>
                )}
              </div>
              {isLeader && (
                <div
                  style={{
                    color: T.mintOnDark,
                    fontFamily: F.label,
                    fontSize: 10.5,
                    fontWeight: 600,
                    letterSpacing: 0.5,
                    textTransform: 'uppercase',
                    marginTop: 2,
                  }}
                  title={leaderTiedWithSomeone ? 'Tied for the lead — leftmost slot shown as leader' : undefined}
                >
                  {leaderTiedWithSomeone ? 'Leader · tied' : 'Leader'}
                </div>
              )}
              {isLeader && canTakeToH2H && (
                <button
                  type="button"
                  onClick={() => onTakeToH2H(p)}
                  style={{
                    marginTop: 4,
                    background: 'transparent',
                    color: T.mintOnDark,
                    border: `1px solid ${T.mintOnDark}`,
                    borderRadius: 6,
                    padding: '6px 12px',
                    fontFamily: F.label,
                    fontSize: 11.5,
                    fontWeight: 600,
                    letterSpacing: 0.3,
                    cursor: 'pointer',
                  }}
                >
                  Take to Head-to-Head →
                </button>
              )}
              {isLeader && !canTakeToH2H && baselineId === p.id && (
                <div
                  style={{
                    color: T.navyTextMuted,
                    fontFamily: F.label,
                    fontSize: 10.5,
                    lineHeight: 1.4,
                    marginTop: 2,
                  }}
                >
                  Baseline plan · H2H compares vs the baseline
                </div>
              )}
            </div>
          );
        })}
      </div>
    </PreviewDrawerShell>
  );
}

// ─── Section renderer ───────────────────────────────────────────────

function Section({
  title,
  rows,
  plans,
  rowScores,
  gridCols,
  differencesOnly,
}: {
  title: string;
  rows: ReadonlyArray<ScoreableRow>;
  plans: ReadonlyArray<Plan>;
  rowScores: Map<string, RowScore>;
  gridCols: string;
  differencesOnly: boolean;
}) {
  // Filter rows against the differencesOnly toggle. When on, drop rows
  // whose score doesn't differentiate (every plan tied). Keep the whole
  // section hidden if nothing survives — the section header is signal,
  // not chrome.
  const visibleRows = differencesOnly
    ? rows.filter((row) => rowScores.get(rowKey(title, row.label))?.differentiates === true)
    : rows;
  if (visibleRows.length === 0) return null;

  return (
    <>
      <div
        style={{
          padding: '26px 18px 6px',
        }}
      >
        <div
          style={{
            color: T.mintOnDark,
            fontFamily: F.label,
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 1.2,
          }}
        >
          {title}
        </div>
      </div>
      {visibleRows.map((row) => {
        const scored = rowScores.get(rowKey(title, row.label));
        return (
          <div
            key={row.label}
            style={{
              display: 'grid',
              gridTemplateColumns: gridCols,
              // Hairline row separator at low opacity — the only fill
              // in the whole view. No column borders; whitespace does
              // the column-separation work.
              borderTop: `1px solid rgba(255,255,255,0.04)`,
              alignItems: 'baseline',
            }}
          >
            <div style={CELL_LABEL}>{row.label}</div>
            {plans.map((p, i) => {
              const rendered = row.render(p);
              const color = scored?.colors?.[i] ?? 'neutral';
              return (
                <div key={p.id} style={CELL_VALUE}>
                  <ScoreCell
                    color={color}
                    text={rendered.text}
                    subtext={rendered.subtext}
                    multiline={rendered.multiline}
                  />
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

// ScoreCell — restraint-first render. No pill background, no border.
// The NUMBER carries the color; everything else is whitespace and
// typography.
//
// Color model (2026-08-08 refinement):
//   • green  — winner on this row. Text color + slightly heavier weight.
//   • neutral — present-but-not-winner. Regular navy-ink text. This is
//               the default state for the vast majority of rows; a
//               plan losing a copay by $5 shouldn't scream in red.
//   • red    — absent / missing / "None" / "Not filed". Reserved for
//               genuinely bad outcomes so it stays informative.
function ScoreCell({
  color,
  text,
  subtext,
  multiline,
}: {
  color: RowColor;
  text: string;
  subtext?: string | null;
  /** Ladder rows: `subtext` carries multi-line per-day breakdown. */
  multiline?: boolean;
}) {
  const fg =
    color === 'green' ? SCORE_GREEN_FG :
    color === 'red' ? SCORE_RED_FG :
    T.navyText;
  return (
    <div style={{ maxWidth: '100%', wordBreak: 'break-word' }}>
      <div
        style={{
          fontFamily: F.num,
          fontSize: 19,
          fontWeight: color === 'green' ? 600 : 500,
          lineHeight: 1.1,
          color: fg,
        }}
      >
        {text}
      </div>
      {subtext && (
        <div
          style={{
            fontFamily: multiline ? F.num : F.label,
            fontSize: 11,
            fontWeight: 400,
            color: T.navyTextMuted,
            marginTop: 6,
            lineHeight: 1.45,
            whiteSpace: multiline ? ('pre-line' as const) : undefined,
          }}
        >
          {subtext}
        </div>
      )}
    </div>
  );
}

// ─── Section + row descriptors ──────────────────────────────────────

interface ScoreableRow {
  label: string;
  direction: 'lower' | 'higher';
  render: (plan: Plan) => RenderedCell;
}
interface RenderedCell {
  text: string;
  /** null → no score input (row can't score this plan; treated as
   *  absent → red unless the exception `neutralOnPending` is set). */
  score: number | null;
  /** Optional second line under the primary value (e.g. ladder total
   *  under the ladder itself). */
  subtext?: string | null;
  multiline?: boolean;
  /** Only true for the medication cost breakdown "Cost pending" case —
   *  the row-scoring pass treats this plan as neutral for that row
   *  (not scored, not tallied). Ignored on non-drug rows. */
  neutralOnPending?: boolean;
}

interface Section {
  title: string;
  rows: ReadonlyArray<ScoreableRow>;
}

type RowColor = 'green' | 'red' | 'neutral';

interface RowScore {
  colors: RowColor[];
  differentiates: boolean;
}

interface PlanTally {
  greens: number;
  reds: number;
}

function scoreRow(row: ScoreableRow, plans: ReadonlyArray<Plan>): RowScore {
  const cells = plans.map((p) => row.render(p));
  const scores = cells.map((c) => c.score);
  const isNeutral = cells.map((c) => c.neutralOnPending === true);

  // Any plan flagged neutral (drug-row Cost pending) drops out of the
  // scoring pool. It renders neutral in the UI and is not tallied.
  const eligibleScores = scores.map((s, i) => (isNeutral[i] ? null : s));

  const nonNullEligible = eligibleScores.filter((s): s is number => s != null);
  if (nonNullEligible.length === 0) {
    // No plan has a scoreable value. Everyone neutral, no tally.
    return { colors: plans.map(() => 'neutral' as RowColor), differentiates: false };
  }

  const best =
    row.direction === 'lower'
      ? Math.min(...nonNullEligible)
      : Math.max(...nonNullEligible);
  const worst =
    row.direction === 'lower'
      ? Math.max(...nonNullEligible)
      : Math.min(...nonNullEligible);

  // Best/worst polarity model (2026-08-09):
  //   • BEST value          → 'green'  (weight 600 text)
  //   • WORST value          → 'red'
  //   • Middle (>=3 plans)   → 'neutral'
  //   • Absent / missing     → 'red'    (absent is worst)
  //   • Ties on best         → all tied plans green
  //   • Ties on worst        → all tied plans red
  //   • All eligible tie AND no absent → all 'neutral' (row has no signal)
  //   • 2 plans, both with values → best green, worst red, no middle
  //   • Cost-pending flagged  → 'neutral' (unscored, not tallied)
  //
  // Note best === worst means every eligible plan has the same value.
  // When there's also an absent plan, that eligible value is
  // simultaneously best (tied among the present) and worst (relative
  // to the row as a whole isn't meaningful, but relative to the absent
  // plan, present > absent) — so the eligible plans should read as
  // "green tied for best" not "red tied for worst."
  const allEligibleTie = best === worst;
  const hasAbsent = eligibleScores.some((s, i) => !isNeutral[i] && s == null);

  const colors: RowColor[] = plans.map((_, i) => {
    if (isNeutral[i]) return 'neutral';
    const s = scores[i];
    if (s == null) return 'red'; // absent → red
    if (allEligibleTie) {
      // Every present plan has the same value. If no absents, no
      // signal — everything neutral. If any absents, the present
      // plans win by default (green).
      return hasAbsent ? 'green' : 'neutral';
    }
    if (s === best) return 'green';
    if (s === worst) return 'red';
    return 'neutral'; // middle band — only reachable with >= 3 plans
  });

  const differentiates = colors.some((c) => c === 'green' || c === 'red');
  return { colors, differentiates };
}

// Extract numeric $ or % from a display string. Returns null when
// nothing parseable is found. Used for non-numeric benefit fallback
// scoring (e.g. hearing "Routine + $500/yr aids" → 500).
function extractNumber(s: string): number | null {
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// Numeric parse of formatCostShare-style output. Handles "$25", "$0",
// "20%", "$0–$190", "N/A — Part D only" (returns null), "—" (null),
// or free-text (null). Coinsurance strings (X%) share the same axis
// as $ within a row — same plan filed one shape, others another;
// direct compare is imperfect but the row still surfaces the winner
// among comparable filings.
function parseMoneyOrPct(s: string): number | null {
  if (!s || s === '—') return null;
  if (s.startsWith('N/A')) return null;
  const rangeMatch = s.match(/^\$(\d+)[–-]/);
  if (rangeMatch) return Number(rangeMatch[1]); // low end of range wins
  const dollarMatch = s.match(/^\$(\d+(?:\.\d+)?)/);
  if (dollarMatch) return Number(dollarMatch[1]);
  const pctMatch = s.match(/^(\d+(?:\.\d+)?)%/);
  if (pctMatch) return Number(pctMatch[1]);
  return null;
}

// Ladder total exposure = Σ copay × (dayEnd - dayStart + 1) across
// every parsed tier. Falls back to `copay × 90` when only a flat
// day-1 copay is filed (matches CMS Medicare Advantage inpatient cap).
// Returns null when neither a ladder nor a copay is available — that
// plan can't be scored on this row.
function ladderTotal(
  description: string | null | undefined,
  copay: number | null | undefined,
  coinsurance: number | null | undefined,
): { total: number | null; fallback: string | null } {
  const tiers = parseInpatientTiers(description);
  if (tiers.length > 0) {
    const total = tiers.reduce(
      (acc, t) => acc + t.copay * (t.dayEnd - t.dayStart + 1),
      0,
    );
    return { total, fallback: null };
  }
  if (typeof copay === 'number') {
    // No parsed ladder — assume flat over 90 days. Marked in the
    // subtext so the broker knows we extrapolated.
    return { total: copay * 90, fallback: 'assumes 90 days' };
  }
  if (typeof coinsurance === 'number') {
    // Coinsurance-only filings can't compute total exposure without
    // notional service prices. Leave unscored on this plan.
    return { total: null, fallback: `${coinsurance}%` };
  }
  return { total: null, fallback: null };
}

function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

// ─── Section builders ──────────────────────────────────────────────

function buildSections(
  _plans: ReadonlyArray<Plan>,
  annualDrugByPlanId: Record<string, number | null>,
  drugCoverageUnknownByPlanId: Record<string, boolean>,
): Section[] {
  const cs = (plan: Plan, getter: (b: PlanBenefits['medical']) => Parameters<typeof formatCostShareWithRange>[0]) => {
    const isPdp = plan.plan_type === 'PDP';
    const val = getter(plan.benefits.medical);
    return {
      text: formatCostShareWithRange(val, { isPdp }),
      score: parseMoneyOrPct(formatCostShareWithRange(val, { isPdp })),
    };
  };

  // Row-in-section only rendered when at least one plan has any data
  // (copay OR coinsurance non-null) for it. Prevents the view from
  // filling with 'Not filed'-only rows that penalize every plan.
  const anyPlanHasCostShare = (
    plans: ReadonlyArray<Plan>,
    getter: (m: PlanBenefits['medical']) => { copay: number | null; coinsurance: number | null },
  ): boolean =>
    plans.some((p) => {
      const v = getter(p.benefits.medical);
      return v.copay != null || v.coinsurance != null;
    });

  const medicalRow = (
    label: string,
    getter: (m: PlanBenefits['medical']) => PlanBenefits['medical']['primary_care'],
  ): ScoreableRow => ({
    label,
    direction: 'lower',
    render: (p) => cs(p, getter),
  });

  // Ladder row — inpatient / SNF / MH-inpatient. The computed Total is
  // the primary read (large mono in ScoreChip), the per-day breakdown
  // stays small and secondary. Empty ladder falls through to "Not
  // filed" as the primary text.
  const ladderRow = (
    label: string,
    getter: (m: PlanBenefits['medical']) => PlanBenefits['medical']['inpatient'],
  ): ScoreableRow => ({
    label,
    direction: 'lower',
    render: (p) => {
      const m = getter(p.benefits.medical);
      const ladder = formatInpatientLadder(m.description, m.copay, m.coinsurance);
      const { total, fallback } = ladderTotal(m.description, m.copay, m.coinsurance);
      // Primary large: the total. Falls back to the ladder value or
      // "Not filed" when total isn't computable (coinsurance-only, no
      // ladder at all). Secondary small: the per-day breakdown.
      if (total != null) {
        const suffix = fallback ? ` · ${fallback}` : '';
        return {
          text: `${fmtMoney(total)}${suffix}`,
          subtext: ladder ?? null,
          score: total,
          multiline: true,
        };
      }
      return {
        text: ladder ?? (fallback ?? 'Not filed'),
        subtext: null,
        score: null,
        multiline: true,
      };
    },
  });

  // Optional medical row — only included when at least one board plan
  // has data for the field. Rob's spec: "only render the row if at least
  // one plan on the board has data for it — don't add rows that are
  // pending across the board."
  const optionalMedicalRow = (
    label: string,
    getter: (m: PlanBenefits['medical']) => PlanBenefits['medical']['primary_care'],
  ): ScoreableRow | null =>
    anyPlanHasCostShare(_plans, getter) ? medicalRow(label, getter) : null;

  const compact = (rows: (ScoreableRow | null)[]): ScoreableRow[] =>
    rows.filter((r): r is ScoreableRow => r !== null);

  return [
    {
      title: 'Cost overview',
      rows: [
        {
          label: 'Premium',
          direction: 'lower',
          render: (p) => ({ text: formatPremium(p), score: p.premium }),
        },
        {
          label: 'MOOP (in-network)',
          direction: 'lower',
          render: (p) => ({
            text: p.moop_in_network > 0 ? fmtMoney(p.moop_in_network) : 'Not filed',
            score: p.moop_in_network > 0 ? p.moop_in_network : null,
          }),
        },
        {
          label: 'Est. annual cost',
          direction: 'lower',
          render: (p) => {
            // If drug coverage is unknown for this plan (brain couldn't
            // resolve at least one user drug against cache OR formulary),
            // the "annual cost" would silently collapse to premium × 12
            // and read as $0-drug in green — a missing value looking
            // like the best value. Route through the same neutral
            // "Cost pending" treatment used in the medication section
            // so this row doesn't sway the tally.
            const drugCost = annualDrugByPlanId[p.id];
            const drugUnknown = drugCoverageUnknownByPlanId[p.id] === true;
            if (drugCost == null || drugUnknown) {
              return {
                text: 'Cost pending',
                score: null,
                neutralOnPending: true,
                subtext: `Premium ${formatPremium(p)}/mo · drug est. unavailable`,
              };
            }
            const est = annualEstimate(p, drugCost);
            if (est.total == null) {
              return {
                text: 'Cost pending',
                score: null,
                neutralOnPending: true,
              };
            }
            return { text: fmtMoney(est.total), score: est.total };
          },
        },
      ],
    },
    {
      title: 'Provider & care',
      rows: compact([
        {
          label: 'PCP copay',
          direction: 'lower',
          render: (p) => ({ text: formatPcp(p), score: parseMoneyOrPct(formatPcp(p)) }),
        },
        {
          label: 'Specialist',
          direction: 'lower',
          render: (p) => ({ text: formatSpecialist(p), score: parseMoneyOrPct(formatSpecialist(p)) }),
        },
        medicalRow('Telehealth', (m) => m.telehealth),
        optionalMedicalRow('Physical / speech therapy', (m) => m.physical_speech_therapy),
        optionalMedicalRow('Occupational therapy', (m) => m.occupational_therapy),
        optionalMedicalRow('Mental health (individual)', (m) => m.mental_health_individual),
        optionalMedicalRow('Mental health (group)', (m) => m.mental_health_group),
        optionalMedicalRow('Substance abuse / opioid tx', (m) => m.substance_abuse),
        optionalMedicalRow('Podiatry', (m) => m.podiatry),
        optionalMedicalRow('Chiropractic', (m) => m.chiropractic),
        optionalMedicalRow('Acupuncture', (m) => m.acupuncture),
      ]),
    },
    {
      title: 'Emergency & urgent',
      rows: compact([
        medicalRow('Urgent care', (m) => m.urgent_care),
        medicalRow('Emergency room', (m) => m.emergency),
        optionalMedicalRow('Ambulance', (m) => m.ambulance),
        optionalMedicalRow('Air transportation', (m) => m.air_transportation),
      ]),
    },
    {
      title: 'Hospital & inpatient',
      rows: compact([
        ladderRow('Inpatient', (m) => m.inpatient),
        ladderRow('Inpatient mental', (m) => m.mental_health_inpatient),
        ladderRow('Skilled nursing', (m) => m.snf),
        medicalRow('Outpatient surg. (hosp)', (m) => m.outpatient_surgery_hospital),
        medicalRow('Outpatient surg. (ASC)', (m) => m.outpatient_surgery_asc),
        optionalMedicalRow('Outpatient observation', (m) => m.outpatient_observation),
        optionalMedicalRow('Home health', (m) => m.home_health),
      ]),
    },
    {
      title: 'Diagnostics & imaging',
      rows: compact([
        optionalMedicalRow('Lab services', (m) => m.lab_services),
        optionalMedicalRow('Diagnostic procedures', (m) => m.diagnostic_procedures),
        optionalMedicalRow('X-ray', (m) => m.xray),
        optionalMedicalRow('Advanced imaging (MRI/CT)', (m) => m.advanced_imaging),
      ]),
    },
    {
      title: 'Equipment & Part B drugs',
      rows: compact([
        optionalMedicalRow('DME / prosthetics', (m) => m.dme_prosthetics),
        optionalMedicalRow('Part B drugs / chemo', (m) => m.partb_drugs),
        optionalMedicalRow('Diabetic supplies', (m) => m.diabetic_supplies),
        optionalMedicalRow('Insulin', (m) => m.insulin),
        optionalMedicalRow('Renal dialysis', (m) => m.renal_dialysis),
      ]),
    },
    {
      title: 'Rx & pharmacy',
      rows: [
        {
          label: 'Part D deductible',
          direction: 'lower',
          render: (p) => ({
            text: p.drug_deductible == null ? 'Not filed' : `$${p.drug_deductible}`,
            score: p.drug_deductible == null ? null : p.drug_deductible,
          }),
        },
        ...tierRows(_plans),
      ],
    },
    {
      title: 'Extras',
      rows: [
        {
          label: 'Dental',
          direction: 'higher',
          render: (p) => {
            const disp = planDisplay(p).dentalMax;
            const annual = p.benefits.dental.annual_max;
            return {
              text: disp === 'None' ? 'None' : disp,
              score: annual > 0 ? annual : (p.benefits.dental.comprehensive || p.benefits.dental.preventive ? 0 : null),
            };
          },
        },
        {
          label: 'Vision',
          direction: 'higher',
          render: (p) => {
            const disp = planDisplay(p).visionAllowance;
            const eyewear = p.benefits.vision.eyewear_allowance_year;
            const exam = p.benefits.vision.exam;
            const numeric = eyewear > 1 ? eyewear : (eyewear === 1 || exam ? 0 : null);
            return { text: disp === '$0' ? 'None' : disp, score: numeric };
          },
        },
        {
          label: 'OTC / qtr',
          direction: 'higher',
          render: (p) => {
            const q = p.benefits.otc.allowance_per_quarter;
            const text = formatOtc(q, p.benefits.otc.description);
            return {
              text: q === 0 ? 'None' : text,
              score: q > 1 ? q : (q === 1 ? 0 : null),
            };
          },
        },
        {
          label: 'Fitness',
          direction: 'higher',
          render: (p) => {
            const disp = planDisplay(p).fitness;
            return { text: disp, score: p.benefits.fitness.enabled ? 1 : null };
          },
        },
        {
          label: 'Hearing',
          direction: 'higher',
          render: (p) => {
            const disp = planDisplay(p).hearing;
            const aids = p.benefits.hearing.aid_allowance_year;
            const exam = p.benefits.hearing.exam;
            const numeric = aids > 1 ? aids : (aids === 1 || exam ? 0 : null);
            return { text: disp === 'None' ? 'None' : disp, score: numeric };
          },
        },
        {
          label: 'Transport',
          direction: 'higher',
          render: (p) => {
            const rides = p.benefits.transportation.rides_per_year;
            const desc = p.benefits.transportation.description?.trim();
            if (rides > 0) return { text: `${rides} trips/yr`, score: rides };
            if (desc) return { text: desc, score: extractNumber(desc) ?? 0 };
            return { text: 'None', score: null };
          },
        },
        {
          label: 'Food card',
          direction: 'higher',
          render: (p) => {
            const monthly = p.benefits.food_card.allowance_per_month;
            const disp = planDisplay(p).meals;
            return {
              text: disp === 'None' ? 'None' : disp,
              score: monthly > 1 ? monthly : (monthly === 1 ? 0 : null),
            };
          },
        },
        {
          label: 'Part B giveback',
          direction: 'higher',
          render: (p) => ({
            text: p.part_b_giveback > 0 ? `$${p.part_b_giveback}/mo` : 'None',
            score: p.part_b_giveback > 0 ? p.part_b_giveback : null,
          }),
        },
      ],
    },
  ];
}

// Tier rows: emit Tier 1-5 always, plus 6/7/8 when any plan in the
// pool files them (matching the existing PreviewGrid convention).
function tierRows(plans: ReadonlyArray<Plan>): ScoreableRow[] {
  const rows: ScoreableRow[] = [];
  const tierKeys: Array<{ label: string; key: keyof PlanBenefits['rx_tiers']; alwaysShow: boolean }> = [
    { label: 'Tier 1', key: 'tier_1', alwaysShow: true },
    { label: 'Tier 2', key: 'tier_2', alwaysShow: true },
    { label: 'Tier 3', key: 'tier_3', alwaysShow: true },
    { label: 'Tier 4', key: 'tier_4', alwaysShow: true },
    { label: 'Tier 5', key: 'tier_5', alwaysShow: true },
    { label: 'Tier 6', key: 'tier_6', alwaysShow: false },
    { label: 'Tier 7', key: 'tier_7', alwaysShow: false },
    { label: 'Tier 8', key: 'tier_8', alwaysShow: false },
  ];
  for (const t of tierKeys) {
    if (!t.alwaysShow) {
      const anyHasIt = plans.some((p) => p.benefits.rx_tiers[t.key] != null);
      if (!anyHasIt) continue;
    }
    rows.push({
      label: t.label,
      direction: 'lower',
      render: (p) => {
        const isPdp = p.plan_type === 'PDP';
        const cs = p.benefits.rx_tiers[t.key];
        if (!cs) {
          return { text: 'Not filed', score: null };
        }
        const text = formatCostShareWithRange(cs, { isPdp });
        return { text, score: parseMoneyOrPct(text) };
      },
    });
  }
  return rows;
}

// ─── Medication cost breakdown section ──────────────────────────────
//
// One row per unique drug across the board (union of all plans'
// breakdowns). Each row scores monthly copay lower=green, with the
// pending-neutral exception. Plus monthly / annual total rows also
// scored (annual is always available; monthly-total is neutral when
// any covered drug on that plan has null monthlyCopay).
//
// Returns null when no plan has a drug breakdown (client has no meds).

function buildDrugSection(
  plans: ReadonlyArray<Plan>,
  drugBreakdownByPlanId: Record<string, ReadonlyArray<DrugRow>> | null | undefined,
): Section | null {
  if (!drugBreakdownByPlanId) return null;
  const perPlan: Array<ReadonlyArray<DrugRow>> = plans.map(
    (p) => drugBreakdownByPlanId[p.id] ?? [],
  );
  const anyMeds = perPlan.some((rows) => rows.length > 0);
  if (!anyMeds) return null;

  // Union of drug identities across plans, keyed by rxcui then name.
  const seen = new Map<string, { rxcui: string; name: string }>();
  for (const rows of perPlan) {
    for (const d of rows) {
      const key = d.rxcui || d.name;
      if (!seen.has(key)) seen.set(key, { rxcui: d.rxcui, name: d.name });
    }
  }
  const drugs = [...seen.values()];

  const perPlanByKey: Array<Map<string, DrugRow>> = perPlan.map((rows) => {
    const m = new Map<string, DrugRow>();
    for (const d of rows) m.set(d.rxcui || d.name, d);
    return m;
  });

  const rows: ScoreableRow[] = [];

  for (const drug of drugs) {
    rows.push({
      label: drug.name,
      direction: 'lower',
      render: (_p, ...args: unknown[]) => {
        void _p; void args;
        // Body handled in per-plan lookup below via a closure.
        return { text: '', score: null };
      },
    });
    // Replace the last-pushed row's render with one that has plan
    // index awareness. Cleaner to build with a plan-index-aware
    // signature, but ScoreableRow's contract is (plan) → cell; we
    // find the plan's index at render time via the plans array.
    const row = rows[rows.length - 1];
    row.render = (plan) => {
      const idx = plans.indexOf(plan);
      const drugRow = idx >= 0 ? perPlanByKey[idx].get(drug.rxcui || drug.name) : undefined;
      if (!drugRow) {
        return { text: 'Not on formulary', score: null };
      }
      if (!drugRow.covered) {
        return { text: 'Not covered', score: null };
      }
      if (drugRow.monthlyCopay == null) {
        return {
          text: 'Cost pending',
          score: null,
          neutralOnPending: true,
          subtext: `Annual est: ${fmtMoney(drugRow.annualCost)}`,
        };
      }
      return {
        text: `$${drugRow.monthlyCopay}/mo`,
        subtext: `Tier ${drugRow.tier ?? '—'} · annual ${fmtMoney(drugRow.annualCost)}`,
        score: drugRow.monthlyCopay,
      };
    };
  }

  // Totals: annual (sum of covered.annualCost across the plan's rows).
  // Monthly total intentionally omitted here — the SoB drawer's
  // "Cost pending" gate collapses the monthly total to a pending pill
  // when any covered drug has null monthlyCopay, which isn't
  // straightforwardly scoreable across plans (the pending itself is
  // the whole signal for that plan). Annual is always summable from
  // filed per-drug annualCost values, so it's the reliable comparison.
  rows.push({
    label: 'Total annual (covered)',
    direction: 'lower',
    render: (plan) => {
      const idx = plans.indexOf(plan);
      const rows = idx >= 0 ? perPlan[idx] : [];
      const covered = rows.filter((r) => r.covered);
      if (covered.length === 0) return { text: 'No coverage', score: null };
      const total = covered.reduce((s, d) => s + d.annualCost, 0);
      return { text: fmtMoney(total), score: total };
    },
  });

  return { title: 'Medication cost breakdown', rows };
}

// ─── Small helpers ──────────────────────────────────────────────────

function planCleanName(plan: Plan): string {
  const carrier = plan.carrier ?? '';
  const name = plan.plan_name ?? '';
  return carrier && name.toLowerCase().startsWith(carrier.toLowerCase())
    ? name.slice(carrier.length).trim()
    : name;
}

function planContract(plan: Plan): string {
  const [contract, planNum, seg] = plan.id.split('-');
  if (!contract || !planNum) return plan.id;
  const segNorm = (seg ?? '0').replace(/^0+/, '') || '0';
  return `${contract}-${planNum}-${segNorm}`;
}

function rowKey(sectionTitle: string, rowLabel: string): string {
  return `${sectionTitle}::${rowLabel}`;
}

// ─── Style constants ────────────────────────────────────────────────

const CELL_LABEL: CSSProperties = {
  // Reference-weight label: small, muted, regular weight. No fill.
  // The number to the right is the read; this anchors the row without
  // competing.
  color: T.navyTextMuted,
  fontFamily: F.label,
  fontSize: 12,
  fontWeight: 400,
  padding: '15px 16px',
  display: 'flex',
  alignItems: 'baseline',
};
const CELL_VALUE: CSSProperties = {
  padding: '15px 14px',
  display: 'flex',
  alignItems: 'baseline',
};
const CELL_HEADER_LABEL: CSSProperties = {
  padding: '14px 14px 12px',
  background: '#0C1626',
};
const CELL_HEADER_PLAN: CSSProperties = {
  padding: '14px 12px 12px',
  minWidth: 0,
};

// Color-carries-the-signal palette (no pill backgrounds).
const SCORE_GREEN_FG = '#7FE0C4';
const SCORE_RED_FG = '#fca5a5';
