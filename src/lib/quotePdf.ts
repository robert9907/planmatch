// quotePdf — generate a professional 5-page Medicare plan-comparison
// PDF from a structured snapshot of QuoteDeliveryV4's render state.
//
// Vector output via jsPDF + jspdf-autotable. No html2canvas screenshot
// path — the printed result needs to look like a quote a broker hands
// a client, not a screenshot of a web app.
//
// Page layout (US Letter portrait, 0.6" margins):
//   1. Cover + client + Plan Brain analysis
//   2. Medication summary (drug-cost table, cost-driver callout)
//   3. Plan comparison (medical copays, plan costs, extras with deltas)
//   4. Real annual cost breakdown + utilization assumptions
//   5. Recommendation + red flags + signature + disclaimer
//
// All pages get a header strip (GenerationHealth.me) and footer
// (page x/y + compliance line).

import { jsPDF } from 'jspdf';
import autoTable, { type RowInput } from 'jspdf-autotable';
import { BROKER, MEDICARE_2026 } from './constants';
import type { ScoredPlan, PlanBrainResult } from './plan-brain-types';
import type { Plan } from '@/types/plans';
import type { Client, Medication, Provider } from '@/types/session';

// ─── Input shape ─────────────────────────────────────────────────────

export interface PrintableMedRow {
  id: string;
  name: string;
  /** "30-day retail" or "90-day mail" */
  fillNote: string;
  /** One per column. null = no tier known. */
  tiers: (number | null)[];
  /** One per column. Display string ("$15", "—", "est. $47*"). */
  values: string[];
  /** Monthly $ per column. null = unavailable. */
  monthly: (number | null)[];
  /** Per-cell PA/ST flags. */
  paStFlags: Array<{ pa?: boolean; st?: boolean } | null>;
}

export interface PrintableProviderRow {
  id: string;
  name: string;
  specialty: string;
  /** 'in' | 'out' | 'unknown' per column */
  status: Array<'in' | 'out' | 'unknown'>;
}

export interface PrintableCopayRow {
  label: string;
  /** Human display per column ("$15", "20%", "—"). */
  values: string[];
  /** Numeric per column for delta math; null when not numeric. */
  numbers: (number | null)[];
  suffix?: string;
  /** When true, higher is better (e.g. Part B Giveback). Drives the
   *  delta sign coloring. */
  betterIsHigher?: boolean;
}

export interface PrintableColumn {
  id: string;
  variant: 'current' | 'best_rx' | 'lowest_oop' | 'giveback' | 'normal';
  /** Ribbon label as shown in the UI ("⭐ Best Rx Match"). Pass-thru. */
  ribbon: string | null;
  carrier: string;
  planName: string;
  hNumber: string;
  star: number;
  plan: Plan;
  scored: ScoredPlan | null;
}

export interface PrintableQuote {
  client: Client;
  age: number | null;
  medications: Medication[];
  providers: Provider[];
  result: PlanBrainResult;
  columns: PrintableColumn[];
  medRows: PrintableMedRow[];
  providerRows: PrintableProviderRow[];
  copayRows: PrintableCopayRow[];
  inpatientRow: PrintableCopayRow;
  /** Total inpatient cost per column ($/year). */
  inpatientTotal: (number | null)[];
  planCostRows: PrintableCopayRow[];
  extraRows: PrintableCopayRow[];
  /** Total monthly Rx cost per column ($/mo). */
  rxTotalMonthly: (number | null)[];
  /** Total annual Rx cost per column ($/yr). */
  rxTotalAnnual: (number | null)[];
  /** Why-switch text per column (already archetype-driven). */
  whySwitch: string[];
  /** Selected recommended plan id, or null. */
  recommendation: string | null;
  /** Pharmacy fill mode for the medication summary header. */
  pharmacyLabel: string;
}

// ─── Style tokens (B&W friendly) ─────────────────────────────────────

const M = 0.6 * 72; // 0.6" margin in points (jsPDF unit: pt)
const PAGE_W = 8.5 * 72;
const PAGE_H = 11 * 72;
const CONTENT_W = PAGE_W - 2 * M;

