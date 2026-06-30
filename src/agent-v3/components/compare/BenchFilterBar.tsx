// BenchFilterBar — the multi-dimensional bench filter UI.
//
// Renders the bench section header (title + filtered/total count badge +
// sort dropdown) on top, a white filter bar with search and five filter
// dropdowns below, and a dismissible active-chip row underneath. All
// state lives in useBenchFilters; this component is pure presentation.

import type { CSSProperties } from 'react';
import { FilterDropdown } from './FilterDropdown';
import {
  SORT_OPTIONS,
  type SortKey,
  type UseBenchFiltersResult,
} from '../../hooks/useBenchFilters';

const NAVY = '#0d2f5e';
const TEAL = '#14b8a6';
const SEAFOAM = '#67e8f9';
const CORAL = '#ef4444';
const PURPLE = '#7c3aed';
const EMERALD = '#059669';
const BORDER = '#e2e8f0';
const TEXT = '#0f172a';
const MUTED = '#64748b';
const FONT_LABEL = "'DM Sans', system-ui, sans-serif";
const FONT_NUM = "'JetBrains Mono', ui-monospace, monospace";

interface BenchFilterBarProps {
  filters: UseBenchFiltersResult;
}

export function BenchFilterBar({ filters }: BenchFilterBarProps) {
  const {
    filtered,
    totalCount,
    filterState,
    setters,
    filterOptions,
    activeFilterCount,
    activeChips,
    clearAll,
  } = filters;

  const filtersActive = activeFilterCount > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <HeaderRow
        filteredCount={filtered.length}
        totalCount={totalCount}
        filtersActive={filtersActive}
        sort={filterState.sort}
        onSortChange={setters.setSort}
      />

      <div
        style={{
          background: 'white',
          border: `1px solid ${BORDER}`,
          borderRadius: 10,
          padding: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <input
          type="search"
          placeholder="Search carrier, plan name, contract or PBP…"
          value={filterState.search}
          onChange={(e) => setters.setSearch(e.target.value)}
          style={{
            flex: '1 1 200px',
            minWidth: 180,
            padding: '6px 10px',
            border: `1px solid ${BORDER}`,
            borderRadius: 8,
            fontFamily: FONT_LABEL,
            fontSize: 12,
            color: TEXT,
            outline: 'none',
          }}
        />

        <Divider />

        <FilterDropdown
          label="Plan Type"
          options={filterOptions.planType}
          selected={filterState.planType}
          onChange={setters.setPlanType}
          accentColor={NAVY}
        />
        <FilterDropdown
          label="Network"
          options={filterOptions.network}
          selected={filterState.network}
          onChange={setters.setNetwork}
          accentColor={NAVY}
        />
        <FilterDropdown
          label="SNP"
          options={filterOptions.snp}
          selected={filterState.snp}
          onChange={setters.setSnp}
          accentColor={CORAL}
        />
        <FilterDropdown
          label="Carrier"
          options={filterOptions.carrier}
          selected={filterState.carrier}
          onChange={setters.setCarrier}
          accentColor={PURPLE}
        />
        <FilterDropdown
          label="Cost & Quality"
          options={filterOptions.costQuality}
          selected={filterState.costQuality}
          onChange={setters.setCostQuality}
          accentColor={EMERALD}
        />

        {filtersActive && (
          <button
            type="button"
            onClick={clearAll}
            style={{
              background: 'transparent',
              color: MUTED,
              border: `1px solid ${BORDER}`,
              borderRadius: 14,
              padding: '5px 10px',
              fontFamily: FONT_LABEL,
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              letterSpacing: 0.2,
              marginLeft: 'auto',
            }}
          >
            Clear all
          </button>
        )}
      </div>

      {activeChips.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              fontFamily: FONT_LABEL,
              fontSize: 10,
              fontWeight: 700,
              color: MUTED,
              textTransform: 'uppercase',
              letterSpacing: 0.6,
              marginRight: 4,
            }}
          >
            Active filters
          </span>
          {activeChips.map((chip) => (
            <ActiveChipPill key={chip.id} label={chip.label} onRemove={chip.onRemove} />
          ))}
        </div>
      )}
    </div>
  );
}

function HeaderRow({
  filteredCount,
  totalCount,
  filtersActive,
  sort,
  onSortChange,
}: {
  filteredCount: number;
  totalCount: number;
  filtersActive: boolean;
  sort: SortKey;
  onSortChange: (next: SortKey) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontFamily: FONT_LABEL,
            fontSize: 10,
            fontWeight: 700,
            color: NAVY,
            textTransform: 'uppercase',
            letterSpacing: 0.8,
          }}
        >
          Bench — plans not on the board
        </span>
        <span
          style={{
            background: TEAL,
            color: 'white',
            fontFamily: FONT_NUM,
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 7px',
            borderRadius: 10,
          }}
        >
          {filteredCount}
        </span>
        {filtersActive && (
          <span
            style={{
              fontFamily: FONT_LABEL,
              fontSize: 10,
              fontWeight: 600,
              color: MUTED,
              letterSpacing: 0.4,
            }}
          >
            of {totalCount}
          </span>
        )}
      </div>

      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: FONT_LABEL,
          fontSize: 11,
          color: MUTED,
        }}
      >
        Sort
        <select
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SortKey)}
          style={{
            background: 'white',
            border: `1px solid ${BORDER}`,
            borderRadius: 8,
            padding: '4px 8px',
            fontFamily: FONT_LABEL,
            fontSize: 11,
            color: TEXT,
            cursor: 'pointer',
            outline: 'none',
          }}
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function ActiveChipPill({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: SEAFOAM,
    color: NAVY,
    fontFamily: FONT_LABEL,
    fontSize: 10,
    fontWeight: 700,
    padding: '3px 4px 3px 8px',
    borderRadius: 12,
    letterSpacing: 0.2,
  };
  return (
    <span style={style}>
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        style={{
          background: 'transparent',
          border: 'none',
          color: NAVY,
          cursor: 'pointer',
          padding: '0 2px',
          fontSize: 12,
          lineHeight: 1,
          fontWeight: 800,
        }}
      >
        ×
      </button>
    </span>
  );
}

function Divider() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 1,
        height: 22,
        background: BORDER,
        margin: '0 2px',
      }}
    />
  );
}
