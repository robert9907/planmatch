// HospitalScreen — hospital indemnity quote (agent-v3).
//
// Stand-alone tool like Dental: NOT a step in the MA flow, never feeds the
// brain. Product: Bankers Fidelity Vantage Flex Plus (HI21BFLIC). Benefit
// rules + pricing live in api/_lib/hospitalIndemnity.ts; a price that isn't
// a real BFLIC line item is tagged "Estimated" and can't be sent.
//
// Send: one link, this product only. Personal = to a named client (link ends
// in their name). General = no name anywhere. Goes through
// /api/hospital-quote-send, which re-prices server-side before saving.

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useSession } from '@/hooks/useSession';
import { ageFromDob } from '@/lib/dentalPricing';
import {
  BENEFIT_PERIODS,
  FIXED,
  HOSPITAL_STATES,
  HOUSEHOLD_LABEL,
  OPTIONS,
  PACKAGES,
  canSend,
  money0,
  money2,
  priceHospital,
  stayPays,
  type BenefitPeriod,
  type HospitalBenefits,
  type Household,
} from '@/lib/hospitalIndemnity';

const NAVY = '#0d2f5e';
const MUTED = '#64748b';
const INK = '#0f172a';
const LINE = 'rgba(13,47,94,0.10)';
const GRN = '#1a9c55';
const GRN_BG = 'rgba(46,204,113,0.10)';
const AMB = '#9A6B1A';
const AMB_BG = '#FDF3E3';
const SERIF = "'Fraunces', Georgia, serif";

/** Where the quote link goes in the editable text. */
const LINK_TOKEN = '[quote link]';

const FED_NOTICE =
  'THIS IS A SUPPLEMENT TO HEALTH INSURANCE AND IS NOT A SUBSTITUTE FOR MAJOR MEDICAL COVERAGE.';

type PkgKey = keyof typeof PACKAGES;

type Scenario = { key: string; label: string; story: string; lines: (b: HospitalBenefits) => Array<[string, string, number]> };
const SCENARIOS: Scenario[] = [
  { key: 'er', label: 'ER visit', story: 'Severe stomach pain, ER visit, sent home the same day.', lines: () => [['Emergency room', '1 of 4 visits a year', FIXED.er]] },
  { key: 'uc', label: 'Urgent care', story: 'Twisted ankle, urgent care, X-ray, sent home.', lines: (b) => [['Urgent care', '1 of 4 visits a year', FIXED.uc], ['Minor diagnostic exam', 'X-ray', b.min]] },
  { key: 'obs', label: 'Observation stay', story: 'Chest pain, ER, kept overnight to watch, never admitted.', lines: (b) => [['Emergency room', '1 visit', FIXED.er], ['Observation room', 'Not admitted', b.daily]] },
  {
    key: 'stay3', label: '3-day hospital stay', story: 'Ambulance to the hospital with pneumonia, admitted 3 days.',
    lines: (b) => { const d = Math.min(3, b.period); return [['Ambulance: ground', '1 trip', b.gnd], ['Hospital admission', 'Paid once', b.adm], ['Daily confinement', `${d} day${d > 1 ? 's' : ''} × ${money0(b.daily)}${d < 3 ? ` (yearly limit ${d})` : ''}`, b.daily * d]]; },
  },
  {
    key: 'stay10', label: '10-day hospital stay', story: 'Heart attack, admitted 10 days, 2 of them in the ICU.',
    lines: (b) => { const d = Math.min(10, b.period); return [['Ambulance: ground', '1 trip', b.gnd], ['Hospital admission', 'Paid once', b.adm], ['Daily confinement', `${d} day${d > 1 ? 's' : ''} × ${money0(b.daily)}${d < 10 ? ` (yearly limit ${d})` : ''}`, b.daily * d], ['ICU admission', b.icuA ? 'Moved to ICU' : 'Rider not added', b.icuA ? 500 : 0], ['Daily ICU confinement', b.icuD ? '2 days × $250' : 'Rider not added', b.icuD ? 500 : 0]]; },
  },
  { key: 'surg', label: 'Outpatient surgery', story: 'Knee surgery at a surgery center, home the same day.', lines: (b) => [['Outpatient surgery', '1 of 2 a year', b.osh]] },
  { key: 'mri', label: 'MRI or CT scan', story: 'Doctor orders an MRI for a back injury.', lines: (b) => [['Major diagnostic exam', 'Once a year', b.maj]] },
];

