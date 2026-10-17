-- Off-exchange individual dental plans + rates for the agent-v3 Dental quote.
--
-- Applied to plan-match-prod (rpcbrkmvalvdmroqzpaq) on 2026-10-17 through the
-- Supabase migrations API (create_pm_dental_tables,
-- pm_dental_benefit_detail_columns, pm_dental_plan_filter_flags). This file is
-- the repo record of that schema; every statement is idempotent.
--
-- Service-role only: RLS on, no policies, no anon grants. Read by
-- /api/dental-plans with SUPABASE_SERVICE_ROLE_KEY.
--
-- Data source: carrier brochures / plan summaries / agent-portal and public
-- quote pages, gathered by Rob Oct 17 2026 (NC only). Not CMS data — there is
-- no federal filing for off-exchange stand-alone dental.

create table if not exists public.pm_dental_plan (
  id uuid primary key default gen_random_uuid(),
  carrier text not null,
  plan_name text not null,
  state text not null,
  plan_type text not null default 'PPO',          -- PPO, DHMO, discount
  is_insurance boolean not null default true,      -- false for discount/savings plans
  network text,
  annual_max text,
  deductible text,
  waiting_period text,
  preventive text,
  basic text,
  major text,
  orthodontia text,
  rating_basis text,                               -- age_band, zip_area, tier, flat, unverified
  source_url text,
  notes text,
  captured_at timestamptz not null default now(),
  unique (carrier, plan_name, state)
);

create table if not exists public.pm_dental_rate (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.pm_dental_plan(id) on delete cascade,
  zip text,                                        -- set = rate was quoted for this one ZIP
  age_min int,
  age_max int,
  tier text not null default 'individual',         -- individual, self_plus_1, self_plus_2_or_more, family
  monthly_premium numeric(8,2) not null,
  is_starting_at boolean not null default false,   -- carrier only published a floor price
  effective_date date,
  captured_at timestamptz not null default now()
);
create index if not exists pm_dental_rate_plan_idx on public.pm_dental_rate(plan_id);

alter table public.pm_dental_plan
  add column if not exists implants text,
  add column if not exists dentures text,
  add column if not exists crowns text,
  add column if not exists root_canals text,
  add column if not exists periodontics text,
  add column if not exists oral_surgery text,
  add column if not exists waiting_waiver text,
  add column if not exists missing_tooth_clause text,
  add column if not exists eligibility text,
  add column if not exists extras text,
  add column if not exists source_doc text,
  -- Filter flags. Null = not confirmed from carrier documents (shown as
  -- unknown, never treated as covered).
  add column if not exists covers_implants boolean,
  add column if not exists covers_major boolean,
  add column if not exists no_waiting boolean;

alter table public.pm_dental_rate
  add column if not exists zip_prefixes text[];    -- 3-digit ZIP prefixes this rate applies to (null = all)

alter table public.pm_dental_plan enable row level security;
alter table public.pm_dental_rate enable row level security;
