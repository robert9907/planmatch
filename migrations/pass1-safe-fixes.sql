-- pass1-safe-fixes.sql
-- Generated 2026-06-26T01:51:23.007553Z
--
-- Curated Pass 1 (cms-sync-2026.ts) findings that are unambiguously
-- safe to apply. Three sections:
--   1. 34 PDP premium NULL → CMS value
--   2. 2 carrier name shortening
--   3. 1 drug_deductible NULL → CMS value
--
-- NOTE ON SECTION 1: spec said "34 NULLs → $0" but the actual audit
-- shows only 5 of 34 PDPs have CMS=$0 (the genuine zero-
-- premium PDPs like Wellcare Value Script). The other 29 are paid
-- PDPs ($4-$163/mo) where the DB simply never ingested the premium.
-- Both groups are safe: PDP DB-NULL is the safety boundary, not the
-- particular CMS value. Each UPDATE writes the per-plan CMS value, so
-- this section fills in 34 NULLs (not 34 zeros).
--
-- NOT INCLUDED (intentionally — see audit notes):
--   • 243 D-SNP premium "mismatches" — DB stores Part D Basic Premium
--     pre-LIS; Plan Finder shows $0 post-LIS. Both correct, semantic
--     difference handled in api/plans.ts via consumer_premium.
--   • 56 MOOP mismatches — DB stores combined in+out MOOP for PPOs;
--     CMS Landscape exposes only in-network. Keep DB as-is.
--   • Any annual_deductible changes — CMS source coverage is partial.

BEGIN;

-- ── Section 1: 34 PDP premium NULL → CMS value ─────────
--   (5 where CMS=$0, 29 where CMS>$0)

