// QuoteDeliveryV4 — sortable agent quote comparison table.
//
// Wires Plan Brain's ranked output into a flat table. Top 3 picks (by
// composite, regardless of current sort) stay pinned at the top with a
// colored left border. Click any column header to sort.
//
// Weight sliders (Drug / Medical / Extras) above the table recompute
// the composite from each plan's cached drug/oop/extras axis scores in
// real time — no re-fetching, no re-running runPlanBrain. Preset chips
// snap the sliders to common profiles.
//
// Filter toggles narrow the visible plan pool: Show SNPs, $0 Premium
// only, Giveback only.
//
// Each row exposes a SunFire button that opens the consumer-portal
// deep link in a new tab.
//
// Design tokens follow the brief: navy #0a3040 header, alternating
// white / #f8fafc rows, DM Sans body, Fraunces for headings.

import { useMemo, useState } from 'react';
import type { Plan } from '@/types/plans';
import type { Client, Medication, Provider } from '@/types/session';
import { usePlanBrain } from '@/hooks/usePlanBrain';
import type {
  PlanBrainResult,
  RibbonKey,
  ScoredPlan,
  WeightProfile,
} from '@/lib/plan-brain-types';

const SUNFIRE_URL =
  'https://www.sunfirematrix.com/app/consumer/yourmedicare/10447418';

// ─── Presets (Drug / Medical / Extras) ──────────────────────────────
const PRESETS: { key: PresetKey; label: string; weights: WeightProfile }[] = [
  { key: 'standard',    label: 'Standard 50/30/20',     weights: { drug: 0.50, oop: 0.30, extras: 0.20 } },
  { key: 'drugHeavy',   label: 'Drug-Heavy 70/20/10',   weights: { drug: 0.70, oop: 0.20, extras: 0.10 } },
  { key: 'extrasHeavy', label: 'Extras-Heavy 20/20/60', weights: { drug: 0.20, oop: 0.20, extras: 0.60 } },
  { key: 'healthy',     label: 'Healthy 30/40/30',      weights: { drug: 0.30, oop: 0.40, extras: 0.30 } },
];
type PresetKey = 'standard' | 'drugHeavy' | 'extrasHeavy' | 'healthy';

const RIBBON_LABEL: Record<RibbonKey, string> = {
  BEST_OVERALL:        'Best overall',
  LOWEST_DRUG_COST:    'Lowest Rx',
  LOWEST_OOP:          'Lowest OOP',
  BEST_EXTRAS:         'Best extras',
  ALL_DOCS_IN_NETWORK: 'All in-network',
  PART_B_SAVINGS:      'Part B giveback',
  ZERO_PREMIUM:        '$0 premium',
  ALL_MEDS_COVERED:    'All meds covered',
};

const RIBBON_TONE: Record<RibbonKey, { bg: string; fg: string }> = {
  BEST_OVERALL:        { bg: '#0a3040', fg: '#ffffff' },
  LOWEST_DRUG_COST:    { bg: '#dcfce7', fg: '#166534' },
  LOWEST_OOP:          { bg: '#cffafe', fg: '#0e7490' },
  BEST_EXTRAS:         { bg: '#fef3c7', fg: '#92400e' },
  ALL_DOCS_IN_NETWORK: { bg: '#dbeafe', fg: '#1e40af' },
  PART_B_SAVINGS:      { bg: '#dcfce7', fg: '#166534' },
  ZERO_PREMIUM:        { bg: '#dcfce7', fg: '#166534' },
  ALL_MEDS_COVERED:    { bg: '#dcfce7', fg: '#166534' },
};

