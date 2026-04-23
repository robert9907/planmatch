import type { Client, Medication, Provider } from '@/types/session';
import type { Plan } from '@/types/plans';

function formatDob(dob: string): string {
  if (!dob) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (!m) return dob;
  const [, y, mo, d] = m;
  return `${mo}/${d}/${y}`;
}

function splitName(full: string): { first: string; last: string } {
  const trimmed = full.trim();
  if (!trimmed) return { first: '', last: '' };
  const parts = trimmed.split(/\s+/);
  const first = parts.shift() ?? '';
  return { first, last: parts.join(' ') };
}

function formatPremium(premium: number): string {
  return premium === 0 ? '$0' : `$${premium.toFixed(2)}/mo`;
}

export function buildClientInfoText({
  client,
  plan,
  medications,
  providers,
}: {
  client: Client;
  plan: Plan;
  medications: Medication[];
  providers: Provider[];
}): string {
  const { first, last } = splitName(client.name);
  const medicareId = (client as { medicareId?: string }).medicareId ?? '';
  const email = (client as { email?: string }).email ?? '';
  const address = (client as { address?: string }).address ?? '';
  const city = (client as { city?: string }).city ?? '';

  const medLines = medications.length
    ? medications
        .map((m) => `- ${m.name}${m.strength ? ` ${m.strength}` : ''}`)
        .join('\n')
    : '- (none)';

  const providerLines = providers.length
    ? providers
        .map((p) => `- ${p.name}${p.npi ? `, NPI ${p.npi}` : ''}`)
        .join('\n')
    : '- (none)';

  return [
    'ENROLLMENT DETAILS',
    `Name: ${first} ${last}`.trimEnd(),
    `DOB: ${formatDob(client.dob)}`,
    `Medicare ID: ${medicareId}`,
    `Phone: ${client.phone}`,
    `Email: ${email}`,
    `Address: ${address}`,
    `City: ${city}`,
    `State: ${client.state ?? ''}`,
    `ZIP: ${client.zip}`,
    `County: ${client.county}`,
    '',
    'PLAN SELECTED',
    `Plan: ${plan.plan_name}`,
    `Plan ID: ${plan.contract_id}-${plan.plan_number}`,
    `Carrier: ${plan.carrier}`,
    `Premium: ${formatPremium(plan.premium)}`,
    `Plan Type: ${plan.plan_type}`,
    '',
    'MEDICATIONS',
    medLines,
    '',
    'PROVIDERS',
    providerLines,
  ].join('\n');
}