const FONT_HEAD = 'helvetica';
const FONT_BODY = 'helvetica';

const COL = {
  ink: '#1f2937',
  inkSub: '#4b5563',
  rule: '#d1d5db',
  navy: '#0c447c',
  navyDeep: '#1a2744',
  green: '#1f6b1f',
  red: '#a32d2d',
  amber: '#854f0b',
  panelBg: '#f5f4f0',
  white: '#ffffff',
};

// ─── Public entry ────────────────────────────────────────────────────

export interface GenerateResult {
  blob: Blob;
  url: string;
  filename: string;
}

export function generateQuotePdf(q: PrintableQuote): GenerateResult {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });

  // jsPDF doesn't track total pages until the doc is built, so we
  // collect a list of "draw page chrome later" callbacks and run
  // them after all content is laid out.
  const finalize: Array<() => void> = [];

  drawCoverPage(doc, q, finalize);
  drawMedicationsPage(doc, q, finalize);
  drawComparisonPages(doc, q, finalize);
  drawRealAnnualCostPage(doc, q, finalize);
  drawRecommendationPage(doc, q, finalize);

  // Header + footer pass — done here so footer can show "page X of Y".
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    drawHeaderFooter(doc, i, total);
  }
  finalize.forEach((fn) => fn());

  const blob = doc.output('blob');
  const url = URL.createObjectURL(blob);
  const filename = buildFilename(q.client.name);
  return { blob, url, filename };
}

function buildFilename(clientName: string): string {
  const safe = (clientName || 'Client').replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
  const today = new Date().toISOString().slice(0, 10);
  return `Medicare-Plan-Comparison-${safe || 'Client'}-${today}.pdf`;
}

// ─── Header / footer ─────────────────────────────────────────────────

function drawHeaderFooter(doc: jsPDF, page: number, total: number) {
  // Header — thin rule under "GenerationHealth.me · Medicare Plan Comparison"
  doc.setFontSize(8);
  doc.setFont(FONT_HEAD, 'bold');
  doc.setTextColor(COL.navyDeep);
  doc.text('GenerationHealth.me', M, M - 14);
  doc.setFont(FONT_HEAD, 'normal');
  doc.setTextColor(COL.inkSub);
  doc.text('Medicare Plan Comparison', PAGE_W - M, M - 14, { align: 'right' });
  doc.setDrawColor(COL.rule);
  doc.setLineWidth(0.5);
  doc.line(M, M - 8, PAGE_W - M, M - 8);

  // Footer — page x / y + compliance line
  const footerY = PAGE_H - M + 20;
  doc.setDrawColor(COL.rule);
  doc.line(M, footerY - 14, PAGE_W - M, footerY - 14);
  doc.setFontSize(7);
  doc.setFont(FONT_BODY, 'normal');
  doc.setTextColor(COL.inkSub);
  doc.text(
    `Prepared by GenerationHealth.me · ${BROKER.phone} · Not connected with or endorsed by the U.S. Government or the Federal Medicare program.`,
    M,
    footerY,
    { maxWidth: CONTENT_W },
  );
  doc.setFont(FONT_BODY, 'bold');
  doc.text(`Page ${page} of ${total}`, PAGE_W - M, footerY + 10, { align: 'right' });
}

// ─── Page 1: cover ──────────────────────────────────────────────────