-- S4802-013-000  Wellcare                       Wellcare Classic (PDP)  CMS=$0
UPDATE pm_plans SET monthly_premium = 0 WHERE contract_id = 'S4802' AND plan_id = '013' AND segment_id = '000';
-- S4802-081-000  Wellcare                       Wellcare Classic (PDP)  CMS=$4.7
UPDATE pm_plans SET monthly_premium = 4.7 WHERE contract_id = 'S4802' AND plan_id = '081' AND segment_id = '000';
-- S4802-082-000  Wellcare                       Wellcare Classic (PDP)  CMS=$0
UPDATE pm_plans SET monthly_premium = 0 WHERE contract_id = 'S4802' AND plan_id = '082' AND segment_id = '000';
-- S4802-143-000  Wellcare                       Wellcare Value Script (PDP)  CMS=$3.6
UPDATE pm_plans SET monthly_premium = 3.6 WHERE contract_id = 'S4802' AND plan_id = '143' AND segment_id = '000';
-- S4802-145-000  Wellcare                       Wellcare Value Script (PDP)  CMS=$0
UPDATE pm_plans SET monthly_premium = 0 WHERE contract_id = 'S4802' AND plan_id = '145' AND segment_id = '000';
-- S4802-155-000  Wellcare                       Wellcare Value Script (PDP)  CMS=$0
UPDATE pm_plans SET monthly_premium = 0 WHERE contract_id = 'S4802' AND plan_id = '155' AND segment_id = '000';
-- S5540-002-000  Blue Cross and Blue Shield of  Blue Medicare Rx Standard (PDP)  CMS=$83.9
UPDATE pm_plans SET monthly_premium = 83.9 WHERE contract_id = 'S5540' AND plan_id = '002' AND segment_id = '000';
-- S5540-004-000  Blue Cross and Blue Shield of  Blue Medicare Rx Enhanced (PDP)  CMS=$163.2
UPDATE pm_plans SET monthly_premium = 163.2 WHERE contract_id = 'S5540' AND plan_id = '004' AND segment_id = '000';
-- S5601-016-000  Aetna Medicare                 SilverScript Choice (PDP)  CMS=$90.2
UPDATE pm_plans SET monthly_premium = 90.2 WHERE contract_id = 'S5601' AND plan_id = '016' AND segment_id = '000';
-- S5601-020-000  Aetna Medicare                 SilverScript Choice (PDP)  CMS=$100.7
UPDATE pm_plans SET monthly_premium = 100.7 WHERE contract_id = 'S5601' AND plan_id = '020' AND segment_id = '000';
-- S5601-044-000  Aetna Medicare                 SilverScript Choice (PDP)  CMS=$94.8
UPDATE pm_plans SET monthly_premium = 94.8 WHERE contract_id = 'S5601' AND plan_id = '044' AND segment_id = '000';
-- S5617-108-000  HealthSpring                   HealthSpring Assurance Rx (PDP)  CMS=$111.4
UPDATE pm_plans SET monthly_premium = 111.4 WHERE contract_id = 'S5617' AND plan_id = '108' AND segment_id = '000';
-- S5617-217-000  HealthSpring                   HealthSpring Assurance Rx (PDP)  CMS=$110.4
UPDATE pm_plans SET monthly_premium = 110.4 WHERE contract_id = 'S5617' AND plan_id = '217' AND segment_id = '000';
-- S5617-219-000  HealthSpring                   HealthSpring Assurance Rx (PDP)  CMS=$149.3
UPDATE pm_plans SET monthly_premium = 149.3 WHERE contract_id = 'S5617' AND plan_id = '219' AND segment_id = '000';
-- S5617-358-000  HealthSpring                   HealthSpring Extra Rx (PDP)  CMS=$78
UPDATE pm_plans SET monthly_premium = 78 WHERE contract_id = 'S5617' AND plan_id = '358' AND segment_id = '000';
-- S5617-360-000  HealthSpring                   HealthSpring Extra Rx (PDP)  CMS=$71.2
UPDATE pm_plans SET monthly_premium = 71.2 WHERE contract_id = 'S5617' AND plan_id = '360' AND segment_id = '000';
-- S5617-372-000  HealthSpring                   HealthSpring Extra Rx (PDP)  CMS=$70
UPDATE pm_plans SET monthly_premium = 70 WHERE contract_id = 'S5617' AND plan_id = '372' AND segment_id = '000';
-- S5715-005-000  HealthSpring                   Blue Cross MedicareRx Value (PDP)  CMS=$167.4
UPDATE pm_plans SET monthly_premium = 167.4 WHERE contract_id = 'S5715' AND plan_id = '005' AND segment_id = '000';
-- S5715-014-000  HealthSpring                   Blue Cross MedicareRx Basic (PDP)  CMS=$104.7
UPDATE pm_plans SET monthly_premium = 104.7 WHERE contract_id = 'S5715' AND plan_id = '014' AND segment_id = '000';
-- S5884-133-000  Humana                         Humana Basic Rx Plan (PDP)  CMS=$6.8
UPDATE pm_plans SET monthly_premium = 6.8 WHERE contract_id = 'S5884' AND plan_id = '133' AND segment_id = '000';
-- S5884-135-000  Humana                         Humana Basic Rx Plan (PDP)  CMS=$0
UPDATE pm_plans SET monthly_premium = 0 WHERE contract_id = 'S5884' AND plan_id = '135' AND segment_id = '000';
-- S5884-143-000  Humana                         Humana Basic Rx Plan (PDP)  CMS=$41.7
UPDATE pm_plans SET monthly_premium = 41.7 WHERE contract_id = 'S5884' AND plan_id = '143' AND segment_id = '000';
-- S5884-154-000  Humana                         Humana Premier Rx Plan (PDP)  CMS=$110.9
UPDATE pm_plans SET monthly_premium = 110.9 WHERE contract_id = 'S5884' AND plan_id = '154' AND segment_id = '000';
-- S5884-156-000  Humana                         Humana Premier Rx Plan (PDP)  CMS=$129.5
UPDATE pm_plans SET monthly_premium = 129.5 WHERE contract_id = 'S5884' AND plan_id = '156' AND segment_id = '000';
-- S5884-168-000  Humana                         Humana Premier Rx Plan (PDP)  CMS=$118.2
UPDATE pm_plans SET monthly_premium = 118.2 WHERE contract_id = 'S5884' AND plan_id = '168' AND segment_id = '000';
-- S5884-187-000  Humana                         Humana Value Rx Plan (PDP)  CMS=$32
UPDATE pm_plans SET monthly_premium = 32 WHERE contract_id = 'S5884' AND plan_id = '187' AND segment_id = '000';
-- S5884-189-000  Humana                         Humana Value Rx Plan (PDP)  CMS=$36.4
UPDATE pm_plans SET monthly_premium = 36.4 WHERE contract_id = 'S5884' AND plan_id = '189' AND segment_id = '000';
-- S5884-201-000  Humana                         Humana Value Rx Plan (PDP)  CMS=$22.9
UPDATE pm_plans SET monthly_premium = 22.9 WHERE contract_id = 'S5884' AND plan_id = '201' AND segment_id = '000';
-- S5921-353-000  UnitedHealthcare               AARP Medicare Rx Saver from UHC (PDP)  CMS=$56.9
UPDATE pm_plans SET monthly_premium = 56.9 WHERE contract_id = 'S5921' AND plan_id = '353' AND segment_id = '000';
-- S5921-355-000  UnitedHealthcare               AARP Medicare Rx Saver from UHC (PDP)  CMS=$98
UPDATE pm_plans SET monthly_premium = 98 WHERE contract_id = 'S5921' AND plan_id = '355' AND segment_id = '000';
-- S5921-367-000  UnitedHealthcare               AARP Medicare Rx Saver from UHC (PDP)  CMS=$89.2
UPDATE pm_plans SET monthly_premium = 89.2 WHERE contract_id = 'S5921' AND plan_id = '367' AND segment_id = '000';
-- S5921-390-000  UnitedHealthcare               AARP Medicare Rx Preferred from UHC (PDP)  CMS=$119.8
UPDATE pm_plans SET monthly_premium = 119.8 WHERE contract_id = 'S5921' AND plan_id = '390' AND segment_id = '000';
-- S5921-392-000  UnitedHealthcare               AARP Medicare Rx Preferred from UHC (PDP)  CMS=$139.8
UPDATE pm_plans SET monthly_premium = 139.8 WHERE contract_id = 'S5921' AND plan_id = '392' AND segment_id = '000';
-- S5921-403-000  UnitedHealthcare               AARP Medicare Rx Preferred from UHC (PDP)  CMS=$114.8
UPDATE pm_plans SET monthly_premium = 114.8 WHERE contract_id = 'S5921' AND plan_id = '403' AND segment_id = '000';

