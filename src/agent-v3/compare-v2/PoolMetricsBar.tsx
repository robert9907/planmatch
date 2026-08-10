// PoolMetricsBar — compact 3-row stat strip above the bench. Same
// design language as the BoardComparisonView: dark navy panel, big
// mono numbers as the primary read, small uppercase muted labels.
// Purpose: at a glance, tell the broker how the pool broke down, why
// plans dropped, and what's in the county.
//
// Every count derives from what CompareScreen already receives from
// the brain adapter — no new fetches, no new computations that could
// diverge from the bench elimination chips. Counts:
//
//   Tier 1 — outcome
//     Full match  = scoredPlans.length (made Top 4; passed all gates
//                    by definition of being in scoredPlans)
//     Partial     = bench plans with every gate passed but ranked past
//                    slot 4 (matches eliminationReason 'Outside Top 4')
//     Eliminated  = bench plans that failed ≥1 gate
//     Unscorable  = plans flagged drugCoverageUnknown — brain couldn't
//                    confirm coverage for ≥1 user drug. NOT the same as
//                    "couldn't rank"; CompareScreen doesn't see plans
//                    that never entered ranking, so this is the closest
//                    proxy available. Reports 0 when the flag map is
//                    absent (no meds captured).
//
//   Tier 2 — why plans dropped (bench elimination reasons)
//     Provider OON      = bench && !gate1_passed
//     Meds uncovered    = bench && gate1_passed && !gate2_passed
//     Missing extra     = bench && gate1_passed && gate2_passed && !gate3_passed
//     Non-commissionable = N/A — filtered upstream by /api/plans
//                          (via pm_non_commissionable_contracts); no
//                          count reaches this screen. Cell renders "—".
//
//   Tier 3 — county composition (across scored + bench)
//     $0 premium        = plans where premium === 0
//     D-SNP             = snp_type === 'D-SNP'
//     C-SNP             = snp_type === 'C-SNP'
//     dental ≥ $2k      = benefits.dental.annual_max >= 2000
//     Part B giveback   = part_b_giveback > 0

import type { CSSProperties } from 'react';
import type { Plan } from '@/types/plans';
import { TOKENS as T, FONT as F } from './tokens';

export interface PoolMetricsBarProps {
  scoredPlans: ReadonlyArray<Plan>;
  benchPlans: ReadonlyArray<Plan>;
  benchGateResultsByPlanId: Record<
    string,
    { gate1_passed: boolean; gate2_passed: boolean; gate3_passed: boolean }
  >;
  drugCoverageUnknownByPlanId?: Record<string, boolean>;
}