function drawCoverPage(doc: jsPDF, q: PrintableQuote, _finalize: Array<() => void>) {
  let y = M + 20;

  // Title block
  doc.setFont(FONT_HEAD, 'bold');
  doc.setFontSize(28);
  doc.setTextColor(COL.navyDeep);
  doc.text('Medicare Plan', M, y);
  y += 28;
  doc.text('Comparison', M, y);
  y += 18;

  doc.setFont(FONT_BODY, 'normal');
  doc.setFontSize(10);
  doc.setTextColor(COL.inkSub);
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  doc.text(`Prepared ${today}`, M, y);
  y += 30;

  // Client block
  drawSectionHeader(doc, 'Client', y);
  y += 20;
  const clientLines: Array<[string, string]> = [
    ['Name', q.client.name || '—'],
    ['Location', [q.client.county, q.client.state, q.client.zip].filter(Boolean).join(', ') || '—'],
    ['Age', q.age != null ? String(q.age) : '—'],
    ['Phone', q.client.phone || '—'],
    ['Plan Type', q.client.planType || '—'],
  ];
  drawKeyValueGrid(doc, clientLines, M, y, CONTENT_W, 14);
  y += clientLines.length * 14 + 18;

  // Plan Brain analysis
  drawSectionHeader(doc, 'Plan Brain Analysis', y);
  y += 20;
  // Conditions row
  doc.setFont(FONT_BODY, 'bold');
  doc.setFontSize(9);
  doc.setTextColor(COL.ink);
  doc.text('Detected Conditions:', M, y);
  doc.setFont(FONT_BODY, 'normal');
  const conds = q.result.detectedConditions
    .map((d) => `${d.condition.charAt(0).toUpperCase()}${d.condition.slice(1)} (${d.confidence})`)
    .join(' · ') || 'None';
  doc.text(conds, M + 110, y, { maxWidth: CONTENT_W - 110 });
  y += 14;

  if (q.result.medicationPatterns.length > 0) {
    doc.setFont(FONT_BODY, 'bold');
    doc.text('Medication Patterns:', M, y);
    doc.setFont(FONT_BODY, 'normal');
    const patterns = q.result.medicationPatterns.map((p) => p.summary).join('\n');
    const splitPatterns = doc.splitTextToSize(patterns, CONTENT_W - 110);
    doc.text(splitPatterns, M + 110, y);
    y += splitPatterns.length * 12 + 4;
  }

  doc.setFont(FONT_BODY, 'bold');
  doc.text('Client Archetype:', M, y);
  doc.setFont(FONT_BODY, 'normal');
  const arch = q.result.archetype;
  doc.text(arch.label, M + 110, y);
  y += 12;
  doc.setFont(FONT_BODY, 'italic');
  doc.setTextColor(COL.inkSub);
  doc.text(arch.description, M + 110, y, { maxWidth: CONTENT_W - 110 });
  y += 14;

  doc.setFont(FONT_BODY, 'bold');
  doc.setTextColor(COL.ink);
  doc.text('Scoring Weights:', M, y);
  doc.setFont(FONT_BODY, 'normal');
  doc.text(
    `Drug ${Math.round(q.result.weights.drug * 100)}%  ·  OOP ${Math.round(q.result.weights.oop * 100)}%  ·  Extras ${Math.round(q.result.weights.extras * 100)}%`,
    M + 110,
    y,
  );
  y += 24;

  // Broker block
  drawSectionHeader(doc, 'Your Broker', y);
  y += 20;
  doc.setFontSize(11);
  doc.setFont(FONT_BODY, 'bold');
  doc.setTextColor(COL.ink);
  doc.text(BROKER.name, M, y);
  y += 14;
  doc.setFontSize(9);
  doc.setFont(FONT_BODY, 'normal');
  doc.setTextColor(COL.inkSub);
  doc.text('Licensed Medicare Broker · NPN #' + BROKER.npn, M, y);
  y += 12;
  doc.text(`${BROKER.phone}  ·  ${BROKER.email}`, M, y);
  y += 12;
  doc.text(`Licensed in: ${BROKER.states.join(', ')}`, M, y);
}

// ─── Page 2: medications ────────────────────────────────────────────

