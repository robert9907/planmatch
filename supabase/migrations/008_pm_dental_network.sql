-- Dentist networks for the agent-v3 Dental quote.
--
-- No dental carrier we sell in NC publishes a usable machine-readable dentist
-- directory for its individual plans (researched 2026-10-19: Delta Dental of
-- NC, Humana, Ameritas, MetLife, Aetna, Blue Cross NC, Cigna, Guardian), and
-- several carriers' site terms forbid automated use of their directories.
-- So "is this dentist in network?" is answered by the broker checking the
-- carrier's own find-a-dentist page and recording the result here — the same
-- broker-confirmation-first source order Plan Match uses for doctors.
--
-- A verification is stored per (carrier, network, NPI), not per plan, so one
-- check answers every plan on that network.
--
-- Service-role only: RLS on, no policies, no anon grants. Read and written by
-- /api/dental-network behind requireSession.

create table if not exists public.pm_dental_network (
  carrier text not null,
  network text not null,
  directory_url text not null,            -- carrier's own public find-a-dentist page
  directory_note text,                    -- what to pick on that page so the search uses this network
  primary key (carrier, network)
);
alter table public.pm_dental_network enable row level security;

create table if not exists public.pm_dental_network_verification (
  id uuid primary key default gen_random_uuid(),
  carrier text not null,
  network text not null,
  npi text not null check (npi ~ '^\d{10}$'),
  dentist_name text not null,
  practice_address text,
  status text not null check (status in ('in_network', 'not_in_network')),
  source text not null default 'broker_verified',
  verified_by text,
  verified_at timestamptz not null default now(),
  notes text,
  unique (carrier, network, npi)
);
create index if not exists pm_dental_network_verification_npi_idx
  on public.pm_dental_network_verification(npi);
alter table public.pm_dental_network_verification enable row level security;

insert into public.pm_dental_network (carrier, network, directory_url, directory_note) values
  ('Aetna', 'Aetna Dental PPO', 'https://health.aetna.com/ahpublic/location?siteId=individualdental', 'Individual dental search · network: Aetna Dental PPO'),
  ('Ameritas', 'Ameritas Classic (PPO)', 'https://www.ameritas.com/', 'Find a provider → Dental → network provider · network: Classic (PPO)'),
  ('Blue Cross NC', 'Dental Blue', 'https://healthnav.bcbsnc.com/?network_id=15&ci=COMMERCIAL', 'Dental Blue network search'),
  ('Blue Cross NC', 'Dental Blue PPO', 'https://healthnav.bcbsnc.com/?network_id=15&ci=COMMERCIAL', 'Dental Blue network search'),
  ('Cigna', 'Cigna Advantage Network', 'https://hcpdirectory.cigna.com/web/public/consumer/directory/search?consumerCode=HDC053', 'Opens pre-set to the Cigna Dental Advantage network'),
  ('Cigna', 'Cigna Total Network', 'https://hcpdirectory.cigna.com/web/public/consumer/directory/search?consumerCode=HDC054', 'Opens pre-set to the Cigna Dental Total network'),
  ('Delta Dental of NC', 'Delta Dental PPO', 'https://www.deltadental.com/us/en/member/find-a-dentist.html', 'Network: Delta Dental PPO'),
  ('Guardian', 'Guardian Advantage PPO', 'https://www.guardianlife.com/find-a-dentist', 'Network: Advantage PPO'),
  ('Guardian', 'Guardian Select PPO', 'https://www.guardianlife.com/find-a-dentist', 'Network: Select PPO'),
  ('Humana', 'Humana PPO', 'https://finder.humana.com/finder/dental?customerId=1004', 'Network: PPO / Traditional Preferred'),
  ('Humana', 'Humana discount network', 'https://finder.humana.com/finder/dental?customerId=1004', 'Discount plan network — any participating dentist'),
  ('MetLife', 'MetLife PDP', 'https://www.metlife.com/', 'Find a Dentist · network: PDP Plus')
on conflict (carrier, network) do update
  set directory_url = excluded.directory_url, directory_note = excluded.directory_note;
