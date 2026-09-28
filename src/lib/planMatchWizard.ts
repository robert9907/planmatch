// Build a deep-link URL into the Plan Match consumer's enrollment wizard
// at /enrollment/wizard pre-filled with the AgentBase client's known data.
//
// The wizard at planmatch.generationhealth.me reads every EnrollmentClient
// field from URL query params on mount (see plan-match repo,
// apps/web/src/pages/enrollment-wizard/EnrollmentWizardPage.tsx). Booleans
// accept "true" / "1". Empty values are skipped — the wizard treats those
// as "broker fills during the call".
//
// Field mapping notes:
//   - AgentBase stores `name` as a single string; we best-effort split into
//     firstName + lastName on the first whitespace. Multi-word last names
//     ("Van Der Meer") get joined back together.
//   - AgentBase has `state` as a 2-letter code; the wizard expects the
//     same for `homeState` (and a long form for `stateOfBirth` which we
//     don't have on this side).
//   - We don't have `ssn` or `homeStreet` on the AgentBase side — the
//     broker captures those during the enrollment call.
//   - SSN/MBI never go in the URL; see openPlanMatchWizard().

import type { Client } from '@/types/session';

const BASE_URL =
  (import.meta.env.VITE_PLANMATCH_WIZARD_URL as string | undefined) ??
  'https://planmatch.generationhealth.me/enrollment/wizard';

export function buildPlanMatchWizardUrl(client: Client): string {
  const { firstName, lastName } = splitName(client.name);

  const params: Record<string, string> = {};
  if (firstName) params.firstName = firstName;
  if (lastName) params.lastName = lastName;
  if (client.dob) params.dateOfBirth = client.dob;
  if (client.zip) params.homeZip = client.zip;
  if (client.county) params.homeCity = client.county; // best effort — broker confirms
  if (client.state) params.homeState = client.state;
  if (client.phone) params.phone = client.phone.replace(/\D/g, '').slice(-10);
  if (client.email) params.email = client.email;
  // MBI deliberately NOT in the URL (browser history, Vercel logs, copied
  // links) — openPlanMatchWizard() hands it over with postMessage.

  const qs = new URLSearchParams(params).toString();
  return qs ? `${BASE_URL}?${qs}` : BASE_URL;
}

/**
 * Open the wizard in a new tab and, once it posts "gh-enroll-prefill-ready",
 * send the MBI to it — addressed only to the wizard's origin. Opened without
 * "noopener" so the wizard can reach its opener for the handshake.
 */
export function openPlanMatchWizard(client: Client): void {
  const url = buildPlanMatchWizardUrl(client);
  const origin = new URL(url).origin;
  const w = window.open(url, '_blank');
  const mbi = (client.mbi ?? '').replace(/[\s-]/g, '').toUpperCase();
  if (!w || !mbi) return;
  const onMessage = (e: MessageEvent): void => {
    if (e.origin !== origin || e.source !== w) return;
    if ((e.data as { type?: string } | null)?.type !== 'gh-enroll-prefill-ready') return;
    w.postMessage({ type: 'gh-enroll-prefill', medicareNumber: mbi }, origin);
    cleanup();
  };
  const cleanup = (): void => {
    window.removeEventListener('message', onMessage);
    clearTimeout(timer);
  };
  const timer = setTimeout(cleanup, 120_000);
  window.addEventListener('message', onMessage);
}

function splitName(full: string): { firstName: string; lastName: string } {
  const trimmed = (full ?? '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return { firstName: '', lastName: '' };
  const idx = trimmed.indexOf(' ');
  if (idx === -1) return { firstName: trimmed, lastName: '' };
  return {
    firstName: trimmed.slice(0, idx),
    lastName: trimmed.slice(idx + 1),
  };
}