function drawMedicationsPage(doc: jsPDF, q: PrintableQuote, _finalize: Array<() => void>) {
  doc.addPage();
  let y = M + 20;

  doc.setFont(FONT_HEAD, 'bold');
  doc.setFontSize(18);
  doc.setTextColor(COL.navyDeep);
  doc.text('Your Medications', M, y);
  y += 8;
  doc.setFont(FONT_BODY, 'normal');
  doc.setFontSize(9);
  doc.setTextColor(COL.inkSub);
  doc.text(`Pricing: ${q.pharmacyLabel} · estimates from formulary tier or pm_drug_cost_cache`, M, y + 10);
  y += 26;

  if (q.medications.length === 0) {
    doc.setFontSize(11);
    doc.setFont(FONT_BODY, 'italic');
    doc.setTextColor(COL.inkSub);
    doc.text('No medications entered.', M, y);
    return;
  }

  // Cost-driver callout — find the rxcui that contributes ≥80% of
  // total annual cost on the lead column. Mirrors the engine's red-flag
  // logic so the UI and PDF agree on the cost driver.
  const driver = identifyCostDriverDisplay(q);
  if (driver) {
    doc.setFillColor(COL.amber + '22');
    doc.rect(M, y, CONTENT_W, 24, 'F');
    doc.setFont(FONT_BODY, 'bold');
    doc.setFontSize(10);
    doc.setTextColor(COL.amber);
    doc.text(`Cost driver: ${driver.medName} drives ${driver.pct}% of your drug costs`, M + 10, y + 16);
    y += 36;
  }

  // Drug table — Drug | Strength | Tier (lead col) | $/30 per column | flags
  const head: RowInput[] = [
    [
      { content: 'Drug', styles: { halign: 'left' } },
      { content: 'Tier', styles: { halign: 'center' } },
      ...q.columns.map((c) => ({ content: planHeader(c), styles: { halign: 'right' as const } })),
      { content: 'Flags', styles: { halign: 'center' } },
    ],
  ];

  const body: RowInput[] = q.medRows.map((m) => [
    { content: m.name, styles: { halign: 'left' as const, fontStyle: 'bold' as const } },
    {
      content: leadTier(m),
      styles: { halign: 'center' as const },
    },
    ...m.values.map((v, ci) => ({
      content: v,
      styles: {
        halign: 'right' as const,
        fontStyle: (ci === 0 ? 'bold' : 'normal') as 'bold' | 'normal',
      },
    })),
    {
      content: paStString(m),
      styles: { halign: 'center' as const, fontSize: 8 },
    },
  ]);

  // Total monthly + annual rows
  body.push([
    { content: 'Total Rx (monthly)', styles: { halign: 'left' as const, fontStyle: 'bold' as const } },
    { content: '', styles: { halign: 'center' } },
    ...q.rxTotalMonthly.map((v) => ({
      content: v != null ? `$${v.toLocaleString()}` : '—',
      styles: { halign: 'right' as const, fontStyle: 'bold' as const },
    })),
    { content: '' },
  ]);
  body.push([
    { content: 'Total Rx (annual)', styles: { halign: 'left' as const, fontStyle: 'bold' as const } },
    { content: '', styles: { halign: 'center' } },
    ...q.rxTotalAnnual.map((v) => ({
      content: v != null ? `$${v.toLocaleString()}` : '—',
      styles: { halign: 'right' as const, fontStyle: 'bold' as const },
    })),
    { content: '' },
  ]);

  autoTable(doc, {
    startY: y,
    head,
    body,
    theme: 'grid',
    margin: { left: M, right: M },
    headStyles: { fillColor: COL.navyDeep, textColor: COL.white, fontSize: 8 },
    bodyStyles: { fontSize: 8, textColor: COL.ink, cellPadding: 4 },
    alternateRowStyles: { fillColor: COL.panelBg },
    columnStyles: { 0: { cellWidth: 130 } },
  });
}

function leadTier(m: PrintableMedRow): string {
  const t = m.tiers[0];
  return t != null ? `T${t}` : '—';
}

function paStString(m: PrintableMedRow): string {
  // Show union flags across all columns — if PA fires anywhere, the
  // client should know.
  const anyPa = m.paStFlags.some((f) => f?.pa);
  const anySt = m.paStFlags.some((f) => f?.st);
  const bits = [anyPa ? 'PA' : '', anySt ? 'ST' : ''].filter(Boolean);
  return bits.join('+');
}

