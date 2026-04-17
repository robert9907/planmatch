-- PlanMatch capture_sessions
-- Token-based photo capture sessions. Rob creates a session, Dorothy's phone
-- POSTs photos, Claude Vision extracts structured data, Rob polls for results
-- and approves each item into the session.

create extension if not exists "pgcrypto";

create table if not exists public.capture_sessions (
  id              uuid primary key default gen_random_uuid(),
  token           text unique not null,
  status          text not null default 'waiting'
                    check (status in ('waiting','has_results','completed','expired')),
  client_name     text,
  client_phone    text,
  started_by      text,
  payload         jsonb not null default '[]'::jsonb,
  item_count      int generated always as (jsonb_array_length(payload)) stored,
  last_item_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '24 hours')
);

create index if not exists capture_sessions_token_idx        on public.capture_sessions (token);
create index if not exists capture_sessions_status_idx       on public.capture_sessions (status);
create index if not exists capture_sessions_expires_at_idx   on public.capture_sessions (expires_at);

create or replace function public.capture_sessions_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists capture_sessions_touch_updated_at on public.capture_sessions;
create trigger capture_sessions_touch_updated_at
before update on public.capture_sessions
for each row execute function public.capture_sessions_touch_updated_at();

alter table public.capture_sessions enable row level security;

-- Service role only; the anon key is never used against this table.
-- Token-in-URL is the authorization model; API functions use the service role.
drop policy if exists capture_sessions_service_role on public.capture_sessions;
create policy capture_sessions_service_role
  on public.capture_sessions
  for all
  to service_role
  using (true)
  with check (true);
