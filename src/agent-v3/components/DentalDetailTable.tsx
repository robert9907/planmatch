// DentalDetailTable — the routine-dental per-category drill-down table.
//
// Rendered on the agent Compare grid (collapsible on each plan card), the
// Head-to-Head view (one block per side), and the client quote
// (QuoteDeliveryV4 uses the shared formatter directly — see dentalDetail.ts).
//
// Rows: Preventive + the comprehensive categories (fillings, root canals, gum
// care, extractions, crowns & bridges, dentures, implants). Columns: covered,
// in-network cost, out-of-network cost, frequency, prior auth. Plus the dental
// deductible (preventive + comprehensive) and annual max above the table.
//
// Missing data → "Not filed — call to verify" per cell (buildDentalDetailView);
// whole detail absent → one line, not an empty table. The one-line routine
// dental summary (benefits.dental.description) is rendered by the caller; this
// is the detail behind it. Does NOT touch Medicare-covered dental.

import { useState } from 'react';
import type { DentalDetail } from '@/types/plans';
import {
  buildDentalDetailView,
  DENTAL_NOT_FILED,
  type DentalDetailRow,
} from '@/lib/dentalDetail';

const LABEL_FONT = "'Inter', system-ui, sans-serif";
const NUM_FONT = "'IBM Plex Mono', ui-monospace, monospace";
const INK = '#0F172A';
const MUTED = '#64748B';
const LINE = '#E6E9EF';
const NOT_FILED_FG = '#9A5B0A';

function cellColor(v: string): string {
  if (v === DENTAL_NOT_FILED) return NOT_FILED_FG;
  if (v === 'Not covered' || v === 'No') return '#991b1b';
  return INK;
}

const COLS: { key: keyof DentalDetailRow; label: string }[] = [
  { key: 'covered', label: 'Covered' },
  { key: 'inNetwork', label: 'In-network' },
  { key: 'outNetwork', label: 'Out-of-network' },
  { key: 'frequency', label: 'Frequency' },
  { key: 'priorAuth', label: 'Prior auth' },
];

/** The table body + deductible/max summary. Caller controls the wrapper. */
export function DentalDetailBody({ detail }: { detail: DentalDetail | null | undefined }) {
  const view = buildDentalDetailView(detail);

  if (view.empty) {
    return (
      <div
        role="note"
        style={{
          fontFamily: LABEL_FONT,
          fontSize: 10.5,
          fontWeight: 600,
          color: NOT_FILED_FG,
          background: 'rgba(245,158,11,0.10)',
          border: '1px solid rgba(245,158,11,0.35)',
          borderRadius: 5,
          padding: '6px 8px',
        }}
      >
        Routine dental detail {DENTAL_NOT_FILED}
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 10,
          marginBottom: 6,
          fontFamily: NUM_FONT,
          fontSize: 10,
          color: MUTED,
        }}
      >
        <span>
          Annual max: <strong style={{ color: cellColor(view.annualMax) }}>{view.annualMax}</strong>
        </span>
        <span>
          Preventive deductible:{' '}
          <strong style={{ color: cellColor(view.deductible.preventive) }}>{view.deductible.preventive}</strong>
        </span>
        <span>
          Comprehensive deductible:{' '}
          <strong style={{ color: cellColor(view.deductible.comprehensive) }}>{view.deductible.comprehensive}</strong>
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 10 }}>
          <thead>
            <tr>
              <th
                style={{
                  textAlign: 'left',
                  padding: '4px 6px',
                  fontFamily: LABEL_FONT,
                  fontWeight: 700,
                  color: MUTED,
                  textTransform: 'uppercase',
                  letterSpacing: 0.3,
                  borderBottom: `1px solid ${LINE}`,
                  whiteSpace: 'nowrap',
                }}
              >
                Service
              </th>
              {COLS.map((c) => (
                <th
                  key={c.key}
                  style={{
                    textAlign: 'left',
                    padding: '4px 6px',
                    fontFamily: LABEL_FONT,
                    fontWeight: 700,
                    color: MUTED,
                    textTransform: 'uppercase',
                    letterSpacing: 0.3,
                    borderBottom: `1px solid ${LINE}`,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row, i) => (
              <tr key={row.key} style={{ background: i % 2 ? '#fcfcfd' : 'white' }}>
                <td
                  style={{
                    padding: '4px 6px',
                    fontFamily: LABEL_FONT,
                    fontWeight: 600,
                    color: INK,
                    whiteSpace: 'nowrap',
                    borderBottom: `1px solid ${LINE}`,
                  }}
                >
                  {row.label}
                </td>
                {COLS.map((c) => (
                  <td
                    key={c.key}
                    style={{
                      padding: '4px 6px',
                      fontFamily: NUM_FONT,
                      color: cellColor(row[c.key]),
                      whiteSpace: 'nowrap',
                      borderBottom: `1px solid ${LINE}`,
                    }}
                  >
                    {row[c.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Collapsible "Dental details" disclosure — used on the Compare grid card so
 *  the default grid stays lean. Starts collapsed. */
export function DentalDetailDisclosure({ detail }: { detail: DentalDetail | null | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: `1px solid ${LINE}`, paddingTop: 8 }}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          fontFamily: LABEL_FONT,
          fontSize: 10,
          fontWeight: 700,
          color: MUTED,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
        }}
        aria-expanded={open}
      >
        <span style={{ fontSize: 8 }}>{open ? '▼' : '▶'}</span>
        Dental details
      </button>
      {open && (
        <div style={{ marginTop: 6 }}>
          <DentalDetailBody detail={detail} />
        </div>
      )}
    </div>
  );
}
