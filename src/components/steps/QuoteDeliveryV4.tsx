// QuoteDeliveryV4 — static-first rebuild.
//
// Per Rob's directive (2026-04-26): wipe the previous implementation
// and rebuild the layout from scratch using hardcoded sample data
// matching the V4 mockup (planmatch-full-flow.html, Marina Burgess
// scenario). The previous version had Plan Brain integration,
// useDrugCosts live priming, useManufacturerAssistance, ribbon-driven
// column selection, and per-carrier override handling — all of which
// will be re-wired in a follow-up once the layout is verified visually.
//
// Layout rules (taken verbatim from the rebuild brief):
//
//   • <div style={{ overflowX: 'auto' }}> wrapping a <table> with
//     borderCollapse + tableLayout: 'fixed' + minWidth: 920px.
//   • NO <colgroup>, no percentages. Column widths are set inline on
//     the first <th>/<td>s of <thead>; with table-layout: fixed those
//     widths apply to every row.
//   • Every <tr> emits exactly 1 <th> + columns.length <td> elements
//     (section headers use colspan to span the full row).
//   • Background colors are applied INLINE on every <td> in a colored
//     column — not via class selectors — so re-renders or hydration
//     order can't strip a column's tint.
//   • Header cells: navy / teal / leaf with white text.
//   • Fonts: Fraunces for plan names + section titles, JetBrains Mono
//     for dollar amounts, Inter for body.
//   • Delta badges inline on every cell that differs from column 1.
//   • Total Annual Value is a navy strip with all <td>s navy and
//     dollar values rendered in green.
//   • Section headers use a single <td colspan={1 + N}> with
//     uppercase + letter-spacing.
//
// The Props signature is preserved so Step6QuoteDelivery still
// compiles. The static body intentionally ignores those props for
// this commit — wiring is the next step.

import type { Plan } from '@/types/plans';
import type { Client, Medication, Provider } from '@/types/session';

// ─── Color tokens ──────────────────────────────────────────────────
const COL = {
  navyHeader: '#0c447c',
  navyBody:   '#e6f1fb',
  tealHeader: '#0f6e56',
  tealBody:   '#e1f5ee',
  leafHeader: '#3b6d11',
  leafBody:   '#eaf3de',
  currentHeader: '#e5e7eb',
  currentBody:   '#f5f4f0',
  summaryNavy:   '#1a2744',
  summaryGreen:  '#5dca5a',
  saveBg: '#eaf3de', saveText: '#3b6d11',
  moreBg: '#fcebeb', moreText: '#a32d2d',
  white: '#fff',
  ink:   '#1f2937',
  inkSub:'#4b5563',
  rule:  '#e5e7eb',
  ruleStrong: '#374151',
  panelBg: '#fafaf7',
};

const FONT = {
  serif: "'Fraunces', Georgia, serif",
  body:  "'Inter', system-ui, -apple-system, sans-serif",
  mono:  "'JetBrains Mono', monospace",
};

// ─── Tier badge palette (V4 spec) ──────────────────────────────────
const TIER_BADGE: Record<number, { bg: string; fg: string }> = {
  1: { bg: '#eaf3de', fg: '#3b6d11' },   // green
  2: { bg: '#e1f5ee', fg: '#0f6e56' },   // teal
  3: { bg: '#e6f1fb', fg: '#0c447c' },   // blue
  4: { bg: '#faeeda', fg: '#854f0b' },   // amber
  5: { bg: '#faece7', fg: '#993c1d' },   // coral
  6: { bg: '#fcebeb', fg: '#a32d2d' },   // red
};

// ─── Column variants ───────────────────────────────────────────────
type ColumnVariant = 'current' | 'best_rx' | 'lowest_oop' | 'giveback';

interface ColumnDef {
  id: string;
  variant: ColumnVariant;
  ribbon: string | null;
  carrier: string;
  planName: string;
  hNumber: string;
  star: number;
  starColor?: string;
}

interface ColumnStyle {
  headerBg: string;
  headerFg: string;
  bodyBg: string | undefined;     // undefined = no inline bg (white)
  bodyFg: string;
}