function identifyCostDriverDisplay(q: PrintableQuote): { medName: string; pct: number } | null {
  // Use the lead (first) column's annual costs.
  const leadAnnual: Record<string, number> = {};
  for (const m of q.medRows) {
    const monthly = m.monthly[0];
    if (typeof monthly === 'number' && monthly > 0) {
      leadAnnual[m.id] = monthly * 12;
    }
  }
  const total = Object.values(leadAnnual).reduce((a, b) => a + b, 0);
  if (total <= 0 || q.medRows.length < 2) return null;
  let bestId: string | null = null;
  let bestVal = 0;
  for (const [id, v] of Object.entries(leadAnnual)) {
    if (v > bestVal) { bestId = id; bestVal = v; }
  }
  if (!bestId) return null;
  const pct = Math.round((bestVal / total) * 100);
  if (pct < 60) return null; // not a "driver" until it dominates
  const med = q.medRows.find((m) => m.id === bestId);
  return med ? { medName: med.name, pct } : null;
}

// ─── Page 3: comparison table ───────────────────────────────────────

function drawComparisonPages(doc: jsPDF, q: PrintableQuote, _finalize: Array<() => void>) {
  doc.addPage();
  let y = M + 20;

  doc.setFont(FONT_HEAD, 'bold');
  doc.setFontSize(18);
  doc.setTextColor(COL.navyDeep);
  doc.text('Plan Comparison', M, y);
  y += 22;

  // Plan headers as a "header" autotable so the layout repeats if
  // we overflow onto a follow-up page.
  const header: RowInput = [
    { content: '', styles: { halign: 'left' } },
    ...q.columns.map((c) => ({
      content: planHeader(c),
      styles: { halign: 'left' as const, fontStyle: 'bold' as const },
    })),
  ];

  const sections: Array<{ label: string; rows: PrintableCopayRow[] }> = [
    { label: 'Medical Copays', rows: q.copayRows },
    { label: 'Inpatient', rows: [q.inpatientRow] },
    { label: 'Plan Costs', rows: q.planCostRows },
    { label: 'Extra Benefits', rows: q.extraRows },
  ];

  // Build the body — section header rows separate the groups.
  const body: RowInput[] = [];
  for (const sec of sections) {
    body.push([
      {
        content: sec.label,
        colSpan: 1 + q.columns.length,
        styles: { fillColor: COL.panelBg, textColor: COL.navyDeep, fontStyle: 'bold', halign: 'left' as const, fontSize: 9 },
      },
    ]);
    for (const row of sec.rows) {
      body.push(buildComparisonRow(row, q));
    }
    if (sec.label === 'Inpatient') {
      // Add the per-year total row right after the inpatient day rate.
      body.push([
        { content: 'Total Inpatient Cost (5-day stay)', styles: { halign: 'left' as const, fontStyle: 'italic' as const } },
        ...q.inpatientTotal.map((v, ci) => ({
          content: v != null ? `$${v.toLocaleString()}` : '—',
          styles: { halign: 'right' as const, ...deltaStyles(v, q.inpatientTotal[0], ci, false) },
        })),
      ]);
    }
  }

  autoTable(doc, {
    startY: y,
    head: [header],
    body,
    theme: 'grid',
    margin: { left: M, right: M },
    headStyles: { fillColor: COL.navyDeep, textColor: COL.white, fontSize: 8 },
    bodyStyles: { fontSize: 8, textColor: COL.ink, cellPadding: 4 },
    alternateRowStyles: { fillColor: '#fafaf7' },
    columnStyles: { 0: { cellWidth: 130, fontStyle: 'bold' } },
  });
}

