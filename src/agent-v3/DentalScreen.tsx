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
import { MAX_QUOTE_DENTAL, type QuoteDentalPick } from '@/lib/session';
import { useProviderSearch, type ProviderSearchResult } from '@/hooks/useProviderSearch';

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

/** Carrier find-a-dentist page for one dental network (pm_dental_network). */
interface DentalNetwork {
  carrier: string;
  network: string;
  directory_url: string;
  directory_note: string | null;
}

type NetworkStatus = 'in_network' | 'not_in_network';

/** The broker's recorded check of one dentist on one network. */
interface NetworkCheck {
  status: NetworkStatus;
  verified_at: string;
}

/** What a plan card shows about the client's dentist. */
interface DentistOnPlan {
  dentistName: string;
  directory: DentalNetwork | null;
  check: NetworkCheck | null;
  saving: boolean;
  error: string | null;
}

function netKey(carrier: string, network: string | null): string {
  return `${carrier}|${network ?? ''}`;
}

const DENTAL_SPECIALTY = /dent|orthodon|endodon|periodon|prosthodon|oral|maxillofacial/i;

function dentistLabel(d: ProviderSearchResult): string {
  return d.display_name;
}

function dentistAddress(d: ProviderSearchResult): string | null {
  const parts = [d.practice_city, d.practice_state, d.practice_zip].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; plans: DentalPlan[] }
  | { status: 'error'; error: string };

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** A price we can put in front of the client: quoted for this client's own
 *  age and ZIP. "Starting at" floors are allowed and labelled as such. */
function quotablePrice(price: PriceResult): { monthly: number; startingAt: boolean } | null {
  if (price.kind !== 'price') return null;
  if (price.flags.includes('quoted_other_age') || price.flags.includes('quoted_other_zip')) return null;
  return { monthly: price.monthly, startingAt: price.flags.includes('starting_at') };
}