// Scoped CSS — everything sits under `.qv4` so the page-level v4 chrome
// outside this component (header, sticky bbar, page hero) stays
// untouched.
const CSS = `
.qv4 {
  font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
  color: #1f2937; font-size: 13px;
  -webkit-font-smoothing: antialiased;
}
.qv4 *, .qv4 *::before, .qv4 *::after { box-sizing: border-box; }
.qv4 .qv4-h, .qv4 h1, .qv4 h2, .qv4 h3 { font-family: 'Fraunces', Georgia, serif; }

/* ── summary strip ── */
.qv4-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px; margin-bottom: 14px; }
.qv4-summary-card { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 10px;
  padding: 12px 14px; }
.qv4-summary-label { font-size: 10px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: #6b7280; }
.qv4-summary-value { font-family: 'Fraunces', Georgia, serif; font-size: 22px; font-weight: 700;
  color: #0a3040; line-height: 1; margin-top: 4px; }
.qv4-summary-sub { font-size: 11px; color: #6b7280; margin-top: 3px; }

/* ── controls panel ── */
.qv4-controls { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px;
  padding: 16px; margin-bottom: 14px; display: grid; gap: 14px; }
.qv4-controls-title { font-family: 'Fraunces', Georgia, serif; font-size: 14px; font-weight: 700;
  color: #0a3040; margin: 0; }
.qv4-presets { display: flex; flex-wrap: wrap; gap: 6px; }
.qv4-preset { padding: 6px 12px; border-radius: 7px; border: 1px solid #d1d5db;
  background: #ffffff; font-family: 'DM Sans', sans-serif; font-size: 12px; font-weight: 600;
  color: #374151; cursor: pointer; transition: all 0.12s; }
.qv4-preset:hover { background: #f3f4f6; border-color: #0a3040; }
.qv4-preset.active { background: #0a3040; color: #ffffff; border-color: #0a3040; }

.qv4-sliders { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px;
  border-top: 1px solid #f1f5f9; padding-top: 12px; }
.qv4-slider-block { display: flex; flex-direction: column; gap: 4px; }
.qv4-slider-row { display: flex; justify-content: space-between; align-items: baseline;
  font-size: 12px; font-weight: 600; color: #374151; }
.qv4-slider-pct { font-family: 'JetBrains Mono', monospace; font-weight: 700; color: #0a3040; }
.qv4-slider-block input[type="range"] { width: 100%; accent-color: #0a3040; }

.qv4-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  border-top: 1px solid #f1f5f9; padding-top: 12px; }
.qv4-filter-label { font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: #6b7280; margin-right: 4px; }
.qv4-toggle { display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 11px; border-radius: 999px; cursor: pointer;
  border: 1px solid #d1d5db; background: #ffffff;
  font-size: 12px; font-weight: 600; color: #374151;
  transition: all 0.12s; user-select: none; }
.qv4-toggle:hover { border-color: #0a3040; }
.qv4-toggle.on { background: #0a3040; color: #ffffff; border-color: #0a3040; }

/* ── table ── */
.qv4-table-wrap { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px;
  overflow-x: auto; }
.qv4-table { width: 100%; border-collapse: collapse; font-family: 'DM Sans', sans-serif; }
.qv4-table thead th { background: #0a3040; color: #ffffff;
  font-family: 'DM Sans', sans-serif;
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
  padding: 12px 12px; text-align: left; cursor: pointer; user-select: none;
  white-space: nowrap; border-bottom: 1px solid #062130; }
.qv4-table thead th.numeric { text-align: right; }
.qv4-table thead th.action { cursor: default; text-align: center; }
.qv4-table thead th:hover:not(.action) { background: #11475d; }
.qv4-table thead th.active { background: #11475d; }
.qv4-table thead th .arrow { color: #83f0f9; margin-left: 4px; }

.qv4-table tbody tr { border-left: 4px solid transparent; background: #ffffff;
  transition: background 0.12s; }
.qv4-table tbody tr.alt { background: #f8fafc; }
.qv4-table tbody tr.top1 { border-left-color: #f59e0b; background: #fffbeb; }
.qv4-table tbody tr.top2 { border-left-color: #10b981; background: #ecfdf5; }
.qv4-table tbody tr.top3 { border-left-color: #3b82f6; background: #eff6ff; }
.qv4-table tbody tr:hover { background: #f1f5f9; }
.qv4-table tbody tr.top1:hover { background: #fef3c7; }
.qv4-table tbody tr.top2:hover { background: #d1fae5; }
.qv4-table tbody tr.top3:hover { background: #dbeafe; }

.qv4-table td { padding: 10px 12px; border-bottom: 1px solid #f1f5f9;
  vertical-align: middle; font-size: 13px; }
.qv4-table td.numeric { text-align: right; font-variant-numeric: tabular-nums; }
.qv4-table td.action { text-align: center; }
.qv4-table td.plan-cell { min-width: 200px; }

.qv4-rank-badge { display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 50%; font-family: 'JetBrains Mono', monospace;
  font-size: 11px; font-weight: 700; margin-right: 8px; vertical-align: middle; }
.qv4-rank-badge.r1 { background: #f59e0b; color: #ffffff; }
.qv4-rank-badge.r2 { background: #10b981; color: #ffffff; }
.qv4-rank-badge.r3 { background: #3b82f6; color: #ffffff; }
.qv4-rank-badge.rN { background: #e5e7eb; color: #475569; }

.qv4-plan-name { font-weight: 700; color: #0a3040; line-height: 1.25; }
.qv4-plan-id { font-family: 'JetBrains Mono', monospace; font-size: 10px;
  color: #94a3b8; margin-top: 2px; }

.qv4-rib { display: inline-block; padding: 3px 8px; border-radius: 4px;
  font-size: 10px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.04em; white-space: nowrap; }

.qv4-composite { font-family: 'JetBrains Mono', monospace; font-weight: 700;
  font-size: 14px; color: #0a3040; }

.qv4-cov-bad { color: #b91c1c; font-weight: 700; }
.qv4-cov-ok  { color: #047857; font-weight: 700; }
.qv4-prov-in  { color: #047857; font-weight: 600; }
.qv4-prov-out { color: #b91c1c; font-weight: 600; }
.qv4-prov-unk { color: #94a3b8; font-weight: 500; }

.qv4-sf-btn { display: inline-flex; align-items: center; gap: 4px;
  padding: 6px 12px; border-radius: 6px; background: #0a3040; color: #ffffff;
  border: none; font-family: 'DM Sans', sans-serif; font-size: 11px; font-weight: 600;
  cursor: pointer; transition: background 0.12s; text-decoration: none;
  white-space: nowrap; }
.qv4-sf-btn:hover { background: #11475d; }

.qv4-rec-btn { display: inline-block; margin-top: 4px; padding: 4px 10px;
  border-radius: 6px; border: 1px solid #d1d5db; background: #ffffff;
  font-family: 'DM Sans', sans-serif; font-size: 10px; font-weight: 600;
  color: #374151; cursor: pointer; transition: all 0.12s; }
.qv4-rec-btn:hover { border-color: #0a3040; }
.qv4-rec-btn.on { background: #0a3040; color: #ffffff; border-color: #0a3040; }

.qv4-loading, .qv4-empty { padding: 28px; text-align: center; color: #6b7280;
  font-size: 13px; background: #ffffff; border: 1px dashed #e5e7eb; border-radius: 12px; }
`;

