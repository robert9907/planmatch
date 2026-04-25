// PlanBrainPanel — agent-side summary surface for the Plan Brain
// scoring engine. Sits above the existing side-by-side V4 table on the
// Quote screen.
//
// Renders:
//   1. Top 3 picks (BEST_OVERALL + next 2 by composite) with ribbon
//      badges and the human-readable cost breakdown string.
//   2. A flat, sortable table of every scored plan:
//        Plan | Composite | Drug Cost | OOP Est | Extras Value | Ribbon
//      Sortable by any numeric column (click header). Default sort is
//      composite descending.
//
// Pure read of the PlanBrainResult — no API, no scoring here. The
// engine runs upstream in usePlanBrain().

import { useMemo, useState } from 'react';
import type {
  PlanBrainResult,
  RibbonKey,
  ScoredPlan,
} from '@/lib/plan-brain-types';
import { bestOverallText } from '@/lib/plan-brain-ribbons';

type SortKey = 'composite' | 'drug' | 'oop' | 'extras' | 'plan';

const RIBBON_LABEL: Record<RibbonKey, string> = {
  BEST_OVERALL: 'Best overall',
  LOWEST_DRUG_COST: 'Lowest Rx cost',
  LOWEST_OOP: 'Lowest total OOP',
  BEST_EXTRAS: 'Best extras',
  ALL_DOCS_IN_NETWORK: 'All providers in-network',
  PART_B_SAVINGS: 'Part B giveback',
  ZERO_PREMIUM: '$0 premium',
  ALL_MEDS_COVERED: 'All meds covered',
};

const RIBBON_TONE: Record<RibbonKey, string> = {
  BEST_OVERALL: '#0d2f5e',
  LOWEST_DRUG_COST: '#1a6b3a',
  LOWEST_OOP: '#0d8a8a',
  BEST_EXTRAS: '#9c5b00',
  ALL_DOCS_IN_NETWORK: '#0d2f5e',
  PART_B_SAVINGS: '#1a6b3a',
  ZERO_PREMIUM: '#1a6b3a',
  ALL_MEDS_COVERED: '#1a6b3a',
};

interface Props {
  result: PlanBrainResult | null;
  loading: boolean;
  county: string;
  conditionLabel?: string | null;
}

