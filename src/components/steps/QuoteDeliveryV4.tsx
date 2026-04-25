// QuoteDeliveryV4 — column-per-plan side-by-side comparison table.
//
// Faithful port of the mockup at planmatch-full-flow.html (the
// `#quote` page, styles `.qt`, `.qh`, `.cb`, `.wb`, `.wh`, `.ti`,
// `.d.s`, `.d.m`, `.bl`, `.ws`, `.act-cell`, `.abtn`).
//
// Columns:
//   1. Left header — sticky, gray bg, holds row labels and section
//      headers ("Your Medications", "Plan Costs", "Extra Benefits").
//   2. Current Plan (gray `cb` bg) — pinned left when the session
//      knows the client's existing plan id (annual review / hydrated
//      client). Drops out gracefully when no current plan is known.
//   3. Best Rx Match (navy `wb` bg) — the highest-composite finalist
//      from Plan Brain. The "winner column" gets the navy hero
//      treatment plus a `.wb` background tint on every cell.
//   4–N. Remaining finalists ranked by composite, capped at 4 plan
//      columns total (so the table never exceeds the mockup's width).
//
// Rows mirror the mockup:
//   • Header card per column (carrier · plan name · H-id · stars).
//   • "Your Medications" section header → one row per medication
//     (tier badge + price + delta vs current + PA/ST flags).
//   • "Total Rx Cost" total row.
//   • Provider divider row (one per added provider) with the
//     ●In-Net / ●Out indicator.
//   • Medical copay rows: PCP / Specialist / Labs / Imaging /
//     ER / Urgent / Outpatient Surgery / Mental Health / PT-OT /
//     Inpatient.
//   • "Plan Costs" section: Premium / MOOP / Rx Deductible.
//   • "Extra Benefits" section: Dental / OTC / Food Card / Giveback.
//   • Navy summary bar — Total Annual Value (estimated total annual
//     cost minus extras value) with savings delta vs the current
//     plan; "Why switch?" bullet derived from the plan's ribbon +
//     biggest deltas.
//   • Action row — Recommend (or Keep Current for the current
//     column) and Open SunFire per column.
//
// Plan Brain composite score determines column position. The
// Recommend toggle wires through to the parent (recommendation
// state lives in the session via Step6QuoteDelivery).

import { useMemo } from 'react';
import type { Plan } from '@/types/plans';
import type { Client, Medication, Provider } from '@/types/session';
import { useSession } from '@/hooks/useSession';
import { usePlanBrain } from '@/hooks/usePlanBrain';
import { findPlan } from '@/lib/cmsPlans';
import type {
  PlanBrainData,
  RibbonKey,
  ScoredPlan,
} from '@/lib/plan-brain-types';

const SUNFIRE_URL =
  'https://www.sunfirematrix.com/app/consumer/yourmedicare/10447418';

const MAX_FINALIST_COLUMNS = 4;

const RIBBON_LABEL: Record<RibbonKey, string> = {
  BEST_OVERALL:        '⭐ Best overall',
  LOWEST_DRUG_COST:    '⭐ Best Rx Match',
  LOWEST_OOP:          'Lowest OOP',
  BEST_EXTRAS:         'Best extras',
  ALL_DOCS_IN_NETWORK: 'All in-network',
  PART_B_SAVINGS:      'Part B giveback',
  ZERO_PREMIUM:        '$0 premium',
  ALL_MEDS_COVERED:    'All meds covered',
};