/** Who the premium covers, in the client's words. */
function coveredLabel(h: Household): string {
  const spouse = h.spouseAge !== undefined;
  const kids = h.children;
  const kidText = kids === 1 ? '1 child' : `${kids} children`;
  if (spouse && kids > 0) return `You, your spouse and ${kidText}`;
  if (spouse) return 'You and your spouse';
  if (kids > 0) return `You and ${kidText}`;
  return 'Just you';
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
  const [childrenText, setChildrenText] = useState('');
  const [must, setMust] = useState<Record<MustHave, boolean>>({
    implants: false, implantNoWait: false, replacesMissing: false, major: false, noWait: false, insuranceOnly: false,
  });
  const [carriersOff, setCarriersOff] = useState<Record<string, boolean>>({});
  const [compare, setCompare] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const quoteDental = useSession((s) => s.quoteDental);
  const upsertQuoteDental = useSession((s) => s.upsertQuoteDental);
  const removeQuoteDental = useSession((s) => s.removeQuoteDental);

  // ── Client's dentist + network checks ──
  const [dentistQuery, setDentistQuery] = useState('');
  const [dentist, setDentist] = useState<ProviderSearchResult | null>(null);
  const [inNetworkOnly, setInNetworkOnly] = useState(false);
  const [directories, setDirectories] = useState<Map<string, DentalNetwork>>(new Map());
  const [checks, setChecks] = useState<Map<string, NetworkCheck>>(new Map());
  const [checksError, setChecksError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const search = useProviderSearch(dentist ? '' : dentistQuery, 'NC');
  const dentistResults = useMemo(
    () => [...search.results].sort((a, b) =>
      Number(DENTAL_SPECIALTY.test(b.specialty ?? '')) - Number(DENTAL_SPECIALTY.test(a.specialty ?? ''))),
    [search.results],
  );

  // Directory links load once; checks reload whenever the dentist changes.
  useEffect(() => {
    let cancelled = false;
    const npi = dentist?.npi;
    setChecks(new Map());
    setChecksError(null);
    setSaveErrors({});
    fetch(`/api/dental-network${npi ? `?npi=${npi}` : ''}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) {
          setChecksError(body.error ?? `HTTP ${r.status}`);
          return;
        }
        setDirectories(new Map((body.networks as DentalNetwork[]).map((n) => [netKey(n.carrier, n.network), n])));
        setChecks(new Map(
          (body.verifications as Array<{ carrier: string; network: string; status: NetworkStatus; verified_at: string }>)
            .map((v) => [netKey(v.carrier, v.network), { status: v.status, verified_at: v.verified_at }]),
        ));
      })
      .catch((e) => { if (!cancelled) setChecksError(String(e)); });
    return () => { cancelled = true; };
  }, [dentist?.npi]);

  async function recordCheck(plan: DentalPlan, status: NetworkStatus | 'clear') {
    if (!dentist || !plan.network) return;
    const key = netKey(plan.carrier, plan.network);
    setSaving((s) => ({ ...s, [key]: true }));
    setSaveErrors((e) => { const n = { ...e }; delete n[key]; return n; });
    try {
      const r = await fetch('/api/dental-network', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          carrier: plan.carrier,
          network: plan.network,
          npi: dentist.npi,
          dentist_name: dentistLabel(dentist),
          practice_address: dentistAddress(dentist),
          status,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setChecks((m) => {
        const next = new Map(m);
        if (status === 'clear') next.delete(key);
        else next.set(key, { status, verified_at: body.verification?.verified_at ?? new Date().toISOString() });
        return next;
      });
    } catch (e) {
      setSaveErrors((s) => ({ ...s, [key]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSaving((s) => ({ ...s, [key]: false }));
    }
  }

  function dentistOnPlan(plan: DentalPlan): DentistOnPlan | null {
    if (!dentist) return null;
    const key = netKey(plan.carrier, plan.network);
    return {
      dentistName: dentistLabel(dentist),
      directory: directories.get(key) ?? null,
      check: checks.get(key) ?? null,
      saving: Boolean(saving[key]),
      error: saveErrors[key] ?? null,
    };
  }

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
    // "4, 10" → two children aged 4 and 10. A bare "?" counts a child whose age isn't known yet.
    const childAges = childrenText
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((t) => (/^\d{1,2}$/.test(t) ? Number(t) : null));
    const children = childAges.length;
    return hasSpouse ? { spouseAge, children, childAges } : { children, childAges };
  }, [hasSpouse, spouseAgeText, childrenText]);

  const priced = useMemo(
    () => plans.map((p) => ({ plan: p, price: priceDentalPlan(p, { age, zip: zip5, household }) })),
    [plans, age, zip5, household],
  );

  // Keep quoted dental picks in step with the inputs: a changed age, ZIP or
  // household re-prices them; a plan that can no longer be priced for this
  // client drops off the quote rather than carrying a stale number.
  const label = coveredLabel(household);
  useEffect(() => {
    if (load.status !== 'ready') return;
    for (const pick of quoteDental) {
      const hit = priced.find((x) => x.plan.id === pick.planId);
      const q = hit ? quotablePrice(hit.price) : null;
      if (!q) {
        removeQuoteDental(pick.planId);
      } else if (q.monthly !== pick.monthlyPremium || q.startingAt !== pick.startingAt || label !== pick.coveredLabel) {
        upsertQuoteDental({ ...pick, monthlyPremium: q.monthly, startingAt: q.startingAt, coveredLabel: label });
      }
    }
  }, [load.status, priced, label, quoteDental, upsertQuoteDental, removeQuoteDental]);

  function toggleQuote(plan: DentalPlan, price: PriceResult) {
    if (quoteDental.some((d) => d.planId === plan.id)) {
      removeQuoteDental(plan.id);
      return;
    }
    const q = quotablePrice(price);
    if (!q) return;
    const pick: QuoteDentalPick = {
      planId: plan.id,
      carrier: plan.carrier,
      planName: plan.plan_name,
      monthlyPremium: q.monthly,
      startingAt: q.startingAt,
      coveredLabel: label,
    };
    upsertQuoteDental(pick);
  }

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
      if (dentist && inNetworkOnly && checks.get(netKey(plan.carrier, plan.network))?.status !== 'in_network') return false;
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
            <LabeledInput id="dental-children" label="Children's ages (under 19, e.g. 4, 10)" value={childrenText} onChange={setChildrenText} />
            {(client.zip || client.dob) && (
              <div style={{ fontSize: 11, color: MUTED }}>Prefilled from the Client screen — edit freely.</div>
            )}
          </Panel>

          <Panel title="Client's dentist">
            {dentist ? (
              <>
                <div style={{ fontSize: 13, color: NAVY, lineHeight: 1.4 }}>
                  <b>{dentistLabel(dentist)}</b>
                  <div style={{ fontSize: 12, color: MUTED }}>
                    {[dentist.specialty, dentistAddress(dentist), `NPI ${dentist.npi}`].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <ChipButton on={inNetworkOnly} onClick={() => setInNetworkOnly((v) => !v)} label="Only plans confirmed in network" />
                {inNetworkOnly && (
                  <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.45 }}>
                    Plans not yet checked are hidden, not assumed in network.
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => { setDentist(null); setDentistQuery(''); setInNetworkOnly(false); }}
                  style={SMALL_BTN}
                >
                  Change dentist
                </button>
              </>
            ) : (
              <>
                <LabeledInput id="dental-dentist" label="Dentist or practice name" value={dentistQuery} onChange={setDentistQuery} />
                {search.loading && <div style={{ fontSize: 12, color: MUTED }}>Searching…</div>}
                {search.error && <div style={{ fontSize: 12, color: '#991b1b' }}>Search failed ({search.error}).</div>}
                {dentistResults.length > 0 && (
                  <ul role="listbox" aria-label="Dentist results" style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 260, overflowY: 'auto', border: `1px solid ${LINE}`, borderRadius: 8 }}>
                    {dentistResults.slice(0, 15).map((d) => (
                      <li key={d.npi}>
                        <button
                          type="button"
                          onClick={() => setDentist(d)}
                          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', borderBottom: `1px solid ${LINE}`, background: 'white', cursor: 'pointer', color: NAVY }}
                        >
                          <div style={{ fontSize: 13, fontWeight: 700 }}>{dentistLabel(d)}</div>
                          <div style={{ fontSize: 11, color: MUTED }}>
                            {[d.specialty, dentistAddress(d)].filter(Boolean).join(' · ')}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.45 }}>
                  Pick the client's dentist to check each plan's network on the carrier's own site.
                </div>
              </>
            )}
            {checksError && (
              <div style={{ fontSize: 12, color: '#991b1b' }}>Network checks didn't load ({checksError}).</div>
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

          {quoteDental.length > 0 && (
            <div role="status" style={{ background: '#ecfeff', border: `1px solid ${SEAFOAM}`, borderRadius: 10, padding: '10px 14px', fontSize: 13, color: NAVY, lineHeight: 1.5 }}>
              <b>{quoteDental.length} dental {quoteDental.length === 1 ? 'plan' : 'plans'} on the client quote:</b>{' '}
              {quoteDental.map((d) => `${d.carrier} ${d.planName}`).join(', ')}.
              {' '}Send it from Compare → Send a quote.
            </div>
          )}

          {comparePlans.length >= 2 && (
            <CompareTable
              dentistName={dentist ? dentistLabel(dentist) : null}
              networkCheck={(p) => checks.get(netKey(p.carrier, p.network)) ?? null}
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
              quote={
                quoteDental.some((d) => d.planId === plan.id) ? 'in'
                : !quotablePrice(price) ? 'cannot'
                : quoteDental.length >= MAX_QUOTE_DENTAL ? 'full'
                : 'can'
              }
              onQuote={() => toggleQuote(plan, price)}
              dentistInfo={dentistOnPlan(plan)}
              onCheck={(status) => recordCheck(plan, status)}
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
  plan, price, age, zip, inCompare, onCompare, expanded, onExpand, quote, onQuote, dentistInfo, onCheck,
}: {
  plan: DentalPlan;
  price: PriceResult;
  age: number | null;
  zip: string | null;
  inCompare: boolean;
  onCompare: () => void;
  expanded: boolean;
  onExpand: () => void;
  /** in = on the client quote; can = addable; full = quote has the max;
   *  cannot = no clean price for this client (re-quote / not priced). */
  quote: 'in' | 'can' | 'full' | 'cannot';
  onQuote: () => void;
  /** null when no dentist is picked. */
  dentistInfo: DentistOnPlan | null;
  onCheck: (status: NetworkStatus | 'clear') => void;
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
          {dentistInfo && <DentistNetworkRow info={dentistInfo} carrier={plan.carrier} onCheck={onCheck} />}
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
          <button
            type="button"
            onClick={onQuote}
            disabled={quote === 'cannot' || quote === 'full'}
            aria-pressed={quote === 'in'}
            title={
              quote === 'cannot' ? 'Needs a price quoted for this client’s age and ZIP before it can go on a quote'
              : quote === 'full' ? `A quote holds up to ${MAX_QUOTE_DENTAL} dental plans`
              : undefined
            }
            style={{
              ...SMALL_BTN,
              background: quote === 'in' ? NAVY : 'white',
              color: quote === 'in' ? 'white' : NAVY,
              opacity: quote === 'cannot' || quote === 'full' ? 0.4 : 1,
              cursor: quote === 'cannot' || quote === 'full' ? 'not-allowed' : 'pointer',
            }}
          >
            {quote === 'in' ? 'On client quote ✓' : 'Add to client quote'}
          </button>
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

function DentistNetworkRow({ info, carrier, onCheck }: {
  info: DentistOnPlan;
  carrier: string;
  onCheck: (status: NetworkStatus | 'clear') => void;
}) {
  const { check, directory } = info;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4, paddingTop: 8, borderTop: `1px dashed ${LINE}` }}>
      {check ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          <Badge tone={check.status === 'in_network' ? 'green' : 'red'}>
            {`${info.dentistName} · ${check.status === 'in_network' ? 'In network' : 'Not in network'}`}
          </Badge>
          <span style={{ fontSize: 11, color: MUTED }}>Broker checked {shortDate(check.verified_at)}</span>
          <button type="button" onClick={() => onCheck('clear')} disabled={info.saving} style={LINK_BTN}>Undo</button>
        </div>
      ) : (
        <>
          <Badge tone="amber">{`${info.dentistName} · Network not checked`}</Badge>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            {directory ? (
              <a href={directory.directory_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, fontWeight: 700, color: NAVY }}>
                Check on {carrier} ↗
              </a>
            ) : (
              <span style={{ fontSize: 12, color: '#92400e' }}>No carrier directory link on file</span>
            )}
            <button type="button" onClick={() => onCheck('in_network')} disabled={info.saving} style={SMALL_BTN}>In network</button>
            <button type="button" onClick={() => onCheck('not_in_network')} disabled={info.saving} style={SMALL_BTN}>Not in network</button>
          </div>
          {directory?.directory_note && (
            <div style={{ fontSize: 11, color: MUTED }}>{directory.directory_note}</div>
          )}
        </>
      )}
      {info.error && <div style={{ fontSize: 12, color: '#991b1b' }}>Didn't save ({info.error}).</div>}
    </div>
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
    : price.kind === 'needs_quote' && price.reason === 'child_ages' ? "Enter each child's age to price"
    : price.kind === 'needs_quote' && price.reason === 'children' ? 'Child rate not available — quote with carrier'
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

function CompareTable({ rows, onClear, dentistName, networkCheck }: {
  rows: Array<{ plan: DentalPlan; price: PriceResult }>;
  onClear: () => void;
  dentistName: string | null;
  networkCheck: (p: DentalPlan) => NetworkCheck | null;
}) {
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
            {dentistName && (
              <tr>
                <th scope="row" style={{ ...TD, fontWeight: 700, color: '#334155' }}>{dentistName}</th>
                {rows.map(({ plan }) => {
                  const c = networkCheck(plan);
                  const text = c?.status === 'in_network' ? 'In network' : c?.status === 'not_in_network' ? 'Not in network' : 'Not checked';
                  return <td key={plan.id} style={{ ...TD, color: c?.status === 'in_network' ? '#065f46' : c ? '#991b1b' : '#92400e', fontWeight: 700 }}>{text}</td>;
                })}
              </tr>
            )}
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
const LINK_BTN: CSSProperties = { background: 'none', border: 'none', padding: 0, fontSize: 12, fontWeight: 700, color: NAVY, textDecoration: 'underline', cursor: 'pointer' };
const TH: CSSProperties = { textAlign: 'left', padding: '8px 10px', borderBottom: `1px solid ${LINE}`, verticalAlign: 'bottom', fontWeight: 700 };
const TD: CSSProperties = { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #eef2f7', verticalAlign: 'top' };
