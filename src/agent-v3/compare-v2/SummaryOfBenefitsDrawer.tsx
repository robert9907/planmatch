// Summary of Benefits — side-by-side comparison across ALL plans
// currently on the 4-Up board (up to 4 columns). Replaces the earlier
// per-plan drawer that only showed one plan at a time; the broker
// needs to compare finalists against each other, not read them serially.
//
// Layout: a single CSS grid with a fixed 200px label column on the
// left and one flex column per plan. Section headers span every
// column. Values in each row line up vertically across plans so the
// broker can eyeball differences.
//
// Data policy — same as everything else in compare-v2: no new fetches.
// Every field reads off `plan.benefits.*`, `plan.drug_deductible`, or
// the existing per-plan DrugRow[] map. If drugBreakdown for a plan is
// missing, the medication section shows an em-dash for that column —
// see fix/preview-extras-and-sbs-comparison Part-3 report for why
// this happens (short version: pm_drug_ndc → pm_drug_cost_cache path
// falls back to formulary-only when the NDC bridge is empty, and
// pm_formulary.copay can be null for the same tier where cache-derived
// annual is populated).

import type { CSSProperties } from 'react';
import type { Plan } from '@/types/plans';
import { TOKENS as T, FONT as F } from './tokens';
import { PreviewDrawerShell } from './QuickPreviewDrawer';
import {
  planDisplay,
  formatCostShareWithRange,
  formatPcp,
  formatSpecialist,
} from '../planDisplay';
import { formatInpatientLadder } from '@/lib/inpatient-format';
import { formatOtc } from '@/lib/extractBenefitValue';

// Mirror of the DrugRow shape in CompareScreen.tsx. Kept local so this
// file doesn't reach up into the parent for a type.
interface DrugRow {
  rxcui: string;
  name: string;
  covered: boolean;
  tier: number | null;
  monthlyCopay: number | null;
  annualCost: number;
}

export interface SummaryOfBenefitsDrawerProps {
  /** Every plan currently on the 4-Up board (up to 4). Null slots are
   *  filtered out before render. */
  plans: ReadonlyArray<Plan>;
  onClose: () => void;
  /** Per-plan drug breakdown map from the brain. Look up per column. */
  drugBreakdownByPlanId?: Record<string, ReadonlyArray<DrugRow>>;
}