export function PlanBrainPanel({ result, loading, county, conditionLabel }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('composite');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const sorted = useMemo(() => {
    if (!result) return [];
    const arr = [...result.scored];
    arr.sort((a, b) => {
      const va = pickValue(a, sortKey);
      const vb = pickValue(b, sortKey);
      if (typeof va === 'string' && typeof vb === 'string') {
        return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      const na = typeof va === 'number' ? va : 0;
      const nb = typeof vb === 'number' ? vb : 0;
      return sortDir === 'asc' ? na - nb : nb - na;
    });
    return arr;
  }, [result, sortKey, sortDir]);

  if (loading && !result) {
    return (
      <div style={panel}>
        <div style={hdr}>
          <div style={hdrTitle}>Plan Brain</div>
          <div style={hdrSub}>Scoring plans…</div>
        </div>
      </div>
    );
  }

  if (!result || result.scored.length === 0) return null;

  const top3 = result.scored.slice(0, 3);
  const headlineCopy = bestOverallText(result.population, county, conditionLabel ?? undefined);

  return (
    <div style={panel}>
      <div style={hdr}>
        <div>
          <div style={hdrTitle}>Plan Brain · {result.scored.length} plan{result.scored.length === 1 ? '' : 's'} scored</div>
          <div style={hdrSub}>
            {headlineCopy}
            {' · '}
            weights drug {pct(result.weights.drug)} / oop {pct(result.weights.oop)} / extras {pct(result.weights.extras)}
            {' · '}
            utilization {result.utilization}
          </div>
        </div>
      </div>

      {/* Top 3 callouts */}
      <div style={top3Row}>
        {top3.map((s) => (
          <div key={s.plan.id} style={top3Card(s.rank)}>
            <div style={top3Rank}>#{s.rank} · {s.plan.carrier}</div>
            <div style={top3Name}>{s.plan.plan_name}</div>
            <div style={top3Composite}>composite <strong>{s.composite.toFixed(1)}</strong></div>
            {s.ribbon && (
              <div style={ribbonChip(RIBBON_TONE[s.ribbon])}>{RIBBON_LABEL[s.ribbon]}</div>
            )}
            <div style={top3Break}>{s.breakdown}</div>
          </div>
        ))}
      </div>

      {/* Sortable flat table */}
      <div style={tableWrap}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <ColHeader label="Plan" k="plan" sortKey={sortKey} sortDir={sortDir} onSort={(k) => toggle(k, sortKey, sortDir, setSortKey, setSortDir)} />
              <ColHeader label="Composite" k="composite" sortKey={sortKey} sortDir={sortDir} numeric onSort={(k) => toggle(k, sortKey, sortDir, setSortKey, setSortDir)} />
              <ColHeader label="Drug Cost" k="drug" sortKey={sortKey} sortDir={sortDir} numeric onSort={(k) => toggle(k, sortKey, sortDir, setSortKey, setSortDir)} />
              <ColHeader label="OOP Est" k="oop" sortKey={sortKey} sortDir={sortDir} numeric onSort={(k) => toggle(k, sortKey, sortDir, setSortKey, setSortDir)} />
              <ColHeader label="Extras Value" k="extras" sortKey={sortKey} sortDir={sortDir} numeric onSort={(k) => toggle(k, sortKey, sortDir, setSortKey, setSortDir)} />
              <th style={thBase}>Ribbon</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.plan.id} style={s.rank === 1 ? rowTop : undefined}>
                <td style={tdBase}>
                  <div style={{ fontWeight: 700 }}>{s.plan.carrier}</div>
                  <div style={tdSub}>{s.plan.plan_name}</div>
                  <div style={tdSub}>{s.plan.id}</div>
                </td>
                <td style={tdNum}>
                  <strong>{s.composite.toFixed(1)}</strong>
                  {s.providerBoost !== 0 && (
                    <div style={tdSub}>{s.providerBoost > 0 ? `+${s.providerBoost} network` : `${s.providerBoost} network`}</div>
                  )}
                </td>
                <td style={tdNum}>
                  <div>{s.drugScore}</div>
                  <div style={tdSub}>${s.totalAnnualDrugCost.toLocaleString()}/yr</div>
                </td>
                <td style={tdNum}>
                  <div>{s.oopScore}</div>
                  <div style={tdSub}>${s.totalOOPEstimate.toLocaleString()}/yr</div>
                </td>
                <td style={tdNum}>
                  <div>{s.extrasScore}</div>
                  <div style={tdSub}>${s.extrasValue.toLocaleString()}/yr</div>
                </td>
                <td style={tdBase}>
                  {s.ribbon ? (
                    <span style={ribbonChip(RIBBON_TONE[s.ribbon])}>{RIBBON_LABEL[s.ribbon]}</span>
                  ) : (
                    <span style={tdSub}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {result.filteredOut.length > 0 && (
        <div style={{ padding: '8px 14px', fontSize: 11, color: '#6b7280' }}>
          {result.filteredOut.length} plan{result.filteredOut.length === 1 ? '' : 's'} filtered out by SNP rules.
        </div>
      )}
    </div>
  );
}

function ColHeader({
  label, k, sortKey, sortDir, onSort, numeric,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (k: SortKey) => void;
  numeric?: boolean;
}) {
  const active = sortKey === k;
  const arrow = active ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '';
  return (
    <th
      onClick={() => onSort(k)}
      style={{
        ...thBase,
        cursor: 'pointer',
        textAlign: numeric ? 'right' : 'left',
        background: active ? '#f1f5f9' : '#f8fafc',
      }}
    >
      {label}{arrow}
    </th>
  );
}

function pickValue(s: ScoredPlan, key: SortKey): number | string {
  switch (key) {
    case 'plan': return s.plan.plan_name;
    case 'composite': return s.composite;
    case 'drug': return s.drugScore;
    case 'oop': return s.oopScore;
    case 'extras': return s.extrasScore;
  }
}

function toggle(
  next: SortKey,
  current: SortKey,
  dir: 'asc' | 'desc',
  setKey: (k: SortKey) => void,
  setDir: (d: 'asc' | 'desc') => void,
) {
  if (current === next) {
    setDir(dir === 'asc' ? 'desc' : 'asc');
  } else {
    setKey(next);
    // Default direction: numeric → desc, alphabetic plan name → asc.
    setDir(next === 'plan' ? 'asc' : 'desc');
  }
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

// ─── styles ─────────────────────────────────────────────────────────
const panel: React.CSSProperties = {
  border: '1px solid #e5e7eb', borderRadius: 12, background: '#ffffff',
  margin: '0 0 16px', overflow: 'hidden',
};
const hdr: React.CSSProperties = {
  padding: '12px 16px', borderBottom: '1px solid #e5e7eb', background: '#f8fafc',
};
const hdrTitle: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: '#0d2f5e' };
const hdrSub: React.CSSProperties = { fontSize: 11, color: '#6b7280', marginTop: 2 };
const top3Row: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 10, padding: 14,
};
const top3Card = (rank: number): React.CSSProperties => ({
  border: '1px solid', borderColor: rank === 1 ? '#0d2f5e' : '#e5e7eb',
  borderRadius: 10, padding: 12, background: rank === 1 ? '#f0f9ff' : '#ffffff',
});
const top3Rank: React.CSSProperties = { fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' };
const top3Name: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: '#0d2f5e', marginTop: 4 };
const top3Composite: React.CSSProperties = { fontSize: 11, color: '#374151', marginTop: 4 };
const top3Break: React.CSSProperties = { fontSize: 11, color: '#6b7280', marginTop: 8, lineHeight: 1.4 };
const ribbonChip = (tone: string): React.CSSProperties => ({
  display: 'inline-block', fontSize: 10, fontWeight: 700, color: tone,
  background: 'rgba(0,0,0,0.04)', border: `1px solid ${tone}`,
  padding: '2px 8px', borderRadius: 999, marginTop: 6,
});
const tableWrap: React.CSSProperties = { overflowX: 'auto', borderTop: '1px solid #e5e7eb' };
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 12 };
const thBase: React.CSSProperties = {
  padding: '8px 12px', borderBottom: '1px solid #e5e7eb', textAlign: 'left',
  fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
  color: '#374151', background: '#f8fafc',
};
const tdBase: React.CSSProperties = {
  padding: '10px 12px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'top',
};
const tdNum: React.CSSProperties = { ...tdBase, textAlign: 'right' };
const tdSub: React.CSSProperties = { fontSize: 10, color: '#6b7280', marginTop: 2 };
const rowTop: React.CSSProperties = { background: '#f0f9ff' };
