// DentalScreen — off-exchange individual dental quote (agent-v3).
//
// Stand-alone tool, NOT a step in the MA flow: it sits after Enroll in the
// AgentBar, never feeds the brain, and never writes to AgentBase. Data is
// pm_dental_plan + pm_dental_rate via /api/dental-plans (NC only for now,
// gathered from carrier documents 2026-10-17).
//
// Pricing rules live in src/lib/dentalPricing.ts. The screen never shows a
// price it doesn't have: a rate quoted for a different age or ZIP is shown
// with an amber "re-quote" flag, and a missing rate says so.

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useSession } from '@/hooks/useSession';
import {
  ageFromDob,
  missingToothStatus,
  priceDentalPlan,
  type DentalPlan,
  type Household,
  type PriceResult,
} from '@/lib/dentalPricing';

const NAVY = '#0d2f5e';
const SEAFOAM = '#83f0f9';
const MUTED = '#64748b';
const LINE = 'rgba(13,47,94,0.10)';

type MustHave = 'implants' | 'implantNoWait' | 'replacesMissing' | 'major' | 'noWait' | 'insuranceOnly';
const MUST_HAVES: Array<{ key: MustHave; label: string }> = [
  { key: 'implants', label: 'Covers implants' },
  { key: 'implantNoWait', label: 'Implants with no waiting period' },
  { key: 'replacesMissing', label: 'Replaces teeth already missing' },
  { key: 'major', label: 'Covers major work' },
  { key: 'noWait', label: 'No waiting period' },
  { key: 'insuranceOnly', label: 'Insurance only (hide discount plans)' },
];

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; plans: DentalPlan[] }
  | { status: 'error'; error: string };

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function yesNo(v: boolean | null): string {
  return v === true ? 'Covered' : v === false ? 'Not covered' : 'Not confirmed';
}

