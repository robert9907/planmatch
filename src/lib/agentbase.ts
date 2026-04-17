import type { StateCode, PlanType } from '@/types/session';

export interface AgentBaseClient {
  id: string;
  name: string;
  phone: string;
  dob: string;
  zip: string;
  county: string;
  state: StateCode;
  plan_type: PlanType;
  medicaid_confirmed: boolean;
  last_contact_at: string;
  current_plan_id: string | null;
  notes_summary: string;
  source: 'agentbase';
}

// Phase 4: inline mock. Phase 6 swaps this for a real call to AGENTBASE_API_URL.
const MOCK_CLIENTS: AgentBaseClient[] = [
  {
    id: 'cli_0001',
    name: 'Dorothy Hayes',
    phone: '(919) 555-0142',
    dob: '1952-04-22',
    zip: '27713',
    county: 'Durham',
    state: 'NC',
    plan_type: 'DSNP',
    medicaid_confirmed: true,
    last_contact_at: '2026-02-14T15:08:00-05:00',
    current_plan_id: 'H5253-041-000',
    notes_summary: 'On Gabapentin + Metformin. Prefers SilverSneakers gym.',
    source: 'agentbase',
  },
  {
    id: 'cli_0002',
    name: 'Robert Carmichael',
    phone: '(919) 555-0188',
    dob: '1949-11-03',
    zip: '27701',
    county: 'Durham',
    state: 'NC',
    plan_type: 'MAPD',
    medicaid_confirmed: false,
    last_contact_at: '2026-03-02T10:15:00-05:00',
    current_plan_id: 'H1406-015-000',
    notes_summary: 'Looking to drop dental rider, keep Atrium providers.',
    source: 'agentbase',
  },
  {
    id: 'cli_0003',
    name: 'Patricia Wainwright',
    phone: '(704) 555-0110',
    dob: '1956-07-18',
    zip: '28202',
    county: 'Mecklenburg',
    state: 'NC',
    plan_type: 'DSNP',
    medicaid_confirmed: true,
    last_contact_at: '2026-03-28T09:30:00-05:00',
    current_plan_id: 'H1427-004-000',
    notes_summary: 'Diabetic — needs OTC > $150 / quarter. Sees Dr. Holloway.',
    source: 'agentbase',
  },
  {
    id: 'cli_0004',
    name: 'Earl Thompson',
    phone: '(713) 555-0191',
    dob: '1951-09-01',
    zip: '77002',
    county: 'Harris',
    state: 'TX',
    plan_type: 'DSNP',
    medicaid_confirmed: true,
    last_contact_at: '2026-01-22T14:40:00-06:00',
    current_plan_id: 'H4514-069-000',
    notes_summary: 'New dual-eligible. Needs transportation benefit.',
    source: 'agentbase',
  },
  {
    id: 'cli_0005',
    name: 'Margaret Lee',
    phone: '(404) 555-0109',
    dob: '1954-12-09',
    zip: '30303',
    county: 'Fulton',
    state: 'GA',
    plan_type: 'DSNP',
    medicaid_confirmed: true,
    last_contact_at: '2026-03-10T13:22:00-05:00',
    current_plan_id: 'H1036-287-000',
    notes_summary: 'On Eliquis + Ozempic. Prefers Emory network.',
    source: 'agentbase',
  },
  {
    id: 'cli_0006',
    name: 'James O. Barnhill',
    phone: '(336) 555-0177',
    dob: '1960-03-14',
    zip: '27401',
    county: 'Guilford',
    state: 'NC',
    plan_type: 'MAPD',
    medicaid_confirmed: false,
    last_contact_at: '2025-11-04T11:00:00-05:00',
    current_plan_id: null,
    notes_summary: 'Aging in — turns 65 June 2026. Shopping first plan.',
    source: 'agentbase',
  },
];

export async function searchClients(query: string): Promise<AgentBaseClient[]> {
  await sleep(120);
  const q = query.trim().toLowerCase();
  if (!q) return MOCK_CLIENTS;
  return MOCK_CLIENTS.filter((c) => {
    if (c.name.toLowerCase().includes(q)) return true;
    if (c.phone.replace(/\D/g, '').includes(q.replace(/\D/g, ''))) return true;
    if (c.zip.includes(q)) return true;
    if (c.dob.includes(q)) return true;
    return false;
  });
}

export function clientByPhone(phone: string): AgentBaseClient | null {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  return MOCK_CLIENTS.find((c) => c.phone.replace(/\D/g, '') === digits) ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
