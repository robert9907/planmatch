// IntakeScreen — agent-v3 screen 1.
//
// Mockup intent: a calm, client-facing-feeling form that collects
// name / dob / zip / county / phone / email. Reads & writes
// useSession.client so anything hydrated from AgentBase (Landing →
// Recent Clients) shows up pre-filled and any edits persist for the
// downstream screens (Meds, Providers, etc).
//
// Wires:
//   • ZIP → /api/zip-county debounced lookup, paints county + state
//     when 5 digits land, surfaces a green dot when confirmed.
//   • DOB string is left as raw text the broker types; the mockup
//     used MM/DD/YYYY display, the existing v4 stores YYYY-MM-DD.
//     We accept either — broker types what the carrier portal shows.

import { useEffect, useRef, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import type { StateCode } from '@/types/session';
import {
  Card,
  Container,
  Field,
  FieldInput,
  GreenDot,
  Header,
  Nav,
} from './atoms';

interface Props {
  onNext: () => void;
}

export function IntakeScreen({ onNext }: Props) {
  const client = useSession((s) => s.client);
  const updateClient = useSession((s) => s.updateClient);

  const [zipLoading, setZipLoading] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  const zipInFlight = useRef<AbortController | null>(null);

  // Debounced ZIP → county/state lookup. Mirrors the v4 IntakePage
  // wiring — same /api/zip-county route, same abort-on-change behavior
  // so a fast typist doesn't race a stale response over a fresh one.
  useEffect(() => {
    if (!client.zip || !/^\d{5}$/.test(client.zip)) return;
    const ctl = new AbortController();
    zipInFlight.current?.abort();
    zipInFlight.current = ctl;
    const t = window.setTimeout(async () => {
      setZipLoading(true);
      setZipError(null);
      try {
        const res = await fetch(`/api/zip-county?zip=${client.zip}`, {
          signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { county?: string; state?: StateCode };
        if (ctl.signal.aborted) return;
        const patch: Partial<typeof client> = {};
        if (body.county && body.county !== client.county) patch.county = body.county;
        if (body.state && body.state !== client.state) patch.state = body.state;
        if (Object.keys(patch).length > 0) updateClient(patch);
      } catch (err) {
        if (!ctl.signal.aborted) setZipError((err as Error).message);
      } finally {
        if (!ctl.signal.aborted) setZipLoading(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [client.zip]); // eslint-disable-line react-hooks/exhaustive-deps

  // Continue requires the four fields the rest of the workflow can't
  // function without. Email is nice-to-have but not blocking; the
  // broker often captures it mid-call after the SOA.
  const canContinue = Boolean(
    client.name &&
      client.dob &&
      /^\d{5}$/.test(client.zip) &&
      client.phone,
  );

  const countyValue = client.county
    ? (
        <>
          <GreenDot /> {client.county} County
          {client.state ? `, ${client.state}` : ''}
        </>
      )
    : '';

  return (
    <Container>
      <Header
        title="Let's find your perfect plan"
        sub="We'll walk through this together — about 5 minutes."
      />
      <Card>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 14,
          }}
        >
          <FieldInput
            label="Name"
            value={client.name}
            onChange={(v) => updateClient({ name: v })}
            placeholder="Robert Johnson"
          />
          <FieldInput
            label="Date of Birth"
            value={client.dob}
            onChange={(v) => updateClient({ dob: v })}
            placeholder="03/15/1958"
          />
          <FieldInput
            label="ZIP"
            value={client.zip}
            onChange={(v) => updateClient({ zip: v.replace(/\D/g, '').slice(0, 5) })}
            inputMode="numeric"
            maxLength={5}
            placeholder="27713"
            rightHint={
              zipLoading
                ? 'looking up…'
                : zipError
                  ? `lookup failed: ${zipError}`
                  : undefined
            }
          />
          {/* County is read-only — derived from the ZIP lookup. Render
              the static Field atom so it matches the mockup's chrome. */}
          <Field label="County" value={countyValue} />
          <FieldInput
            label="Phone"
            value={client.phone}
            onChange={(v) => updateClient({ phone: v })}
            type="tel"
            inputMode="tel"
            placeholder="(919) 555-0147"
          />
          <FieldInput
            label="Email"
            value={client.email ?? ''}
            onChange={(v) => updateClient({ email: v })}
            type="email"
            inputMode="email"
            placeholder="rjohnson58@gmail.com"
          />
        </div>
      </Card>
      <Nav onNext={onNext} nextDisabled={!canContinue} />
    </Container>
  );
}