function styleFor(variant: ColumnVariant): ColumnStyle {
  switch (variant) {
    case 'current':
      return { headerBg: COL.currentHeader, headerFg: COL.ink, bodyBg: COL.currentBody, bodyFg: COL.ink };
    case 'best_rx':
      return { headerBg: COL.navyHeader, headerFg: COL.white, bodyBg: COL.navyBody, bodyFg: COL.ink };
    case 'lowest_oop':
      return { headerBg: COL.tealHeader, headerFg: COL.white, bodyBg: COL.tealBody, bodyFg: COL.ink };
    case 'giveback':
      return { headerBg: COL.leafHeader, headerFg: COL.white, bodyBg: COL.leafBody, bodyFg: COL.ink };
  }
}

// ─── Hardcoded sample data (Marina Burgess scenario from mockup) ────
const COLUMNS: ColumnDef[] = [
  {
    id: 'H1036-308',
    variant: 'current',
    ribbon: null,
    carrier: 'Humana',
    planName: 'Gold Plus HMO',
    hNumber: 'H1036-308',
    star: 4.5,
    starColor: '#3b6d11',
  },
  {
    id: 'H9725-014',
    variant: 'best_rx',
    ribbon: '⭐ Best Rx Match',
    carrier: 'HealthSpring',
    planName: 'Preferred Select (HMO)',
    hNumber: 'H9725-014',
    star: 4,
  },
  {
    id: 'H9725-009',
    variant: 'lowest_oop',
    ribbon: '⭐ Lowest OOP',
    carrier: 'HealthSpring',
    planName: 'Preferred (HMO)',
    hNumber: 'H9725-009',
    star: 4,
  },
  {
    id: 'H3146-021',
    variant: 'giveback',
    ribbon: '⭐ Part B Giveback',
    carrier: 'Aetna Medicare',
    planName: 'Signature Care (HMO)',
    hNumber: 'H3146-021',
    star: 4,
  },
];

// Per-cell row data — index into COLUMNS for the value/delta rendering.
// Format: [ <current>, <best_rx>, <lowest_oop>, <giveback> ]
type Row4Display = [string, string, string, string];
type Row4Num = [number | null, number | null, number | null, number | null];
type TierRow = [number | null, number | null, number | null, number | null];

interface MedRow {
  name: string;
  fillNote: string;
  tiers: TierRow;
  values: Row4Display;   // formatted display values
  monthly: Row4Num;      // numeric monthly cost (null = not covered)
  paStFlags?: Array<{ pa?: boolean; st?: boolean } | null>;
}

const MEDS: MedRow[] = [
  {
    name: 'Metformin 500 MG', fillNote: '30-day',
    tiers: [6, 1, 1, 1],
    values: ['$0', '$0', '$0', '$0'],
    monthly: [0, 0, 0, 0],
  },
  {
    name: 'Gabapentin 300 MG', fillNote: '30-day',
    tiers: [2, 1, 1, 1],
    values: ['$5', '$0', '$4', '$0'],
    monthly: [5, 0, 4, 0],
  },
  {
    name: 'Lisinopril 10 MG', fillNote: '30-day',
    tiers: [6, 1, 1, 1],
    values: ['$0', '$0', '$0', '$0'],
    monthly: [0, 0, 0, 0],
  },
  {
    name: 'Atorvastatin 20 MG', fillNote: '30-day',
    tiers: [6, 1, 1, 1],
    values: ['$0', '$0', '$0', '$0'],
    monthly: [0, 0, 0, 0],
  },
  {
    name: 'Eliquis 5 MG', fillNote: '30-day',
    tiers: [3, 3, 3, 3],
    values: ['$47', '$47', '$47', '24%'],
    monthly: [47, 47, 47, null],
    paStFlags: [{ pa: true }, null, null, { pa: true, st: true }],
  },
  {
    name: 'Jardiance 25 MG', fillNote: '30-day',
    tiers: [3, 3, 3, 3],
    values: ['$47', '$47', '$47', '24%'],
    monthly: [47, 47, 47, null],
  },
];

const RX_TOTAL_MONTHLY: Row4Num = [99, 94, 98, 114];
const RX_TOTAL_ANNUAL:  Row4Num = [1188, 1128, 1176, 1368];