function buildComparisonRow(row: PrintableCopayRow, q: PrintableQuote): RowInput {
  const cells: RowInput = [
    { content: row.label, styles: { halign: 'left' as const } },
  ];
  const baseNum = row.numbers[0];
  for (let ci = 0; ci < q.columns.length; ci++) {
    const display = row.values[ci] ?? '—';
    const num = row.numbers[ci];
    const delta = baseNum != null && num != null && ci > 0 ? num - baseNum : null;
    cells.push({
      content: formatCellWithDelta(display, delta, row.suffix, row.betterIsHigher),
      styles: { halign: 'right' as const, ...deltaStyles(num, baseNum, ci, row.betterIsHigher) },
    });
  }
  return cells;
}

function formatCellWithDelta(
  display: string,
  delta: number | null,
  suffix?: string,
  betterIsHigher?: boolean,
): string {
  if (delta == null || Math.abs(delta) < 0.5) return display;
  const sign = delta > 0 ? '+' : '−';
  const prefix = (delta > 0) === Boolean(betterIsHigher) ? '↑' : '↓';
  return `${display}\n${prefix}${sign}$${Math.abs(Math.round(delta)).toLocaleString()}${suffix ?? ''}`;
}

function deltaStyles(
  num: number | null,
  base: number | null,
  ci: number,
  betterIsHigher?: boolean,
): { textColor?: string; fontStyle?: 'bold' | 'normal' } {
  if (ci === 0 || num == null || base == null) return {};
  const diff = num - base;
  if (Math.abs(diff) < 0.5) return {};
  const better = betterIsHigher ? diff > 0 : diff < 0;
  return {
    textColor: better ? COL.green : COL.red,
    fontStyle: 'bold',
  };
}

// ─── Page 4: real annual cost breakdown ─────────────────────────────

function drawRealAnnualCostPage(doc: jsPDF, q: PrintableQuote, _finalize: Array<() => void>) {
  doc.addPage();
  let y = M + 20;

  doc.setFont(FONT_HEAD, 'bold');
  doc.setFontSize(18);
  doc.setTextColor(COL.navyDeep);
  doc.text('Real Annual Cost', M, y);
  y += 22;

  // Utilization assumption block
  const u = q.result.utilizationProfile;
  doc.setFont(FONT_BODY, 'normal');
  doc.setFontSize(9);
  doc.setTextColor(COL.inkSub);
  const conds = q.result.detectedConditions.map((d) => d.condition).join(' + ') || 'healthy baseline';
  const assumption = `Based on ${conds}: ${u.pcp} PCP visits, ${u.specialist} specialist visits, ${u.labs} lab draws, ${(u.erProbability * 100).toFixed(0)}% ER probability, ${(u.hospitalProbability * 100).toFixed(0)}% hospital probability${u.monthlySupplies > 0 ? `, ${u.monthlySupplies} months of supplies` : ''}.`;
  const wrapped = doc.splitTextToSize(assumption, CONTENT_W);
  doc.text(wrapped, M, y);
  y += wrapped.length * 11 + 14;

  // Per-plan breakdown table (rows are line items, columns are plans).
  const lineItems: Array<{ label: string; key: keyof NonNullable<ScoredPlan['realAnnualCost']>; positive: boolean }> = [
    { label: 'Premium ($/yr)', key: 'premium', positive: true },
    { label: 'Drug Cost ($/yr)', key: 'drugs', positive: true },
    { label: 'Medical Visits ($/yr)', key: 'medicalVisits', positive: true },
    { label: 'Diabetic Supplies ($/yr)', key: 'supplies', positive: true },
    { label: 'ER Risk ($/yr)', key: 'erExpected', positive: true },
    { label: 'Hospital Risk ($/yr)', key: 'hospitalExpected', positive: true },
    { label: 'Part B Giveback ($/yr)', key: 'givebackSavings', positive: false }, // negative line
  ];

  const head: RowInput[] = [
    [
      { content: 'Component', styles: { halign: 'left' } },
      ...q.columns.map((c) => ({
        content: planHeader(c),
        styles: { halign: 'right' as const, fontStyle: 'bold' as const },
      })),
    ],
  ];

  const body: RowInput[] = lineItems.map((li) => [
    { content: li.label, styles: { halign: 'left' as const, fontStyle: 'bold' as const } },
    ...q.columns.map((c) => {
      const r = c.scored?.realAnnualCost ?? null;
      if (!r) return { content: '—', styles: { halign: 'right' as const } };
      const v = r[li.key] as number;
      const display = v === 0 ? '—' : `${li.positive ? '' : '−'}$${v.toLocaleString()}`;
      return { content: display, styles: { halign: 'right' as const } };
    }),
  ]);

  // Net annual row
  body.push([
    { content: 'Net Annual Cost', styles: { halign: 'left' as const, fontStyle: 'bold' as const, fontSize: 10, fillColor: COL.navyDeep, textColor: COL.white } },
    ...q.columns.map((c) => {
      const r = c.scored?.realAnnualCost ?? null;
      const v = r?.netAnnual;
      return {
        content: v != null ? `$${v.toLocaleString()}/yr` : '—',
        styles: {
          halign: 'right' as const,
          fontStyle: 'bold' as const,
          fontSize: 10,
          fillColor: COL.navyDeep,
          textColor: COL.white,
        },
      };
    }),
  ]);

  autoTable(doc, {
    startY: y,
    head,
    body,
    theme: 'grid',
    margin: { left: M, right: M },
    headStyles: { fillColor: COL.navyDeep, textColor: COL.white, fontSize: 8 },
    bodyStyles: { fontSize: 8, textColor: COL.ink, cellPadding: 4 },
    alternateRowStyles: { fillColor: '#fafaf7' },
    columnStyles: { 0: { cellWidth: 150 } },
  });

  // Note about MOOP capping when applicable
  const anyCapped = q.columns.some((c) => c.scored?.realAnnualCost?.cappedAtMoop);
  if (anyCapped) {
    const yAfter = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y + 200;
    doc.setFont(FONT_BODY, 'italic');
    doc.setFontSize(8);
    doc.setTextColor(COL.amber);
    doc.text(
      'Note: Medical components are capped at the in-network MOOP for plans where projected utilization × copays would exceed it.',
      M,
      yAfter + 16,
      { maxWidth: CONTENT_W },
    );
  }
}

