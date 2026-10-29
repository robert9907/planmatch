// QuoteBuilder — agent-v3 surface for sending a multi-plan quote.
//
// Twin of apps/web/src/pages/agent-v3/components/QuoteBuilder.tsx in the
// consumer repo (robert9907/plan-match). User-visible behavior must
// stay aligned even though the surfaces have different shapes (this
// repo: flat files, inline styles, zustand session; consumer repo:
// screens/components/hooks subdirs, Tailwind, AgentContext).
//
// Pick up to 5 plans the brain ranked (and optionally mark one as the top
// pick), carry any dental plans added on the Dental screen, write a personal
// note, choose text and/or email, POST to the consumer-host /api/quotes
// (where pm_quotes lives), get back a /quote/:short_id URL. The consumer API
// sends the text (AgentBase bridge) and the email (Resend).

import { useMemo, useState, type CSSProperties } from 'react';
import { useSession } from '@/lib/session';
import { useTpmoCounts } from '@/hooks/useTpmoCounts';
import type { LibraryRankPlan } from '@/lib/library-client';
import { Btn } from './compare-v2/Button';
import type { HeadToHeadQuote } from './headToHeadQuote';

const MAX_PLANS = 5;
// Sends go through this app's own server (api/quote-send.ts): it checks the
// broker session and adds the secret the consumer quote API requires.
const QUOTE_SEND_URL = '/api/quote-send';

// Tokens mirror the rest of agent-v3.
const NAVY = '#0d2f5e';
const BRAND_BLUE = '#0071e3';
const BORDER = '#e2e8f0';
const MUTED = '#64748b';
const TEXT = '#0f172a';
const SUCCESS_BG = '#d1fae5';
const SUCCESS_TEXT = '#047857';
const ERROR_BG = '#fee2e2';
const ERROR_TEXT = '#b91c1c';

interface QuoteBuilderProps {
  /** Ranked plans the agent can choose from (typically result.top_plans
   *  concat result.bench_plans, in display order). */
  rankedPlans: LibraryRankPlan[];
  /** Called with the quote URL + shortId after a successful send. */
  onQuoteSent?: (url: string, shortId: string) => void;
  /** Head-to-Head mode: send the frozen Current-vs-Challenger comparison.
   *  The plan picker is replaced by the fixed pair; rankedPlans must hold
   *  just the challenger. */
  headToHead?: HeadToHeadQuote;
}