interface ProviderRow {
  name: string;
  specialty: string;
  status: ['in' | 'out' | 'unknown', 'in' | 'out' | 'unknown', 'in' | 'out' | 'unknown', 'in' | 'out' | 'unknown'];
}
const PROVIDERS: ProviderRow[] = [
  { name: 'Dr. Klein, DO', specialty: 'Internal Medicine', status: ['in', 'in', 'in', 'in'] },
];

interface CopayRow {
  label: string;
  values: Row4Display;
  numbers: Row4Num;    // for delta calc
  suffix?: string;     // e.g. "/day"
  bold?: boolean;
}

const COPAYS: CopayRow[] = [
  { label: 'PCP',                values: ['$0', '$0', '$0', '$0'],          numbers: [0, 0, 0, 0] },
  { label: 'Specialist',         values: ['$45', '$15', '$15', '$10'],      numbers: [45, 15, 15, 10] },
  { label: 'Labs',               values: ['$20', '$0', '$0', '$0'],         numbers: [20, 0, 0, 0] },
  { label: 'Imaging / MRI',      values: ['$250', '$200', '$200', '$260'],  numbers: [250, 200, 200, 260] },
  { label: 'ER',                 values: ['$115', '$150', '$150', '$130'],  numbers: [115, 150, 150, 130] },
  { label: 'Urgent Care',        values: ['$40', '$65', '$65', '$50'],      numbers: [40, 65, 65, 50] },
  { label: 'Outpatient Surgery', values: ['$250', '$200', '$200', '$250'],  numbers: [250, 200, 200, 250] },
  { label: 'Mental Health',      values: ['$40', '$30', '$30', '$25'],      numbers: [40, 30, 30, 25] },
  { label: 'PT / OT',            values: ['$40', '$30', '$30', '$25'],      numbers: [40, 30, 30, 25] },
  { label: 'Inpatient',          values: ['$375/day', '$275/day', '$250/day', '$382/day'],
                                 numbers: [375, 275, 250, 382], suffix: '/day' },
];

const INPATIENT_DAYS = 5;
const INPATIENT_TOTAL: Row4Num = [1875, 1375, 1250, 1910];   // daily × 5

const PLAN_COSTS: CopayRow[] = [
  { label: 'Premium',         values: ['$0/mo', '$0/mo', '$0/mo', '$0/mo'], numbers: [0, 0, 0, 0] },
  { label: 'MOOP',            values: ['$9,250', '$3,200', '$3,550', '$6,350'], numbers: [9250, 3200, 3550, 6350] },
  { label: 'Rx Deductible',   values: ['$450', '$295', '$295', '$615'],     numbers: [450, 295, 295, 615] },
  { label: 'Part B Giveback', values: ['$1/mo', '$5/mo', '$0/mo', '$0/mo'], numbers: [1, 5, 0, 0] },
];

const EXTRAS: Array<CopayRow & { betterIsHigher?: boolean }> = [
  { label: 'Dental',    values: ['$2,000/yr', '$1,500/yr', '$1,500/yr', '$2,500/yr'], numbers: [2000, 1500, 1500, 2500], betterIsHigher: true },
  { label: 'Vision',    values: ['$200/yr', '$300/yr', '$300/yr', '$250/yr'],         numbers: [200, 300, 300, 250],     betterIsHigher: true },
  { label: 'Hearing',   values: ['$1,500/yr', '$2,000/yr', '$2,000/yr', '$1,200/yr'], numbers: [1500, 2000, 2000, 1200], betterIsHigher: true },
  { label: 'OTC',       values: ['$0/qtr', '$405/qtr', '$120/qtr', '$90/qtr'],        numbers: [0, 405, 120, 90],        betterIsHigher: true },
  { label: 'Food Card', values: ['$0/mo', '$75/mo', '$50/mo', '$0/mo'],               numbers: [0, 75, 50, 0],           betterIsHigher: true },
  { label: 'Fitness',   values: ['SilverSneakers', 'Renew Active', 'SilverSneakers', 'SilverSneakers'], numbers: [1, 1, 1, 1] },
];

const ANNUAL_NET: Row4Num = [-2074, -3917, -2759, -3127];
const SAVINGS_VS_CURRENT: Row4Num = [0, 1843, 685, 1053];
const WHY_SWITCH: Row4Display = [
  'Current plan',
  'Lowest Rx · $6K lower MOOP · $1,620 OTC · $900 food · 24 trips · in-network',
  'Low Rx · $5.7K lower MOOP · $480 OTC · $600 food · in-network',
  'Best specialist $10 · dental $2,500 · higher Rx deductible',
];