// ─── Page 5: recommendation ────────────────────────────────────────

function drawRecommendationPage(doc: jsPDF, q: PrintableQuote, _finalize: Array<() => void>) {
  doc.addPage();
  let y = M + 20;

  doc.setFont(FONT_HEAD, 'bold');
  doc.setFontSize(18);
  doc.setTextColor(COL.navyDeep);
  doc.text('Broker Recommendation', M, y);
  y += 22;

  // Recommended plan callout
  const rec = q.recommendation
    ? q.columns.find((c) => c.id === q.recommendation)
    : null;
  if (rec) {
    doc.setFillColor(COL.green + '22');
    doc.rect(M, y, CONTENT_W, 60, 'F');
    doc.setFont(FONT_BODY, 'bold');
    doc.setFontSize(10);
    doc.setTextColor(COL.green);
    doc.text('✓ Recommended', M + 12, y + 18);
    doc.setFontSize(13);
    doc.setTextColor(COL.ink);
    doc.text(`${rec.carrier} · ${rec.planName}`, M + 12, y + 36);
    doc.setFontSize(9);
    doc.setFont(FONT_BODY, 'normal');
    doc.setTextColor(COL.inkSub);
    doc.text(`${rec.hNumber} · ${rec.star.toFixed(1)}★`, M + 12, y + 50);
    y += 76;
  }

  // Per-plan Why-switch + red flags
  drawSectionHeader(doc, 'Why Each Plan Earned Its Spot', y);
  y += 20;
  for (let ci = 0; ci < q.columns.length; ci++) {
    const c = q.columns[ci];
    if (y > PAGE_H - M - 100) {
      doc.addPage();
      y = M + 20;
      drawSectionHeader(doc, 'Why Each Plan Earned Its Spot (continued)', y);
      y += 20;
    }
    doc.setFont(FONT_BODY, 'bold');
    doc.setFontSize(10);
    doc.setTextColor(COL.ink);
    doc.text(`${c.carrier} · ${c.planName}`, M, y);
    y += 12;
    doc.setFont(FONT_BODY, 'normal');
    doc.setFontSize(9);
    doc.setTextColor(COL.inkSub);
    const why = q.whySwitch[ci] || '—';
    const wrapped = doc.splitTextToSize(why, CONTENT_W);
    doc.text(wrapped, M, y);
    y += wrapped.length * 11 + 4;

    // Red flags for this plan
    const flags = c.scored?.redFlags ?? [];
    const critical = flags.filter((f) => f.severity === 'critical' || f.severity === 'disqualify');
    if (critical.length > 0) {
      doc.setFont(FONT_BODY, 'bold');
      doc.setTextColor(COL.red);
      doc.text('⚠ Red flag:', M, y);
      doc.setFont(FONT_BODY, 'normal');
      const messages = critical.map((f) => f.message).join(' · ');
      const wrapMsg = doc.splitTextToSize(messages, CONTENT_W - 60);
      doc.text(wrapMsg, M + 60, y);
      y += wrapMsg.length * 11 + 6;
    }
    y += 8;
  }

  // Signature + disclaimer block
  if (y > PAGE_H - M - 180) {
    doc.addPage();
    y = M + 20;
  }
  y += 10;
  drawSectionHeader(doc, 'Signature', y);
  y += 24;
  doc.setDrawColor(COL.ink);
  doc.setLineWidth(0.5);
  doc.line(M, y, M + 240, y);
  doc.line(M + 280, y, M + 460, y);
  doc.setFont(FONT_BODY, 'normal');
  doc.setFontSize(8);
  doc.setTextColor(COL.inkSub);
  doc.text('Broker (Rob Simm)', M, y + 12);
  doc.text('Date', M + 280, y + 12);
  y += 30;

  drawSectionHeader(doc, 'Disclaimer', y);
  y += 18;
  doc.setFont(FONT_BODY, 'normal');
  doc.setFontSize(8);
  doc.setTextColor(COL.inkSub);
  const disclaimer =
    `This comparison is based on CMS plan data for ${MEDICARE_2026 ? '2026' : new Date().getFullYear()}. ` +
    'Costs are estimates derived from the plan\'s formulary tier, average utilization for your detected ' +
    'conditions, and CMS-published copays — verify with the carrier before enrollment. ' +
    `Rob Simm · NPN #${BROKER.npn} · ${BROKER.email} · ${BROKER.phone}.`;
  const wrap = doc.splitTextToSize(disclaimer, CONTENT_W);
  doc.text(wrap, M, y);
}