export function SummaryOfBenefitsDrawer(props: SummaryOfBenefitsDrawerProps) {
  const { plans, onClose, drugBreakdownByPlanId } = props;

  if (plans.length === 0) return null;

  const n = plans.length;
  // 200px label column + N minmax(180px, 1fr) plan columns. If N is
  // 4 and the viewport is narrow, the outer scroll container handles
  // overflow so nothing gets squeezed unreadable.
  const gridCols = `200px repeat(${n}, minmax(180px, 1fr))`;

  // Union of every user drug across the selected plans, keyed by the
  // FIRST plan that files a row for that rxcui. Preserves brain
  // ordering (all plans share the same drug order per the userProfile
  // input, so the first-hit dictates position). Uncovered drugs still
  // appear as rows so the broker can see "plan A won't fill this."
  const drugOrder = buildDrugRowOrder(plans, drugBreakdownByPlanId);
  const hasAnyMeds = drugOrder.length > 0;

  return (
    <PreviewDrawerShell
      title={`Summary of benefits · ${n} plan${n === 1 ? '' : 's'}`}
      subtitle="Side-by-side comparison of every finalist currently on the board"
      contractLabel={null}
      sbfUrl={null}
      onClose={onClose}
      footer={null}
    >
      <div
        style={{
          overflowX: 'auto',
          padding: '0 0 4px',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: gridCols,
            minWidth: 200 + n * 180,
          }}
        >
          <PlanIdentityHeaderRow plans={plans} />

          <SectionHeader label="Provider &amp; care" span={n + 1} />
          <ComparisonRow
            label="PCP copay"
            values={plans.map((p) => formatPcp(p))}
          />
          <ComparisonRow
            label="Specialist"
            values={plans.map((p) => formatSpecialist(p))}
          />
          <ComparisonRow
            label="Urgent care"
            values={plans.map((p) =>
              formatCostShareWithRange(p.benefits.medical.urgent_care, {
                isPdp: p.plan_type === 'PDP',
              }),
            )}
          />
          <ComparisonRow
            label="Emergency"
            values={plans.map((p) =>
              formatCostShareWithRange(p.benefits.medical.emergency, {
                isPdp: p.plan_type === 'PDP',
              }),
            )}
          />
          <ComparisonRow
            label="Telehealth"
            values={plans.map((p) =>
              formatCostShareWithRange(p.benefits.medical.telehealth, {
                isPdp: p.plan_type === 'PDP',
              }),
            )}
          />

          <SectionHeader label="Hospital" span={n + 1} />
          <ComparisonRow
            label="Inpatient"
            values={plans.map(
              (p) =>
                formatInpatientLadder(
                  p.benefits.medical.inpatient.description,
                  p.benefits.medical.inpatient.copay,
                  p.benefits.medical.inpatient.coinsurance,
                ) ?? '—',
            )}
            multiline
          />
          <ComparisonRow
            label="Inpatient mental"
            values={plans.map(
              (p) =>
                formatInpatientLadder(
                  p.benefits.medical.mental_health_inpatient.description,
                  p.benefits.medical.mental_health_inpatient.copay,
                  p.benefits.medical.mental_health_inpatient.coinsurance,
                ) ?? '—',
            )}
            multiline
          />
          <ComparisonRow
            label="Skilled nursing"
            values={plans.map(
              (p) =>
                formatInpatientLadder(
                  p.benefits.medical.snf.description,
                  p.benefits.medical.snf.copay,
                  p.benefits.medical.snf.coinsurance,
                ) ?? '—',
            )}
            multiline
          />
          <ComparisonRow
            label="Outpatient surg. (hosp)"
            values={plans.map((p) =>
              formatCostShareWithRange(
                p.benefits.medical.outpatient_surgery_hospital,
                { isPdp: p.plan_type === 'PDP' },
              ),
            )}
          />
          <ComparisonRow
            label="Outpatient surg. (ASC)"
            values={plans.map((p) =>
              formatCostShareWithRange(p.benefits.medical.outpatient_surgery_asc, {
                isPdp: p.plan_type === 'PDP',
              }),
            )}
          />

          <SectionHeader label="Rx &amp; pharmacy" span={n + 1} />
          <ComparisonRow
            label="Part D deductible"
            values={plans.map((p) =>
              p.drug_deductible == null ? '—' : `$${p.drug_deductible}`,
            )}
          />
          {(
            [
              { label: 'Tier 1', get: (p: Plan) => p.benefits.rx_tiers.tier_1 },
              { label: 'Tier 2', get: (p: Plan) => p.benefits.rx_tiers.tier_2 },
              { label: 'Tier 3', get: (p: Plan) => p.benefits.rx_tiers.tier_3 },
              { label: 'Tier 4', get: (p: Plan) => p.benefits.rx_tiers.tier_4 },
              { label: 'Tier 5', get: (p: Plan) => p.benefits.rx_tiers.tier_5 },
            ] as const
          ).map(({ label, get }) => (
            <ComparisonRow
              key={label}
              label={label}
              values={plans.map((p) =>
                formatCostShareWithRange(get(p), { isPdp: p.plan_type === 'PDP' }),
              )}
            />
          ))}
          {plans.some((p) => p.benefits.rx_tiers.tier_6) && (
            <ComparisonRow
              label="Tier 6"
              values={plans.map((p) =>
                p.benefits.rx_tiers.tier_6
                  ? formatCostShareWithRange(p.benefits.rx_tiers.tier_6, {
                      isPdp: p.plan_type === 'PDP',
                    })
                  : '—',
              )}
            />
          )}

          <SectionHeader label="Extras" span={n + 1} />
          <ComparisonRow
            label="Dental"
            values={plans.map((p) => planDisplay(p).dentalMax)}
          />
          <ComparisonRow
            label="Vision"
            values={plans.map((p) => planDisplay(p).visionAllowance)}
          />
          <ComparisonRow
            label="OTC / qtr"
            values={plans.map((p) =>
              formatOtc(
                p.benefits.otc.allowance_per_quarter,
                p.benefits.otc.description,
              ),
            )}
          />
          <ComparisonRow
            label="Healthy food card"
            values={plans.map((p) => planDisplay(p).meals)}
          />
          <ComparisonRow
            label="Fitness"
            values={plans.map((p) => planDisplay(p).fitness)}
          />
          <ComparisonRow
            label="Hearing"
            values={plans.map((p) => planDisplay(p).hearing)}
          />
          <ComparisonRow
            label="Transportation"
            values={plans.map((p) => planDisplay(p).transport)}
          />
          <ComparisonRow
            label="Part B giveback"
            values={plans.map((p) =>
              p.part_b_giveback > 0 ? `$${p.part_b_giveback}/mo` : '—',
            )}
          />

          {hasAnyMeds && (
            <>
              <SectionHeader
                label="Medication cost breakdown"
                span={n + 1}
                subtitle="Monthly · quarterly · annual per plan. Uncovered drugs excluded from totals."
              />
              {drugOrder.map((drug) => (
                <MedRow
                  key={drug.rxcui || drug.name}
                  drug={drug}
                  plans={plans}
                  drugBreakdownByPlanId={drugBreakdownByPlanId}
                />
              ))}
              <MedTotalsRow
                plans={plans}
                drugBreakdownByPlanId={drugBreakdownByPlanId}
              />
            </>
          )}
        </div>
      </div>
    </PreviewDrawerShell>
  );
}