const SUNFIRE_URL = 'https://www.sunfirematrix.com/app/consumer/yourmedicare/10447418';

// ─── Component ─────────────────────────────────────────────────────

interface Props {
  finalists: Plan[];
  client: Client;
  medications: Medication[];
  providers: Provider[];
  recommendation?: string | null;
  onRecommend?: (id: string | null) => void;
}

export function QuoteDeliveryV4({
  recommendation,
  onRecommend,
}: Props) {
  // Layout-first commit: hardcoded sample data, props intentionally
  // ignored. Re-wiring in the follow-up.
  void 0;

  const N = COLUMNS.length;
  const minWidth = 200 + N * 180;
  const colSpanFull = 1 + N;

  return (
    <div style={{ fontFamily: FONT.body, color: COL.ink }}>
      {/* Pharmacy toggle (visual-only in the static commit) */}
      <div style={{ marginBottom: 12, fontSize: 12, color: COL.inkSub }}>
        <strong style={{ marginRight: 8, fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Pharmacy</strong>
        <span style={pharmBtnStyle(true)}>30-day retail</span>
        <span style={pharmBtnStyle(false)}>90-day mail</span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            borderCollapse: 'collapse',
            tableLayout: 'fixed',
            minWidth,
            width: '100%',
          }}
        >
          {/* ── Column header row ─────────────────────────────────── */}
          <thead>
            <tr>
              <th
                style={{
                  width: 200,
                  minWidth: 200,
                  padding: 14,
                  textAlign: 'left',
                  fontFamily: FONT.serif,
                  fontSize: 16,
                  fontWeight: 700,
                  color: COL.navyHeader,
                  background: COL.panelBg,
                  borderBottom: `1px solid ${COL.rule}`,
                }}
              >
                Quote Comparison
              </th>
              {COLUMNS.map((col) => {
                const s = styleFor(col.variant);
                return (
                  <th
                    key={col.id}
                    style={{
                      width: 180,
                      minWidth: 180,
                      padding: 14,
                      textAlign: 'left',
                      verticalAlign: 'top',
                      background: s.headerBg,
                      color: s.headerFg,
                      borderBottom: `1px solid ${COL.rule}`,
                      fontWeight: 400,
                    }}
                  >
                    {col.ribbon && (
                      <div
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          color: col.variant === 'current' ? COL.inkSub : 'rgba(255,255,255,0.85)',
                          marginBottom: 3,
                        }}
                      >
                        {col.ribbon}
                      </div>
                    )}
                    {col.variant === 'current' && (
                      <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: COL.inkSub, marginBottom: 3 }}>
                        Current Plan
                      </div>
                    )}
                    <div style={{ fontSize: 10, opacity: 0.75 }}>{col.carrier}</div>
                    <div
                      style={{
                        fontFamily: FONT.serif,
                        fontSize: 13,
                        fontWeight: 600,
                        marginTop: 1,
                        lineHeight: 1.2,
                      }}
                    >
                      {col.planName}
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                      <span style={{ fontFamily: FONT.mono, fontSize: 9, opacity: 0.7 }}>{col.hNumber}</span>
                      <span style={{ fontSize: 9, fontWeight: 600, color: col.starColor ?? (col.variant === 'current' ? '#d97706' : '#fef3c7') }}>
                        {col.star}★
                      </span>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>

          {/* ── Body ─────────────────────────────────────────────── */}
          <tbody>
            <SectionHeader colSpan={colSpanFull} label="Your Medications" />

            {MEDS.map((m, mi) => (
              <tr key={`med-${mi}`}>
                <th style={labelCellStyle}>
                  <div>{m.name}</div>
                  <div style={{ fontSize: 10, color: COL.inkSub, fontWeight: 400 }}>{m.fillNote}</div>
                </th>
                {COLUMNS.map((col, ci) => {
                  const s = styleFor(col.variant);
                  const tier = m.tiers[ci];
                  const flags = m.paStFlags?.[ci];
                  const monthlyHere = m.monthly[ci];
                  const monthlyBase = m.monthly[0];
                  const delta =
                    ci === 0 || monthlyHere == null || monthlyBase == null || monthlyHere === monthlyBase
                      ? null
                      : monthlyHere - monthlyBase;
                  return (
                    <td key={col.id} style={cellStyle(s.bodyBg)}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                        {tier != null && <TierBadge tier={tier} />}
                        <span style={{ fontFamily: FONT.mono, fontSize: 12, color: s.bodyFg }}>{m.values[ci]}</span>
                        {delta != null && <DeltaBadge value={delta} />}
                        {flags?.pa && <Flag>PA</Flag>}
                        {flags?.st && <Flag>ST</Flag>}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}

            {/* Total Rx Cost */}
            <tr>
              <th style={{ ...labelCellStyle, fontWeight: 700, borderTop: `1.5px solid ${COL.rule}` }}>
                Total Rx Cost
              </th>
              {COLUMNS.map((col, ci) => {
                const s = styleFor(col.variant);
                const annual = RX_TOTAL_ANNUAL[ci] as number;
                const monthly = RX_TOTAL_MONTHLY[ci] as number;
                const baseAnnual = RX_TOTAL_ANNUAL[0] as number;
                const delta = ci === 0 ? null : annual - baseAnnual;
                return (
                  <td key={col.id} style={{ ...cellStyle(s.bodyBg), fontWeight: 700, borderTop: `1.5px solid ${COL.rule}` }}>
                    <span style={{ fontFamily: FONT.mono, fontSize: 12 }}>${monthly}/mo · ${annual.toLocaleString()}/yr</span>
                    {delta != null && delta !== 0 && <DeltaBadge value={delta} />}
                  </td>
                );
              })}
            </tr>

            <SectionHeader colSpan={colSpanFull} label="Providers" />

            {PROVIDERS.map((pr, pi) => (
              <tr key={`prov-${pi}`}>
                <th style={labelCellStyle}>
                  <div style={{ fontWeight: 600 }}>{pr.name}</div>
                  <div style={{ fontSize: 10, color: COL.inkSub, fontWeight: 400 }}>{pr.specialty}</div>
                </th>
                {COLUMNS.map((col, ci) => {
                  const s = styleFor(col.variant);
                  const status = pr.status[ci];
                  const dot = status === 'in' ? '●' : status === 'out' ? '●' : '●';
                  const text = status === 'in' ? 'In-Net' : status === 'out' ? 'Out' : 'Unknown';
                  const color = status === 'in' ? '#3b6d11' : status === 'out' ? '#a32d2d' : '#6b7280';
                  return (
                    <td key={col.id} style={cellStyle(s.bodyBg)}>
                      <span style={{ color, fontWeight: 700, fontSize: 11 }}>
                        {dot} {text}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}

            <SectionHeader colSpan={colSpanFull} label="Medical Copays" />

            {COPAYS.map((row, ri) => (
              <CopayRowEl key={`cp-${ri}`} row={row} />
            ))}

            {/* Total inpatient cost — bold subtotal directly under Inpatient/day */}
            <tr>
              <th style={{ ...labelCellStyle, fontWeight: 700, borderBottom: `1.5px solid ${COL.ruleStrong}` }}>
                <div>Total inpatient cost</div>
                <div style={{ fontSize: 10, color: COL.inkSub, fontWeight: 400 }}>{INPATIENT_DAYS}-day hospital stay</div>
              </th>
              {COLUMNS.map((col, ci) => {
                const s = styleFor(col.variant);
                const total = INPATIENT_TOTAL[ci] as number;
                const base = INPATIENT_TOTAL[0] as number;
                const delta = ci === 0 ? null : total - base;
                return (
                  <td
                    key={col.id}
                    style={{
                      ...cellStyle(s.bodyBg),
                      fontWeight: 700,
                      borderBottom: `1.5px solid ${COL.ruleStrong}`,
                    }}
                  >
                    <span style={{ fontFamily: FONT.mono, fontSize: 12 }}>${total.toLocaleString()}</span>
                    {delta != null && delta !== 0 && <DeltaBadge value={delta} />}
                  </td>
                );
              })}
            </tr>

            <SectionHeader colSpan={colSpanFull} label="Plan Costs" />

            {PLAN_COSTS.map((row, ri) => (
              <CopayRowEl key={`pc-${ri}`} row={row} />
            ))}

            <SectionHeader colSpan={colSpanFull} label="Extra Benefits" />

            {EXTRAS.map((row, ri) => (
              <CopayRowEl key={`ex-${ri}`} row={row} betterIsHigher={row.betterIsHigher} />
            ))}

            {/* Total Annual Value navy bar */}
            <tr>
              <th
                style={{
                  width: 200,
                  padding: '12px 14px',
                  textAlign: 'left',
                  background: COL.summaryNavy,
                  color: COL.white,
                  fontFamily: FONT.serif,
                  fontSize: 13,
                  fontWeight: 700,
                  borderBottom: 'none',
                }}
              >
                Total Annual Value
              </th>
              {COLUMNS.map((col, ci) => {
                const isCurrent = col.variant === 'current';
                const annual = ANNUAL_NET[ci] as number;
                const savings = SAVINGS_VS_CURRENT[ci] as number;
                return (
                  <td
                    key={col.id}
                    style={{
                      width: 180,
                      padding: '12px 14px',
                      background: COL.summaryNavy,
                      color: isCurrent ? COL.white : COL.summaryGreen,
                      fontFamily: FONT.mono,
                      fontSize: 15,
                      fontWeight: 700,
                      borderBottom: 'none',
                    }}
                  >
                    {annual < 0 ? '−' : ''}${Math.abs(annual).toLocaleString()}/yr
                    {!isCurrent && savings > 0 && (
                      <span style={{ fontSize: 9, marginLeft: 6, opacity: 0.85 }}>saves ${savings.toLocaleString()}</span>
                    )}
                  </td>
                );
              })}
            </tr>

            {/* Why switch? subtitle row */}
            <tr>
              <th
                style={{
                  padding: '0 14px 10px',
                  textAlign: 'left',
                  background: COL.summaryNavy,
                  color: 'rgba(255,255,255,0.55)',
                  fontSize: 10,
                  fontWeight: 400,
                  borderBottom: 'none',
                }}
              >
                Why switch?
              </th>
              {COLUMNS.map((col, ci) => (
                <td
                  key={col.id}
                  style={{
                    padding: '0 14px 10px',
                    background: COL.summaryNavy,
                    color: 'rgba(255,255,255,0.7)',
                    fontFamily: FONT.body,
                    fontSize: 10,
                    borderBottom: 'none',
                    whiteSpace: 'normal',
                  }}
                >
                  {WHY_SWITCH[ci]}
                </td>
              ))}
            </tr>

            {/* Action row — Recommend + Open SunFire */}
            <tr>
              <th style={{ width: 200, padding: 12, background: COL.panelBg, borderBottom: 'none' }}></th>
              {COLUMNS.map((col) => {
                const isCurrent = col.variant === 'current';
                const isRec = recommendation === col.id;
                return (
                  <td
                    key={col.id}
                    style={{
                      width: 180,
                      padding: 12,
                      background: COL.panelBg,
                      verticalAlign: 'top',
                      borderBottom: 'none',
                    }}
                  >
                    {isCurrent ? (
                      <button type="button" style={btnSecondaryStyle}>Keep Current</button>
                    ) : (
                      <button
                        type="button"
                        style={isRec ? btnRecOnStyle : btnRecStyle}
                        onClick={() => onRecommend?.(isRec ? null : col.id)}
                      >
                        {isRec ? '✓ Recommended' : 'Recommend'}
                      </button>
                    )}
                    <a
                      href={SUNFIRE_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={btnSunfireStyle}
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
    </div>
  );
}

// ─── Subcomponents + helpers ───────────────────────────────────────

function SectionHeader({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        style={{
          padding: '14px 14px 4px',
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: COL.navyHeader,
          background: COL.panelBg,
          borderBottom: `1.5px solid ${COL.navyHeader}`,
          fontFamily: FONT.body,
        }}
      >
        {label}
      </td>
    </tr>
  );
}

function CopayRowEl({ row, betterIsHigher }: { row: CopayRow; betterIsHigher?: boolean }) {
  return (
    <tr>
      <th style={labelCellStyle}>{row.label}</th>
      {COLUMNS.map((col, ci) => {
        const s = styleFor(col.variant);
        const v = row.values[ci];
        const num = row.numbers[ci];
        const baseNum = row.numbers[0];
        const isNumeric = typeof num === 'number' && typeof baseNum === 'number';
        const delta = ci === 0 || !isNumeric || num === baseNum ? null : (num as number) - (baseNum as number);
        return (
          <td key={col.id} style={cellStyle(s.bodyBg)}>
            <span style={{ fontFamily: FONT.mono, fontSize: 12, color: s.bodyFg }}>{v}</span>
            {delta != null && delta !== 0 && (
              <DeltaBadge value={delta} flipBetter={betterIsHigher} />
            )}
          </td>
        );
      })}
    </tr>
  );
}

function TierBadge({ tier }: { tier: number }) {
  const palette = TIER_BADGE[tier] ?? { bg: '#e5e7eb', fg: '#374151' };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        borderRadius: 4,
        background: palette.bg,
        color: palette.fg,
        fontSize: 10,
        fontWeight: 700,
        fontFamily: FONT.mono,
      }}
    >
      {tier}
    </span>
  );
}

function DeltaBadge({ value, flipBetter }: { value: number; flipBetter?: boolean }) {
  // flipBetter=true → positive delta is good (e.g. larger benefit dollar value)
  const isSavings = flipBetter ? value > 0 : value < 0;
  const sign = value < 0 ? '−' : '+';
  const abs = Math.abs(value);
  return (
    <span
      style={{
        marginLeft: 6,
        padding: '1px 6px',
        borderRadius: 4,
        fontSize: 10,
        fontFamily: FONT.mono,
        fontWeight: 700,
        background: isSavings ? COL.saveBg : COL.moreBg,
        color: isSavings ? COL.saveText : COL.moreText,
        whiteSpace: 'nowrap',
      }}
    >
      {sign}${abs.toLocaleString()}
    </span>
  );
}

function Flag({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 8,
        fontWeight: 700,
        padding: '1px 4px',
        borderRadius: 3,
        background: '#faeeda',
        color: '#854f0b',
        fontFamily: FONT.mono,
        marginLeft: 2,
      }}
    >
      {children}
    </span>
  );
}

// ─── Style atoms ───────────────────────────────────────────────────

const labelCellStyle: React.CSSProperties = {
  width: 200,
  padding: '8px 14px',
  textAlign: 'left',
  fontSize: 12,
  fontWeight: 500,
  color: COL.inkSub,
  background: COL.panelBg,
  borderBottom: `1px solid ${COL.rule}`,
  whiteSpace: 'normal',
  fontFamily: FONT.body,
};

function cellStyle(bg: string | undefined): React.CSSProperties {
  return {
    width: 180,
    padding: '8px 14px',
    textAlign: 'left',
    fontSize: 12,
    color: COL.ink,
    background: bg ?? COL.white,
    borderBottom: `1px solid ${COL.rule}`,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}

function pharmBtnStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-block',
    padding: '5px 11px',
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 600,
    fontFamily: FONT.body,
    background: active ? COL.navyHeader : '#fff',
    color: active ? '#fff' : COL.inkSub,
    border: `1px solid ${active ? COL.navyHeader : '#d1d5db'}`,
    marginRight: 4,
  };
}

const btnRecStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '8px 10px',
  borderRadius: 6,
  border: 'none',
  background: COL.tealHeader,
  color: '#fff',
  fontFamily: FONT.body,
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
  marginBottom: 4,
};
const btnRecOnStyle: React.CSSProperties = {
  ...btnRecStyle,
  background: COL.leafHeader,
};
const btnSecondaryStyle: React.CSSProperties = {
  ...btnRecStyle,
  background: '#f1f3f5',
  color: COL.inkSub,
  border: '1px solid #d1d5db',
};
const btnSunfireStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '6px 10px',
  borderRadius: 6,
  background: '#f1f3f5',
  color: COL.inkSub,
  fontFamily: FONT.body,
  fontSize: 11,
  fontWeight: 600,
  textAlign: 'center',
  textDecoration: 'none',
  border: '1px solid #d1d5db',
  boxSizing: 'border-box',
};