export function DentalScreen() {
  const client = useSession((s) => s.client);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [zip, setZip] = useState(client.zip ?? '');
  const [ageText, setAgeText] = useState(() => {
    const a = ageFromDob(client.dob);
    return a == null ? '' : String(a);
  });
  const [hasSpouse, setHasSpouse] = useState(false);
  const [spouseAgeText, setSpouseAgeText] = useState('');
  const [childrenText, setChildrenText] = useState('0');
  const [must, setMust] = useState<Record<MustHave, boolean>>({
    implants: false, implantNoWait: false, replacesMissing: false, major: false, noWait: false, insuranceOnly: false,
  });
  const [carriersOff, setCarriersOff] = useState<Record<string, boolean>>({});
  const [compare, setCompare] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/dental-plans?state=NC')
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok || !Array.isArray(body.plans)) {
          setLoad({ status: 'error', error: body.error ?? `HTTP ${r.status}` });
          return;
        }
        setLoad({ status: 'ready', plans: body.plans as DentalPlan[] });
      })
      .catch((e) => { if (!cancelled) setLoad({ status: 'error', error: String(e) }); });
    return () => { cancelled = true; };
  }, []);

  const age = /^\d{1,3}$/.test(ageText) ? Number(ageText) : null;
  const zip5 = /^\d{5}$/.test(zip) ? zip : null;
  const plans = useMemo(() => (load.status === 'ready' ? load.plans : []), [load]);

  const household = useMemo<Household>(() => {
    const spouseAge = /^\d{1,3}$/.test(spouseAgeText) ? Number(spouseAgeText) : null;
    const children = /^\d{1,2}$/.test(childrenText) ? Number(childrenText) : 0;
    return hasSpouse ? { spouseAge, children } : { children };
  }, [hasSpouse, spouseAgeText, childrenText]);

  const priced = useMemo(
    () => plans.map((p) => ({ plan: p, price: priceDentalPlan(p, { age, zip: zip5, household }) })),
    [plans, age, zip5, household],
  );

  const carriers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { plan, price } of priced) {
      if (price.kind === 'ineligible') continue;
      counts.set(plan.carrier, (counts.get(plan.carrier) ?? 0) + 1);
    }
    return [...new Set(plans.map((p) => p.carrier))].sort().map((c) => ({ name: c, count: counts.get(c) ?? 0 }));
  }, [plans, priced]);

  const ineligibleCount = priced.filter((x) => x.price.kind === 'ineligible').length;

  const visible = priced
    .filter(({ plan, price }) => {
      if (price.kind === 'ineligible') return false;
      if (carriersOff[plan.carrier]) return false;
      if (must.insuranceOnly && !plan.is_insurance) return false;
      if (must.implants && plan.covers_implants !== true) return false;
      if (must.implantNoWait && !(plan.covers_implants === true && plan.implant_wait_months === 0)) return false;
      if (must.replacesMissing && missingToothStatus(plan.missing_tooth_clause) !== 'replaces') return false;
      if (must.major && plan.covers_major !== true) return false;
      if (must.noWait && plan.no_waiting !== true) return false;
      return true;
    })
    .sort((a, b) => sortKey(a.price) - sortKey(b.price));

  const comparePlans = compare
    .map((id) => priced.find((x) => x.plan.id === id))
    .filter((x): x is { plan: DentalPlan; price: PriceResult } => Boolean(x));

  function toggleCompare(id: string) {
    setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id].slice(-4)));
  }

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto', padding: '28px 18px 64px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 20 }}>
        <div>
          <div style={{ fontFamily: "'Fraunces', Georgia, serif", fontSize: 26, fontWeight: 700, color: NAVY }}>
            Dental quote
          </div>
          <div style={{ color: MUTED, fontSize: 13 }}>
            Off-exchange individual dental · North Carolina · carrier data as of Oct 17, 2026
          </div>
        </div>
        <div style={{ color: MUTED, fontSize: 13 }}>Sorted lowest monthly premium first</div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
        {/* ── Inputs + filters ── */}
        <aside style={{ flex: '1 1 260px', maxWidth: 300, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Panel title="Client">
            <LabeledInput id="dental-zip" label="ZIP code" value={zip} onChange={setZip} inputMode="numeric" />
            <LabeledInput id="dental-age" label="Age" value={ageText} onChange={setAgeText} inputMode="numeric" />
            <ChipButton on={hasSpouse} onClick={() => setHasSpouse((v) => !v)} label="Add spouse / partner" />
            {hasSpouse && (
              <LabeledInput id="dental-spouse-age" label="Spouse age" value={spouseAgeText} onChange={setSpouseAgeText} inputMode="numeric" />
            )}
            <LabeledInput id="dental-children" label="Children covered (under 19)" value={childrenText} onChange={setChildrenText} inputMode="numeric" />
            {(client.zip || client.dob) && (
              <div style={{ fontSize: 11, color: MUTED }}>Prefilled from the Client screen — edit freely.</div>
            )}
          </Panel>

          <Panel title="Must have">
            {MUST_HAVES.map((m) => (
              <ChipButton
                key={m.key}
                on={must[m.key]}
                onClick={() => setMust((s) => ({ ...s, [m.key]: !s[m.key] }))}
                label={m.label}
              />
            ))}
            {(must.implants || must.implantNoWait || must.replacesMissing) && (
              <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.45 }}>
                Plans whose coverage isn't confirmed are hidden, not assumed covered.
              </div>
            )}
            {(must.implants || must.implantNoWait || must.replacesMissing) && (
              <div style={{ fontSize: 12, color: NAVY, background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '8px 10px', lineHeight: 1.45 }}>
                <b>Tooth needs pulling?</b> Have it pulled after the plan starts. A tooth pulled before the
                effective date counts as already missing — plans marked "Won't replace teeth missing at enrollment"
                won't pay to replace it. A tooth pulled after enrollment qualifies once the implant waiting period is met.
              </div>
            )}
          </Panel>

          <Panel title="Carriers">
            {carriers.map((c) => (
              <ChipButton
                key={c.name}
                on={!carriersOff[c.name]}
                onClick={() => setCarriersOff((s) => ({ ...s, [c.name]: !s[c.name] }))}
                label={c.name}
                trailing={String(c.count)}
              />
            ))}
          </Panel>
        </aside>

        {/* ── Results ── */}
        <section style={{ flex: '999 1 600px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {load.status === 'loading' && <Notice>Loading dental plans…</Notice>}
          {load.status === 'error' && (
            <Notice tone="error">Dental plans failed to load ({load.error}). Refresh to retry.</Notice>
          )}
          {load.status === 'ready' && (
            <div style={{ fontFamily: "'Fraunces', Georgia, serif", fontSize: 20, fontWeight: 700, color: NAVY }}>
              {visible.length} {visible.length === 1 ? 'plan' : 'plans'}
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 500, color: MUTED }}>
                {' '}· age {age ?? '—'}
                {hasSpouse && ` + spouse ${household.spouseAge ?? '—'}`}
                {household.children > 0 && ` + ${household.children} ${household.children === 1 ? 'child' : 'children'}`}
                {' '}· ZIP {zip5 ?? '—'}
              </span>
            </div>
          )}

          {comparePlans.length >= 2 && (
            <CompareTable
              rows={comparePlans}
              onClear={() => setCompare([])}
            />
          )}

          {visible.map(({ plan, price }) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              price={price}
              age={age}
              zip={zip5}
              inCompare={compare.includes(plan.id)}
              onCompare={() => toggleCompare(plan.id)}
              expanded={open === plan.id}
              onExpand={() => setOpen((o) => (o === plan.id ? null : plan.id))}
            />
          ))}

          {load.status === 'ready' && visible.length === 0 && (
            <Notice>No plans match these must-haves. Turn one off to see more.</Notice>
          )}
          {ineligibleCount > 0 && (
            <div style={{ fontSize: 12, color: MUTED }}>
              {ineligibleCount} {ineligibleCount === 1 ? 'plan is' : 'plans are'} hidden because the client is under the plan's minimum age.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function sortKey(p: PriceResult): number {
  return p.kind === 'price' ? p.monthly : Number.POSITIVE_INFINITY;
}

// ─── Plan card ───────────────────────────────────────────────────────

function PlanCard({
  plan, price, age, zip, inCompare, onCompare, expanded, onExpand,
}: {
  plan: DentalPlan;
  price: PriceResult;
  age: number | null;
  zip: string | null;
  inCompare: boolean;
  onCompare: () => void;
  expanded: boolean;
  onExpand: () => void;
}) {
  const badges = priceBadges(plan, price, age, zip);
  return (
    <article style={{ background: 'white', border: `1px solid ${LINE}`, borderRadius: 12, padding: '16px 18px', boxShadow: '0 2px 10px rgba(13,47,94,0.04)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'stretch' }}>
        <div style={{ flex: '1 1 210px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: MUTED }}>{plan.carrier}</div>
          <div style={{ fontFamily: "'Fraunces', Georgia, serif", fontSize: 18, fontWeight: 700, color: NAVY, lineHeight: 1.25 }}>{plan.plan_name}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {badges.map((b) => <Badge key={b.text} tone={b.tone}>{b.text}</Badge>)}
          </div>
        </div>

        <dl style={{ flex: '2 1 330px', minWidth: 0, margin: 0, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px 16px', alignContent: 'start' }}>
          <Stat label="Annual max" value={plan.annual_max} />
          <Stat label="Deductible" value={plan.deductible} />
          <Stat label="Waiting period" value={plan.waiting_period} />
          <Stat label="Basic" value={plan.basic} />
          <Stat label="Major" value={plan.major} />
          <Stat label="Implants" value={plan.implants ?? yesNo(plan.covers_implants)} highlight={plan.covers_implants === true} />
        </dl>

        <div style={{ flex: '0 1 160px', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10, textAlign: 'right' }}>
          <PriceBlock price={price} />
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" onClick={onExpand} aria-expanded={expanded} style={SMALL_BTN}>
              {expanded ? 'Less' : 'Details'}
            </button>
            <button
              type="button"
              onClick={onCompare}
              aria-pressed={inCompare}
              style={{ ...SMALL_BTN, background: inCompare ? SEAFOAM : 'white', borderColor: inCompare ? SEAFOAM : NAVY }}
            >
              {inCompare ? 'Comparing ✓' : 'Compare'}
            </button>
          </div>
        </div>
      </div>

      {expanded && (
        <dl style={{ margin: '14px 0 0', paddingTop: 14, borderTop: `1px solid ${LINE}`, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px 18px' }}>
          <Stat label="Preventive" value={plan.preventive} />
          <Stat label="Crowns" value={plan.crowns} />
          <Stat label="Dentures" value={plan.dentures} />
          <Stat label="Root canals" value={plan.root_canals} />
          <Stat label="Gum treatment" value={plan.periodontics} />
          <Stat label="Oral surgery / extractions" value={plan.oral_surgery} />
          <Stat label="Orthodontia" value={plan.orthodontia} />
          <Stat label="Missing-tooth rule" value={plan.missing_tooth_clause} />
          <Stat label="Waiting-period waiver" value={plan.waiting_waiver} />
          <Stat label="Who can enroll" value={plan.eligibility} />
          <Stat label="Extras" value={plan.extras} />
          <Stat label="Source" value={plan.source_doc} />
        </dl>
      )}
    </article>
  );
}

function priceBadges(plan: DentalPlan, price: PriceResult, age: number | null, zip: string | null): Array<{ text: string; tone: Tone }> {
  const out: Array<{ text: string; tone: Tone }> = [];
  if (!plan.is_insurance) out.push({ text: 'Discount plan · not insurance', tone: 'red' });
  if (price.kind === 'price') {
    if (price.flags.includes('quoted_other_age')) out.push({ text: `Rate quoted at age ${price.quotedAge} — re-quote for ${age ?? 'this client'}`, tone: 'amber' });
    if (price.flags.includes('quoted_other_zip')) out.push({ text: `Rate quoted for ZIP ${price.quotedZip} — re-quote for ${zip ?? 'this ZIP'}`, tone: 'amber' });
    if (price.flags.includes('starting_at')) out.push({ text: '"Starting at" price', tone: 'amber' });
  }
  if (plan.covers_implants === true) {
    const w = plan.implant_wait_months;
    out.push({ text: w === 0 ? 'Implants · no wait' : w != null ? `Implants · ${w}-mo wait` : 'Implants', tone: 'green' });
  }
  if (plan.no_waiting === true) out.push({ text: 'No waiting period', tone: 'green' });
  const mt = missingToothStatus(plan.missing_tooth_clause);
  if (mt === 'replaces') out.push({ text: 'Replaces teeth already missing', tone: 'green' });
  if (mt === 'excludes') out.push({ text: "Won't replace teeth missing at enrollment", tone: 'red' });
  if (mt === 'unknown' && plan.covers_implants === true) out.push({ text: 'Missing-tooth rule unconfirmed', tone: 'amber' });
  return out;
}

function PriceBlock({ price }: { price: PriceResult }) {
  if (price.kind === 'price') {
    return (
      <div>
        <div style={{ fontSize: 11, color: MUTED }}>Monthly premium</div>
        <div style={{ fontFamily: "'Fraunces', Georgia, serif", fontSize: 28, fontWeight: 700, color: NAVY }}>{money(price.monthly)}</div>
      </div>
    );
  }
  const msg =
    price.kind === 'no_tier' ? 'Household rate not loaded'
    : price.kind === 'needs_quote' && price.reason === 'children' ? 'Child rate not published — quote with carrier'
    : price.kind === 'needs_quote' ? 'Enter spouse age to price'
    : 'Rate not quoted for this age';
  return (
    <div>
      <div style={{ fontSize: 11, color: MUTED }}>Monthly premium</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#92400e' }}>{msg}</div>
    </div>
  );
}

// ─── Compare table ───────────────────────────────────────────────────

const COMPARE_ROWS: Array<{ label: string; get: (p: DentalPlan, pr: PriceResult) => string | null }> = [
  { label: 'Monthly premium', get: (_p, pr) => (pr.kind === 'price' ? money(pr.monthly) : null) },
  { label: 'Annual max', get: (p) => p.annual_max },
  { label: 'Deductible', get: (p) => p.deductible },
  { label: 'Waiting period', get: (p) => p.waiting_period },
  { label: 'Preventive', get: (p) => p.preventive },
  { label: 'Basic', get: (p) => p.basic },
  { label: 'Major', get: (p) => p.major },
  { label: 'Implants', get: (p) => p.implants ?? yesNo(p.covers_implants) },
  {
    label: 'Implant waiting period',
    get: (p) => (p.covers_implants !== true ? null : p.implant_wait_months === 0 ? 'None' : p.implant_wait_months != null ? `${p.implant_wait_months} months` : null),
  },
  { label: 'Dentures', get: (p) => p.dentures },
  { label: 'Missing-tooth rule', get: (p) => p.missing_tooth_clause },
  { label: 'Orthodontia', get: (p) => p.orthodontia },
];

function CompareTable({ rows, onClear }: { rows: Array<{ plan: DentalPlan; price: PriceResult }>; onClear: () => void }) {
  return (
    <section aria-label="Dental plan comparison" style={{ background: 'white', border: `2px solid ${NAVY}`, borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontFamily: "'Fraunces', Georgia, serif", fontSize: 17, fontWeight: 700, color: NAVY }}>Side by side ({rows.length})</div>
        <button type="button" onClick={onClear} style={SMALL_BTN}>Clear</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 600, fontSize: 13 }}>
          <thead>
            <tr>
              <th scope="col" style={{ ...TH, width: 140 }} />
              {rows.map(({ plan }) => (
                <th scope="col" key={plan.id} style={TH}>
                  <div style={{ fontSize: 10, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.5 }}>{plan.carrier}</div>
                  <div style={{ color: NAVY }}>{plan.plan_name}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPARE_ROWS.map((r) => (
              <tr key={r.label}>
                <th scope="row" style={{ ...TD, fontWeight: 700, color: '#334155' }}>{r.label}</th>
                {rows.map(({ plan, price }) => {
                  const v = r.get(plan, price);
                  return <td key={plan.id} style={{ ...TD, color: v ? '#0f172a' : '#92400e' }}>{v ?? 'Not on file'}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Small atoms ─────────────────────────────────────────────────────

type Tone = 'green' | 'amber' | 'red';
const TONES: Record<Tone, { bg: string; fg: string }> = {
  green: { bg: '#d1fae5', fg: '#065f46' },
  amber: { bg: '#fef3c7', fg: '#92400e' },
  red: { bg: '#fee2e2', fg: '#991b1b' },
};

function Badge({ tone, children }: { tone: Tone; children: string }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999, background: TONES[tone].bg, color: TONES[tone].fg }}>
      {children}
    </span>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string | null; highlight?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <dt style={{ fontSize: 11, color: MUTED }}>{label}</dt>
      <dd style={{ margin: 0, fontSize: 13, lineHeight: 1.35, color: value ? '#0f172a' : '#92400e', fontWeight: highlight ? 700 : 500, overflowWrap: 'anywhere' }}>
        {value ?? 'Not on file'}
      </dd>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ background: 'white', border: `1px solid ${LINE}`, borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontFamily: "'Fraunces', Georgia, serif", fontSize: 16, fontWeight: 700, color: NAVY }}>{title}</div>
      {children}
    </section>
  );
}

function LabeledInput({ id, label, value, onChange, inputMode }: {
  id: string; label: string; value: string; onChange: (v: string) => void; inputMode?: 'numeric';
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label htmlFor={id} style={LABEL}>{label}</label>
      <input id={id} value={value} inputMode={inputMode} onChange={(e) => onChange(e.target.value.trim())} style={INPUT} />
    </div>
  );
}

function ChipButton({ on, onClick, label, trailing }: { on: boolean; onClick: () => void; label: string; trailing?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
        minHeight: 40, width: '100%', padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
        fontSize: 13, fontWeight: 600, textAlign: 'left',
        background: on ? NAVY : 'white', color: on ? 'white' : NAVY, border: `1px solid ${on ? NAVY : 'rgba(13,47,94,0.25)'}`,
      }}
    >
      <span>{label}</span>
      {trailing && <span style={{ fontSize: 12, opacity: 0.7 }}>{trailing}</span>}
    </button>
  );
}

function Notice({ children, tone }: { children: ReactNode; tone?: 'error' }) {
  return (
    <div style={{
      padding: '14px 16px', borderRadius: 10, fontSize: 13, fontWeight: 600,
      background: tone === 'error' ? '#fef2f2' : 'white',
      border: `1px ${tone === 'error' ? 'solid #fecaca' : `dashed ${LINE}`}`,
      color: tone === 'error' ? '#7f1d1d' : '#334155',
    }}>
      {children}
    </div>
  );
}

const LABEL: CSSProperties = { fontSize: 10, fontWeight: 600, color: MUTED, letterSpacing: 0.5, textTransform: 'uppercase' };
const INPUT: CSSProperties = { height: 40, padding: '0 10px', border: '1px solid rgba(13,47,94,0.2)', borderRadius: 8, fontSize: 14, color: NAVY, background: 'white' };
const SMALL_BTN: CSSProperties = { minHeight: 36, padding: '0 12px', borderRadius: 8, border: `1px solid ${NAVY}`, background: 'white', color: NAVY, fontSize: 12, fontWeight: 700, cursor: 'pointer' };
const TH: CSSProperties = { textAlign: 'left', padding: '8px 10px', borderBottom: `1px solid ${LINE}`, verticalAlign: 'bottom', fontWeight: 700 };
const TD: CSSProperties = { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #eef2f7', verticalAlign: 'top' };