function explain(b: HospitalBenefits): Record<string, string> {
  const yr = b.period === 1 ? '1 day' : `${b.period} days`;
  const nz = (v: number, on: string, off: string) => (v > 0 ? on : off);
  return {
    adm: `Admitted as an inpatient: pays ${money0(b.adm)} per admission, up to 5 a year.`,
    daily: `${money0(b.daily)} for each hospital day, up to ${yr} a year in total. Yearly most: ${money0(b.daily * b.period)}.`,
    period: 'Hospital days paid per policy year, across all stays.',
    er: `Fixed: ${money0(FIXED.er)} per ER visit for sickness or injury, up to 4 a year.`,
    uc: `Fixed: ${money0(FIXED.uc)} per urgent care visit, up to 4 a year.`,
    obs: `Always equals daily confinement: ${money0(b.daily)} when kept for observation, up to 5 a year.`,
    air: `${money0(b.air)} per air ambulance trip, up to 4 a year.`,
    gnd: `${money0(b.gnd)} per ground or water ambulance trip, up to 4 a year.`,
    icuA: b.icuA ? '$500 when moved into the ICU, once a year.' : 'Not added.',
    icuD: b.icuD ? '$250 per ICU day, up to 10 days a year.' : 'Not added.',
    osh: nz(b.osh, `Same-day surgery pays ${money0(b.osh)}, up to 2 a year.`, 'Not added.'),
    maj: nz(b.maj, `MRI, CT or PET scan pays ${money0(b.maj)}, once a year.`, 'Not added.'),
    inv: nz(b.inv, `Colonoscopy or biopsy pays ${money0(b.inv)}, once a year.`, 'Not added.'),
    min: nz(b.min, `X-ray, lab or EKG pays ${money0(b.min)}, up to 2 a year.`, 'Not added.'),
    hs: nz(b.hs, `Wellness screening pays ${money0(b.hs)}, once a year per person.`, 'Not added.'),
    rehab: b.rehab ? `$50 per rehab unit day, up to ${b.rehab} days a year.` : 'Not added.',
    snf: nz(b.snf, `${money0(b.snf)} per skilled nursing day, up to 50 days a year.`, 'Not added.'),
    nlt: b.nlt ? '$100 per round trip for treatment far from home, up to 5 a year.' : 'Not added.',
    lodge: b.lodge ? '$100 a night for a family member’s lodging, up to 30 nights a year.' : 'Not added.',
    maternity: b.maternity ? 'Hospital stay to give birth pays like any stay. 10-month wait for normal pregnancy.' : 'Excluded.',
    mentalNervous: b.mentalNervous ? 'Inpatient mental health / substance use stays pay admission + daily.' : 'Excluded.',
  };
}