export function PoolMetricsBar(props: PoolMetricsBarProps) {
  const {
    scoredPlans,
    benchPlans,
    benchGateResultsByPlanId,
    drugCoverageUnknownByPlanId,
  } = props;

  const all: ReadonlyArray<Plan> = [...scoredPlans, ...benchPlans];
  if (all.length === 0) return null;

  // Tier 1 outcome
  const fullMatch = scoredPlans.length;
  let partial = 0;
  let eliminated = 0;
  for (const p of benchPlans) {
    const g = benchGateResultsByPlanId[p.id];
    if (!g) continue; // no gate signal → don't attribute
    if (g.gate1_passed && g.gate2_passed && g.gate3_passed) partial += 1;
    else eliminated += 1;
  }
  const unscorable = drugCoverageUnknownByPlanId
    ? Object.values(drugCoverageUnknownByPlanId).filter((v) => v === true).length
    : 0;

  // Tier 2 elimination reasons (bench only; same shape as
  // eliminationReason() in CompareScreen.tsx)
  let providerOon = 0;
  let medsUncovered = 0;
  let missingExtra = 0;
  for (const p of benchPlans) {
    const g = benchGateResultsByPlanId[p.id];
    if (!g) continue;
    if (!g.gate1_passed) providerOon += 1;
    else if (!g.gate2_passed) medsUncovered += 1;
    else if (!g.gate3_passed) missingExtra += 1;
  }

  // Tier 3 composition (scored + bench)
  let zeroPrem = 0;
  let dsnp = 0;
  let csnp = 0;
  let dentalHigh = 0;
  let partBGive = 0;
  for (const p of all) {
    if (p.premium === 0) zeroPrem += 1;
    if (p.snp_type === 'D-SNP') dsnp += 1;
    if (p.snp_type === 'C-SNP') csnp += 1;
    if ((p.benefits.dental?.annual_max ?? 0) >= 2000) dentalHigh += 1;
    if ((p.part_b_giveback ?? 0) > 0) partBGive += 1;
  }

  return (
    <div
      role="region"
      aria-label="Pool metrics"
      style={{
        margin: '10px 0 6px',
        background: T.navy950,
        borderRadius: 10,
        padding: '14px 18px 12px',
        boxShadow: '0 2px 10px rgba(10,18,32,0.14)',
      }}
    >
      {/* Tier 1 — 4 cells */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          gap: 20,
          paddingBottom: 10,
          borderBottom: `1px solid rgba(255,255,255,0.06)`,
        }}
      >
        <PrimaryCell value={fullMatch} label="Full match" />
        <PrimaryCell value={partial} label="Partial" muted={partial === 0} />
        <PrimaryCell value={eliminated} label="Eliminated" muted={eliminated === 0} />
        <PrimaryCell
          value={unscorable}
          label="Unscorable"
          muted={unscorable === 0}
          title="Plans where the brain couldn't confirm drug coverage for at least one user drug — not the same as 'couldn't rank at all'"
        />
      </div>

      {/* Tier 2 — inline stat list */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '10px 22px',
          padding: '10px 0',
          borderBottom: `1px solid rgba(255,255,255,0.06)`,
        }}
      >
        <SecondaryStat value={providerOon} label="Provider OON" />
        <SecondaryStat value={medsUncovered} label="Meds uncovered" />
        <SecondaryStat value={missingExtra} label="Missing extra" />
        <SecondaryStat value="—" label="Non-commissionable" title="Filtered upstream by /api/plans via pm_non_commissionable_contracts — no count reaches this screen" />
      </div>

      {/* Tier 3 — inline composition */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '10px 22px',
          padding: '10px 0 0',
        }}
      >
        <SecondaryStat value={zeroPrem} label="$0 premium" />
        <SecondaryStat value={dsnp} label="D-SNP" />
        <SecondaryStat value={csnp} label="C-SNP" />
        <SecondaryStat value={dentalHigh} label="Dental ≥ $2k" />
        <SecondaryStat value={partBGive} label="Part B giveback" />
      </div>
    </div>
  );
}

// ─── Cells ────────────────────────────────────────────────────────

function PrimaryCell({
  value,
  label,
  muted = false,
  title,
}: {
  value: number;
  label: string;
  muted?: boolean;
  title?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }} title={title}>
      <div
        style={{
          fontFamily: F.num,
          fontSize: 22,
          fontWeight: 500,
          lineHeight: 1,
          color: muted ? T.navyTextMuted : T.mintOnDark,
        }}
      >
        {value}
      </div>
      <div style={LABEL_STYLE}>{label}</div>
    </div>
  );
}

function SecondaryStat({
  value,
  label,
  title,
}: {
  value: number | string;
  label: string;
  title?: string;
}) {
  const isNumeric = typeof value === 'number';
  const zero = isNumeric && value === 0;
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 8,
        minWidth: 0,
      }}
      title={title}
    >
      <span
        style={{
          fontFamily: F.num,
          fontSize: 17,
          fontWeight: 500,
          lineHeight: 1,
          color: zero || !isNumeric ? T.navyTextMuted : '#FFFFFF',
        }}
      >
        {value}
      </span>
      <span style={LABEL_STYLE}>{label}</span>
    </div>
  );
}

const LABEL_STYLE: CSSProperties = {
  fontFamily: F.label,
  fontSize: 11,
  fontWeight: 500,
  color: T.navyTextMuted,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
};
