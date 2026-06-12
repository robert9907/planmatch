// QuoteBuilder — agent-v3 surface for sending a multi-plan quote.
//
// Twin of apps/web/src/pages/agent-v3/components/QuoteBuilder.tsx in the
// consumer repo (robert9907/plan-match). User-visible behavior must
// stay aligned even though the surfaces have different shapes (this
// repo: flat files, inline styles, zustand session; consumer repo:
// screens/components/hooks subdirs, Tailwind, AgentContext).
//
// Pickup to 5 plans the brain ranked, write a personal note, optionally
// override the prospect's phone number, POST to the consumer-host
// /api/quotes (where pm_quotes lives), get back a /quote/:short_id URL.

import { useMemo, useState, type CSSProperties } from 'react';
import { useSession } from '@/lib/session';
import type { LibraryRankPlan } from '@/lib/library-client';

const MAX_PLANS = 5;
// Consumer-side host where pm_quotes lives and where the public
// /quote/:id page is served. The agent surface (planmatch.vercel.app)
// posts cross-origin — setCors() on api/quotes.ts allows it.
const QUOTE_API_BASE = 'https://planmatch.generationhealth.me';

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
}

export function QuoteBuilder({ rankedPlans, onQuoteSent }: QuoteBuilderProps) {
  const session = useSession();
  const client = session.client;
  const drugs = session.medications;
  const providers = session.providers;

  const defaultSelected = useMemo(() => {
    return rankedPlans.slice(0, 3).map((p) => p.plan_id);
  }, [rankedPlans]);

  const [selectedIds, setSelectedIds] = useState<string[]>(defaultSelected);
  const [note, setNote] = useState<string>(buildDefaultNote(firstNameFrom(client.name)));
  const [phoneOverride, setPhoneOverride] = useState<string>(client.phone ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | { kind: 'idle' }
    | { kind: 'error'; message: string }
    | { kind: 'sent'; url: string; shortId: string; smsSent: boolean; smsError?: string }
  >({ kind: 'idle' });

  const toggle = (id: string) => {
    setSelectedIds((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
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

  const canSend = !submitting && selectedIds.length > 0 && missingFields.length === 0;

  const onSend = async () => {
    if (!canSend) return;
    setSubmitting(true);
    setResult({ kind: 'idle' });
    const payload = {
      clientName: client.name.trim(),
      clientPhone: phoneOverride.trim() || client.phone || null,
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
      const resp = await fetch(`${QUOTE_API_BASE}/api/quotes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await resp.json().catch(() => null)) as {
        success?: boolean;
        url?: string;
        shortId?: string;
        sms?: { sent: boolean; error?: string };
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
      <div style={{ fontSize: 18, fontWeight: 600, color: NAVY, fontFamily: 'Fraunces, Georgia, serif' }}>
        Send a quote
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: MUTED }}>
        Pick up to {MAX_PLANS} plans, add a personal note, and text the prospect a
        link to a frozen comparison page.
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
                  {p.star_rating != null && <> · {p.star_rating.toFixed(1)}★</>}
                </div>
              </div>
            </label>
          );
        })}
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: MUTED }}>
        {selectedIds.length} of {MAX_PLANS} selected
      </div>

      <FieldLabel>Personal note</FieldLabel>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={4}
        style={inputStyle}
        placeholder="A short note that shows above the comparison on the page."
      />

      <FieldLabel>Prospect phone</FieldLabel>
      <input
        type="tel"
        value={phoneOverride}
        onChange={(e) => setPhoneOverride(e.target.value)}
        style={inputStyle}
        placeholder="(828) 555-0100"
      />
      <div style={{ marginTop: 4, fontSize: 11, color: MUTED }}>
        Leave blank to skip the SMS — the quote URL is still returned.
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

      <button
        type="button"
        disabled={!canSend}
        onClick={onSend}
        style={{
          marginTop: 16,
          width: '100%',
          padding: '12px 16px',
          borderRadius: 999,
          border: 'none',
          background: canSend ? BRAND_BLUE : '#cbd5e1',
          color: '#fff',
          fontWeight: 600,
          fontSize: 14,
          cursor: canSend ? 'pointer' : 'not-allowed',
        }}
      >
        {submitting
          ? 'Sending…'
          : phoneOverride.trim() || client.phone
            ? `Text quote to ${displayPhone(phoneOverride.trim() || client.phone || '')}`
            : 'Create quote link'}
      </button>

      {missingFields.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#92400e' }}>
          Add {missingFields.join(', ')} on the Intake screen before sending.
        </div>
      )}
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────

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
  return first || null;
}

function buildDefaultNote(firstName: string | null): string {
  const greeting = firstName ? `Hi ${firstName}` : 'Hi there';
  return `${greeting}, here are the plans we talked about. Tap into a plan for full benefits, and call or text me if anything looks off.`;
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
  result: { url: string; shortId: string; smsSent: boolean; smsError?: string };
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
          ? 'SMS delivered to the prospect via AgentBase.'
          : `SMS skipped: ${result.smsError ?? 'no phone on file'}.`}
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