// ─── Helpers ────────────────────────────────────────────────────────

function planHeader(c: PrintableColumn): string {
  const ribbon = c.ribbon ? `\n${c.ribbon}` : '';
  return `${c.carrier}\n${c.planName}\n${c.hNumber} · ${c.star.toFixed(1)}★${ribbon}`;
}

function drawSectionHeader(doc: jsPDF, label: string, y: number) {
  doc.setFont(FONT_HEAD, 'bold');
  doc.setFontSize(11);
  doc.setTextColor(COL.navyDeep);
  doc.text(label, M, y);
  doc.setDrawColor(COL.navy);
  doc.setLineWidth(1);
  doc.line(M, y + 4, PAGE_W - M, y + 4);
}

function drawKeyValueGrid(
  doc: jsPDF,
  rows: Array<[string, string]>,
  x: number,
  y: number,
  width: number,
  rowH: number,
) {
  const labelW = 90;
  doc.setFontSize(9);
  for (let i = 0; i < rows.length; i++) {
    const [k, v] = rows[i];
    const cy = y + i * rowH + rowH * 0.7;
    doc.setFont(FONT_BODY, 'bold');
    doc.setTextColor(COL.inkSub);
    doc.text(k, x, cy);
    doc.setFont(FONT_BODY, 'normal');
    doc.setTextColor(COL.ink);
    doc.text(v, x + labelW, cy, { maxWidth: width - labelW });
  }
}