function slugName(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function HospitalScreen() {
  const session = useSession();
  const client = session.client;

  const [state, setState] = useState<string>(HOSPITAL_STATES.includes(client.state as never) ? (client.state as string) : 'NC');
  const [ageText, setAgeText] = useState<string>(() => {
    const a = ageFromDob(client.dob);
    return a != null ? String(a) : '';
  });
  const [zip, setZip] = useState<string>(client.zip ?? '');
  const [household, setHousehold] = useState<Household>('ind');
  const [b, setB] = useState<HospitalBenefits>(PACKAGES.balanced);
  const [pkg, setPkg] = useState<PkgKey | null>('balanced');
  const [scen, setScen] = useState<string>('stay3');
  const [showBreak, setShowBreak] = useState(false);
  const [sending, setSending] = useState(false);

  const age = /^\d{1,3}$/.test(ageText) ? Number(ageText) : null;
  const price = useMemo(() => priceHospital(b, age ?? 53, household), [b, age, household]);
  const sendCheck = canSend(price, age, state);
  const why = explain(b);

  const set = <K extends keyof HospitalBenefits>(k: K, v: HospitalBenefits[K]) => {
    setB((cur) => ({ ...cur, [k]: v }));
    setPkg(null);
  };

  // Maternity is NC only.
  const maternityAllowed = state === 'NC';
  useEffect(() => {
    if (!maternityAllowed) setB((cur) => (cur.maternity ? { ...cur, maternity: false } : cur));
  }, [maternityAllowed]);

  const sc = SCENARIOS.find((s) => s.key === scen) ?? SCENARIOS[3];
  const scLines = sc.lines(b);
  const scTotal = scLines.reduce((s, l) => s + l[2], 0);

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto', padding: '28px 18px 64px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 16 }}>
        <div>
          <div style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, color: NAVY }}>Hospital indemnity quote</div>
          <div style={{ color: MUTED, fontSize: 13 }}>Bankers Fidelity · Vantage Flex Plus · policy form HI21BFLIC · issue ages 18–85 · NC, TX, GA</div>
        </div>
        <span style={{ ...PILL, color: AMB, background: AMB_BG }}>
          Real BFLIC rates: age 53, individual. Everything else is estimated until the rate manual is loaded.
        </span>
      </div>

      {/* Read-to-client notice — mirrors the call-recording disclosure card. */}
      <section style={{ background: '#FFF9EB', border: '2px solid #F5A623', borderRadius: 10, padding: '16px 18px', marginBottom: 20 }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: '#B45309', marginBottom: 4 }}>Read to the client before quoting</div>
        <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: NAVY, marginBottom: 10 }}>This is a hospital indemnity plan. It is not health insurance.</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, fontSize: 13, lineHeight: 1.5, color: INK }}>
          <div><b style={{ display: 'block', color: NAVY }}>It pays you a set cash amount.</b>Admitted, ER visit, or another covered service: the plan pays the fixed amount for that benefit, no matter the bill.</div>
          <div><b style={{ display: 'block', color: NAVY }}>It does not pay your doctor or hospital.</b>The bill goes to your health insurance. This plan has no network and no deductible.</div>
          <div><b style={{ display: 'block', color: NAVY }}>Buy it with or without health insurance.</b>Alongside a health plan or on its own. On its own it pays only the set amounts, and the client owes the rest. Never present it as a replacement for health insurance.</div>
        </div>
        <p style={{ margin: '12px 0 0', fontSize: 11, fontWeight: 700, color: '#B45309', lineHeight: 1.45 }}>Required notice on the application and quote: {FED_NOTICE}</p>
      </section>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
        {/* ── Client ── */}
        <aside style={{ flex: '1 1 240px', maxWidth: 270, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Panel title="Client">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label htmlFor="hosp-state" style={LABEL}>State</label>
                <select id="hosp-state" value={state} onChange={(e) => setState(e.target.value)} style={INPUT}>
                  {HOSPITAL_STATES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
              <LabeledInput id="hosp-age" label="Age" value={ageText} onChange={setAgeText} inputMode="numeric" />
            </div>
            <LabeledInput id="hosp-zip" label="ZIP code" value={zip} onChange={setZip} inputMode="numeric" />
            <div style={LABEL}>Who's covered</div>
            {(Object.keys(HOUSEHOLD_LABEL) as Household[]).map((h) => (
              <ChipButton key={h} on={household === h} onClick={() => setHousehold(h)} label={HOUSEHOLD_LABEL[h]} />
            ))}
            {age != null && (age < 18 || age > 85) && <div style={{ fontSize: 12, color: '#991b1b' }}>Vantage Flex Plus issues ages 18 to 85.</div>}
            {(client.zip || client.dob) && <div style={{ fontSize: 11, color: MUTED }}>Prefilled from the Client screen — edit freely.</div>}
          </Panel>
          <Panel title="Quick start">
            {(['essential', 'balanced', 'max'] as PkgKey[]).map((k) => (
              <ChipButton key={k} on={pkg === k} onClick={() => { setB(PACKAGES[k]); setPkg(k); }} label={k[0].toUpperCase() + k.slice(1)} />
            ))}
            <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.45 }}>Balanced matches the BFLIC eApp quote line for line.</div>
          </Panel>
        </aside>

        {/* ── Benefits ── */}
        <main style={{ flex: '3 1 480px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Panel title={`What the plan pays when you use care${household !== 'ind' ? ' · per covered person' : ''}`}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {SCENARIOS.map((s) => (
                <button key={s.key} type="button" aria-pressed={scen === s.key} onClick={() => setScen(s.key)} style={scen === s.key ? PILL_ON : PILL_OFF}>{s.label}</button>
              ))}
            </div>
            <div style={{ fontSize: 13, color: INK }}>{sc.story}</div>
            <div>
              {scLines.map(([l, d, a]) => (
                <div key={l} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderTop: `1px solid ${LINE}`, fontSize: 13 }}>
                  <span>{l}<span style={{ display: 'block', fontSize: 11, color: MUTED }}>{d}</span></span>
                  <b style={{ color: a ? NAVY : MUTED, fontWeight: a ? 700 : 500 }}>{a ? money0(a) : '$0 — not covered'}</b>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderTop: `2px solid ${NAVY}`, paddingTop: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: NAVY }}>Cash paid to the client</span>
                <b style={{ fontFamily: SERIF, fontSize: 26, color: GRN }}>{money0(scTotal)}</b>
              </div>
            </div>
          </Panel>

          <Panel title="Core benefits">
            <div style={GRID}>
              <Sel id="adm" label="Hospital admission" value={b.adm} options={OPTIONS.adm} onChange={(v) => set('adm', v)} note={why.adm} />
              <Sel id="daily" label="Daily confinement" value={b.daily} options={OPTIONS.daily} onChange={(v) => set('daily', v)} note={why.daily} />
              <div style={BEN}>
                <label htmlFor="hosp-period" style={LABEL}>Benefit period</label>
                <select id="hosp-period" value={b.period} onChange={(e) => set('period', Number(e.target.value) as BenefitPeriod)} style={INPUT}>
                  {BENEFIT_PERIODS.map((p) => <option key={p} value={p}>{p === 1 ? 'First day only' : `${p} days`}</option>)}
                </select>
                <span style={NOTE}>{why.period}</span>
              </div>
              <Fixed label="Emergency room" value={money0(FIXED.er)} note={why.er} />
              <Fixed label="Urgent care" value={money0(FIXED.uc)} note={why.uc} />
              <Fixed label="Observation room" value={money0(b.daily)} note={why.obs} />
              <Sel id="air" label="Ambulance: air" value={b.air} options={OPTIONS.air} onChange={(v) => set('air', v)} note={why.air} />
              <Sel id="gnd" label="Ambulance: ground/water" value={b.gnd} options={OPTIONS.gnd} onChange={(v) => set('gnd', v)} note={why.gnd} />
            </div>
          </Panel>

          <Panel title="Optional riders">
            <div style={GRID}>
              <YesNo id="icuA" label="ICU admission" value={b.icuA} onChange={(v) => set('icuA', v)} note={why.icuA} />
              <YesNo id="icuD" label="Daily ICU confinement" value={b.icuD} onChange={(v) => set('icuD', v)} note={why.icuD} />
              <Sel id="osh" label="Outpatient surgery" value={b.osh} options={OPTIONS.osh} onChange={(v) => set('osh', v)} note={why.osh} />
              <Sel id="maj" label="Major diagnostic exam" value={b.maj} options={OPTIONS.maj} onChange={(v) => set('maj', v)} note={why.maj} />
              <Sel id="inv" label="Invasive diagnostic exam" value={b.inv} options={OPTIONS.inv} onChange={(v) => set('inv', v)} note={why.inv} />
              <Sel id="min" label="Minor diagnostic exam" value={b.min} options={OPTIONS.min} onChange={(v) => set('min', v)} note={why.min} />
              <Sel id="hs" label="Health screening" value={b.hs} options={OPTIONS.hs} onChange={(v) => set('hs', v)} note={why.hs} />
              <div style={BEN}>
                <label htmlFor="hosp-rehab" style={LABEL}>Rehab unit</label>
                <select id="hosp-rehab" value={b.rehab} onChange={(e) => set('rehab', Number(e.target.value) as 0 | 15 | 31)} style={INPUT}>
                  <option value={0}>None</option><option value={15}>15 days</option><option value={31}>31 days</option>
                </select>
                <span style={NOTE}>{why.rehab}</span>
              </div>
              <Sel id="snf" label="Skilled nursing" value={b.snf} options={OPTIONS.snf} onChange={(v) => set('snf', v)} note={why.snf} />
              <YesNo id="nlt" label="Non-local transportation" value={b.nlt} onChange={(v) => set('nlt', v)} note={why.nlt} />
              <YesNo id="lodge" label="Family member lodging" value={b.lodge} onChange={(v) => set('lodge', v)} note={why.lodge} />
              <YesNo id="maternity" label="Maternity" value={b.maternity} disabled={!maternityAllowed} onChange={(v) => set('maternity', v)} note={maternityAllowed ? why.maternity : 'North Carolina only.'} yesLabel="Included" noLabel="Excluded" />
              <YesNo id="mn" label="Mental/nervous & substance abuse" value={b.mentalNervous} onChange={(v) => set('mentalNervous', v)} note={why.mentalNervous} yesLabel="Included" noLabel="Excluded" />
            </div>
          </Panel>
        </main>

        {/* ── Premium ── */}
        <aside aria-live="polite" style={{ flex: '1 1 280px', maxWidth: 320, position: 'sticky', top: 56, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <section style={{ background: 'white', border: `1px solid ${LINE}`, borderRadius: 12, padding: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: MUTED }}>Bankers Fidelity Life</div>
            <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: NAVY, margin: '2px 0 12px' }}>Vantage Flex Plus</div>
            <div style={{ fontFamily: SERIF, fontSize: 40, fontWeight: 700, color: NAVY, lineHeight: 1 }}>
              {age != null && age >= 18 && age <= 85 ? money2(price.total) : '—'}<span style={{ fontFamily: 'inherit', fontSize: 13, color: MUTED, fontWeight: 500 }}> /mo</span>
            </div>
            <div style={{ marginTop: 10 }}>
              <span style={{ ...PILL, color: price.exact ? GRN : AMB, background: price.exact ? GRN_BG : AMB_BG }}>
                {price.exact ? 'Exact BFLIC rate' : 'Estimated rate'}
              </span>
            </div>
            <KV k="Coverage" v={HOUSEHOLD_LABEL[household]} />
            <KV k="Annual" v={money2(price.total * 12)} />
            <KV k="3-day stay pays" v={money0(stayPays(b, 3))} />
            {!price.exact && (
              <div style={{ fontSize: 11, color: AMB, lineHeight: 1.45, marginTop: 8 }}>Estimated because: {price.estimateReasons.join('; ')}.</div>
            )}
            <button type="button" onClick={() => setShowBreak((v) => !v)} aria-expanded={showBreak} style={{ ...LINK_BTN, marginTop: 10 }}>Premium breakdown</button>
            {showBreak && (
              <div style={{ marginTop: 6 }}>
                {price.lines.map((l) => <KV key={l.key} k={l.label} v={money2(l.monthly)} />)}
                <KV k="Monthly total" v={money2(price.total)} strong />
              </div>
            )}
            <button type="button" onClick={() => setSending((v) => !v)} style={{ ...BTN_PRI, marginTop: 14 }}>Send hospital quote</button>
            <a href="https://agent.bflic.com/eAppsRebuild#/products" target="_blank" rel="noopener noreferrer" style={{ ...BTN, marginTop: 8 }}>Open in BFLIC eApp ↗</a>
            <p style={{ fontSize: 10.5, color: MUTED, lineHeight: 1.45, margin: '12px 0 0' }}>
              Limited benefit policy. Not Medicare Supplement insurance. 6-month pre-existing condition limitation. 30-day free look. Health questions + prescription check. Rates subject to change on a class basis.
            </p>
          </section>
          {sending && (
            <SendPanel
              b={b}
              age={age}
              state={state}
              zip={zip}
              household={household}
              total={price.total}
              sendCheck={sendCheck}
              defaults={{ name: client.name ?? '', phone: client.phone ?? '', email: client.email ?? '' }}
              onClose={() => setSending(false)}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

// ─── Send ────────────────────────────────────────────────────────────────

function SendPanel(props: {
  b: HospitalBenefits; age: number | null; state: string; zip: string; household: Household; total: number;
  sendCheck: { ok: boolean; reason: string | null };
  defaults: { name: string; phone: string; email: string };
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'personal' | 'general'>(props.defaults.name ? 'personal' : 'general');
  const [first, setFirst] = useState(props.defaults.name.split(/\s+/)[0] ?? '');
  const [last, setLast] = useState(props.defaults.name.split(/\s+/).slice(1).join(' '));
  const [phone, setPhone] = useState(props.defaults.phone);
  const [email, setEmail] = useState(props.defaults.email);
  const [sms, setSms] = useState(true);
  const [mail, setMail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | { kind: 'idle' }
    | { kind: 'error'; message: string }
    | { kind: 'sent'; url: string; smsSent: boolean; smsError?: string; emailSent: boolean; emailError?: string }
  >({ kind: 'idle' });

  const name = mode === 'personal' ? `${first} ${last}`.trim() : '';
  const phoneOk = phone.replace(/\D/g, '').length >= 10;
  const emailOk = /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i.test(email.trim());
  const wantSms = sms && phoneOk;
  const wantEmail = mail && emailOk;
  const missing: string[] = [];
  if (mode === 'personal' && (!first.trim() || !last.trim())) missing.push('first and last name');
  if (!props.sendCheck.ok && props.sendCheck.reason) missing.push(props.sendCheck.reason);
  const canGo = !busy && missing.length === 0;

  const defaultMessage = `${mode === 'personal' && first.trim() ? `Hi ${first.trim()}` : 'Hi'}, it's Rob with GenerationHealth.me. Here's your Bankers Fidelity hospital indemnity quote:\n\n${LINK_TOKEN}\n\nThis quote is good for 30 days. Call or text me at (828) 761-3326.`;
  const [message, setMessage] = useState<string | null>(null); // null = use the default
  const text = message ?? defaultMessage;
  const linkShown = `planmatch.generationhealth.me/hospital-quote/…${mode === 'personal' && name ? `/${slugName(name)}` : ''}`;

  async function send() {
    if (!canGo) return;
    setBusy(true);
    setResult({ kind: 'idle' });
    try {
      const resp = await fetch('/api/hospital-quote-send', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          clientName: name || null,
          clientPhone: phone.trim() || null,
          clientEmail: email.trim() || null,
          send: { sms: wantSms, email: wantEmail },
          stateCode: props.state,
          zip: /^\d{5}$/.test(props.zip) ? props.zip : null,
          age: props.age,
          household: props.household,
          benefits: props.b,
          monthlyPremium: props.total,
          message: wantSms ? text : null,
        }),
      });
      const data = (await resp.json().catch(() => null)) as
        | { success?: boolean; url?: string; error?: string; sms?: { sent: boolean; error?: string }; email?: { sent: boolean; error?: string } }
        | null;
      if (!resp.ok || !data?.success || !data.url) {
        setResult({ kind: 'error', message: data?.error ?? `HTTP ${resp.status}` });
        return;
      }
      setResult({ kind: 'sent', url: data.url, smsSent: !!data.sms?.sent, smsError: data.sms?.error, emailSent: !!data.email?.sent, emailError: data.email?.error });
    } catch (e) {
      setResult({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (result.kind === 'sent') {
    return (
      <Panel title="Quote sent">
        <div style={{ fontSize: 13, color: INK, wordBreak: 'break-all' }}><a href={result.url} target="_blank" rel="noopener noreferrer" style={{ color: NAVY, fontWeight: 700 }}>{result.url}</a></div>
        <div style={{ fontSize: 12, color: result.smsSent ? GRN : MUTED }}>Text: {result.smsSent ? 'sent' : `not sent${result.smsError ? ` (${result.smsError})` : ''}`}</div>
        <div style={{ fontSize: 12, color: result.emailSent ? GRN : MUTED }}>Email: {result.emailSent ? 'sent' : `not sent${result.emailError ? ` (${result.emailError})` : ''}`}</div>
        <button type="button" onClick={() => { void navigator.clipboard?.writeText(result.url).catch(() => undefined); }} style={BTN}>Copy link</button>
        <button type="button" onClick={props.onClose} style={BTN_PRI}>Done</button>
      </Panel>
    );
  }

  return (
    <Panel title="Send hospital quote">
      <div style={{ fontSize: 12, color: MUTED, marginTop: -4 }}>One link, this product only. Good for 30 days.</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" aria-pressed={mode === 'personal'} onClick={() => setMode('personal')} style={mode === 'personal' ? PILL_ON : PILL_OFF}>Personal</button>
        <button type="button" aria-pressed={mode === 'general'} onClick={() => setMode('general')} style={mode === 'general' ? PILL_ON : PILL_OFF}>General</button>
      </div>
      <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.45 }}>
        {mode === 'personal' ? 'Named client: their name is on the page and the link ends in it.' : 'No name anywhere — the page says "Prepared for you".'}
      </div>
      {mode === 'personal' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <LabeledInput id="hq-first" label="First name" value={first} onChange={setFirst} />
          <LabeledInput id="hq-last" label="Last name" value={last} onChange={setLast} />
        </div>
      )}
      <LabeledInput id="hq-phone" label="Mobile" value={phone} onChange={setPhone} inputMode="numeric" />
      <LabeledInput id="hq-email" label="Email" value={email} onChange={setEmail} />
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" aria-pressed={sms} onClick={() => setSms((v) => !v)} style={sms ? PILL_ON : PILL_OFF}>Text</button>
        <button type="button" aria-pressed={mail} onClick={() => setMail((v) => !v)} style={mail ? PILL_ON : PILL_OFF}>Email</button>
      </div>
      {!wantSms && !wantEmail && <div style={{ fontSize: 11, color: MUTED }}>Nothing will be texted or emailed — you'll get the link to copy.</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <label htmlFor="hq-msg" style={LABEL}>Text message</label>
        {message !== null && <button type="button" onClick={() => setMessage(null)} style={LINK_BTN}>Reset</button>}
      </div>
      <textarea
        id="hq-msg"
        value={text}
        onChange={(e) => setMessage(e.target.value)}
        rows={7}
        maxLength={600}
        style={{ fontFamily: 'inherit', fontSize: 12.5, color: INK, background: 'white', border: '1px solid rgba(13,47,94,0.2)', borderRadius: 8, padding: 10, lineHeight: 1.45, resize: 'vertical' }}
      />
      <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.45 }}>
        {text.includes(LINK_TOKEN)
          ? <>{LINK_TOKEN} becomes the quote link ({linkShown}).</>
          : <>No {LINK_TOKEN} in the message — the link is added at the end.</>}
      </div>
      {missing.length > 0 && <div style={{ fontSize: 12, color: '#991b1b', lineHeight: 1.45 }}>{missing.join(' · ')}</div>}
      {result.kind === 'error' && <div style={{ fontSize: 12, color: '#991b1b' }}>Not sent: {result.message}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={props.onClose} style={{ ...BTN, flex: 1 }}>Cancel</button>
        <button type="button" onClick={send} disabled={!canGo} style={{ ...BTN_PRI, flex: 1, opacity: canGo ? 1 : 0.5, cursor: canGo ? 'pointer' : 'not-allowed' }}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
    </Panel>
  );
}

// ─── Small pieces (match DentalScreen) ───────────────────────────────────

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ background: 'white', border: `1px solid ${LINE}`, borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: NAVY }}>{title}</div>
      {children}
    </section>
  );
}

