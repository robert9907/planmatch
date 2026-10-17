-- 006_pm_dental_household_adults.sql
--
-- Adds household_pricing = 'sum_by_age_adults': per-person pricing confirmed
-- for adults only (Humana labels every rate "per individual", but never shows
-- a child rate). Children on these plans show "quote with carrier".

alter table public.pm_dental_plan
  drop constraint if exists pm_dental_plan_household_pricing_check;

alter table public.pm_dental_plan
  add constraint pm_dental_plan_household_pricing_check
  check (household_pricing in ('tier', 'sum_by_age', 'sum_by_age_adults'));
