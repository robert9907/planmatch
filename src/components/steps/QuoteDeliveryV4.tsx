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

import { useMemo, useState } from 'react';
import type { Plan } from '@/types/plans';
import type { Client, Medication, Provider } from '@/types/session';
import { useSession } from '@/hooks/useSession';
import { usePlanBrain } from '@/hooks/usePlanBrain';
import { useDrugCosts, lookupPlanCost, type DrugCostMap } from '@/hooks/useDrugCosts';
import {
  useManufacturerAssistance,
  type AssistanceRow,
} from '@/hooks/useManufacturerAssistance';
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
  /* Column-header accents — match the V4 mockup spec. */
  --qv4-navy:#0c447c;        /* Best Rx Match header */
  --qv4-teal:#0f6e56;        /* Lowest OOP header */
  --qv4-leaf:#3b6d11;        /* Part B Giveback / Healthy header */
  --qv4-summary-navy:#1a2744; /* Total Annual Value bar */
  --qv4-navy-lt:#1a4a8a; --qv4-navy-dk:#091f3f;
  --qv4-sea:#83f0f9;  --qv4-sea-dim:rgba(131,240,249,0.1);
  --qv4-w:#fff;
  /* Column body backgrounds — persist through every cell in that column. */
  --qv4-current-bg:#f5f4f0;  /* Current Plan column body */
  --qv4-bestrx-bg:#e6f1fb;   /* Best Rx Match column body */
  --qv4-oop-bg:#e1f5ee;      /* Lowest OOP column body */
  --qv4-leaf-bg:#eaf3de;     /* Part B Giveback column body */
  /* Delta badges — savings / more-expensive. */
  --qv4-delta-save-bg:#eaf3de; --qv4-delta-save:#3b6d11; --qv4-delta-save-bdr:rgba(59,109,17,0.25);
  --qv4-delta-more-bg:#fcebeb; --qv4-delta-more:#a32d2d; --qv4-delta-more-bdr:rgba(163,45,45,0.25);
  --qv4-g50:#f8f9fa; --qv4-g100:#f1f3f5; --qv4-g200:#e9ecef;
  --qv4-g300:#dee2e6; --qv4-g400:#ced4da; --qv4-g500:#adb5bd;
  --qv4-g600:#868e96; --qv4-g700:#495057; --qv4-g800:#343a40; --qv4-g900:#212529;
  --qv4-grn:#3b6d11; --qv4-grn-bg:#eaf3de; --qv4-grn-bdr:rgba(59,109,17,0.25);
  --qv4-red:#a32d2d; --qv4-red-bg:#fcebeb; --qv4-red-bdr:rgba(163,45,45,0.25);
  --qv4-amb:#e67e22; --qv4-amb-bg:rgba(243,156,18,0.08);
  --qv4-fb:'Inter',system-ui,sans-serif;
  --qv4-fm:'JetBrains Mono',monospace;
  --qv4-fd:'Fraunces',Georgia,serif;
  font-family: var(--qv4-fb);
  color: var(--qv4-g900); font-size: 12px;
  -webkit-font-smoothing: antialiased;
}
.qv4 *, .qv4 *::before, .qv4 *::after { box-sizing: border-box; }

.qv4-qwrap { overflow-x: auto; padding: 0 0 12px; -webkit-overflow-scrolling: touch;
  /* min-height keeps the wrapper from collapsing while data loads */
  min-height: 200px; }
/* table-layout: fixed + the <colgroup> below force every plan column
 * to honor its assigned width — fixed pixel widths so the layout
 * doesn't collapse on narrow viewports and Lowest OOP / Giveback
 * don't get squeezed to slivers. The min-width of the table itself
 * is computed inline from numColumns × 180 + 200 so the wrapper's
 * overflow-x: auto kicks in when the viewport is narrower. */
.qv4 table.qt {
  border-collapse: collapse;
  width: 100%;
  table-layout: fixed;
}
.qv4 .qt th, .qv4 .qt td {
  padding: 7px 12px; text-align: left; vertical-align: middle;
  border-bottom: 1px solid var(--qv4-g100); font-size: 12px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.qv4 .qt .lc {
  position: sticky; left: 0; z-index: 5; background: var(--qv4-g50);
  font-weight: 500; color: var(--qv4-g600); white-space: normal;
  overflow: visible;
}
.qv4 .qt th.qh {
  padding: 12px; border-bottom: 1px solid var(--qv4-g200);
  vertical-align: top; font-weight: 400;
  white-space: normal; overflow: hidden;
}
/* Column header backgrounds — gray current, navy best Rx, teal OOP, leaf giveback. */
.qv4 .qt th.qh.cb { background: var(--qv4-g200); color: var(--qv4-g800); }
.qv4 .qt th.qh.bb { background: var(--qv4-navy); color: var(--qv4-w); }
.qv4 .qt th.qh.tb { background: var(--qv4-teal); color: var(--qv4-w); }
.qv4 .qt th.qh.lb { background: var(--qv4-leaf); color: var(--qv4-w); }

.qv4 .qt td { font-family: var(--qv4-fm); font-size: 12px; color: var(--qv4-g800); }
/* Column body backgrounds — persist through every section row. */
.qv4 .qt td.cb { background: var(--qv4-current-bg); }
.qv4 .qt td.bb { background: var(--qv4-bestrx-bg); }
.qv4 .qt td.tb { background: var(--qv4-oop-bg); }
.qv4 .qt td.lb { background: var(--qv4-leaf-bg); }
/* .wh = "this cell beats current" — bolds the value. */
.qv4 .qt td.wh { font-weight: 700; }
.qv4 .qt td.bb.wh { color: var(--qv4-navy); }
.qv4 .qt td.tb.wh { color: var(--qv4-teal); }
.qv4 .qt td.lb.wh { color: var(--qv4-leaf); }

.qv4 .qt tr.sh td, .qv4 .qt tr.sh th {
  font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--qv4-navy); padding-top: 12px; padding-bottom: 4px;
  border-bottom: 2px solid var(--qv4-navy); background: var(--qv4-g50);
  font-family: var(--qv4-fb);
}
/* Section dividers keep the column tint. */
.qv4 .qt tr.sh td.cb { background: var(--qv4-current-bg); }
.qv4 .qt tr.sh td.bb { background: var(--qv4-bestrx-bg); }
.qv4 .qt tr.sh td.tb { background: var(--qv4-oop-bg); }
.qv4 .qt tr.sh td.lb { background: var(--qv4-leaf-bg); }

