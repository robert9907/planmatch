-- 005_pm_dental_household.sql
--
-- How a carrier prices more than one person on a dental plan.
--
--   tier        — flat household tiers stored in pm_dental_rate.tier
--                 (Ameritas, Delta EHB A/B/C, MetLife). Default.
--   sum_by_age  — each person pays their own age rate; the couple price is
--                 primary + spouse, with an optional spouse discount.
--                 Confirmed against carrier quotes 2026-10-17:
--                   Guardian  — exact sum, 6 age pairs x 8 plans
--                   Cigna     — spouse 15% off own rate (0% on 3000/100),
--                               6 quotes across 3 rating areas
--                   BCBS NC   — exact sum, all 3 plans
--                   Delta NC Enhanced/Premium/Preventive — per-person by
--                               age, from Delta's published 2026 rate table
--
-- Additive, nullable-safe. RLS on pm_dental_plan is unchanged (enabled in 004).

alter table public.pm_dental_plan
  add column if not exists household_pricing text not null default 'tier',
  add column if not exists spouse_discount_pct numeric(5,2);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pm_dental_plan_household_pricing_check'
  ) then
    alter table public.pm_dental_plan
      add constraint pm_dental_plan_household_pricing_check
      check (household_pricing in ('tier', 'sum_by_age'));
  end if;
end $$;