export function QuoteBuilder({ rankedPlans, onQuoteSent, headToHead }: QuoteBuilderProps) {
  const session = useSession();
  const client = session.client;
  const drugs = session.medications;
  const providers = session.providers;
  const quoteDental = session.quoteDental;
  const removeQuoteDental = session.removeQuoteDental;
  const tpmo = useTpmoCounts();

  const defaultSelected = useMemo(() => {
    return rankedPlans.slice(0, headToHead ? 1 : 3).map((p) => p.plan_id);
  }, [rankedPlans, headToHead]);

  const [pickedIds, setSelectedIds] = useState<string[]>(defaultSelected);
  // Head-to-Head: the challenger is always the one plan on the quote, even
  // when the broker swaps challengers with the panel open.
  const selectedIds = headToHead ? defaultSelected : pickedIds;
  const [note, setNote] = useState<string>(
    headToHead
      ? buildHeadToHeadNote(firstNameFrom(client.name), headToHead)
      : buildDefaultNote(firstNameFrom(client.name)),
  );
  const [phoneOverride, setPhoneOverride] = useState<string>(client.phone ?? '');
  const [emailOverride, setEmailOverride] = useState<string>(client.email ?? '');
  const [sendText, setSendText] = useState<boolean>(true);
  const [sendEmail, setSendEmail] = useState<boolean>(true);
  const [topPick, setTopPick] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | { kind: 'idle' }
    | { kind: 'error'; message: string }
    | { kind: 'sent'; url: string; shortId: string; smsSent: boolean; smsError?: string; emailSent: boolean; emailError?: string }
  >({ kind: 'idle' });

  const toggle = (id: string) => {
    setSelectedIds((cur) => {
      if (cur.includes(id)) {
        if (topPick === id) setTopPick(null);
        return cur.filter((x) => x !== id);
      }
      if (cur.length >= MAX_PLANS) return cur;
      return [...cur, id];
    });
  };

  const selectedPlans = selectedIds
    .map((id) => rankedPlans.find((p) => p.plan_id === id))
    .filter((p): p is LibraryRankPlan => Boolean(p));

  const missingFields = (() => {
    const out: string[] = [];
    if (!client.name?.trim()) out.push('client name');
    if (!client.county?.trim()) out.push('county');
    if (!client.state) out.push('state');
    return out;
  })();

  const phone = phoneOverride.trim() || client.phone || '';
  const email = emailOverride.trim();
  const emailValid = !email || /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i.test(email);
  const willText = sendText && phone.replace(/\D/g, '').length >= 10;
  const willEmail = sendEmail && !!email && emailValid;
  const canSend = !submitting && selectedIds.length > 0 && missingFields.length === 0 && emailValid;

  const onSend = async () => {
    if (!canSend) return;
    setSubmitting(true);
    setResult({ kind: 'idle' });
    const payload = {
      clientName: client.name.trim(),
      clientPhone: phone || null,
      clientEmail: email || undefined,
      send: { sms: willText, email: willEmail },
      topPick: headToHead
        ? tripleKey(parseTriple(selectedIds[0]))
        : topPick ? tripleKey(parseTriple(topPick)) : undefined,
      headToHead: headToHead ?? undefined,
      tpmoOrgCount: tpmo.status === 'ready' ? tpmo.counts.orgCount : undefined,
      tpmoProductCount: tpmo.status === 'ready' ? tpmo.counts.productCount : undefined,
      dentalPlans: quoteDental.map((d) => ({
        planId: d.planId,
        monthlyPremium: d.monthlyPremium,
        startingAt: d.startingAt,
        coveredLabel: d.coveredLabel,
      })),
      countyName: client.county,
      stateCode: client.state,
      zip: client.zip || undefined,
      agentName: 'Rob Simm',
      agentPhone: '(828) 761-3326',
      agentNpn: '10447418',
      agentNote: note.trim() || null,
      plans: selectedPlans.map((p) => parseTriple(p.plan_id)),
      medications: drugs
        .filter((d): d is typeof d & { rxcui: string } => !!d.rxcui)
        .map((d) => ({
          rxcui: d.rxcui,
          name: d.name,
          dosage: d.dose ?? undefined,
        })),
      providers: providers
        .filter((p) => p.npi)
        .map((p) => ({
          npi: p.npi as string,
          name: p.name,
          specialty: p.specialty,
        })),
    };
    try {
      const resp = await fetch(QUOTE_SEND_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await resp.json().catch(() => null)) as {
        success?: boolean;
        url?: string;
        shortId?: string;
        sms?: { sent: boolean; error?: string };
        email?: { sent: boolean; error?: string };
        error?: string;
      } | null;
      if (!resp.ok || !data?.success || !data.url || !data.shortId) {
        setResult({ kind: 'error', message: data?.error ?? `HTTP ${resp.status}` });
        return;
      }
      setResult({
        kind: 'sent',
        url: data.url,
        shortId: data.shortId,
        smsSent: !!data.sms?.sent,
        smsError: data.sms?.error,
        emailSent: !!data.email?.sent,
        emailError: data.email?.error,
      });
      onQuoteSent?.(data.url, data.shortId);
    } catch (err) {
      setResult({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  };

  if (result.kind === 'sent') {
    return <SentSuccess result={result} onReset={() => setResult({ kind: 'idle' })} />;
  }

  return (
    <div style={cardStyle}>
      {headToHead ? (
        <>
          <div style={{ fontSize: 18, fontWeight: 600, color: NAVY, fontFamily: 'Fraunces, Georgia, serif' }}>
            Send this comparison
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: MUTED }}>
            Texts and/or emails the client a link to this exact Head to Head, frozen as it is now.
          </div>
          <FieldLabel>Comparison</FieldLabel>
          <div
            style={{
              marginTop: 6, padding: 12, borderRadius: 10, border: `1px solid ${BORDER}`,
              display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 10, alignItems: 'center',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                {headToHead.baseline_label}
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>{headToHead.current.carrier}</div>
              <div style={{ fontSize: 11, color: MUTED }}>{headToHead.current.plan_name}</div>
            </div>
            <div style={{ fontSize: 11, fontWeight: 800, color: NAVY }}>VS</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                Challenger
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>{headToHead.challenger.carrier}</div>
              <div style={{ fontSize: 11, color: MUTED }}>{headToHead.challenger.plan_name}</div>
            </div>
          </div>
          <div style={{ marginTop: 4, fontSize: 11, color: MUTED }}>
            {headToHead.rows.length} rows · {headToHead.challenger.carrier} wins {headToHead.challenger_wins}
            {headToHead.annual_savings ? ` · saves ~$${Math.round(headToHead.annual_savings).toLocaleString()}/yr` : ''}
          </div>
        </>
      ) : (
        <>
        <div style={{ fontSize: 18, fontWeight: 600, color: NAVY, fontFamily: 'Fraunces, Georgia, serif' }}>
          Send a quote
        </div>
        <div style={{ marginTop: 4, fontSize: 12, color: MUTED }}>
          Pick up to {MAX_PLANS} plans, add a personal note, and text and/or email the
          client a link to a frozen comparison page.
        </div>

        <FieldLabel>Plans</FieldLabel>
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rankedPlans.map((p) => {
            const id = p.plan_id;
            const checked = selectedIds.includes(id);
            const disabled = !checked && selectedIds.length >= MAX_PLANS;
            return (
              <label
                key={id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: 12,
                  borderRadius: 10,
                  border: `1px solid ${checked ? BRAND_BLUE : BORDER}`,
                  background: checked ? `${BRAND_BLUE}0d` : '#fff',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.4 : 1,
                  transition: 'background 120ms ease, border-color 120ms ease',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggle(id)}
                  style={{ marginTop: 2 }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: TEXT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.plan_name}
                  </div>
                  <div style={{ fontSize: 11, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.carrier ?? 'Carrier n/a'}
                    {' · '}
                    {p.plan_type ?? '—'}
                    {' · '}${p.premium.toFixed(2)}/mo
                    {' · '}{p.star_rating != null ? `${p.star_rating.toFixed(1)}★` : 'Not yet rated'}
                  </div>
                </div>
                {checked && (
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); setTopPick((cur) => (cur === id ? null : id)); }}
                    aria-pressed={topPick === id}
                    style={{
                      flex: 'none',
                      alignSelf: 'center',
                      padding: '4px 10px',
                      borderRadius: 999,
                      border: `1px solid ${NAVY}`,
                      background: topPick === id ? NAVY : '#fff',
                      color: topPick === id ? '#fff' : NAVY,
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {topPick === id ? 'Top pick ✓' : 'Mark top pick'}
                  </button>
                )}
              </label>
            );
          })}
        </div>
        <div style={{ marginTop: 4, fontSize: 11, color: MUTED }}>
          {selectedIds.length} of {MAX_PLANS} selected
        </div>
        </>
      )}

      <FieldLabel>Dental plans</FieldLabel>
      {quoteDental.length === 0 ? (
        <div style={{ marginTop: 6, fontSize: 12, color: MUTED }}>
          None. Add up to 3 from the Dental tab ("Add to client quote").
        </div>
      ) : (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {quoteDental.map((d) => (
            <div
              key={d.planId}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: 12,
                borderRadius: 10, border: `1px solid ${BORDER}`, background: '#fff',
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: TEXT }}>{d.carrier} {d.planName}</div>
                <div style={{ fontSize: 11, color: MUTED }}>
                  {d.startingAt ? 'From ' : ''}${d.monthlyPremium.toFixed(2)}/mo · {d.coveredLabel}
                </div>
              </div>
              <button
                type="button"
                onClick={() => removeQuoteDental(d.planId)}
                style={{ background: 'transparent', border: 'none', color: MUTED, fontSize: 12, textDecoration: 'underline', cursor: 'pointer' }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <FieldLabel>Personal note</FieldLabel>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={4}
        style={inputStyle}
        placeholder="A short note that shows above the comparison on the page."
      />

      <FieldLabel>Send to</FieldLabel>
      <label style={channelRow}>
        <input type="checkbox" checked={sendText} onChange={(e) => setSendText(e.target.checked)} />
        <span style={{ width: 44, fontSize: 12, color: TEXT, fontWeight: 600 }}>Text</span>
        <input
          type="tel"
          aria-label="Client phone"
          value={phoneOverride}
          onChange={(e) => setPhoneOverride(e.target.value)}
          style={{ ...inputStyle, marginTop: 0, flex: 1 }}
          placeholder="(828) 555-0100"
        />
      </label>
      <label style={channelRow}>
        <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
        <span style={{ width: 44, fontSize: 12, color: TEXT, fontWeight: 600 }}>Email</span>
        <input
          type="email"
          aria-label="Client email"
          value={emailOverride}
          onChange={(e) => setEmailOverride(e.target.value)}
          style={{ ...inputStyle, marginTop: 0, flex: 1 }}
          placeholder="name@example.com"
        />
      </label>
      {!emailValid && (
        <div style={{ marginTop: 4, fontSize: 11, color: ERROR_TEXT }}>That email address doesn't look right.</div>
      )}
      <div style={{ marginTop: 4, fontSize: 11, color: MUTED }}>
        Uncheck both (or leave them blank) to just create the link.
        {tpmo.status === 'error' && ' County TPMO counts unavailable — the page and email fall back to the statewide counts.'}
      </div>

      {result.kind === 'error' && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 8,
            background: ERROR_BG,
            color: ERROR_TEXT,
            fontSize: 12,
          }}
        >
          Couldn't send: {result.message}
        </div>
      )}

      <Btn
        tier="primary"
        size="lg"
        block
        disabled={!canSend}
        onClick={onSend}
        title={
          canSend
            ? undefined
            : `Add ${missingFields.join(', ')} on the Intake screen before sending`
        }
        style={{ marginTop: 16 }}
      >
        {submitting
          ? 'Sending…'
          : willText && willEmail
            ? 'Text + email quote'
            : willText
              ? `Text quote to ${displayPhone(phone)}`
              : willEmail
                ? `Email quote to ${email}`
                : 'Create quote link'}
      </Btn>

      {missingFields.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#92400e' }}>
          Add {missingFields.join(', ')} on the Intake screen before sending.
        </div>
      )}
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────

function tripleKey(t: { contract_id: string; plan_id: string; segment_id: string }): string {
  // Same key the consumer API uses for contract_plan_segment.
  return `${t.contract_id}_${t.plan_id}_${t.segment_id}`;
}

function parseTriple(planId: string): { contract_id: string; plan_id: string; segment_id: string } {
  // LibraryRankPlan.plan_id format: "<contract>-<plan>" or "<contract>-<plan>-<segment>".
  const parts = planId.split('-');
  if (parts.length >= 3) {
    return { contract_id: parts[0], plan_id: parts[1], segment_id: parts.slice(2).join('-') };
  }
  return { contract_id: parts[0] ?? '', plan_id: parts[1] ?? '', segment_id: '0' };
}

function firstNameFrom(name: string | undefined | null): string | null {
  if (!name) return null;
  const first = name.trim().split(/\s+/)[0];
  if (!first) return null;
  // "CHARLANA" / "charlana" → "Charlana"; mixed case ("DeShawn") kept.
  if (first !== first.toUpperCase() && first !== first.toLowerCase()) return first;
  return first
    .split('-')
    .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p))
    .join('-');
}

function buildDefaultNote(firstName: string | null): string {
  const greeting = firstName ? `Hi ${firstName}` : 'Hi there';
  return `${greeting}, here are the plans we talked about. Tap into a plan for full benefits, and call or text me if anything looks off.`;
}

function buildHeadToHeadNote(firstName: string | null, h2h: HeadToHeadQuote): string {
  const greeting = firstName ? `Hi ${firstName}` : 'Hi there';
  const savings = h2h.annual_savings && h2h.annual_savings > 0
    ? ` It's an estimated $${Math.round(h2h.annual_savings).toLocaleString()} a year less for you.`
    : '';
  return `${greeting}, here's your current plan side by side with ${h2h.challenger.plan_name.toLowerCase().startsWith(h2h.challenger.carrier.toLowerCase()) ? h2h.challenger.plan_name : `${h2h.challenger.carrier} ${h2h.challenger.plan_name}`}.${savings} Call or text me if anything looks off.`;
}

function displayPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

// ─── presentational ──────────────────────────────────────────────────────

const cardStyle: CSSProperties = {
  background: '#fff',
  border: `1px solid ${BORDER}`,
  borderRadius: 14,
  padding: 20,
  boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
};

const channelRow: CSSProperties = {
  marginTop: 6,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const inputStyle: CSSProperties = {
  marginTop: 6,
  width: '100%',
  padding: '10px 12px',
  borderRadius: 10,
  border: `1px solid ${BORDER}`,
  fontSize: 13,
  fontFamily: 'inherit',
  color: TEXT,
  background: '#fff',
  outline: 'none',
  resize: 'vertical',
};

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 16,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        color: MUTED,
      }}
    >
      {children}
    </div>
  );
}

