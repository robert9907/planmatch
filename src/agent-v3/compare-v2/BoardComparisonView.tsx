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

import type { CSSProperties } from 'react';
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
  const { plans, drugBreakdownByPlanId, annualDrugByPlanId, onClose, onTakeToH2H, baselineId } = props;

  if (plans.length === 0) return null;

  // ── Row descriptors + scoring pass ──────────────────────────────
  const sections = buildSections(plans, annualDrugByPlanId);

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
      {/* Plan-column header row */}
      <div style={{ display: 'grid', gridTemplateColumns: gridCols, borderBottom: `1px solid ${T.navyLine}` }}>
        <div style={CELL_HEADER_LABEL} />
        {plans.map((p, i) => (
          <div key={p.id} style={{ ...CELL_HEADER_PLAN, borderLeft: i === 0 ? 'none' : `1px solid ${T.navyLine}` }}>
            <div style={{ color: T.mintOnDark, fontFamily: F.label, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase' }}>
              {p.carrier}
            </div>
            <div style={{ color: '#FFFFFF', fontFamily: F.label, fontSize: 12.5, fontWeight: 600, lineHeight: 1.25, marginTop: 2 }}>
              {planCleanName(p)}
            </div>
            <div style={{ color: T.navyTextDim, fontFamily: F.num, fontSize: 10.5, marginTop: 2 }}>
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
        />
      )}

      {/* Tally scoreboard */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: gridCols,
          borderTop: `2px solid ${T.navyLine}`,
          background: '#0C1626',
        }}
      >
        <div style={{ ...CELL_LABEL, padding: '14px 16px', color: T.mintOnDark, fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
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
                borderLeft: i === 0 ? 'none' : `1px solid ${T.navyLine}`,
                padding: '14px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                alignItems: 'center',
                background: isLeader ? 'rgba(127,224,196,0.08)' : 'transparent',
              }}
            >
              <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                <span style={{ color: SCORE_GREEN_FG, fontFamily: F.num, fontSize: 22, fontWeight: 700 }}>
                  {t.greens}
                </span>
                <span style={{ color: T.navyTextMuted, fontFamily: F.label, fontSize: 10.5 }}>
                  greens
                </span>
                <span style={{ color: SCORE_RED_FG, fontFamily: F.num, fontSize: 18, fontWeight: 600, marginLeft: 6 }}>
                  {t.reds}
                </span>
                <span style={{ color: T.navyTextMuted, fontFamily: F.label, fontSize: 10.5 }}>
                  reds
                </span>
              </div>
              {isLeader && (
                <div
                  style={{
                    background: 'rgba(127,224,196,0.22)',
                    color: T.mintOnDark,
                    fontFamily: F.label,
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 0.4,
                    textTransform: 'uppercase',
                    padding: '3px 8px',
                    borderRadius: 3,
                  }}
                  title={leaderTiedWithSomeone ? 'Tied for the lead — leftmost slot shown as leader' : undefined}
                >
                  {leaderTiedWithSomeone ? 'Leader (tied)' : 'Leader'}
                </div>
              )}
              {isLeader && canTakeToH2H && (
                <button
                  type="button"
                  onClick={() => onTakeToH2H(p)}
                  style={{
                    background: T.mint600,
                    color: T.mintOnMint,
                    border: 'none',
                    borderRadius: 8,
                    padding: '8px 14px',
                    fontFamily: F.label,
                    fontSize: 11.5,
                    fontWeight: 700,
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
                    textAlign: 'center',
                    lineHeight: 1.3,
                  }}
                >
                  Baseline plan · H2H compares<br/>vs the baseline
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
}: {
  title: string;
  rows: ReadonlyArray<ScoreableRow>;
  plans: ReadonlyArray<Plan>;
  rowScores: Map<string, RowScore>;
  gridCols: string;
}) {
  return (
    <>
      <div
        style={{
          padding: '12px 16px 6px',
          background: '#0C1626',
          borderTop: `1px solid ${T.navyLine}`,
        }}
      >
        <div
          style={{
            color: T.mintOnDark,
            fontFamily: F.label,
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          {title}
        </div>
      </div>
      {rows.map((row) => {
        const scored = rowScores.get(rowKey(title, row.label));
        return (
          <div
            key={row.label}
            style={{
              display: 'grid',
              gridTemplateColumns: gridCols,
              borderTop: `1px solid ${T.navyRow}`,
              alignItems: 'stretch',
            }}
          >
            <div style={CELL_LABEL}>{row.label}</div>
            {plans.map((p, i) => {
              const rendered = row.render(p);
              const color = scored?.colors?.[i] ?? 'neutral';
              return (
                <div
                  key={p.id}
                  style={{
                    ...CELL_VALUE,
                    borderLeft: i === 0 ? 'none' : `1px solid ${T.navyRow}`,
                    ...(rendered.multiline ? { whiteSpace: 'pre-line' as const } : {}),
                  }}
                >
                  <ScoreChip color={color} text={rendered.text} subtext={rendered.subtext} multiline={rendered.multiline} />
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

function ScoreChip({
  color,
  text,
  subtext,
  multiline,
}: {
  color: RowColor;
  text: string;
  subtext?: string | null;
  multiline?: boolean;
}) {
  const bg =
    color === 'green' ? SCORE_GREEN_BG :
    color === 'red' ? SCORE_RED_BG :
    'transparent';
  const fg =
    color === 'green' ? SCORE_GREEN_FG :
    color === 'red' ? SCORE_RED_FG :
    T.navyTextMuted;
  return (
    <div
      style={{
        background: bg,
        color: fg,
        borderRadius: 5,
        padding: multiline ? '6px 8px' : '5px 8px',
        fontFamily: F.num,
        fontSize: multiline ? 11 : 12,
        fontWeight: 600,
        display: 'inline-block',
        maxWidth: '100%',
        wordBreak: 'break-word',
        lineHeight: 1.35,
      }}
    >
      {text}
      {subtext && (
        <div style={{ fontFamily: F.label, fontSize: 10, fontWeight: 500, opacity: 0.85, marginTop: 2 }}>
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

  // All eligible plans share the best value AND there are no
  // ineligible-but-non-neutral plans (missing counts as differentiation
  // — winner beats absent). Score check: every plan must be either
  // eligible + at best, OR neutral (drug-pending). Otherwise it
  // differentiates.
  const allAtBest = eligibleScores.every((s, i) => {
    if (isNeutral[i]) return true;
    return s != null && s === best;
  });

  const colors: RowColor[] = plans.map((_, i) => {
    if (isNeutral[i]) return 'neutral';
    const s = scores[i];
    if (s == null) return 'red'; // absent when others have a value → red
    return s === best ? 'green' : 'red';
  });

  return { colors, differentiates: !allAtBest };
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
): Section[] {
  const cs = (plan: Plan, getter: (b: PlanBenefits['medical']) => Parameters<typeof formatCostShareWithRange>[0]) => {
    const isPdp = plan.plan_type === 'PDP';
    const val = getter(plan.benefits.medical);
    return {
      text: formatCostShareWithRange(val, { isPdp }),
      score: parseMoneyOrPct(formatCostShareWithRange(val, { isPdp })),
    };
  };

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
            const est = annualEstimate(p, annualDrugByPlanId[p.id] ?? null);
            if (est.total == null) {
              return { text: 'Cost pending', score: null };
            }
            return { text: fmtMoney(est.total), score: est.total };
          },
        },
      ],
    },
    {
      title: 'Provider & care',
      rows: [
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
        {
          label: 'Urgent care',
          direction: 'lower',
          render: (p) => cs(p, (m) => m.urgent_care),
        },
        {
          label: 'Emergency',
          direction: 'lower',
          render: (p) => cs(p, (m) => m.emergency),
        },
        {
          label: 'Telehealth',
          direction: 'lower',
          render: (p) => cs(p, (m) => m.telehealth),
        },
      ],
    },
    {
      title: 'Hospital',
      rows: [
        {
          label: 'Inpatient',
          direction: 'lower',
          render: (p) => {
            const m = p.benefits.medical.inpatient;
            const ladder = formatInpatientLadder(m.description, m.copay, m.coinsurance);
            const { total, fallback } = ladderTotal(m.description, m.copay, m.coinsurance);
            return {
              text: ladder ?? 'Not filed',
              subtext: total != null ? `Total: ${fmtMoney(total)}${fallback ? ` · ${fallback}` : ''}` : (fallback ?? null),
              score: total,
              multiline: true,
            };
          },
        },
        {
          label: 'Inpatient mental',
          direction: 'lower',
          render: (p) => {
            const m = p.benefits.medical.mental_health_inpatient;
            const ladder = formatInpatientLadder(m.description, m.copay, m.coinsurance);
            const { total, fallback } = ladderTotal(m.description, m.copay, m.coinsurance);
            return {
              text: ladder ?? 'Not filed',
              subtext: total != null ? `Total: ${fmtMoney(total)}${fallback ? ` · ${fallback}` : ''}` : (fallback ?? null),
              score: total,
              multiline: true,
            };
          },
        },
        {
          label: 'Skilled nursing',
          direction: 'lower',
          render: (p) => {
            const m = p.benefits.medical.snf;
            const ladder = formatInpatientLadder(m.description, m.copay, m.coinsurance);
            const { total, fallback } = ladderTotal(m.description, m.copay, m.coinsurance);
            return {
              text: ladder ?? 'Not filed',
              subtext: total != null ? `Total: ${fmtMoney(total)}${fallback ? ` · ${fallback}` : ''}` : (fallback ?? null),
              score: total,
              multiline: true,
            };
          },
        },
        {
          label: 'Outpatient surg. (hosp)',
          direction: 'lower',
          render: (p) => cs(p, (m) => m.outpatient_surgery_hospital),
        },
        {
          label: 'Outpatient surg. (ASC)',
          direction: 'lower',
          render: (p) => cs(p, (m) => m.outpatient_surgery_asc),
        },
      ],
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
  color: T.navyTextDim,
  fontFamily: F.label,
  fontSize: 11,
  fontWeight: 500,
  padding: '9px 14px',
  background: '#101B2E',
  display: 'flex',
  alignItems: 'center',
};
const CELL_VALUE: CSSProperties = {
  padding: '9px 10px',
  display: 'flex',
  alignItems: 'center',
};
const CELL_HEADER_LABEL: CSSProperties = {
  padding: '14px 14px 12px',
  background: '#0C1626',
};
const CELL_HEADER_PLAN: CSSProperties = {
  padding: '14px 12px 12px',
  minWidth: 0,
};

const SCORE_GREEN_BG = 'rgba(127,224,196,0.20)';
const SCORE_GREEN_FG = '#7FE0C4';
const SCORE_RED_BG = 'rgba(239,68,68,0.18)';
const SCORE_RED_FG = '#fca5a5';
