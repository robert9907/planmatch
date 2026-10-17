-- 007_pm_dental_implant_wait.sql
--
-- Months a member must be enrolled before implants are covered. Null = the
-- plan doesn't cover implants or the wait isn't confirmed. Sourced from each
-- plan's own summary (pm_dental_plan.implants / waiting_period text).
-- Drives the Dental screen's "Implants with no waiting period" filter and
-- the pulled-tooth guidance.

alter table public.pm_dental_plan
  add column if not exists implant_wait_months smallint;
