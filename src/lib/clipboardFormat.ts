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

// Compact SunFire-handoff payload — fired when the broker clicks "Open
// SunFire" on a finalist column. SunFire's enrollment portal does NOT
// expose a documented deep-link API for plan pre-selection, so we use
// the clipboard handoff: copy a structured paste-ready block, then
// open the broker's SunFire workspace in a new tab. The broker pastes
// once into SunFire's plan search / intake field.
//
// Format is tuned for paste-readability — single line per fact, no
// markdown, no Unicode quotes (some Windows enrollment portals choke
// on smart quotes). The full triple "H1036-308-0" goes in the Contract
// line so SunFire's plan search resolves to one specific plan even
// when the carrier has multiple variants in the same county.
export function buildSunfireRecommendationText({
  client,
  plan,
  brokerName,
  brokerNpn,
  brokerPhone,
}: {
  client: Client;
  plan: Plan;
  brokerName: string;
  brokerNpn: string;
  brokerPhone: string;
}): string {
  // Plan id triple — Plan.id is "H1036-308-0"; we expose every part
  // separately on the Contract line so SunFire's intake parser picks
  // up whichever it indexes on.
  const segmentId = plan.id.split('-')[2] ?? '0';
  const triple = `${plan.contract_id}-${plan.plan_number}-${segmentId}`;
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  const location = [client.county, client.state, client.zip].filter(Boolean).join(', ');
  const giveback = (plan.part_b_giveback ?? 0) > 0
    ? `$${plan.part_b_giveback.toFixed(2)}/mo`
    : null;

  // Build conditionally so optional fields don't leave gaps. Section
  // separator (blank line) stays in for visual readability when the
  // broker pastes into a SunFire intake field that respects newlines.
  const lines: string[] = [];
  lines.push('SUNFIRE HANDOFF');
  lines.push(`Client: ${client.name} · DOB: ${formatDob(client.dob)}`);
  if (location) lines.push(`Location: ${location}`);
  if (client.phone) lines.push(`Phone: ${client.phone}`);
  lines.push('');
  lines.push('RECOMMENDED PLAN');
  lines.push(`Plan: ${plan.plan_name}`);
  lines.push(`Carrier: ${plan.carrier}`);
  lines.push(`Contract: ${triple}`);
  lines.push(`Premium: ${formatPremium(plan.premium)} · MOOP: $${(plan.moop_in_network ?? 0).toLocaleString()}`);
  if (giveback) lines.push(`Part B Giveback: ${giveback}`);
  lines.push('');
  lines.push(`Recommended by: ${brokerName} · NPN #${brokerNpn} · ${brokerPhone}`);
  lines.push(`Date: ${today}`);
  return lines.join('\n');
}