// Scoped CSS — mirrors the mockup variable names but namespaced under
// `.qv4` so it can't bleed into the rest of the v4 chrome.
const CSS = `
.qv4 {
  --qv4-navy:#0d2f5e; --qv4-navy-lt:#1a4a8a; --qv4-navy-dk:#091f3f;
  --qv4-sea:#83f0f9;  --qv4-sea-dim:rgba(131,240,249,0.1);
  --qv4-w:#fff;
  --qv4-g50:#f8f9fa; --qv4-g100:#f1f3f5; --qv4-g200:#e9ecef;
  --qv4-g300:#dee2e6; --qv4-g400:#ced4da; --qv4-g500:#adb5bd;
  --qv4-g600:#868e96; --qv4-g700:#495057; --qv4-g800:#343a40; --qv4-g900:#212529;
  --qv4-grn:#1a9c55; --qv4-grn-bg:rgba(46,204,113,0.08); --qv4-grn-bdr:rgba(46,204,113,0.2);
  --qv4-red:#d63031; --qv4-red-bg:rgba(231,76,60,0.06); --qv4-red-bdr:rgba(231,76,60,0.2);
  --qv4-amb:#e67e22; --qv4-amb-bg:rgba(243,156,18,0.08);
  --qv4-fb:'Inter',system-ui,sans-serif;
  --qv4-fm:'JetBrains Mono',monospace;
  --qv4-fd:'Fraunces',Georgia,serif;
  font-family: var(--qv4-fb);
  color: var(--qv4-g900); font-size: 12px;
  -webkit-font-smoothing: antialiased;
}
.qv4 *, .qv4 *::before, .qv4 *::after { box-sizing: border-box; }

.qv4-qwrap { overflow-x: auto; padding: 0 0 12px; }
.qv4 table.qt { border-collapse: collapse; width: 100%; min-width: 1100px; }
.qv4 .qt th, .qv4 .qt td {
  padding: 7px 12px; text-align: left; vertical-align: middle;
  border-bottom: 1px solid var(--qv4-g100); font-size: 12px; white-space: nowrap;
}
.qv4 .qt .lc {
  position: sticky; left: 0; z-index: 5; background: var(--qv4-g50);
  font-weight: 500; color: var(--qv4-g600); min-width: 160px; white-space: normal;
}
.qv4 .qt th.qh {
  padding: 12px; border-bottom: 1px solid var(--qv4-g200);
  vertical-align: top; font-weight: 400; min-width: 210px;
}
.qv4 .qt th.qh.cb { background: var(--qv4-g200); }
.qv4 .qt th.qh.wb { background: var(--qv4-navy); color: var(--qv4-w); }
.qv4 .qt td { font-family: var(--qv4-fm); font-size: 12px; color: var(--qv4-g800); }
.qv4 .qt td.cb { background: var(--qv4-g100); }
.qv4 .qt td.wb { background: rgba(131,240,249,0.04); }
.qv4 .qt td.wh { color: var(--qv4-navy); font-weight: 700; }

.qv4 .qt tr.sh td, .qv4 .qt tr.sh th {
  font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--qv4-navy); padding-top: 12px; padding-bottom: 4px;
  border-bottom: 2px solid var(--qv4-navy); background: var(--qv4-g50);
  font-family: var(--qv4-fb);
}
.qv4 .qt tr.sh td.cb { background: var(--qv4-g100); }
.qv4 .qt tr.sh td.wb { background: rgba(131,240,249,0.04); }

.qv4 .qt tr.tot td, .qv4 .qt tr.tot th {
  font-weight: 700; border-bottom: 2px solid var(--qv4-g300); padding: 8px 12px;
}
.qv4 .qt tr.tot th { background: var(--qv4-g100); color: var(--qv4-g900); }

.qv4 .qt tr.bl td, .qv4 .qt tr.bl th {
  background: var(--qv4-navy); color: var(--qv4-w);
  border-bottom: none; padding: 10px 12px;
}
.qv4 .qt tr.ws td {
  background: var(--qv4-navy); color: rgba(255,255,255,0.6);
  font-size: 10px; font-weight: 400; font-family: var(--qv4-fb);
  border-bottom: none; padding: 2px 12px 10px; white-space: normal; max-width: 240px;
}
.qv4 .qt tr.ws th {
  background: var(--qv4-navy); color: rgba(255,255,255,0.5);
  font-size: 10px; font-weight: 400; border-bottom: none;
}

.qv4 .ptag2  { font-size: 9px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--qv4-g500); margin-bottom: 2px; }
.qv4 .wtag2  { font-size: 9px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--qv4-sea); margin-bottom: 2px; }
.qv4 .pcar2  { font-size: 10px; color: var(--qv4-g500); font-weight: 500; }
.qv4 .qh.wb .pcar2 { color: rgba(255,255,255,0.5); }
.qv4 .pn2 { font-family: var(--qv4-fd); font-size: 13px; font-weight: 600;
  color: var(--qv4-g900); line-height: 1.2; }
.qv4 .qh.wb .pn2 { color: var(--qv4-w); }
.qv4 .qh.cb .pn2 { color: var(--qv4-g700); }
.qv4 .pm2 { display: flex; gap: 5px; margin-top: 3px; align-items: center; }
.qv4 .pid2 { font-family: var(--qv4-fm); font-size: 9px; color: var(--qv4-g500); }
.qv4 .qh.wb .pid2 { color: rgba(255,255,255,0.4); }
.qv4 .star2 { font-size: 9px; font-weight: 600; color: var(--qv4-amb); }
.qv4 .qh.wb .star2 { color: var(--qv4-sea); }

.qv4 .ti { display: inline-flex; align-items: center; justify-content: center;
  width: 17px; height: 17px; border-radius: 3px;
  font-size: 9px; font-weight: 700; font-family: var(--qv4-fm); margin-right: 3px; }
.qv4 .ti.t1, .qv4 .ti.t2, .qv4 .ti.t6 { background: #d4edda; color: #155724; }
.qv4 .ti.t3 { background: #fff3cd; color: #856404; }
.qv4 .ti.t4, .qv4 .ti.t5 { background: #f8d7da; color: #721c24; }

.qv4 .d { font-size: 9px; font-weight: 700; padding: 1px 4px; border-radius: 3px;
  margin-left: 3px; font-family: var(--qv4-fm); }
.qv4 .d.s { background: rgba(46,204,113,0.08); color: var(--qv4-grn);
  border: 1px solid var(--qv4-grn-bdr); }
.qv4 .d.m { background: rgba(231,76,60,0.05); color: var(--qv4-red);
  border: 1px solid var(--qv4-red-bdr); }

.qv4 .prov-in2  { color: var(--qv4-grn); font-weight: 700;
  font-family: var(--qv4-fb); font-size: 11px; }
.qv4 .prov-out2 { color: var(--qv4-red); font-weight: 700;
  font-family: var(--qv4-fb); font-size: 11px; }
.qv4 .prov-unk2 { color: var(--qv4-g500); font-weight: 600;
  font-family: var(--qv4-fb); font-size: 11px; }

.qv4 .fl { display: inline-flex; gap: 2px; margin-left: 3px; }
.qv4 .fg { font-size: 7px; font-weight: 700; padding: 1px 3px; border-radius: 2px;
  background: var(--qv4-amb-bg); color: #b8860b; font-family: var(--qv4-fm); }

.qv4 .act-cell { padding: 8px 12px; vertical-align: top; }
.qv4 .abtn { display: block; width: 100%; padding: 8px; border-radius: 7px;
  border: none; font-family: var(--qv4-fb); font-size: 11px; font-weight: 600;
  cursor: pointer; text-align: center; margin-bottom: 4px; }
.qv4 .abtn.rec  { background: var(--qv4-navy); color: var(--qv4-w); }
.qv4 .abtn.rec:hover { background: var(--qv4-navy-lt); }
.qv4 .abtn.rec.sea { background: var(--qv4-sea); color: var(--qv4-navy); }
.qv4 .abtn.rec.sea:hover { background: #6de8f2; }
.qv4 .abtn.sec  { background: var(--qv4-g100); color: var(--qv4-g700);
  border: 1px solid var(--qv4-g200); }
.qv4 .abtn.sec:hover { background: var(--qv4-g200); }

.qv4 .sub { font-size: 10px; color: var(--qv4-g500); font-weight: 400; }
.qv4-loading, .qv4-empty { padding: 28px; text-align: center; color: var(--qv4-g600);
  font-size: 13px; background: #fff; border: 1px dashed var(--qv4-g200);
  border-radius: 12px; }
`;