.qv4 .qt tr.tot td, .qv4 .qt tr.tot th {
  font-weight: 700; border-bottom: 2px solid var(--qv4-g300); padding: 8px 12px;
}
.qv4 .qt tr.tot th { background: var(--qv4-g100); color: var(--qv4-g900); }

/* Total Inpatient Cost — bold subtotal sitting under "Inpatient per day". */
.qv4 .qt tr.tip td, .qv4 .qt tr.tip th {
  font-weight: 700; border-bottom: 1.5px solid var(--qv4-g400); padding: 7px 12px;
}
.qv4 .qt tr.tip th { color: var(--qv4-g900); }

.qv4 .qt tr.bl td, .qv4 .qt tr.bl th {
  background: var(--qv4-summary-navy); color: var(--qv4-w);
  border-bottom: none; padding: 10px 12px;
}
.qv4 .qt tr.ws td {
  background: var(--qv4-summary-navy); color: rgba(255,255,255,0.6);
  font-size: 10px; font-weight: 400; font-family: var(--qv4-fb);
  border-bottom: none; padding: 2px 12px 10px; white-space: normal; max-width: 240px;
}
.qv4 .qt tr.ws th {
  background: var(--qv4-summary-navy); color: rgba(255,255,255,0.5);
  font-size: 10px; font-weight: 400; border-bottom: none;
}

.qv4 .ptag2  { font-size: 9px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--qv4-g500); margin-bottom: 2px; }
.qv4 .wtag2  { font-size: 9px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: rgba(255,255,255,0.85); margin-bottom: 2px; }
.qv4 .pcar2  { font-size: 10px; color: var(--qv4-g500); font-weight: 500; }
.qv4 .qh.bb .pcar2, .qv4 .qh.tb .pcar2, .qv4 .qh.lb .pcar2 { color: rgba(255,255,255,0.6); }
.qv4 .pn2 { font-family: var(--qv4-fd); font-size: 13px; font-weight: 600;
  color: var(--qv4-g900); line-height: 1.2; }
.qv4 .qh.bb .pn2, .qv4 .qh.tb .pn2, .qv4 .qh.lb .pn2 { color: var(--qv4-w); }
.qv4 .qh.cb .pn2 { color: var(--qv4-g700); }
.qv4 .pm2 { display: flex; gap: 5px; margin-top: 3px; align-items: center; }
.qv4 .pid2 { font-family: var(--qv4-fm); font-size: 9px; color: var(--qv4-g500); }
.qv4 .qh.bb .pid2, .qv4 .qh.tb .pid2, .qv4 .qh.lb .pid2 { color: rgba(255,255,255,0.5); }
.qv4 .star2 { font-size: 9px; font-weight: 600; color: var(--qv4-amb); }
.qv4 .qh.bb .star2, .qv4 .qh.tb .star2, .qv4 .qh.lb .star2 { color: var(--qv4-sea); }

.qv4 .ti { display: inline-flex; align-items: center; justify-content: center;
  width: 17px; height: 17px; border-radius: 3px;
  font-size: 9px; font-weight: 700; font-family: var(--qv4-fm); margin-right: 3px; }
/* Per V4 spec: T1 green, T2 teal, T3 blue, T4 amber, T5 coral, T6 red.
   Hex tokens reuse the same palette as the column backgrounds so the
   badge feels native to the table rather than a separate component. */