-- ── Section 2: 2 carrier name standardization ──────────
-- DB carrier strings that differ from the canonical CMS marketing
-- name. Comment shows DB → CMS so you can verify it is a casing/
-- shortening diff (safe) vs a re-labeling (review needed).

-- S5715-005-000  Blue Cross MedicareRx Value (PDP)
--   DB='Blue Cross and Blue Shield of IL, NM, OK, TX'  →  CMS='HealthSpring'
UPDATE pm_plans SET carrier = 'HealthSpring' WHERE contract_id = 'S5715' AND plan_id = '005' AND segment_id = '000';
-- S5715-014-000  Blue Cross MedicareRx Basic (PDP)
--   DB='Blue Cross and Blue Shield of IL, NM, OK, TX'  →  CMS='HealthSpring'
UPDATE pm_plans SET carrier = 'HealthSpring' WHERE contract_id = 'S5715' AND plan_id = '014' AND segment_id = '000';

-- ── Section 3: 1 drug_deductible NULL → CMS value ─────────

-- H8634-026-000  Blue Cross and Blue Shield of  Blue Cross Medicare Advantage Protect (P  CMS=$750
UPDATE pm_plans SET drug_deductible = 750 WHERE contract_id = 'H8634' AND plan_id = '026' AND segment_id = '000';

-- COMMIT;  -- uncomment when verified
-- ROLLBACK;