function SentSuccess({
  result, onReset,
}: {
  result: { url: string; shortId: string; smsSent: boolean; smsError?: string; emailSent: boolean; emailError?: string };
  onReset: () => void;
}) {
  return (
    <div style={cardStyle}>
      <div
        style={{
          padding: '10px 14px',
          borderRadius: 999,
          background: SUCCESS_BG,
          color: SUCCESS_TEXT,
          fontSize: 13,
          fontWeight: 600,
          display: 'inline-block',
        }}
      >
        Quote sent ✓
      </div>
      <div style={{ marginTop: 10, fontSize: 12, color: MUTED }}>
        {result.smsSent
          ? 'Text sent via AgentBase.'
          : `Text not sent: ${result.smsError ?? 'no phone on file'}.`}
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: result.emailSent || result.emailError === 'not requested' || result.emailError === 'no client email provided' ? MUTED : ERROR_TEXT }}>
        {result.emailSent
          ? 'Email sent.'
          : `Email not sent: ${result.emailError ?? 'no email on file'}.`}
      </div>
      <div
        style={{
          marginTop: 12,
          padding: 12,
          borderRadius: 10,
          background: '#f8fafc',
          border: `1px solid ${BORDER}`,
          fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
          fontSize: 12,
          wordBreak: 'break-all',
        }}
      >
        <a
          href={result.url}
          target="_blank"
          rel="noreferrer"
          style={{ color: BRAND_BLUE, textDecoration: 'underline' }}
        >
          {result.url}
        </a>
      </div>
      <button
        type="button"
        onClick={onReset}
        style={{
          marginTop: 12,
          background: 'transparent',
          border: 'none',
          color: MUTED,
          fontSize: 12,
          textDecoration: 'underline',
          cursor: 'pointer',
        }}
      >
        Send another quote
      </button>
    </div>
  );
}