// ─── Plan-identity header row ───────────────────────────────────────

function PlanIdentityHeaderRow({ plans }: { plans: ReadonlyArray<Plan> }) {
  return (
    <>
      <div
        style={{
          gridColumn: 1,
          padding: '14px 18px 10px',
          background: '#0C1626',
          borderBottom: `1px solid ${T.navyLine}`,
        }}
      />
      {plans.map((p, i) => (
        <div
          key={i}
          style={{
            gridColumn: i + 2,
            padding: '14px 14px 10px',
            background: '#0C1626',
            borderBottom: `1px solid ${T.navyLine}`,
            borderLeft: i === 0 ? 'none' : `1px solid ${T.navyLine}`,
            minWidth: 0,
          }}
        >
          <div
            style={{
              fontFamily: F.label,
              fontSize: 9.5,
              fontWeight: 700,
              color: T.mintOnDark,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              marginBottom: 3,
            }}
          >
            {p.carrier}
          </div>
          <div
            style={{
              fontFamily: F.label,
              fontSize: 12,
              fontWeight: 700,
              color: '#FFFFFF',
              lineHeight: 1.25,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              wordBreak: 'break-word',
            }}
            title={p.plan_name ?? ''}
          >
            {planCleanName(p)}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              marginTop: 4,
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                fontFamily: F.num,
                fontSize: 9.5,
                color: 'rgba(255,255,255,0.55)',
                letterSpacing: 0.5,
              }}
            >
              {planContract(p)}
            </span>
            {p.sbf_url && (
              <a
                href={p.sbf_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={{
                  color: T.mintOnDark,
                  textDecoration: 'none',
                  fontFamily: F.label,
                  fontWeight: 700,
                  fontSize: 9,
                  background: 'rgba(127,224,196,0.18)',
                  padding: '2px 6px',
                  borderRadius: 3,
                  letterSpacing: 0.3,
                }}
                title="Summary of Benefits (source PDF)"
              >
                📄 SBF ↗
              </a>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

// ─── Section header + comparison row ────────────────────────────────

function SectionHeader({
  label,
  span,
  subtitle,
}: {
  label: string;
  span: number;
  subtitle?: string;
}) {
  return (
    <div
      style={{
        gridColumn: `1 / ${span + 1}`,
        padding: '12px 18px 6px',
        borderTop: `1px solid ${T.navyLine}`,
        background: '#0C1626',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <span
        style={{
          fontFamily: F.label,
          fontSize: 10,
          fontWeight: 700,
          color: T.mintOnDark,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        {label}
      </span>
      {subtitle && (
        <span
          style={{
            fontFamily: F.label,
            fontSize: 10,
            color: T.navyTextMuted,
          }}
        >
          {subtitle}
        </span>
      )}
    </div>
  );
}

function ComparisonRow({
  label,
  values,
  multiline,
}: {
  label: string;
  values: ReadonlyArray<string>;
  multiline?: boolean;
}) {
  return (
    <>
      <div style={{ ...LABEL_CELL, ...(multiline && { alignItems: 'flex-start' }) }}>
        {label}
      </div>
      {values.map((v, i) => (
        <div
          key={i}
          style={{
            ...VALUE_CELL,
            borderLeft: i === 0 ? 'none' : `1px solid ${T.navyLine}`,
            whiteSpace: multiline ? 'pre-line' : 'nowrap',
            alignItems: multiline ? 'flex-start' : 'baseline',
            lineHeight: multiline ? 1.35 : 1.2,
          }}
          title={v}
        >
          {v}
        </div>
      ))}
    </>
  );
}

// ─── Medication rows ────────────────────────────────────────────────

interface DrugRowEntry {
  rxcui: string;
  name: string;
}

function buildDrugRowOrder(
  plans: ReadonlyArray<Plan>,
  byPlan: Record<string, ReadonlyArray<DrugRow>> | undefined,
): DrugRowEntry[] {
  if (!byPlan) return [];
  const seen = new Set<string>();
  const order: DrugRowEntry[] = [];
  for (const p of plans) {
    const rows = byPlan[p.id];
    if (!rows) continue;
    for (const r of rows) {
      const key = r.rxcui || r.name;
      if (seen.has(key)) continue;
      seen.add(key);
      order.push({ rxcui: r.rxcui, name: r.name });
    }
  }
  return order;
}

function findDrugRow(
  plan: Plan,
  drug: DrugRowEntry,
  byPlan: Record<string, ReadonlyArray<DrugRow>> | undefined,
): DrugRow | null {
  const rows = byPlan?.[plan.id];
  if (!rows) return null;
  return (
    rows.find((r) => (drug.rxcui && r.rxcui === drug.rxcui) || r.name === drug.name) ??
    null
  );
}

function MedRow({
  drug,
  plans,
  drugBreakdownByPlanId,
}: {
  drug: DrugRowEntry;
  plans: ReadonlyArray<Plan>;
  drugBreakdownByPlanId?: Record<string, ReadonlyArray<DrugRow>>;
}) {
  return (
    <>
      <div style={{ ...LABEL_CELL, alignItems: 'flex-start' }} title={drug.name}>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            display: 'block',
          }}
        >
          {drug.name}
        </span>
      </div>
      {plans.map((p, i) => {
        const row = findDrugRow(p, drug, drugBreakdownByPlanId);
        return (
          <div
            key={i}
            style={{
              ...VALUE_CELL,
              borderLeft: i === 0 ? 'none' : `1px solid ${T.navyLine}`,
              alignItems: 'flex-start',
              flexDirection: 'column',
              gap: 2,
              padding: '8px 14px',
              lineHeight: 1.3,
            }}
          >
            {row == null ? (
              <span style={{ color: T.navyTextMuted }}>—</span>
            ) : !row.covered ? (
              <span
                style={{
                  background: 'rgba(239,68,68,0.18)',
                  color: '#fca5a5',
                  fontFamily: F.label,
                  fontSize: 9,
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: 3,
                  letterSpacing: 0.3,
                }}
              >
                Not covered
              </span>
            ) : (
              <MedCellNumbers row={row} />
            )}
          </div>
        );
      })}
    </>
  );
}

function MedCellNumbers({ row }: { row: DrugRow }) {
  const tierLabel = row.tier != null ? `Tier ${row.tier}` : 'Tier —';
  const monthly = row.monthlyCopay;
  const quarterly = monthly == null ? null : monthly * 3;
  const annual = row.annualCost;
  return (
    <>
      <span
        style={{
          fontFamily: F.label,
          fontSize: 9.5,
          fontWeight: 700,
          color: T.navyTextMuted,
          letterSpacing: 0.3,
          textTransform: 'uppercase',
        }}
      >
        {tierLabel}
      </span>
      <span style={{ fontFamily: F.num, fontSize: 11, color: '#EAF0F6' }}>
        {monthly == null ? '—' : fmtDollars(monthly)}
        {' · '}
        {quarterly == null ? '—' : fmtDollars(quarterly)}
        {' · '}
        <span style={{ color: T.mintOnDark, fontWeight: 700 }}>
          {fmtDollars(annual)}
        </span>
      </span>
      <span
        style={{
          fontFamily: F.label,
          fontSize: 9,
          color: T.navyTextMuted,
          letterSpacing: 0.2,
        }}
      >
        mo · qtr · yr
      </span>
    </>
  );
}

function MedTotalsRow({
  plans,
  drugBreakdownByPlanId,
}: {
  plans: ReadonlyArray<Plan>;
  drugBreakdownByPlanId?: Record<string, ReadonlyArray<DrugRow>>;
}) {
  return (
    <>
      <div
        style={{
          ...LABEL_CELL,
          borderTop: `1px solid ${T.navyLine}`,
          color: '#FFFFFF',
          fontWeight: 700,
        }}
      >
        Total (covered)
      </div>
      {plans.map((p, i) => {
        const rows = (drugBreakdownByPlanId?.[p.id] ?? []).filter((r) => r.covered);
        const monthly = rows.reduce((s, r) => s + (r.monthlyCopay ?? 0), 0);
        const quarterly = monthly * 3;
        const annual = rows.reduce((s, r) => s + r.annualCost, 0);
        const filedMonthlyCount = rows.filter((r) => r.monthlyCopay != null).length;
        const asterisk = filedMonthlyCount < rows.length; // some drug's monthlyCopay was null
        return (
          <div
            key={i}
            style={{
              ...VALUE_CELL,
              borderLeft: i === 0 ? 'none' : `1px solid ${T.navyLine}`,
              borderTop: `1px solid ${T.navyLine}`,
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 2,
              padding: '10px 14px',
              lineHeight: 1.3,
            }}
          >
            <span style={{ fontFamily: F.num, fontSize: 11, color: '#FFFFFF', fontWeight: 700 }}>
              {fmtDollars(monthly)}
              {asterisk && '*'}
              {' · '}
              {fmtDollars(quarterly)}
              {asterisk && '*'}
              {' · '}
              <span style={{ color: T.mintOnDark }}>{fmtDollars(annual)}</span>
            </span>
            {asterisk && (
              <span
                style={{
                  fontFamily: F.label,
                  fontSize: 9,
                  color: T.navyTextMuted,
                }}
                title="Some drugs on this plan file annual cost but no per-fill copay — monthly / quarterly totals are undercounted"
              >
                * excludes drugs without a filed monthly copay
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

// ─── Style constants ────────────────────────────────────────────────

const LABEL_CELL: CSSProperties = {
  gridColumn: 1,
  padding: '8px 18px',
  fontFamily: F.label,
  fontSize: 11.5,
  color: T.navyTextMuted,
  borderTop: `1px solid ${T.navyRow}`,
  display: 'flex',
  alignItems: 'baseline',
  minWidth: 0,
};

const VALUE_CELL: CSSProperties = {
  padding: '8px 14px',
  fontFamily: F.num,
  fontSize: 11.5,
  color: '#EAF0F6',
  fontWeight: 500,
  borderTop: `1px solid ${T.navyRow}`,
  display: 'flex',
  alignItems: 'baseline',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

// ─── Helpers ────────────────────────────────────────────────────────

function fmtDollars(n: number): string {
  const v = Math.round(n);
  return `$${v.toLocaleString('en-US')}`;
}

function planCleanName(plan: Plan): string {
  const carrier = plan.carrier ?? '';
  const name = plan.plan_name ?? '';
  return carrier && name.toLowerCase().startsWith(carrier.toLowerCase())
    ? name.slice(carrier.length).trim()
    : name;
}

function planContract(plan: Plan): string | null {
  const [contract, planNum, seg] = plan.id.split('-');
  if (!contract || !planNum) return null;
  const segNorm = (seg ?? '0').replace(/^0+/, '') || '0';
  return `${contract}-${planNum}-${segNorm}`;
}