interface Props {
  finalists: Plan[];
  client: Client;
  medications: Medication[];
  providers: Provider[];
  recommendation?: string | null;
  onRecommend?: (id: string | null) => void;
}

interface ColumnPlan {
  plan: Plan;
  scored: ScoredPlan | null;   // null when this is the current-plan column
  /** Render flavor — cb (current/gray), wb (winner/navy), or none. */
  variant: 'current' | 'winner' | 'normal';
  ribbon: RibbonKey | null;
}

export function QuoteDeliveryV4({
  finalists,
  client,
  medications,
  providers,
  recommendation,
  onRecommend,
}: Props) {
  const currentPlanId = useSession((s) => s.currentPlanId);

  // Plan Brain feeds composite ranking + per-axis scores. data exposes
  // the raw per-drug / per-network rows so we can render exact dollar
  // numbers in each cell instead of just the composite.
  const { result, data, loading } = usePlanBrain({
    plans: finalists,
    client,
    medications,
    providers,
  });

  const currentPlan = useMemo<Plan | null>(
    () => (currentPlanId ? findPlan(currentPlanId) : null),
    [currentPlanId],
  );

  // ─── Column ordering ────────────────────────────────────────────
  // Mockup pattern:
  //   col 0 (sticky labels)
  //   col 1 = current plan (gray) — drops out if no current
  //   col 2 = winner (navy)        — top composite
  //   col 3..N = next finalists by composite
  // We cap total *plan* columns at MAX_FINALIST_COLUMNS so the table
  // never exceeds the mockup's width.
  const columns = useMemo<ColumnPlan[]>(() => {
    const cols: ColumnPlan[] = [];
    if (currentPlan) {
      const inFinalist = result?.scored.find((s) => s.plan.id === currentPlan.id) ?? null;
      cols.push({
        plan: currentPlan,
        scored: inFinalist,
        variant: 'current',
        ribbon: null,
      });
    }
    const ranked = result ? [...result.scored].sort((a, b) => b.composite - a.composite) : [];
    for (const s of ranked) {
      if (cols.length >= MAX_FINALIST_COLUMNS) break;
      // Skip the current plan when it's already pinned left.
      if (currentPlan && s.plan.id === currentPlan.id) continue;
      cols.push({
        plan: s.plan,
        scored: s,
        // First non-current column gets the winner treatment.
        variant: cols.every((c) => c.variant !== 'winner') ? 'winner' : 'normal',
        ribbon: s.ribbon,
      });
    }
    return cols;
  }, [currentPlan, result]);

  if (loading && !result) {
    return (
      <div className="qv4">
        <style>{CSS}</style>
        <div className="qv4-loading">Plan Brain scoring plans…</div>
      </div>
    );
  }

  if (columns.length === 0) {
    return (
      <div className="qv4">
        <style>{CSS}</style>
        <div className="qv4-empty">
          No plans to compare yet. Complete steps 2–5 so Plan Brain has finalists to rank.
        </div>
      </div>
    );
  }

  // The current column is the cost benchmark for delta badges.
  const currentCol = columns.find((c) => c.variant === 'current') ?? null;
  const baseline = currentCol?.plan ?? null;

  return (
    <div className="qv4">
      <style>{CSS}</style>

      <div className="qv4-qwrap">
        <table className="qt">
          <thead>
            <tr>
              <th
                className="lc"
                style={{
                  fontFamily: 'var(--qv4-fd)',
                  fontSize: 15,
                  fontWeight: 700,
                  color: 'var(--qv4-navy)',
                  padding: 12,
                }}
              >
                Quote Comparison
              </th>
              {columns.map((c) => (
                <ColumnHeader key={c.plan.id} col={c} />
              ))}
            </tr>
          </thead>
          <tbody>
            {/* ── Medications ─────────────────────────────────────── */}
            <SectionRow label="Your Medications" cols={columns} />
            {medications.length === 0 ? (
              <tr>
                <th className="lc" style={{ fontStyle: 'italic', color: 'var(--qv4-g500)' }}>
                  No medications added
                </th>
                {columns.map((c) => (
                  <td key={c.plan.id} className={cellCls(c)}>
                    —
                  </td>
                ))}
              </tr>
            ) : (
              medications.map((m) => (
                <MedicationRow
                  key={m.id}
                  medication={m}
                  cols={columns}
                  data={data}
                  baseline={baseline}
                />
              ))
            )}
            <TotalRxRow cols={columns} medications={medications} data={data} />

            {/* ── Provider divider rows ───────────────────────────── */}
            {providers.map((pr) => (
              <ProviderRow key={pr.id} provider={pr} cols={columns} />
            ))}

            {/* ── Medical copays ──────────────────────────────────── */}
            {MEDICAL_ROWS.map((row) => (
              <CopayRow
                key={row.label}
                row={row}
                cols={columns}
                baseline={baseline}
              />
            ))}

            {/* ── Plan Costs ──────────────────────────────────────── */}
            <SectionRow label="Plan Costs" cols={columns} />
            <PlanCostRow
              label="Premium"
              cols={columns}
              fmt={(p) => `$${p.premium}/mo`}
              raw={(p) => p.premium}
              baseline={baseline}
              betterIsLower
              suffix="/mo"
            />
            <PlanCostRow
              label="MOOP"
              cols={columns}
              fmt={(p) => `$${p.moop_in_network.toLocaleString()}`}
              raw={(p) => p.moop_in_network}
              baseline={baseline}
              betterIsLower
            />
            <PlanCostRow
              label="Rx Deductible"
              cols={columns}
              fmt={(p) => (p.drug_deductible == null ? '—' : `$${p.drug_deductible}`)}
              raw={(p) => p.drug_deductible ?? 0}
              baseline={baseline}
              betterIsLower
            />

            {/* ── Extra Benefits ──────────────────────────────────── */}
            <SectionRow label="Extra Benefits" cols={columns} />
            <PlanCostRow
              label="Dental"
              cols={columns}
              fmt={(p) =>
                p.benefits.dental.annual_max > 0
                  ? `$${p.benefits.dental.annual_max.toLocaleString()}/yr`
                  : '—'
              }
              raw={(p) => p.benefits.dental.annual_max}
              baseline={baseline}
              betterIsLower={false}
            />
            <PlanCostRow
              label="OTC"
              cols={columns}
              fmt={(p) =>
                p.benefits.otc.allowance_per_quarter > 0
                  ? `$${p.benefits.otc.allowance_per_quarter}/qtr`
                  : '—'
              }
              raw={(p) => p.benefits.otc.allowance_per_quarter}
              baseline={baseline}
              betterIsLower={false}
              annualMultiplier={4}
            />
            <PlanCostRow
              label="Food Card"
              cols={columns}
              fmt={(p) =>
                p.benefits.food_card.allowance_per_month > 0
                  ? `$${p.benefits.food_card.allowance_per_month}/mo`
                  : '—'
              }
              raw={(p) => p.benefits.food_card.allowance_per_month}
              baseline={baseline}
              betterIsLower={false}
              annualMultiplier={12}
            />
            <PlanCostRow
              label="Giveback"
              cols={columns}
              fmt={(p) =>
                (p.part_b_giveback ?? 0) > 0 ? `$${p.part_b_giveback}/mo` : '—'
              }
              raw={(p) => p.part_b_giveback ?? 0}
              baseline={baseline}
              betterIsLower={false}
              annualMultiplier={12}
            />

            {/* ── Total Annual Value ──────────────────────────────── */}
            <TotalAnnualRow cols={columns} baseline={baseline} />
            <WhySwitchRow cols={columns} baseline={baseline} />

            {/* ── Action row ──────────────────────────────────────── */}
            <tr>
              <th className="lc"></th>
              {columns.map((c) => {
                const isCurrent = c.variant === 'current';
                const isRecommended = recommendation === c.plan.id;
                return (
                  <td key={c.plan.id} className={`act-cell ${cellClsBare(c)}`}>
                    {isCurrent ? (
                      <button type="button" className="abtn sec">Keep Current</button>
                    ) : (
                      <button
                        type="button"
                        className={`abtn rec${c.variant === 'winner' && !isRecommended ? ' sea' : ''}`}
                        onClick={() =>
                          onRecommend?.(isRecommended ? null : c.plan.id)
                        }
                      >
                        {isRecommended ? '✓ Recommended' : c.variant === 'winner' ? '✓ Recommend' : 'Recommend'}
                      </button>
                    )}
                    <a
                      className="abtn sec"
                      href={SUNFIRE_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ textDecoration: 'none' }}
                    >
                      Open SunFire →
                    </a>
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      {result && client.county && (
        <div style={{ padding: '4px 0 0', fontSize: 10, color: 'var(--qv4-g500)' }}>
          Plan Brain · population {result.population.toUpperCase()} · utilization {result.utilization} · {client.county}, {client.state}
        </div>
      )}
    </div>
  );
}

// ─── Header ───────────────────────────────────────────────────────────

function ColumnHeader({ col }: { col: ColumnPlan }) {
  const cls = `qh ${col.variant === 'current' ? 'cb' : col.variant === 'winner' ? 'wb' : ''}`;
  const tag =
    col.variant === 'current' ? (
      <div className="ptag2">Current Plan</div>
    ) : col.variant === 'winner' ? (
      <div className="wtag2">{col.ribbon ? RIBBON_LABEL[col.ribbon] : '⭐ Best Rx Match'}</div>
    ) : col.ribbon ? (
      <div className="ptag2" style={{ color: 'var(--qv4-amb)' }}>
        {RIBBON_LABEL[col.ribbon]}
      </div>
    ) : null;
  return (
    <th className={cls}>
      {tag}
      <div className="pcar2" style={{ marginTop: tag ? 0 : 8 }}>
        {col.plan.carrier}
      </div>
      <div className="pn2">{col.plan.plan_name}</div>
      <div className="pm2">
        <span className="pid2">
          {col.plan.contract_id}-{col.plan.plan_number}
        </span>
        <span className="star2">{col.plan.star_rating}★</span>
      </div>
    </th>
  );
}

// ─── Section divider row ──────────────────────────────────────────────

function SectionRow({ label, cols }: { label: string; cols: ColumnPlan[] }) {
  return (
    <tr className="sh">
      <th className="lc">{label}</th>
      {cols.map((c) => (
        <td key={c.plan.id} className={cellClsBare(c)}></td>
      ))}
    </tr>
  );
}

// ─── Medication row ───────────────────────────────────────────────────

function MedicationRow({
  medication,
  cols,
  data,
  baseline,
}: {
  medication: Medication;
  cols: ColumnPlan[];
  data: PlanBrainData | null;
  baseline: Plan | null;
}) {
  const baselineCost = baseline ? lookupDrugCost(baseline, medication, data) : null;
  return (
    <tr>
      <th className="lc">
        {medication.name}
        {medication.strength ? ` ${medication.strength}` : ''}
        <br />
        <span className="sub">30-day</span>
      </th>
      {cols.map((c) => {
        const info = lookupDrugCost(c.plan, medication, data);
        return (
          <td key={c.plan.id} className={cellCls(c, info?.improvedVs(baselineCost))}>
            {info ? (
              <>
                {info.tier && (
                  <span className={`ti t${info.tier}`}>
                    {info.tier}
                  </span>
                )}
                {info.label}
                {info.deltaVs(baselineCost) && (
                  <span className={`d ${info.deltaVs(baselineCost)!.sign}`}>
                    {info.deltaVs(baselineCost)!.text}
                  </span>
                )}
                {(info.priorAuth || info.stepTherapy) && (
                  <span className="fl">
                    {info.priorAuth && <span className="fg">PA</span>}
                    {info.stepTherapy && <span className="fg">ST</span>}
                  </span>
                )}
              </>
            ) : (
              <span style={{ color: 'var(--qv4-g500)' }}>—</span>
            )}
          </td>
        );
      })}
    </tr>
  );
}

// ─── Total Rx row ─────────────────────────────────────────────────────

function TotalRxRow({
  cols,
  medications,
  data,
}: {
  cols: ColumnPlan[];
  medications: Medication[];
  data: PlanBrainData | null;
}) {
  const totals = cols.map((c) => totalAnnualRx(c.plan, medications, data));
  const baselineTotal = cols.find((c) => c.variant === 'current')
    ? totals[cols.findIndex((c) => c.variant === 'current')]
    : null;
  return (
    <tr className="tot">
      <th className="lc">Total Rx Cost</th>
      {cols.map((c, i) => {
        const annual = totals[i];
        const monthly = Math.round(annual / 12);
        const delta =
          baselineTotal != null && c.variant !== 'current'
            ? annual - baselineTotal
            : 0;
        const variantCls = cellClsBare(c);
        return (
          <td
            key={c.plan.id}
            className={variantCls}
            style={c.variant === 'winner' ? { color: 'var(--qv4-navy)' } : undefined}
          >
            ${monthly}/mo · ${annual.toLocaleString()}/yr
            {delta !== 0 && (
              <span className={`d ${delta < 0 ? 's' : 'm'}`}>
                {delta < 0 ? '−' : '+'}${Math.abs(delta).toLocaleString()}
              </span>
            )}
          </td>
        );
      })}
    </tr>
  );
}

// ─── Provider divider row ─────────────────────────────────────────────

function ProviderRow({
  provider,
  cols,
}: {
  provider: Provider;
  cols: ColumnPlan[];
}) {
  return (
    <tr>
      <th
        className="lc"
        style={{
          fontWeight: 600,
          color: 'var(--qv4-g800)',
          padding: '9px 12px',
          borderBottom: '2px solid var(--qv4-g200)',
        }}
      >
        {provider.name}
        {provider.specialty && (
          <>
            <br />
            <span className="sub">{provider.specialty}</span>
          </>
        )}
      </th>
      {cols.map((c) => {
        const override = provider.manualOverrides?.[c.plan.carrier];
        const raw = provider.networkStatus?.[c.plan.id] ?? 'unknown';
        const status: 'in' | 'out' | 'unknown' =
          override?.status === 'in' ? 'in' : raw;
        return (
          <td
            key={c.plan.id}
            className={cellClsBare(c)}
            style={{ borderBottom: '2px solid var(--qv4-g200)' }}
          >
            <span
              className={
                status === 'in'
                  ? 'prov-in2'
                  : status === 'out'
                    ? 'prov-out2'
                    : 'prov-unk2'
              }
            >
              {status === 'in' ? '● In-Net' : status === 'out' ? '● Out' : '● ?'}
            </span>
          </td>
        );
      })}
    </tr>
  );
}

// ─── Medical copay row ────────────────────────────────────────────────

interface MedicalRowDef {
  label: string;
  pick: (plan: Plan) => { copay: number | null; coinsurance: number | null; description: string | null };
  /** Format extras (e.g. "/day · 5d" for inpatient). */
  suffix?: string;
}

const MEDICAL_ROWS: MedicalRowDef[] = [
  { label: 'PCP', pick: (p) => p.benefits.medical.primary_care },
  { label: 'Specialist', pick: (p) => p.benefits.medical.specialist },
  { label: 'Labs', pick: (p) => p.benefits.medical.lab_services },
  { label: 'Imaging / MRI', pick: (p) => p.benefits.medical.diagnostic_radiology },
  { label: 'ER', pick: (p) => p.benefits.medical.emergency },
  { label: 'Urgent Care', pick: (p) => p.benefits.medical.urgent_care },
  { label: 'Outpatient Surgery', pick: (p) => p.benefits.medical.outpatient_surgery_hospital },
  { label: 'Mental Health', pick: (p) => p.benefits.medical.mental_health_individual },
  { label: 'PT / OT', pick: (p) => p.benefits.medical.physical_therapy },
  { label: 'Inpatient', pick: (p) => p.benefits.medical.inpatient, suffix: '/day' },
];

function CopayRow({
  row,
  cols,
  baseline,
}: {
  row: MedicalRowDef;
  cols: ColumnPlan[];
  baseline: Plan | null;
}) {
  const baseVal = baseline ? copayCash(row.pick(baseline)) : null;
  return (
    <tr>
      <th className="lc">
        {row.label}
        {row.suffix ? (
          <>
            <br />
            <span className="sub">per day</span>
          </>
        ) : null}
      </th>
      {cols.map((c) => {
        const cs = row.pick(c.plan);
        const val = copayCash(cs);
        const formatted = formatCostShare(cs, row.suffix);
        const delta =
          val != null && baseVal != null && c.variant !== 'current' && val !== baseVal
            ? val - baseVal
            : null;
        const better = delta != null && delta < 0;
        const variantCls = cellCls(c, better);
        return (
          <td key={c.plan.id} className={variantCls}>
            {formatted}
            {delta != null && delta !== 0 && (
              <span className={`d ${delta < 0 ? 's' : 'm'}`}>
                {delta < 0 ? '−' : '+'}${Math.abs(delta)}
              </span>
            )}
          </td>
        );
      })}
    </tr>
  );
}

// ─── Plan-level numeric row (Premium / MOOP / Dental / OTC / Food / Giveback) ─

function PlanCostRow({
  label,
  cols,
  fmt,
  raw,
  baseline,
  betterIsLower,
  annualMultiplier,
  suffix: _suffix,
}: {
  label: string;
  cols: ColumnPlan[];
  fmt: (p: Plan) => string;
  raw: (p: Plan) => number;
  baseline: Plan | null;
  betterIsLower: boolean;
  annualMultiplier?: number;
  suffix?: string;
}) {
  const baseVal = baseline ? raw(baseline) : null;
  return (
    <tr>
      <th className="lc">{label}</th>
      {cols.map((c) => {
        const v = raw(c.plan);
        const delta =
          baseVal != null && c.variant !== 'current' && v !== baseVal ? v - baseVal : null;
        const better =
          delta != null
            ? betterIsLower
              ? delta < 0
              : delta > 0
            : false;
        const variantCls = cellCls(c, better);
        const annualDelta =
          delta != null && annualMultiplier ? delta * annualMultiplier : delta;
        const sign = better ? 's' : 'm';
        const text =
          annualDelta != null && annualDelta !== 0
            ? `${annualDelta < 0 ? '−' : '+'}$${Math.abs(annualDelta).toLocaleString()}`
            : '';
        return (
          <td key={c.plan.id} className={variantCls}>
            {fmt(c.plan)}
            {text && <span className={`d ${sign}`}>{text}</span>}
          </td>
        );
      })}
    </tr>
  );
}

// ─── Total Annual Value summary bar ───────────────────────────────────

function TotalAnnualRow({ cols, baseline }: { cols: ColumnPlan[]; baseline: Plan | null }) {
  const baseTotal = baseline ? estimatedAnnualValue(cols.find((c) => c.plan.id === baseline.id)) : null;
  return (
    <tr className="bl">
      <th
        style={{
          background: 'var(--qv4-navy)',
          color: 'var(--qv4-w)',
          fontFamily: 'var(--qv4-fd)',
          fontSize: 13,
        }}
      >
        Total Annual Value
      </th>
      {cols.map((c) => {
        const total = estimatedAnnualValue(c);
        const isWinner = c.variant === 'winner';
        const isCurrent = c.variant === 'current';
        const savings =
          baseTotal != null && !isCurrent ? baseTotal - total : 0;
        const color = isCurrent
          ? 'var(--qv4-w)'
          : isWinner
            ? 'var(--qv4-sea)'
            : 'rgba(255,255,255,0.6)';
        return (
          <td
            key={c.plan.id}
            style={{
              background: 'var(--qv4-navy)',
              color,
              fontFamily: 'var(--qv4-fm)',
              fontSize: 15,
              fontWeight: 700,
            }}
          >
            {total < 0 ? '−' : ''}${Math.abs(total).toLocaleString()}/yr
            {!isCurrent && savings > 0 && (
              <span className="d s" style={{ fontSize: 9, marginLeft: 4 }}>
                saves ${savings.toLocaleString()}
              </span>
            )}
          </td>
        );
      })}
    </tr>
  );
}

function WhySwitchRow({ cols, baseline }: { cols: ColumnPlan[]; baseline: Plan | null }) {
  return (
    <tr className="ws">
      <th>Why switch?</th>
      {cols.map((c) => {
        const text = whySwitchText(c, baseline);
        return (
          <td key={c.plan.id}>{text}</td>
        );
      })}
    </tr>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────

function cellCls(c: ColumnPlan, betterThanBaseline?: boolean | null): string {
  const base =
    c.variant === 'current' ? 'cb' : c.variant === 'winner' ? 'wb' : '';
  // `.wh` is the highlight that the mockup applies to a winner cell
  // when that cell beats the current plan — bolds + recolors to navy.
  if (c.variant === 'winner' && betterThanBaseline) return `${base} wh`;
  return base;
}

function cellClsBare(c: ColumnPlan): string {
  return c.variant === 'current' ? 'cb' : c.variant === 'winner' ? 'wb' : '';
}

interface DrugInfo {
  tier: number | null;
  label: string;
  priorAuth: boolean;
  stepTherapy: boolean;
  monthlyCost: number;
  annualCost: number;
  improvedVs: (other: DrugInfo | null) => boolean;
  deltaVs: (other: DrugInfo | null) => { sign: 's' | 'm'; text: string } | null;
}

function lookupDrugCost(
  plan: Plan,
  med: Medication,
  data: PlanBrainData | null,
): DrugInfo | null {
  if (!med.rxcui) return null;
  const tripleId = plan.id;
  const contractPlan = `${plan.contract_id}-${plan.plan_number}`;

  const ndc = data?.ndcByRxcui[med.rxcui]?.ndc;
  const cached = ndc ? data?.drugCostCache[tripleId]?.[ndc] : undefined;
  const formulary = data?.formularyByContractPlan[contractPlan]?.[med.rxcui];

  let tier: number | null = cached?.tier ?? formulary?.tier ?? null;
  if (tier == null) {
    // Fallback to plan's seed formulary if Plan Brain data hasn't loaded.
    const seedTier = plan.formulary[med.rxcui];
    if (typeof seedTier === 'number') tier = seedTier;
  }
  if (tier == null) {
    // Excluded vs not-listed.
    const seedTier = plan.formulary[med.rxcui];
    if (seedTier === 'excluded') {
      return makeDrugInfo({ tier: null, label: 'Excluded', monthly: 0, annual: 0, pa: false, st: false });
    }
  }

  const annualFromCache = cached?.estimated_yearly_total ?? null;
  const monthlyFromFormulary = formulary?.copay ?? null;
  const monthlyFromTierBenefits = tier ? tierCopayFromPlan(plan, tier) : null;

  const monthly =
    annualFromCache != null
      ? Math.round(annualFromCache / 12)
      : monthlyFromFormulary ?? monthlyFromTierBenefits ?? 0;
  const annual = annualFromCache != null ? Math.round(annualFromCache) : monthly * 12;

  const label = formatDrugLabel(monthly, formulary?.coinsurance);
  return makeDrugInfo({
    tier,
    label,
    monthly,
    annual,
    pa: formulary?.prior_auth === true,
    st: formulary?.step_therapy === true,
  });
}

function makeDrugInfo(args: {
  tier: number | null;
  label: string;
  monthly: number;
  annual: number;
  pa: boolean;
  st: boolean;
}): DrugInfo {
  return {
    tier: args.tier,
    label: args.label,
    priorAuth: args.pa,
    stepTherapy: args.st,
    monthlyCost: args.monthly,
    annualCost: args.annual,
    improvedVs: (other) => !!other && args.monthly < other.monthlyCost,
    deltaVs: (other) => {
      if (!other) return null;
      const diff = args.monthly - other.monthlyCost;
      if (diff === 0) return null;
      return {
        sign: diff < 0 ? 's' : 'm',
        text: `${diff < 0 ? '−' : '+'}$${Math.abs(diff)}`,
      };
    },
  };
}

function tierCopayFromPlan(plan: Plan, tier: number): number | null {
  const map: Record<number, keyof Plan['benefits']['rx_tiers']> = {
    1: 'tier_1', 2: 'tier_2', 3: 'tier_3', 4: 'tier_4', 5: 'tier_5',
  };
  const key = map[tier];
  if (!key) return null;
  const cs = plan.benefits.rx_tiers[key];
  return cs.copay ?? null;
}

function formatDrugLabel(monthly: number, coinsurance: number | null | undefined): string {
  if (coinsurance != null && (monthly === 0 || monthly == null)) return `${coinsurance}%`;
  return `$${monthly}`;
}

function totalAnnualRx(
  plan: Plan,
  medications: Medication[],
  data: PlanBrainData | null,
): number {
  let total = 0;
  for (const m of medications) {
    const info = lookupDrugCost(plan, m, data);
    if (info) total += info.annualCost;
  }
  return total;
}

function copayCash(cs: { copay: number | null; coinsurance: number | null }): number | null {
  if (cs.copay != null) return cs.copay;
  return null;
}

function formatCostShare(
  cs: { copay: number | null; coinsurance: number | null; description: string | null },
  suffix?: string,
): string {
  if (cs.copay != null) {
    if (suffix === '/day') return `$${cs.copay}/day · 5d`;
    return `$${cs.copay}`;
  }
  if (cs.coinsurance != null) return `${cs.coinsurance}%`;
  return '—';
}

function estimatedAnnualValue(col: ColumnPlan | undefined): number {
  if (!col) return 0;
  const plan = col.plan;
  const scored = col.scored;
  // Convention: negative value = net annual cost (premium + medical +
  // drugs - extras). Positive after sign-flip would mean the extras
  // exceed the cost; the mockup expresses this as e.g. "−$3,917/yr"
  // for a plan whose net cost is $3,917.
  if (scored) {
    const cost = scored.totalOOPEstimate + plan.premium * 12;
    const extras = scored.extrasValue;
    return -(cost - extras);
  }
  // Current-plan column with no Plan Brain row — fall back to a rough
  // premium + dental + OTC + food estimate so the bar isn't blank.
  const extras =
    plan.benefits.dental.annual_max +
    plan.benefits.otc.allowance_per_quarter * 4 +
    plan.benefits.food_card.allowance_per_month * 12 +
    (plan.part_b_giveback ?? 0) * 12;
  return -(plan.premium * 12 - extras);
}

function whySwitchText(col: ColumnPlan, baseline: Plan | null): string {
  if (col.variant === 'current') return 'Current plan';
  const bits: string[] = [];
  if (col.scored?.ribbon) bits.push(RIBBON_LABEL[col.scored.ribbon].replace(/^⭐ /, ''));
  if (baseline) {
    const moopDiff = baseline.moop_in_network - col.plan.moop_in_network;
    if (moopDiff > 500) bits.push(`$${(moopDiff / 1000).toFixed(1)}K lower MOOP`);
    const otcDiff =
      col.plan.benefits.otc.allowance_per_quarter -
      baseline.benefits.otc.allowance_per_quarter;
    if (otcDiff > 0) bits.push(`$${otcDiff * 4}/yr OTC`);
    const foodDiff =
      col.plan.benefits.food_card.allowance_per_month -
      baseline.benefits.food_card.allowance_per_month;
    if (foodDiff > 0) bits.push(`$${foodDiff * 12}/yr food`);
    const dentalDiff =
      col.plan.benefits.dental.annual_max - baseline.benefits.dental.annual_max;
    if (dentalDiff > 0) bits.push(`+$${dentalDiff} dental`);
  }
  if (col.scored?.providerNetworkStatus === 'all_in') bits.push('in-network');
  return bits.length > 0 ? bits.join(' · ') : '—';
}