// ─── Sort + row types ───────────────────────────────────────────────
type SortKey =
  | 'plan' | 'carrier' | 'ribbon'
  | 'drugMonthly' | 'drugAnnual' | 'oop'
  | 'premium' | 'moop' | 'extras' | 'composite'
  | 'meds' | 'providers' | 'giveback';

interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

interface Row {
  plan: Plan;
  scored: ScoredPlan;
  composite: number;        // recomputed under current weights
  rank: number;             // 1-based rank under current weights
  monthlyDrug: number;      // round(annual / 12)
  ribbon: RibbonKey | null;
}

interface Props {
  finalists: Plan[];
  client: Client;
  medications: Medication[];
  providers: Provider[];
  recommendation?: string | null;
  onRecommend?: (id: string | null) => void;
}

export function QuoteDeliveryV4({
  finalists,
  client,
  medications,
  providers,
  recommendation,
  onRecommend,
}: Props) {
  const [weights, setWeights] = useState<WeightProfile>(PRESETS[0].weights);
  const [showSnps, setShowSnps] = useState(false);
  const [zeroPremiumOnly, setZeroPremiumOnly] = useState(false);
  const [givebackOnly, setGivebackOnly] = useState(false);
  const [sort, setSort] = useState<SortState>({ key: 'composite', dir: 'desc' });

  // Plan Brain runs once with default weights; we recompute composite
  // locally from the cached axis scores when the sliders move so sliders
  // feel instant.
  const { result, loading } = usePlanBrain({
    plans: finalists,
    client,
    medications,
    providers,
  });

  const presetKey = useMemo(() => detectPreset(weights), [weights]);
  const rows = useMemo(() => buildRows(result, weights), [result, weights]);

  const filtered = useMemo(
    () => rows.filter((r) => {
      if (!showSnps && looksLikeSnp(r.plan)) return false;
      if (zeroPremiumOnly && r.plan.premium > 0) return false;
      if (givebackOnly && (r.plan.part_b_giveback ?? 0) <= 0) return false;
      return true;
    }),
    [rows, showSnps, zeroPremiumOnly, givebackOnly],
  );

  // Pin top 3 by composite to the top regardless of current sort.
  const display = useMemo(() => {
    const top3Ids = new Set(
      [...filtered].sort((a, b) => b.composite - a.composite).slice(0, 3).map((r) => r.plan.id),
    );
    const sorted = sortRows(filtered, sort);
    const pinned = sorted.filter((r) => top3Ids.has(r.plan.id))
      .sort((a, b) => a.rank - b.rank);
    const rest = sorted.filter((r) => !top3Ids.has(r.plan.id));
    return [...pinned, ...rest];
  }, [filtered, sort]);

  if (loading && !result) {
    return (
      <div className="qv4">
        <style>{CSS}</style>
        <div className="qv4-loading">Plan Brain scoring plans…</div>
      </div>
    );
  }

  if (!result || result.scored.length === 0) {
    return (
      <div className="qv4">
        <style>{CSS}</style>
        <div className="qv4-empty">
          No finalists scored yet. Complete steps 2–5 so Plan Brain has plans to rank.
        </div>
      </div>
    );
  }

  return (
    <div className="qv4">
      <style>{CSS}</style>

      <SummaryStrip rows={rows} totalMeds={medications.length} />

      <div className="qv4-controls">
        <h3 className="qv4-controls-title">Score Weights</h3>
        <div className="qv4-presets">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`qv4-preset${presetKey === p.key ? ' active' : ''}`}
              onClick={() => setWeights(p.weights)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="qv4-sliders">
          <SliderBlock
            label="Drug"
            value={weights.drug}
            onChange={(v) => setWeights((w) => updateWeight(w, 'drug', v))}
          />
          <SliderBlock
            label="Medical"
            value={weights.oop}
            onChange={(v) => setWeights((w) => updateWeight(w, 'oop', v))}
          />
          <SliderBlock
            label="Extras"
            value={weights.extras}
            onChange={(v) => setWeights((w) => updateWeight(w, 'extras', v))}
          />
        </div>
        <div className="qv4-filters">
          <span className="qv4-filter-label">Filter</span>
          <FilterToggle on={showSnps} onClick={() => setShowSnps((v) => !v)} label="Show SNPs" />
          <FilterToggle on={zeroPremiumOnly} onClick={() => setZeroPremiumOnly((v) => !v)} label="$0 Premium Only" />
          <FilterToggle on={givebackOnly} onClick={() => setGivebackOnly((v) => !v)} label="Giveback Only" />
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6b7280', fontFamily: 'JetBrains Mono, monospace' }}>
            {filtered.length} / {rows.length} plans
          </span>
        </div>
      </div>

      <div className="qv4-table-wrap">
        <table className="qv4-table">
          <thead>
            <tr>
              <Header label="Plan Name"    k="plan"        sort={sort} onSort={setSort} />
              <Header label="Carrier"      k="carrier"     sort={sort} onSort={setSort} />
              <Header label="Ribbon"       k="ribbon"      sort={sort} onSort={setSort} />
              <Header label="Mo Drug"      k="drugMonthly" sort={sort} onSort={setSort} numeric />
              <Header label="Annual Drug"  k="drugAnnual"  sort={sort} onSort={setSort} numeric />
              <Header label="OOP Est"      k="oop"         sort={sort} onSort={setSort} numeric />
              <Header label="Premium"      k="premium"     sort={sort} onSort={setSort} numeric />
              <Header label="MOOP"         k="moop"        sort={sort} onSort={setSort} numeric />
              <Header label="Extras"       k="extras"      sort={sort} onSort={setSort} numeric />
              <Header label="Score"        k="composite"   sort={sort} onSort={setSort} numeric />
              <Header label="Meds"         k="meds"        sort={sort} onSort={setSort} />
              <Header label="Providers"    k="providers"   sort={sort} onSort={setSort} />
              <Header label="Giveback"     k="giveback"    sort={sort} onSort={setSort} numeric />
              <th className="action">Action</th>
            </tr>
          </thead>
          <tbody>
            {display.map((row, idx) => {
              const top = row.rank === 1 ? 'top1'
                : row.rank === 2 ? 'top2'
                : row.rank === 3 ? 'top3'
                : (idx % 2 === 1 ? 'alt' : '');
              return (
                <tr key={row.plan.id} className={top}>
                  <td className="plan-cell">
                    <span className={`qv4-rank-badge ${row.rank === 1 ? 'r1' : row.rank === 2 ? 'r2' : row.rank === 3 ? 'r3' : 'rN'}`}>
                      {row.rank}
                    </span>
                    <span style={{ display: 'inline-block', verticalAlign: 'middle' }}>
                      <div className="qv4-plan-name">{row.plan.plan_name}</div>
                      <div className="qv4-plan-id">{row.plan.id}</div>
                    </span>
                  </td>
                  <td>{row.plan.carrier}</td>
                  <td>{ribbonBadge(row.ribbon)}</td>
                  <td className="numeric">${row.monthlyDrug.toLocaleString()}</td>
                  <td className="numeric">${row.scored.totalAnnualDrugCost.toLocaleString()}</td>
                  <td className="numeric">${row.scored.totalOOPEstimate.toLocaleString()}</td>
                  <td className="numeric">${row.plan.premium}</td>
                  <td className="numeric">${row.plan.moop_in_network.toLocaleString()}</td>
                  <td className="numeric">${row.scored.extrasValue.toLocaleString()}</td>
                  <td className="numeric"><span className="qv4-composite">{row.composite.toFixed(1)}</span></td>
                  <td>{medsCoveredCell(row.scored, medications.length)}</td>
                  <td>{providerCell(row.scored.providerNetworkStatus)}</td>
                  <td className="numeric">{row.plan.part_b_giveback > 0 ? `$${row.plan.part_b_giveback}/mo` : '—'}</td>
                  <td className="action">
                    <a
                      className="qv4-sf-btn"
                      href={SUNFIRE_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      SunFire ↗
                    </a>
                    {onRecommend && (
                      <button
                        type="button"
                        className={`qv4-rec-btn${recommendation === row.plan.id ? ' on' : ''}`}
                        onClick={() => onRecommend(recommendation === row.plan.id ? null : row.plan.id)}
                      >
                        {recommendation === row.plan.id ? 'Recommended' : 'Recommend'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {display.length === 0 && (
              <tr>
                <td colSpan={14} style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>
                  No plans match the current filter combination.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {result.filteredOut.length > 0 && (
        <div style={{ padding: '10px 4px', fontSize: 11, color: '#6b7280' }}>
          {result.filteredOut.length} plan{result.filteredOut.length === 1 ? '' : 's'} filtered out by SNP rules.
        </div>
      )}

      {client.county && (
        <div style={{ padding: '4px', fontSize: 10, color: '#94a3b8' }}>
          Population: {result.population.toUpperCase()} · Utilization: {result.utilization} · {client.county}, {client.state}
        </div>
      )}
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────

function SliderBlock({
  label, value, onChange,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="qv4-slider-block">
      <div className="qv4-slider-row">
        <span>{label}</span>
        <span className="qv4-slider-pct">{Math.round(value * 100)}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
    </div>
  );
}

function FilterToggle({
  on, onClick, label,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`qv4-toggle${on ? ' on' : ''}`}
      onClick={onClick}
      aria-pressed={on}
    >
      <span aria-hidden>{on ? '✓' : '○'}</span>
      {label}
    </button>
  );
}

function Header({
  label, k, sort, onSort, numeric,
}: {
  label: string;
  k: SortKey;
  sort: SortState;
  onSort: (next: SortState) => void;
  numeric?: boolean;
}) {
  const active = sort.key === k;
  const arrow = active ? (sort.dir === 'desc' ? '↓' : '↑') : '';
  return (
    <th
      className={`${numeric ? 'numeric' : ''}${active ? ' active' : ''}`}
      onClick={() => {
        if (active) onSort({ key: k, dir: sort.dir === 'asc' ? 'desc' : 'asc' });
        else onSort({ key: k, dir: numeric ? 'desc' : 'asc' });
      }}
    >
      {label}
      {arrow ? <span className="arrow">{arrow}</span> : null}
    </th>
  );
}

function SummaryStrip({ rows, totalMeds }: { rows: Row[]; totalMeds: number }) {
  if (rows.length === 0) return null;
  const top = [...rows].sort((a, b) => b.composite - a.composite)[0];
  const lowestRx = rows.reduce(
    (acc, r) => (r.scored.totalAnnualDrugCost < acc.scored.totalAnnualDrugCost ? r : acc),
    rows[0],
  );
  const bestExtras = rows.reduce(
    (acc, r) => (r.scored.extrasValue > acc.scored.extrasValue ? r : acc),
    rows[0],
  );
  return (
    <div className="qv4-summary">
      <div className="qv4-summary-card">
        <div className="qv4-summary-label">Plans scored</div>
        <div className="qv4-summary-value">{rows.length}</div>
        <div className="qv4-summary-sub">{totalMeds} med{totalMeds === 1 ? '' : 's'} factored in</div>
      </div>
      <div className="qv4-summary-card">
        <div className="qv4-summary-label">Top score</div>
        <div className="qv4-summary-value">{top.composite.toFixed(1)}</div>
        <div className="qv4-summary-sub">{top.plan.carrier}</div>
      </div>
      <div className="qv4-summary-card">
        <div className="qv4-summary-label">Lowest annual Rx</div>
        <div className="qv4-summary-value">${lowestRx.scored.totalAnnualDrugCost.toLocaleString()}</div>
        <div className="qv4-summary-sub">{lowestRx.plan.carrier}</div>
      </div>
      <div className="qv4-summary-card">
        <div className="qv4-summary-label">Best extras</div>
        <div className="qv4-summary-value">${bestExtras.scored.extrasValue.toLocaleString()}</div>
        <div className="qv4-summary-sub">{bestExtras.plan.carrier}</div>
      </div>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────

function buildRows(
  result: PlanBrainResult | null,
  weights: WeightProfile,
): Row[] {
  if (!result) return [];
  const recomputed = result.scored.map((s) => {
    const composite =
      s.drugScore * weights.drug +
      s.oopScore * weights.oop +
      s.extrasScore * weights.extras +
      s.providerBoost;
    return { scored: s, composite };
  });
  recomputed.sort((a, b) => b.composite - a.composite);
  return recomputed.map((r, i) => ({
    plan: r.scored.plan,
    scored: r.scored,
    composite: Math.round(r.composite * 100) / 100,
    rank: i + 1,
    monthlyDrug: Math.round(r.scored.totalAnnualDrugCost / 12),
    ribbon: r.scored.ribbon,
  }));
}

function detectPreset(w: WeightProfile): PresetKey | null {
  for (const p of PRESETS) {
    if (
      Math.abs(p.weights.drug - w.drug) < 0.005 &&
      Math.abs(p.weights.oop - w.oop) < 0.005 &&
      Math.abs(p.weights.extras - w.extras) < 0.005
    ) return p.key;
  }
  return null;
}

// Update one axis to `value` and rescale the other two so the three
// weights still sum to 1.0. When the other two are both zero, split the
// remainder evenly so the user can still raise them by sliding.
function updateWeight(
  w: WeightProfile,
  axis: keyof WeightProfile,
  value: number,
): WeightProfile {
  const clamped = Math.min(1, Math.max(0, value));
  const others: (keyof WeightProfile)[] = (['drug', 'oop', 'extras'] as const).filter(
    (k) => k !== axis,
  );
  const next: WeightProfile = { ...w, [axis]: clamped };
  const otherSum = others.reduce((acc, k) => acc + w[k], 0);
  const rest = Math.max(0, 1 - clamped);
  if (otherSum <= 0) {
    others.forEach((k) => { next[k] = rest / 2; });
  } else {
    others.forEach((k) => { next[k] = (w[k] / otherSum) * rest; });
  }
  return next;
}

function looksLikeSnp(plan: Plan): boolean {
  const blob = `${plan.plan_name ?? ''} ${plan.plan_type ?? ''}`.toUpperCase();
  if (/\bD-?SNP\b/.test(blob) || /\bC-?SNP\b/.test(blob) || /\bI-?SNP\b/.test(blob)) return true;
  return plan.plan_type === 'DSNP';
}

function sortRows(rows: Row[], sort: SortState): Row[] {
  const arr = [...rows];
  arr.sort((a, b) => {
    const va = pickSortValue(a, sort.key);
    const vb = pickSortValue(b, sort.key);
    if (typeof va === 'string' && typeof vb === 'string') {
      return sort.dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    const na = typeof va === 'number' ? va : 0;
    const nb = typeof vb === 'number' ? vb : 0;
    return sort.dir === 'asc' ? na - nb : nb - na;
  });
  return arr;
}

function pickSortValue(r: Row, key: SortKey): number | string {
  switch (key) {
    case 'plan':        return r.plan.plan_name;
    case 'carrier':     return r.plan.carrier;
    case 'ribbon':      return r.ribbon ? RIBBON_LABEL[r.ribbon] : '~';
    case 'drugMonthly': return r.monthlyDrug;
    case 'drugAnnual':  return r.scored.totalAnnualDrugCost;
    case 'oop':         return r.scored.totalOOPEstimate;
    case 'premium':     return r.plan.premium;
    case 'moop':        return r.plan.moop_in_network;
    case 'extras':      return r.scored.extrasValue;
    case 'composite':   return r.composite;
    case 'meds':        return -r.scored.uncoveredDrugRxcuis.length;
    case 'providers':   return providerSortValue(r.scored.providerNetworkStatus);
    case 'giveback':    return r.plan.part_b_giveback ?? 0;
  }
}

function providerSortValue(status: ScoredPlan['providerNetworkStatus']): number {
  switch (status) {
    case 'all_in':  return 3;
    case 'partial': return 2;
    case 'unknown': return 1;
    case 'all_out': return 0;
  }
}

function ribbonBadge(rk: RibbonKey | null) {
  if (!rk) return <span style={{ color: '#94a3b8' }}>—</span>;
  const tone = RIBBON_TONE[rk];
  return (
    <span className="qv4-rib" style={{ background: tone.bg, color: tone.fg }}>
      {RIBBON_LABEL[rk]}
    </span>
  );
}

function medsCoveredCell(s: ScoredPlan, totalMeds: number) {
  if (totalMeds === 0) return <span style={{ color: '#94a3b8' }}>—</span>;
  const uncovered = s.uncoveredDrugRxcuis.length;
  const covered = totalMeds - uncovered;
  return (
    <span className={uncovered === 0 ? 'qv4-cov-ok' : 'qv4-cov-bad'}>
      {covered}/{totalMeds}
    </span>
  );
}

function providerCell(status: ScoredPlan['providerNetworkStatus']) {
  switch (status) {
    case 'all_in':  return <span className="qv4-prov-in">All in</span>;
    case 'partial': return <span className="qv4-prov-out">Partial</span>;
    case 'all_out': return <span className="qv4-prov-out">All out</span>;
    case 'unknown': return <span className="qv4-prov-unk">—</span>;
  }
}