function LabeledInput({ id, label, value, onChange, inputMode }: { id: string; label: string; value: string; onChange: (v: string) => void; inputMode?: 'numeric' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <label htmlFor={id} style={LABEL}>{label}</label>
      <input id={id} value={value} inputMode={inputMode} onChange={(e) => onChange(e.target.value)} style={INPUT} />
    </div>
  );
}

function ChipButton({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} style={{ minHeight: 40, width: '100%', padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, textAlign: 'left', background: on ? NAVY : 'white', color: on ? 'white' : NAVY, border: `1px solid ${on ? NAVY : 'rgba(13,47,94,0.25)'}` }}>
      {label}
    </button>
  );
}

function Sel({ id, label, value, options, onChange, note }: { id: string; label: string; value: number; options: readonly number[]; onChange: (v: number) => void; note: string }) {
  return (
    <div style={BEN}>
      <label htmlFor={`hosp-${id}`} style={LABEL}>{label}</label>
      <select id={`hosp-${id}`} value={value} onChange={(e) => onChange(Number(e.target.value))} style={INPUT}>
        {options.map((o) => <option key={o} value={o}>{o === 0 ? 'None' : money0(o)}</option>)}
      </select>
      <span style={NOTE}>{note}</span>
    </div>
  );
}

function YesNo({ id, label, value, onChange, note, disabled, yesLabel = 'Yes', noLabel = 'No' }: { id: string; label: string; value: boolean; onChange: (v: boolean) => void; note: string; disabled?: boolean; yesLabel?: string; noLabel?: string }) {
  return (
    <div style={BEN}>
      <label htmlFor={`hosp-${id}`} style={LABEL}>{label}</label>
      <select id={`hosp-${id}`} value={value ? '1' : '0'} disabled={disabled} onChange={(e) => onChange(e.target.value === '1')} style={{ ...INPUT, ...(disabled ? DISABLED : null) }}>
        <option value="0">{noLabel}</option>
        <option value="1">{yesLabel}</option>
      </select>
      <span style={NOTE}>{note}</span>
    </div>
  );
}