.qv4 .ti.t1 { background: #eaf3de; color: #3b6d11; }   /* green */
.qv4 .ti.t2 { background: #e1f5ee; color: #0f6e56; }   /* teal */
.qv4 .ti.t3 { background: #e6f1fb; color: #0c447c; }   /* blue */
.qv4 .ti.t4 { background: #faeeda; color: #854f0b; }   /* amber */
.qv4 .ti.t5 { background: #faece7; color: #993c1d; }   /* coral */
.qv4 .ti.t6 { background: #fcebeb; color: #a32d2d; }   /* red */

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
.qv4 .abtn.rec  { background: var(--qv4-teal); color: var(--qv4-w); }
.qv4 .abtn.rec:hover { background: #0a5945; }
.qv4 .abtn.rec.on { background: var(--qv4-leaf); }
.qv4 .abtn.sec  { background: var(--qv4-g100); color: var(--qv4-g700);
  border: 1px solid var(--qv4-g200); text-decoration: none; display: block; }
.qv4 .abtn.sec:hover { background: var(--qv4-g200); }

/* Pharmacy fill-type toggle above the table. */
.qv4-pharm-toggle { display: inline-flex; align-items: center; gap: 0;
  border: 1px solid var(--qv4-g300); border-radius: 7px; overflow: hidden;
  background: #fff; margin-bottom: 12px; font-family: var(--qv4-fb); }
.qv4-pharm-toggle button { padding: 6px 14px; border: none; background: transparent;
  font-size: 11px; font-weight: 600; color: var(--qv4-g600); cursor: pointer; }
.qv4-pharm-toggle button.on { background: var(--qv4-navy); color: var(--qv4-w); }
.qv4-pharm-label { font-size: 10px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--qv4-g500); margin-right: 8px; }

.qv4 .sub { font-size: 10px; color: var(--qv4-g500); font-weight: 400; }
.qv4-loading, .qv4-empty { padding: 28px; text-align: center; color: var(--qv4-g600);
  font-size: 13px; background: #fff; border: 1px dashed var(--qv4-g200);
  border-radius: 12px; }

/* ── Assistance indicators ─────────────────────────────────────── */
.qv4 .ai-icon { display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; margin-left: 4px; border-radius: 50%;
  background: var(--qv4-amb-bg); color: var(--qv4-amb);
  font-size: 9px; font-weight: 700; cursor: pointer;
  border: 1px solid rgba(243,156,18,0.4); font-family: var(--qv4-fb); }
.qv4 .ai-icon:hover { background: var(--qv4-amb); color: #fff; }
.qv4 .ai-tag { font-size: 9px; color: var(--qv4-amb); font-weight: 600;
  margin-left: 4px; font-family: var(--qv4-fb); }

.qv4-help { margin-top: 16px; background: #fff; border: 1px solid var(--qv4-g200);
  border-radius: 12px; overflow: hidden; }
.qv4-help-hdr { padding: 12px 16px; display: flex; align-items: center;
  justify-content: space-between; cursor: pointer; user-select: none;
  background: linear-gradient(0deg, var(--qv4-amb-bg), #fff); }
.qv4-help-hdr-l { display: flex; align-items: center; gap: 8px; }
.qv4-help-icon { width: 24px; height: 24px; border-radius: 50%;
  background: var(--qv4-amb); color: #fff; display: flex;
  align-items: center; justify-content: center; font-size: 12px; font-weight: 700; }
.qv4-help-title { font-family: var(--qv4-fd); font-size: 14px; font-weight: 700;
  color: var(--qv4-navy); }
.qv4-help-sub { font-size: 11px; color: var(--qv4-g600); margin-top: 1px; }
.qv4-help-toggle { font-size: 11px; color: var(--qv4-navy); font-weight: 600; }
.qv4-help-body { padding: 12px 16px 16px; border-top: 1px solid var(--qv4-g200); }
.qv4-help-section { margin-bottom: 14px; }
.qv4-help-section:last-child { margin-bottom: 0; }
.qv4-help-section-h { font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--qv4-navy); margin-bottom: 6px; }
.qv4-pap-row { padding: 8px 10px; border: 1px solid var(--qv4-g200);
  border-radius: 8px; margin-bottom: 6px; display: grid;
  grid-template-columns: 1fr auto; gap: 4px 12px; align-items: start;
  font-size: 12px; }
.qv4-pap-row:last-child { margin-bottom: 0; }
.qv4-pap-name { font-weight: 700; color: var(--qv4-navy); font-family: var(--qv4-fd); }
.qv4-pap-mfr { font-size: 10px; color: var(--qv4-g600); margin-top: 1px; }
.qv4-pap-elig { grid-column: 1 / -1; font-size: 11px; color: var(--qv4-g700);
  margin-top: 4px; line-height: 1.4; }
.qv4-pap-meta { font-size: 10px; color: var(--qv4-g500); font-family: var(--qv4-fm);
  text-align: right; white-space: nowrap; }
.qv4-pap-cta { display: inline-block; font-size: 11px; font-weight: 600;
  color: var(--qv4-navy); text-decoration: none; padding: 4px 10px;
  border: 1px solid var(--qv4-g300); border-radius: 5px; margin-right: 4px; }
.qv4-pap-cta:hover { background: var(--qv4-g50); }
.qv4-pap-tag { display: inline-block; font-size: 9px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 6px;
  border-radius: 3px; margin-right: 4px; }
.qv4-pap-tag.pap { background: var(--qv4-grn-bg); color: var(--qv4-grn); }
.qv4-pap-tag.copay { background: var(--qv4-sea-dim); color: var(--qv4-navy); }
.qv4-pap-tag.found { background: var(--qv4-amb-bg); color: var(--qv4-amb); }
.qv4-pap-tag.no-medicare { background: var(--qv4-red-bg); color: var(--qv4-red); }
.qv4-help-generic { font-size: 12px; color: var(--qv4-g700); line-height: 1.5; }
.qv4-help-generic ul { margin: 4px 0 0 18px; padding: 0; }
.qv4-help-generic li { margin-bottom: 4px; }
`;

interface Props {
  finalists: Plan[];
  client: Client;
  medications: Medication[];
  providers: Provider[];
  recommendation?: string | null;
  onRecommend?: (id: string | null) => void;
}

/**
 * Column visual treatment. Maps directly to a CSS class pair for the
 * header (`qh.<v>`) and body cells (`td.<v>`):
 *
 *   current   → cb  gray   (#f5f4f0)  Current Plan benchmark
 *   best_rx   → bb  navy   (#0c447c)  LOWEST_DRUG_COST / BEST_OVERALL ribbon
 *   lowest_oop→ tb  teal   (#0f6e56)  LOWEST_OOP ribbon
 *   giveback  → lb  leaf   (#3b6d11)  PART_B_SAVINGS ribbon
 *   normal    → ''  white  (no special background) — backfill column
 */
type ColumnVariant = 'current' | 'best_rx' | 'lowest_oop' | 'giveback' | 'normal';

interface ColumnPlan {
  plan: Plan;
  scored: ScoredPlan | null;   // null when this is the current-plan column
  variant: ColumnVariant;
  ribbon: RibbonKey | null;
}

type PharmacyFill = 'retail_30' | 'mail_90';

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

  // Manufacturer assistance — fetched once per session, indexed by
  // medication id. Used to flag drugs that come back not_covered or
  // tier 4-5 expensive on every plan column so the agent can pivot
  // to PAP / copay-card / foundation alternatives.
  const assistance = useManufacturerAssistance(medications);

  // Pharmacy fill-type toggle. Drug cost cache stores per-NDC
  // estimated_yearly_total at scrape time; until per-fill-type costs
  // are cached separately, mail_90 displays as a 3× monthly value
  // with a clear "est." note (most plans deliver mail-order at a
  // small discount vs 3× retail; we can't promise a specific number
  // without the per-plan mail-order pricing rows).
  const [pharmacyFill, setPharmacyFill] = useState<PharmacyFill>('retail_30');

  // Live-prime drug costs by hitting /api/drug-costs for the visible
  // finalists. Without this, lookupDrugCost reads pm_drug_cost_cache
  // through usePlanBrain, which is empty for any (plan, NDC) pair the
  // consumer-side scraper hasn't visited — and every cell renders $0.
  // useDrugCosts triggers the Medicare.gov fetch + cache write, then
  // exposes per-plan totals via byPlanId.
  const drugCosts = useDrugCosts(
    finalists,
    medications,
    pharmacyFill === 'mail_90' ? 'mail' : 'retail',
  );

  const currentPlan = useMemo<Plan | null>(
    () => (currentPlanId ? findPlan(currentPlanId) : null),
    [currentPlanId],
  );

  // ─── Column ordering ────────────────────────────────────────────
  // V4 mockup:
  //   col 0 (sticky labels)
  //   col 1 = current plan (gray) — pinned left when session has currentPlanId
  //   col 2 = Best Rx Match (navy)  — LOWEST_DRUG_COST / BEST_OVERALL ribbon
  //   col 3 = Lowest OOP (teal)     — LOWEST_OOP ribbon
  //   col 4 = Part B Giveback (leaf)— PART_B_SAVINGS ribbon
  //   any unfilled slot backfills with the next-highest composite
  //
  // Cap at MAX_FINALIST_COLUMNS plan columns total so the table never
  // overflows the mockup's width.
  const columns = useMemo<ColumnPlan[]>(() => {
    const cols: ColumnPlan[] = [];
    const used = new Set<string>();

    if (currentPlan) {
      const inFinalist = result?.scored.find((s) => s.plan.id === currentPlan.id) ?? null;
      cols.push({ plan: currentPlan, scored: inFinalist, variant: 'current', ribbon: null });
      used.add(currentPlan.id);
    }

    const ranked = result ? [...result.scored].sort((a, b) => b.composite - a.composite) : [];
    const pickByRibbon = (...ribbons: RibbonKey[]): ScoredPlan | null => {
      for (const r of ribbons) {
        const hit = ranked.find((s) => s.ribbon === r && !used.has(s.plan.id));
        if (hit) return hit;
      }
      return null;
    };

    // Slot 2 — Best Rx Match. Prefer LOWEST_DRUG_COST; fall back to
    // BEST_OVERALL or first un-used composite.
    const bestRx =
      pickByRibbon('LOWEST_DRUG_COST', 'BEST_OVERALL') ??
      ranked.find((s) => !used.has(s.plan.id)) ??
      null;
    if (bestRx) {
      cols.push({ plan: bestRx.plan, scored: bestRx, variant: 'best_rx', ribbon: bestRx.ribbon });
      used.add(bestRx.plan.id);
    }

    // Slot 3 — Lowest OOP. Prefer LOWEST_OOP; fall back to plan with
    // smallest totalOOPEstimate among un-used.
    let lowestOop = pickByRibbon('LOWEST_OOP');
    if (!lowestOop) {
      lowestOop = ranked
        .filter((s) => !used.has(s.plan.id))
        .reduce<ScoredPlan | null>(
          (best, s) =>
            best == null || s.totalOOPEstimate < best.totalOOPEstimate ? s : best,
          null,
        );
    }
    if (lowestOop && cols.length < MAX_FINALIST_COLUMNS) {
      cols.push({ plan: lowestOop.plan, scored: lowestOop, variant: 'lowest_oop', ribbon: lowestOop.ribbon });
      used.add(lowestOop.plan.id);
    }

    // Slot 4 — Part B Giveback / Healthy. Prefer PART_B_SAVINGS; fall
    // back to plan with the highest part_b_giveback among un-used. If
    // no plan has a giveback >0, leave the slot empty rather than fake
    // a third column.
    let giveback = pickByRibbon('PART_B_SAVINGS');
    if (!giveback) {
      const candidate = ranked
        .filter((s) => !used.has(s.plan.id) && (s.plan.part_b_giveback ?? 0) > 0)
        .reduce<ScoredPlan | null>(
          (best, s) =>
            best == null || (s.plan.part_b_giveback ?? 0) > (best.plan.part_b_giveback ?? 0) ? s : best,
          null,
        );
      giveback = candidate;
    }
    if (giveback && cols.length < MAX_FINALIST_COLUMNS) {
      cols.push({ plan: giveback.plan, scored: giveback, variant: 'giveback', ribbon: giveback.ribbon });
      used.add(giveback.plan.id);
    }

    // Backfill — any remaining plan columns up to MAX_FINALIST_COLUMNS
    // get the neutral 'normal' variant.
    for (const s of ranked) {
      if (cols.length >= MAX_FINALIST_COLUMNS) break;
      if (used.has(s.plan.id)) continue;
      cols.push({ plan: s.plan, scored: s, variant: 'normal', ribbon: s.ribbon });
      used.add(s.plan.id);
    }
    return cols;
  }, [currentPlan, result]);

  // Cost benchmark for delta badges. When the session has a current
  // plan we use that (the agent is comparing alternatives against
  // what the client is on today). When there's no current plan —
  // first quote, or "Test Test" with no AgentBase history — fall
  // back to the leftmost plan column (typically Best Rx Match) so
  // columns 2..N can still show "+/- $X" vs the lead. Without this
  // fallback, every delta is suppressed and the table reads as a
  // bare grid of numbers.
  // Computed before any early return to keep hook order stable.
  const currentCol = columns.find((c) => c.variant === 'current') ?? null;
  const baseline =
    currentCol?.plan ??
    columns.find((c) => c.variant !== 'current')?.plan ??
    null;
  // (baselineIsCurrent flag is intentionally not threaded through the
  // row components — when there's no current column, the baseline
  // plan is itself the leftmost column. Its delta vs itself is 0 so
  // no badge renders, and every other column compares against it
  // naturally. If we ever want a "vs lead" subtitle we can revive
  // the flag.)

  // Medications needing manufacturer assistance: any med where every
  // plan column comes back excluded / not_covered, or tier 4–5 with
  // monthly >$100 on the lowest-cost plan. Stored as a Set so the
  // medication row + cell + help section can all read in O(1).
  // Must be called before any early return — hooks order is fixed.
  const medsNeedingAssistance = useMemo(() => {
    const out = new Set<string>();
    for (const med of medications) {
      let worstNeeds = false;
      let everyPlanExpensive = true;
      let hasAnyPlan = false;
      for (const c of columns) {
        const info = lookupDrugCost(c.plan, med, data);
        hasAnyPlan = true;
        if (!info || info.label === 'Excluded') {
          worstNeeds = true;
          continue;
        }
        const expensiveTier = info.tier != null && info.tier >= 4 && info.monthlyCost > 100;
        if (!expensiveTier) everyPlanExpensive = false;
      }
      if (!hasAnyPlan) continue;
      if (worstNeeds || everyPlanExpensive) out.add(med.id);
    }
    return out;
  }, [columns, medications, data]);

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

  return (
    <div className="qv4">
      <style>{CSS}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span className="qv4-pharm-label">Pharmacy</span>
        <div className="qv4-pharm-toggle" role="tablist" aria-label="Pharmacy fill type">
          <button
            type="button"
            className={pharmacyFill === 'retail_30' ? 'on' : ''}
            aria-pressed={pharmacyFill === 'retail_30'}
            onClick={() => setPharmacyFill('retail_30')}
          >
            30-day retail
          </button>
          <button
            type="button"
            className={pharmacyFill === 'mail_90' ? 'on' : ''}
            aria-pressed={pharmacyFill === 'mail_90'}
            onClick={() => setPharmacyFill('mail_90')}
          >
            90-day mail
          </button>
        </div>
        {pharmacyFill === 'mail_90' && (
          <span style={{ fontSize: 10, color: 'var(--qv4-g500)', marginLeft: 8 }}>
            est. — per-plan mail-order pricing pending
          </span>
        )}
      </div>

      <div className="qv4-qwrap">
        {/*
          Fixed pixel widths via colgroup + table min-width make the
          column layout deterministic regardless of cell content
          length. 200px label + 180px × N plan columns → wrapper
          scrolls horizontally when the viewport is narrower.
        */}
        <table
          className="qt"
          style={{ minWidth: `${200 + columns.length * 180}px` }}
        >
          <colgroup>
            <col style={{ width: 200 }} />
            {columns.map((c) => (
              <col key={c.plan.id} style={{ width: 180 }} />
            ))}
          </colgroup>
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
                  width: 200,
                  minWidth: 200,
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
                  needsAssistance={medsNeedingAssistance.has(m.id)}
                  hasMatchingProgram={!!assistance.byMedicationId[m.id]?.length}
                  pharmacyFill={pharmacyFill}
                />
              ))
            )}
            <TotalRxRow
              cols={columns}
              medications={medications}
              data={data}
              pharmacyFill={pharmacyFill}
              drugCosts={drugCosts}
            />

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
            <CopayRow row={INPATIENT_ROW} cols={columns} baseline={baseline} />
            <TotalInpatientCostRow cols={columns} baseline={baseline} />

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
            <PlanCostRow
              label="Part B Giveback"
              cols={columns}
              fmt={(p) =>
                (p.part_b_giveback ?? 0) > 0 ? `$${p.part_b_giveback}/mo` : '—'
              }
              raw={(p) => p.part_b_giveback ?? 0}
              baseline={baseline}
              betterIsLower={false}
              annualMultiplier={12}
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
              label="Vision"
              cols={columns}
              fmt={(p) =>
                p.benefits.vision.eyewear_allowance_year > 0
                  ? `$${p.benefits.vision.eyewear_allowance_year}/yr`
                  : p.benefits.vision.exam ? 'Exam only' : '—'
              }
              raw={(p) => p.benefits.vision.eyewear_allowance_year}
              baseline={baseline}
              betterIsLower={false}
            />
            <PlanCostRow
              label="Hearing"
              cols={columns}
              fmt={(p) =>
                p.benefits.hearing.aid_allowance_year > 0
                  ? `$${p.benefits.hearing.aid_allowance_year.toLocaleString()}/yr`
                  : p.benefits.hearing.exam ? 'Exam only' : '—'
              }
              raw={(p) => p.benefits.hearing.aid_allowance_year}
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
              label="Fitness"
              cols={columns}
              fmt={(p) =>
                p.benefits.fitness.enabled
                  ? p.benefits.fitness.program ?? 'Included'
                  : '—'
              }
              raw={(p) => (p.benefits.fitness.enabled ? 1 : 0)}
              baseline={baseline}
              betterIsLower={false}
              suppressDelta
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
                        className={`abtn rec${c.variant === 'best_rx' && !isRecommended ? ' sea' : ''}`}
                        onClick={() =>
                          onRecommend?.(isRecommended ? null : c.plan.id)
                        }
                      >
                        {isRecommended ? '✓ Recommended' : c.variant === 'best_rx' ? '✓ Recommend' : 'Recommend'}
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

      {medsNeedingAssistance.size > 0 && (
        <AssistanceHelpSection
          medications={medications.filter((m) => medsNeedingAssistance.has(m.id))}
          assistanceByMedId={assistance.byMedicationId}
        />
      )}

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
  const cls = `qh ${cellClsBare(col)}`;
  // Per-variant ribbon label. Falls back to the plan's actual Brain
  // ribbon for the 'normal' backfill column.
  const tagText =
    col.variant === 'current' ? 'Current Plan' :
    col.variant === 'best_rx' ? '⭐ Best Rx Match' :
    col.variant === 'lowest_oop' ? '⭐ Lowest OOP' :
    col.variant === 'giveback' ? '⭐ Part B Giveback' :
    col.ribbon ? RIBBON_LABEL[col.ribbon] : null;
  const tagCls = col.variant === 'current' ? 'ptag2' : 'wtag2';
  return (
    // Explicit width on every plan-column <th>. With table-layout:
    // fixed the colgroup is authoritative, but some browser-reflow
    // paths (especially on initial paint before the colgroup is
    // parsed, or when the table is re-rendered with a different
    // column count) can fall back to natural sizing — and a cell
    // with a long ribbon label can collapse adjacent cells. Setting
    // width + minWidth inline on every header cell guarantees no
    // single column (lookin' at Lowest OOP) gets squeezed to a
    // sliver when its neighbors render first.
    <th className={cls} style={{ width: 180, minWidth: 180 }}>
      {tagText && <div className={tagCls}>{tagText}</div>}
      <div className="pcar2" style={{ marginTop: tagText ? 0 : 8 }}>
        {col.plan.carrier ?? '—'}
      </div>
      <div className="pn2">{col.plan.plan_name ?? '—'}</div>
      <div className="pm2">
        <span className="pid2">
          {col.plan.contract_id}-{col.plan.plan_number}
        </span>
        <span className="star2">{col.plan.star_rating ?? 0}★</span>
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
  needsAssistance,
  hasMatchingProgram,
  pharmacyFill,
}: {
  medication: Medication;
  cols: ColumnPlan[];
  data: PlanBrainData | null;
  baseline: Plan | null;
  needsAssistance: boolean;
  hasMatchingProgram: boolean;
  pharmacyFill: PharmacyFill;
}) {
  const baselineCost = baseline ? lookupDrugCost(baseline, medication, data, pharmacyFill) : null;
  function scrollToHelp() {
    const target = document.getElementById(`qv4-help-${medication.id}`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  return (
    <tr>
      <th className="lc">
        {medication.name}
        {medication.strength ? ` ${medication.strength}` : ''}
        {needsAssistance && hasMatchingProgram && (
          <button
            type="button"
            className="ai-icon"
            title="Manufacturer assistance available — click for details"
            onClick={scrollToHelp}
            aria-label={`Show assistance options for ${medication.name}`}
          >
            i
          </button>
        )}
        <br />
        <span className="sub">{pharmacyFill === 'mail_90' ? '90-day mail' : '30-day retail'}</span>
      </th>
      {cols.map((c) => {
        const info = lookupDrugCost(c.plan, medication, data, pharmacyFill);
        const notCovered = !info || info.label === 'Excluded';
        return (
          <td key={c.plan.id} className={cellCls(c, info?.improvedVs(baselineCost))}>
            {info ? (
              <>
                {info.tier && (
                  <span className={`ti t${info.tier}`}>
                    {info.tier}
                  </span>
                )}
                {info.label === 'Excluded' ? (
                  <>
                    Not covered
                    {hasMatchingProgram && (
                      <span className="ai-tag" onClick={scrollToHelp} style={{ cursor: 'pointer' }}>
                        · assistance available
                      </span>
                    )}
                  </>
                ) : (
                  info.label
                )}
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
                {info.tier != null && info.tier >= 4 && info.monthlyCost > 100 && hasMatchingProgram && (
                  <span className="ai-tag" onClick={scrollToHelp} style={{ cursor: 'pointer' }}>
                    · assistance
                  </span>
                )}
              </>
            ) : (
              <>
                <span style={{ color: 'var(--qv4-g500)' }}>—</span>
                {notCovered && hasMatchingProgram && (
                  <span className="ai-tag" onClick={scrollToHelp} style={{ cursor: 'pointer' }}>
                    · assistance available
                  </span>
                )}
              </>
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
  pharmacyFill,
  drugCosts,
}: {
  cols: ColumnPlan[];
  medications: Medication[];
  data: PlanBrainData | null;
  pharmacyFill: PharmacyFill;
  drugCosts: DrugCostMap;
}) {
  // Prefer the live /api/drug-costs total when available — that's the
  // authoritative Medicare.gov Plan Finder number for the client's
  // exact prescription set. Fall back to summing per-drug cells when
  // the live fetch hasn't responded or returned null.
  const totals = cols.map((c) => {
    const live = lookupPlanCost(drugCosts, c.plan);
    if (live?.annual_cost != null) return Math.round(live.annual_cost);
    return totalAnnualRx(c.plan, medications, data, pharmacyFill);
  });
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
            style={c.variant === 'best_rx' ? { color: 'var(--qv4-navy)' } : undefined}
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
];
// Inpatient is rendered as its own pair (per-day row + total stay row)
// so the total cost can show daily × days with delta badges.
const INPATIENT_ROW: MedicalRowDef = {
  label: 'Inpatient',
  pick: (p) => p.benefits.medical.inpatient,
  suffix: '/day',
};
// Default 5-day acute admission. Real per-plan inpatient days live in
// pbp_benefits.tiered_cost_sharing day-stage rows (see scrape-medicare-gov.mjs
// PLAN_DETAIL_URL_FN extraction). Until that field is plumbed onto the
// agent-side Plan type, every column uses the same default — which still
// produces meaningful daily × days totals for comparison.
const DEFAULT_INPATIENT_DAYS = 5;
function inpatientDaysFor(_plan: Plan): number {
  return DEFAULT_INPATIENT_DAYS;
}

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
  suppressDelta,
  suffix: _suffix,
}: {
  label: string;
  cols: ColumnPlan[];
  fmt: (p: Plan) => string;
  raw: (p: Plan) => number;
  baseline: Plan | null;
  betterIsLower: boolean;
  annualMultiplier?: number;
  /** Suppress delta badges entirely — for non-numeric rows like Fitness
   *  where +$1 vs −$0 is meaningless. */
  suppressDelta?: boolean;
  suffix?: string;
}) {
  const baseVal = baseline ? raw(baseline) : null;
  return (
    <tr>
      <th className="lc">{label}</th>
      {cols.map((c) => {
        const v = raw(c.plan);
        const delta =
          !suppressDelta && baseVal != null && c.variant !== 'current' && v !== baseVal
            ? v - baseVal
            : null;
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

// ─── Total Inpatient Cost ────────────────────────────────────────────
//
// Sits directly below the "Inpatient per day" copay row. Shows
// daily_copay × days for each plan with delta badges vs the current
// plan. Bold + heavier bottom border to read as a section subtotal.
// `inpatient_days` defaults to 5 (acute admission baseline) — see
// inpatientDaysFor() for the per-plan extension point.

function TotalInpatientCostRow({ cols, baseline }: { cols: ColumnPlan[]; baseline: Plan | null }) {
  const baseDaily = baseline ? copayCash(baseline.benefits.medical.inpatient) : null;
  const baseDays = baseline ? inpatientDaysFor(baseline) : null;
  const baseTotal = baseDaily != null && baseDays != null ? baseDaily * baseDays : null;
  return (
    <tr className="tip">
      <th className="lc">
        Total inpatient cost
        <br />
        <span className="sub">
          {baseDays ?? DEFAULT_INPATIENT_DAYS}-day hospital stay
        </span>
      </th>
      {cols.map((c) => {
        const daily = copayCash(c.plan.benefits.medical.inpatient);
        const days = inpatientDaysFor(c.plan);
        const total = daily != null ? daily * days : null;
        const delta =
          total != null && baseTotal != null && c.variant !== 'current' && total !== baseTotal
            ? total - baseTotal
            : null;
        const better = delta != null && delta < 0;
        const variantCls = cellCls(c, better);
        return (
          <td key={c.plan.id} className={variantCls}>
            {total == null ? (
              <span style={{ color: 'var(--qv4-g500)' }}>—</span>
            ) : (
              <>
                ${total.toLocaleString()}
                {delta != null && (
                  <span className={`d ${better ? 's' : 'm'}`}>
                    {delta < 0 ? '−' : '+'}${Math.abs(delta).toLocaleString()}
                  </span>
                )}
              </>
            )}
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
        className="lc"
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
        const isWinner = c.variant === 'best_rx';
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
      <th className="lc">Why switch?</th>
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

function cellClsBare(c: ColumnPlan): string {
  switch (c.variant) {
    case 'current':    return 'cb';
    case 'best_rx':    return 'bb';
    case 'lowest_oop': return 'tb';
    case 'giveback':   return 'lb';
    default:           return '';
  }
}

function cellCls(c: ColumnPlan, betterThanBaseline?: boolean | null): string {
  const base = cellClsBare(c);
  // `.wh` highlights a non-current cell that beats the current plan —
  // bolds the value and recolors it to the column's accent.
  if (betterThanBaseline && c.variant !== 'current' && c.variant !== 'normal') {
    return `${base} wh`;
  }
  return base;
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
  pharmacyFill: PharmacyFill = 'retail_30',
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
      logDrugLookup(plan, med, { source: 'excluded', monthly: 0, ndc, tier: null });
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

  // Diagnostic — surfaces which lookup path produced the cell value.
  // Throttled to once per (plan, rxcui) pair to keep console
  // readable. When every drug shows $0 in production, this log tells
  // us whether the cause is (a) no NDC bridge, (b) no cache row,
  // (c) no formulary copay, or (d) no pbp_benefits tier copay —
  // each has a different fix path.
  logDrugLookup(plan, med, {
    source:
      annualFromCache != null
        ? 'drug_cost_cache'
        : monthlyFromFormulary != null
          ? 'pm_formulary.copay'
          : monthlyFromTierBenefits != null
            ? 'pbp_benefits.tier_copay'
            : 'fallback_zero',
    monthly,
    ndc,
    tier,
  });

  // Mail-order 90-day pricing — until per-fill-type rows are cached
  // separately we display a 3× monthly value (the per-fill cost the
  // client would pay at the mail-order pharmacy). The annual total
  // stays the same — this is purely a display-side adjustment, since
  // 12 × monthly == 4 × (3 × monthly) from a year-cost POV.
  const display90 = pharmacyFill === 'mail_90' ? monthly * 3 : monthly;
  const label = formatDrugLabel(display90, formulary?.coinsurance);

  return makeDrugInfo({
    tier,
    label,
    monthly: display90,
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

// Throttled diagnostic — emits one console.info per (plan, rxcui) pair
// so the dev console isn't spammed when the table re-renders. Resets
// when the page reloads. Logs:
//   plan_id  – agent-side triple id
//   rxcui    – RxNorm concept the lookup was for
//   ndc      – bridge from pm_drug_ndc, undefined when bridge is missing
//   tier     – formulary tier (cache → formulary → seed → null)
//   source   – which path produced `monthly`. fallback_zero means every
//              source returned null and the cell will render $0; that's
//              the failure mode users see when the drug-cost cache is
//              cold for these (plan, NDC) pairs.
const drugLookupLogged = new Set<string>();
function logDrugLookup(
  plan: Plan,
  med: Medication,
  info: { source: string; monthly: number; ndc: string | undefined; tier: number | null },
): void {
  const key = `${plan.id}::${med.rxcui ?? ''}`;
  if (drugLookupLogged.has(key)) return;
  drugLookupLogged.add(key);
  if (typeof console === 'undefined') return;
  console.info('[lookupDrugCost]', {
    plan_id: plan.id,
    rxcui: med.rxcui,
    med: med.name,
    ndc: info.ndc,
    tier: info.tier,
    monthly: info.monthly,
    source: info.source,
  });
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
  pharmacyFill: PharmacyFill = 'retail_30',
): number {
  let total = 0;
  for (const m of medications) {
    const info = lookupDrugCost(plan, m, data, pharmacyFill);
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

// ─── Assistance help section ─────────────────────────────────────────
//
// Renders below the comparison table when one or more medications come
// back not_covered or tier 4–5 expensive on every plan column. For each
// such medication, lists the matching pm_manufacturer_assistance rows
// (PAP / copay card / foundation) and a generic-guidance block covering
// formulary exceptions, Extra Help / LIS, and the Medicare Prescription
// Payment Plan (M3P, started 2025) — the three Medicare-side levers
// that work regardless of manufacturer.

function AssistanceHelpSection({
  medications,
  assistanceByMedId,
}: {
  medications: Medication[];
  assistanceByMedId: Record<string, AssistanceRow[]>;
}) {
  const [open, setOpen] = useState(true);
  const totalPrograms = medications.reduce(
    (acc, m) => acc + (assistanceByMedId[m.id]?.length ?? 0),
    0,
  );
  return (
    <div className="qv4-help">
      <div className="qv4-help-hdr" onClick={() => setOpen((v) => !v)}>
        <div className="qv4-help-hdr-l">
          <div className="qv4-help-icon">!</div>
          <div>
            <div className="qv4-help-title">Medication assistance options</div>
            <div className="qv4-help-sub">
              {medications.length} drug{medications.length === 1 ? '' : 's'} need help · {totalPrograms} program{totalPrograms === 1 ? '' : 's'} matched
            </div>
          </div>
        </div>
        <div className="qv4-help-toggle">{open ? '−' : '+'}</div>
      </div>
      {open && (
        <div className="qv4-help-body">
          {medications.map((m) => {
            const programs = assistanceByMedId[m.id] ?? [];
            return (
              <div
                key={m.id}
                id={`qv4-help-${m.id}`}
                className="qv4-help-section"
              >
                <div className="qv4-help-section-h">
                  {m.name}
                  {m.strength ? ` ${m.strength}` : ''}
                </div>
                {programs.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--qv4-g600)' }}>
                    No manufacturer program matched on brand name. Try the generic-options section below or search NeedyMeds / RxAssist.
                  </div>
                ) : (
                  programs.map((p) => <ProgramRow key={p.id} row={p} />)
                )}
              </div>
            );
          })}

          <div className="qv4-help-section">
            <div className="qv4-help-section-h">Medicare-side options (work for any drug)</div>
            <div className="qv4-help-generic">
              <ul>
                <li>
                  <strong>Formulary exception</strong> — prescriber requests the plan
                  cover a non-formulary drug or move it to a lower tier. Decision in
                  72 hrs (24 hrs if expedited).
                </li>
                <li>
                  <strong>Extra Help / LIS</strong> — Social Security low-income
                  subsidy. 2025 thresholds ≤150% FPL ($22,590 individual, $30,660
                  couple) with asset cap $17,600 / $35,130. Drops Part D copays to
                  $1.55–$11.20 per fill; full LIS waives the deductible.
                </li>
                <li>
                  <strong>Medicare Prescription Payment Plan (M3P)</strong> — new
                  in 2025. Spreads the annual $2,000 Part D OOP cap over 12
                  monthly bills instead of front-loading at the pharmacy.
                  Available on every Part D plan; enrollment via the plan, not
                  CMS.
                </li>
                <li>
                  <strong>Generic / therapeutic substitution</strong> — ask the
                  prescriber whether a tier-1 alternative exists for the same
                  indication (e.g. losartan for Entresto-resistant cases,
                  generic atorvastatin for high-cost statins).
                </li>
                <li>
                  <strong>Foundation grants</strong> — disease-fund grants from
                  PAN Foundation (panfoundation.org), HealthWell
                  (healthwellfoundation.org), Good Days (mygooddays.org). Open /
                  closed funds rotate; check before applying.
                </li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProgramRow({ row }: { row: AssistanceRow }) {
  const tagCls =
    row.program_type === 'PAP' ? 'pap' : row.program_type === 'copay_card' ? 'copay' : 'found';
  const tagLabel =
    row.program_type === 'PAP'
      ? 'Free drug'
      : row.program_type === 'copay_card'
        ? 'Copay card'
        : 'Foundation';
  return (
    <div className="qv4-pap-row">
      <div>
        <div className="qv4-pap-name">
          <span className={`qv4-pap-tag ${tagCls}`}>{tagLabel}</span>
          {row.program_name}
          {!row.covers_medicare && (
            <span className="qv4-pap-tag no-medicare" style={{ marginLeft: 6 }}>
              Excludes Medicare
            </span>
          )}
        </div>
        <div className="qv4-pap-mfr">
          {row.brand_name} · {row.manufacturer}
        </div>
      </div>
      <div className="qv4-pap-meta">
        {row.income_limit_individual != null && (
          <>
            ≤${row.income_limit_individual.toLocaleString()} indiv
            <br />
            ≤${(row.income_limit_couple ?? 0).toLocaleString()} couple
          </>
        )}
      </div>
      {row.eligibility_summary && (
        <div className="qv4-pap-elig">{row.eligibility_summary}</div>
      )}
      <div style={{ gridColumn: '1 / -1', marginTop: 6 }}>
        {row.application_url && (
          <a
            className="qv4-pap-cta"
            href={row.application_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Apply ↗
          </a>
        )}
        {row.phone_number && (
          <a className="qv4-pap-cta" href={`tel:${row.phone_number.replace(/\D/g, '')}`}>
            ☎ {row.phone_number}
          </a>
        )}
      </div>
    </div>
  );
}