function Fixed({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div style={BEN}>
      <div style={LABEL}>{label}</div>
      <div style={{ ...INPUT, ...DISABLED, display: 'flex', alignItems: 'center' }}>{value}</div>
      <span style={NOTE}>{note}</span>
    </div>
  );
}

function KV({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5, padding: '7px 0', borderTop: `1px solid ${LINE}` }}>
      <span style={{ color: MUTED }}>{k}</span>
      <b style={{ color: NAVY, fontWeight: strong ? 700 : 600 }}>{v}</b>
    </div>
  );
}

const LABEL: CSSProperties = { fontSize: 10, fontWeight: 600, color: MUTED, letterSpacing: 0.5, textTransform: 'uppercase' };
const INPUT: CSSProperties = { height: 40, padding: '0 10px', border: '1px solid rgba(13,47,94,0.2)', borderRadius: 8, fontSize: 14, color: NAVY, background: 'white', fontWeight: 600, minWidth: 0 };
const DISABLED: CSSProperties = { background: '#f8f9fa', color: MUTED };
const NOTE: CSSProperties = { fontSize: 11.5, color: INK, lineHeight: 1.4 };
const BEN: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 };
const GRID: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '14px 16px' };
const PILL: CSSProperties = { display: 'inline-block', fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '4px 10px' };
const PILL_OFF: CSSProperties = { border: '1px solid rgba(13,47,94,0.2)', background: 'white', color: NAVY, borderRadius: 999, fontSize: 12, fontWeight: 600, padding: '7px 11px', cursor: 'pointer' };
const PILL_ON: CSSProperties = { ...PILL_OFF, background: 'rgba(131,240,249,0.18)', borderColor: NAVY };
const BTN: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', minHeight: 38, border: `1px solid ${NAVY}`, background: 'white', color: NAVY, borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', textDecoration: 'none' };
const BTN_PRI: CSSProperties = { ...BTN, background: NAVY, color: 'white' };
const LINK_BTN: CSSProperties = { background: 'none', border: 'none', padding: 0, fontSize: 12, fontWeight: 600, color: NAVY, textDecoration: 'underline', cursor: 'pointer', alignSelf: 'flex-start' };
