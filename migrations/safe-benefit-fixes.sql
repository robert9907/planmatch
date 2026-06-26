-- safe-benefit-fixes.sql
-- Generated 2026-06-25T21:45:13.791507Z
-- 
-- Field-level fixes confirmed safe in the 2026-06-25 spot-check
-- (see _tmp/cms-sync/out/benefit-diff.json + Claude session notes).
-- 
-- WHY THESE ARE SAFE
--   • partb_drugs.coinsurance — DB blanket-stamps the original-Medicare
--     20% coinsurance default; MA plans waive it (CMS PBP filed 0%).
--     Confirmed across all top-15 carriers, no false positives.
--   • insulin.coinsurance — same pattern; DB has the IRA $35 cap right
--     but adds 20% coinsurance on top, which CMS files as 0%.
--   • dental.max_coverage (DB NULL/0 only) — DB import skipped
--     b16c_maxplan_cmp_amt for ~half the catalog. Only filling NULLs/$0
--     here; rows with non-zero DB max values are LEFT ALONE because some
--     are real comprehensive caps that just disagree with CMS for valid
--     reasons (carrier marketed value vs structured PBP filing).
--   • hearing.copay (DB NULL/0 only) — same: gap-fill missing values,
--     never overwrite a real DB copay.
--   • vision.copay & vision.max_coverage (DB NULL/0 only) — same.
-- 
-- WHAT THIS DOES NOT DO
--   • Does not change DB values that disagree with CMS but are non-zero.
--     Spot-checking 5 NC carriers showed real cases where DB > 0 vs
--     CMS = 0 was DB being correct (carrier-rendered SBF value) and CMS
--     PBP being structurally undercounted.
--   • Does not change the 318 plan-level (pm_plans) values from pass-1.
-- 
-- DEPLOY ORDER:
--   1. Begin tx.
--   2. Run each section. Verify row counts match the summary line.
--   3. Sample SELECT 10 rows after, eyeball CMS-vs-new vs CMS reference.
--   4. Commit if clean; rollback if anything looks off.

BEGIN;

-- ──── H0111-001-000  Wellcare — Wellcare Simple Open (PPO) (GA)
-- H0111-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0111', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0111-001-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0111', '001', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;

-- H0111-001-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0111', '001', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H0111-004-000  Wellcare — Wellcare Dual Access Open (PPO D-SNP) (GA)
-- H0111-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0111', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0111-004-000  vision.max_coverage: CMS=600 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0111', '004', '000', 'vision', 600) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 600;


-- ──── H0111-007-000  Wellcare — Wellcare Patriot Giveback Open (PPO) (GA)
-- H0111-007-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0111', '007', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0111-007-000  dental.max_coverage: CMS=1000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0111', '007', '000', 'dental', 1000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 1000;

-- H0111-007-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0111', '007', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H1112-006-000  Wellcare — Wellcare Dual Access (HMO-POS D-SNP) (GA)
-- H1112-006-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1112', '006', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1112-006-000  dental.max_coverage: CMS=4000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '006', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H1112-006-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '006', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H1112-033-000  Wellcare — Wellcare Dual Liberty (HMO-POS D-SNP) (GA)
-- H1112-033-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1112', '033', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1112-033-000  dental.max_coverage: CMS=5000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '033', '000', 'dental', 5000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 5000;

-- H1112-033-000  vision.max_coverage: CMS=600 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '033', '000', 'vision', 600) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 600;


-- ──── H1112-034-000  Wellcare — Wellcare Patriot Simple (HMO-POS) (GA)
-- H1112-034-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1112', '034', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1112-034-000  dental.max_coverage: CMS=5000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '034', '000', 'dental', 5000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 5000;

-- H1112-034-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '034', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H1112-039-000  Wellcare — Wellcare Simple (HMO-POS) (GA)
-- H1112-039-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1112', '039', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1112-039-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '039', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H1112-042-000  Wellcare — Wellcare Giveback (HMO-POS) (GA)
-- H1112-042-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1112', '042', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1112-042-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '042', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H1112-043-000  Wellcare — Wellcare Assist (HMO-POS) (GA)
-- H1112-043-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1112', '043', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1112-043-000  dental.max_coverage: CMS=2000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '043', '000', 'dental', 2000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 2000;

-- H1112-043-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '043', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;

-- H1112-043-000  hearing.copay: CMS=15 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H1112', '043', '000', 'hearing', 15) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 15;


-- ──── H1112-046-000  Wellcare — Wellcare Dual Reserve (HMO-POS D-SNP) (GA)
-- H1112-046-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1112', '046', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1112-046-000  dental.max_coverage: CMS=3000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '046', '000', 'dental', 3000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 3000;

-- H1112-046-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '046', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H1112-046-000  hearing.copay: CMS=15 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H1112', '046', '000', 'hearing', 15) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 15;


-- ──── H1889-013-000  UnitedHealthcare — UHC Medicare Advantage GA-2 (PPO) (GA)
-- H1889-013-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1889', '013', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1889-013-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1889', '013', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1889-013-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1889', '013', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H1889-020-000  UnitedHealthcare — UHC Complete Care GA-3 (PPO C-SNP) (GA)
-- H1889-020-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1889', '020', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1889-020-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1889', '020', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1889-020-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1889', '020', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H1889-022-000  UnitedHealthcare — AARP Medicare Advantage Patriot No Rx GA-MA01 (PPO) (GA)
-- H1889-022-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1889', '022', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1889-022-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1889', '022', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1889-022-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1889', '022', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H1889-028-000  UnitedHealthcare — UHC Complete Care Support GA-9 (PPO C-SNP) (GA)
-- H1889-028-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1889', '028', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1889-028-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1889', '028', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1889-028-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1889', '028', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H2293-001-000  Aetna Medicare — Aetna Medicare Value Care (PPO) (GA)
-- H2293-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2293', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H2293-002-000  Aetna Medicare — Aetna Medicare Dual Extra Care (PPO D-SNP) (GA)
-- H2293-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2293', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H2293-009-000  Aetna Medicare — Aetna Medicare Eagle Plus (PPO) (GA)
-- H2293-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2293', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2293-009-000  dental.max_coverage: CMS=4000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2293', '009', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H2293-009-000  hearing.copay: CMS=35 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H2293', '009', '000', 'hearing', 35) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 35;


-- ──── H2293-021-000  Aetna Medicare — Aetna Medicare Dual Extra (PPO D-SNP) (GA)
-- H2293-021-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2293', '021', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H2293-031-000  Aetna Medicare — Aetna Medicare Elite (PPO) (GA)
-- H2293-031-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2293', '031', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2293-031-000  dental.max_coverage: CMS=1500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2293', '031', '000', 'dental', 1500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 1500;

-- H2293-031-000  hearing.copay: CMS=55 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H2293', '031', '000', 'hearing', 55) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 55;


-- ──── H3256-004-002  UnitedHealthcare — UHC Dual Complete GA-S2 (PPO D-SNP) (GA)
-- H3256-004-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3256', '004', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3256-004-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3256', '004', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3256-004-002  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3256', '004', '002', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H3256-005-002  UnitedHealthcare — UHC Dual Complete GA-S1 (PPO D-SNP) (GA)
-- H3256-005-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3256', '005', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3256-005-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3256', '005', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3256-005-002  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3256', '005', '002', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H3256-006-002  UnitedHealthcare — UHC Dual Complete GA-V1 (PPO D-SNP) (GA)
-- H3256-006-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3256', '006', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3256-006-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3256', '006', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3256-006-002  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3256', '006', '002', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H3288-034-000  Aetna Medicare — Aetna Medicare Eagle Plus (PPO) (GA)
-- H3288-034-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '034', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3288-034-000  dental.max_coverage: CMS=4000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3288', '034', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H3288-034-000  hearing.copay: CMS=50 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3288', '034', '000', 'hearing', 50) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 50;


-- ──── H4036-030-000  Anthem Blue Cross and Blue Shield — Anthem Medicare Advantage 2 (PPO) (GA)
-- H4036-030-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4036', '030', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4036-030-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H4036', '030', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H4036-040-000  Anthem Blue Cross and Blue Shield — Anthem Veteran (PPO) (GA)
-- H4036-040-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4036', '040', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4036-040-000  hearing.copay: CMS=50 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H4036', '040', '000', 'hearing', 50) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 50;


-- ──── H5141-026-000  Clover Health — Clover Health LiveHealthy (PPO) (GA)
-- H5141-026-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5141', '026', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5141-026-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5141', '026', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5141-045-000  Clover Health — Clover Health LiveHealthy Value (PPO) (GA)
-- H5141-045-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5141', '045', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5141-045-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5141', '045', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H5141-056-000  Clover Health — Clover Health Valor (PPO) (GA)
-- H5141-056-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5141', '056', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5141-056-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5141', '056', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;

-- H5141-056-000  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5141', '056', '000', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H5141-063-000  Clover Health — Clover Health LiveHealthy Giveback (PPO) (GA)
-- H5141-063-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5141', '063', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5141-063-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5141', '063', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H5216-154-000  Humana — HumanaChoice Giveback H5216-154 (PPO) (GA)
-- H5216-154-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '154', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-154-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '154', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5216-157-000  Humana — HumanaChoice H5216-157 (PPO) (GA)
-- H5216-157-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '157', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-157-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '157', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5216-207-000  Humana — HumanaChoice H5216-207 (PPO) (GA)
-- H5216-207-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '207', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-207-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '207', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5216-217-000  Humana — Humana USAA Honor Giveback (PPO) (GA)
-- H5216-217-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '217', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-217-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '217', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-217-000  hearing.copay: CMS=50 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5216', '217', '000', 'hearing', 50) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 50;


-- ──── H5216-242-000  Humana — Humana Together in Health (PPO I-SNP) (GA)
-- H5216-242-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '242', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-242-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '242', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5216-246-000  Humana — HumanaChoice - Diabetes and Heart (PPO C-SNP) (GA)
-- H5216-246-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '246', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-246-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '246', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5216-284-000  Humana — HumanaChoice H5216-284 (PPO) (GA)
-- H5216-284-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '284', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-284-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '284', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-284-000  hearing.copay: CMS=30 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5216', '284', '000', 'hearing', 30) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 30;


-- ──── H5216-286-000  Humana — Humana USAA Honor Giveback (PPO) (GA)
-- H5216-286-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '286', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-286-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '286', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5216-345-000  Humana — HumanaChoice Giveback H5216-345 (PPO) (GA)
-- H5216-345-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '345', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-345-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '345', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5216-421-000  Humana — HumanaChoice H5216-421 (PPO) (GA)
-- H5216-421-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '421', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-421-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '421', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-421-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5216', '421', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H5302-024-000  Aetna Medicare — Aetna Medicare Full Dual Care (HMO D-SNP) (GA)
-- H5302-024-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5302', '024', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5302-024-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5302', '024', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H5322-047-002  UnitedHealthcare — AARP Medicare Advantage from UHC GA-5 (HMO-POS) (GA)
-- H5322-047-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '047', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-047-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '047', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-047-002  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5322', '047', '002', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5322-049-002  UnitedHealthcare — UHC Dual Complete GA-S3 (HMO-POS D-SNP) (GA)
-- H5322-049-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '049', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-049-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '049', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-049-002  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5322', '049', '002', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H5322-050-002  UnitedHealthcare — UHC Dual Complete GA-D2 (HMO-POS D-SNP) (GA)
-- H5322-050-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '050', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-050-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '050', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-050-002  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5322', '050', '002', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H5422-011-000  Anthem Blue Cross and Blue Shield — Anthem Medicare Advantage (HMO-POS) (GA)
-- H5422-011-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5422', '011', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5422-011-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5422', '011', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;

-- H5422-011-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5422', '011', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H5422-013-000  Anthem Blue Cross and Blue Shield — Anthem Extra Help (HMO-POS) (GA)
-- H5422-013-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5422', '013', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5422-013-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5422', '013', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H5422-014-000  Anthem Blue Cross and Blue Shield — Anthem Veteran (HMO-POS) (GA)
-- H5422-014-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5422', '014', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5422-014-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5422', '014', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H5422-014-000  hearing.copay: CMS=35 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5422', '014', '000', 'hearing', 35) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 35;


-- ──── H5422-015-000  Anthem Blue Cross and Blue Shield — Anthem Kidney Care (HMO-POS C-SNP) (GA)
-- H5422-015-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5422', '015', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5422-015-000  vision.max_coverage: CMS=275 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5422', '015', '000', 'vision', 275) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 275;


-- ──── H5422-018-000  Anthem Blue Cross and Blue Shield — Anthem Dual Advantage (HMO D-SNP) (GA)
-- H5422-018-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5422', '018', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5422-018-000  vision.max_coverage: CMS=225 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5422', '018', '000', 'vision', 225) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 225;


-- ──── H5422-019-000  Anthem Blue Cross and Blue Shield — Anthem Full Dual Advantage (HMO D-SNP) (GA)
-- H5422-019-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5422', '019', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5422-019-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5422', '019', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5453-003-000  Devoted Health — DEVOTED CHOICE MA ONLY 003 GA (PPO) (GA)
-- H5453-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-003-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5453', '003', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;

-- H5453-003-000  hearing.copay: CMS=50 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5453', '003', '000', 'hearing', 50) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 50;


-- ──── H5453-004-000  Devoted Health — DEVOTED CHOICE 004 GA (PPO) (GA)
-- H5453-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-004-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '004', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-004-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5453', '004', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H5453-005-000  Devoted Health — DEVOTED CHOICE GIVEBACK 005 GA (PPO) (GA)
-- H5453-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-005-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '005', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-005-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5453', '005', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H5453-005-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5453', '005', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H5453-016-000  Devoted Health — DEVOTED C-SNP CHOICE PLUS 016 GA (PPO C-SNP) (GA)
-- H5453-016-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '016', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-016-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '016', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-016-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5453', '016', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5453-018-000  Devoted Health — DEVOTED C-SNP CHOICE PREMIUM 018 GA (PPO C-SNP) (GA)
-- H5453-018-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '018', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-018-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '018', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-018-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5453', '018', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H7617-093-000  Humana — HumanaChoice H7617-093 (PPO) (GA)
-- H7617-093-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '093', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-093-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '093', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-093-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H7617', '093', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H7617-094-000  Humana — HumanaChoice Giveback H7617-094 (PPO) (GA)
-- H7617-094-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '094', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-094-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '094', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H7617-096-000  Humana — Humana USAA Honor Giveback (PPO) (GA)
-- H7617-096-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '096', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-096-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '096', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H8093-001-000  Georgia Health Advantage — Georgia Health Advantage (HMO I-SNP) (GA)
-- H8093-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8093', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8093-001-000  vision.max_coverage: CMS=325 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8093', '001', '000', 'vision', 325) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 325;


-- ──── H8093-002-000  Georgia Health Advantage — Georgia Health Advantage Choice (HMO I-SNP) (GA)
-- H8093-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8093', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8093-002-000  vision.max_coverage: CMS=275 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8093', '002', '000', 'vision', 275) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 275;


-- ──── H8390-015-000  CareSource — CareSource Dual Advantage (HMO D-SNP) (GA)
-- H8390-015-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8390', '015', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8390-015-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8390', '015', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8390-015-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8390', '015', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H8390-017-000  CareSource — CareSource Dual Advantage Plus (HMO D-SNP) (GA)
-- H8390-017-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8390', '017', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8390-017-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8390', '017', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8390-017-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8390', '017', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── R0110-019-000  Humana — HumanaChoice R0110-019 (Regional PPO) (GA)
-- R0110-019-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R0110', '019', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R0110-019-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R0110', '019', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R0110-019-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('R0110', '019', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── R0110-020-000  Humana — Humana Full Access R0110-020 (Regional PPO) (GA)
-- R0110-020-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R0110', '020', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R0110-020-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R0110', '020', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── R2604-002-000  UnitedHealthcare — UHC Complete Care Support GS-1A (Regional PPO C-SNP) (GA)
-- R2604-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R2604', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R2604-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R2604', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R2604-002-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('R2604', '002', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── R2604-005-000  UnitedHealthcare — UHC Medicare Advantage Patriot No Rx GS-MA01 (Regional PPO) (GA)
-- R2604-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R2604', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R2604-005-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R2604', '005', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R2604-005-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('R2604', '005', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H1112-044-000  Wellcare — Wellcare Simple (HMO-POS) (GA)
-- H1112-044-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1112', '044', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1112-044-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '044', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5216-205-000  Humana — HumanaChoice SNP-DE H5216-205 (PPO D-SNP) (GA)
-- H5216-205-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '205', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-205-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '205', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5216-206-000  Humana — Humana Dual Select H5216-206 (PPO D-SNP) (GA)
-- H5216-206-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '206', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-206-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '206', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-206-000  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5216', '206', '000', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H5525-049-000  Humana — HumanaChoice H5525-049 (PPO) (GA)
-- H5525-049-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5525', '049', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5525-049-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5525', '049', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5525-049-000  hearing.copay: CMS=35 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5525', '049', '000', 'hearing', 35) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 35;


-- ──── H8145-069-000  Humana — Humana Gold Choice H8145-069 (PFFS) (GA)
-- H8145-069-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8145', '069', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8145-069-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8145', '069', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8145-069-000  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H8145', '069', '000', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H3288-042-000  Aetna Medicare — Aetna Medicare Enhanced (PPO) (GA)
-- H3288-042-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '042', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3288-042-000  dental.max_coverage: CMS=1750 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3288', '042', '000', 'dental', 1750) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 1750;

-- H3288-042-000  hearing.copay: CMS=35 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3288', '042', '000', 'hearing', 35) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 35;


-- ──── H3291-001-000  PruittHealth Premier — PruittHealth Premier (HMO I-SNP) (GA)
-- H3291-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3291', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3291-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3291', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3291-001-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3291', '001', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H3291-002-000  PruittHealth Premier — PruittHealth Premier D-SNP (HMO D-SNP) (GA)
-- H3291-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3291', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3291-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3291', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3291-002-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3291', '002', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H3291-003-000  PruittHealth Premier — PruittHealth Premier Advantage (HMO I-SNP) (GA)
-- H3291-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3291', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3291-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3291', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3291-003-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3291', '003', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H4141-003-000  Humana — Humana Gold Plus SNP-DE H4141-003 (HMO D-SNP) (GA)
-- H4141-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4141', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4141-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4141', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4141-003-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4141', '003', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H4141-017-005  Humana — Humana Gold Plus H4141-017 (HMO) (GA)
-- H4141-017-005  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4141', '017', '005', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4141-017-005  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4141', '017', '005', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4141-017-005  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4141', '017', '005', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4141-024-000  Humana — Humana Gold Plus SNP-DE H4141-024 (HMO D-SNP) (GA)
-- H4141-024-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4141', '024', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4141-024-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4141', '024', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4141-024-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4141', '024', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H4141-025-000  Humana — Humana Gold Plus SNP-DE H4141-025 (HMO D-SNP) (GA)
-- H4141-025-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4141', '025', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4141-025-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4141', '025', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4141-025-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4141', '025', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5216-203-002  Humana — HumanaChoice H5216-203 (PPO) (GA)
-- H5216-203-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '203', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-203-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '203', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H6672-003-000  Clear Spring Health — Clear Spring Health Balance+ Diabetes & Heart (HMO C-SNP) (GA)
-- H6672-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6672', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6672-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6672', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6672-003-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6672', '003', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;

-- H6672-003-000  hearing.copay: CMS=30 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H6672', '003', '000', 'hearing', 30) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 30;


-- ──── H6672-005-000  Clear Spring Health — Clear Spring Health BrightPath Advantage (HMO) (GA)
-- H6672-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6672', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6672-005-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6672', '005', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6672-005-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6672', '005', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H6672-005-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H6672', '005', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H9589-003-000  Clear Spring Health — Clear Spring Health BrightPath Advantage (PPO) (GA)
-- H9589-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9589', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9589-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9589', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9589-003-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9589', '003', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H2293-004-000  Aetna Medicare — Aetna Medicare Dual Care (PPO D-SNP) (GA)
-- H2293-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2293', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H2293-023-000  Aetna Medicare — Aetna Medicare Value Care (PPO) (GA)
-- H2293-023-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2293', '023', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2293-023-000  dental.max_coverage: CMS=2250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2293', '023', '000', 'dental', 2250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 2250;


-- ──── H2293-029-000  Aetna Medicare — Aetna Medicare Signature Care (PPO) (GA)
-- H2293-029-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2293', '029', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2293-029-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H2293', '029', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H2406-052-000  UnitedHealthcare — UHC Dual Complete GA-D001 (PPO D-SNP) (GA)
-- H2406-052-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2406', '052', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2406-052-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2406', '052', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2406-052-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2406', '052', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H3288-027-000  Aetna Medicare — Aetna Medicare Elite (PPO) (GA)
-- H3288-027-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '027', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3288-027-000  dental.max_coverage: CMS=2000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3288', '027', '000', 'dental', 2000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 2000;

-- H3288-027-000  hearing.copay: CMS=55 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3288', '027', '000', 'hearing', 55) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 55;


-- ──── H5216-466-000  Humana — HumanaChoice H5216-466 (PPO) (GA)
-- H5216-466-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '466', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-466-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '466', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H0439-002-000  HealthSpring — HealthSpring TotalCare (HMO D-SNP) (GA)
-- H0439-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-002-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0439', '002', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H0439-006-000  HealthSpring — HealthSpring Preferred Plus (HMO) (GA)
-- H0439-006-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '006', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-006-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '006', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-006-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0439', '006', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H0439-010-000  HealthSpring — HealthSpring Preferred (HMO) (GA)
-- H0439-010-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '010', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-010-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '010', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-010-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0439', '010', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H0439-012-000  HealthSpring — HealthSpring TotalCare Plus (HMO D-SNP) (GA)
-- H0439-012-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '012', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-012-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '012', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-012-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0439', '012', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H0439-018-000  HealthSpring — HealthSpring Preferred Savings (HMO) (GA)
-- H0439-018-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '018', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-018-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '018', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-018-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0439', '018', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H1112-038-000  Wellcare — Wellcare Simple (HMO-POS) (GA)
-- H1112-038-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1112', '038', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1112-038-000  dental.max_coverage: CMS=1000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '038', '000', 'dental', 1000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 1000;

-- H1112-038-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '038', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H1112-038-000  hearing.copay: CMS=15 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H1112', '038', '000', 'hearing', 15) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 15;


-- ──── H2293-033-000  Aetna Medicare — Aetna Medicare Value Plus (PPO) (GA)
-- H2293-033-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2293', '033', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5302-012-000  Aetna Medicare — Aetna Medicare Dual Extra Care (HMO D-SNP) (GA)
-- H5302-012-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5302', '012', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5302-012-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5302', '012', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5302-020-000  Aetna Medicare — Aetna Medicare Dual Care (HMO D-SNP) (GA)
-- H5302-020-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5302', '020', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5302-020-000  vision.max_coverage: CMS=175 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5302', '020', '000', 'vision', 175) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 175;


-- ──── H7849-145-000  HealthSpring — HealthSpring True Choice (PPO) (GA)
-- H7849-145-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7849', '145', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7849-145-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7849', '145', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7849-145-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7849', '145', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H0439-003-001  HealthSpring — HealthSpring Preferred GA (HMO) (GA)
-- H0439-003-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '003', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-003-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '003', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-003-001  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0439', '003', '001', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H0439-015-001  HealthSpring — HealthSpring Preferred (HMO) (GA)
-- H0439-015-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '015', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-015-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '015', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-015-001  vision.max_coverage: CMS=175 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0439', '015', '001', 'vision', 175) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 175;

-- H0439-015-001  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0439', '015', '001', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H0439-016-000  HealthSpring — HealthSpring Preferred Savings (HMO) (GA)
-- H0439-016-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '016', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-016-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '016', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-016-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0439', '016', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H0710-033-000  UnitedHealthcare — UHC Nursing Home Plan GA-F001 (PPO I-SNP) (GA)
-- H0710-033-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0710', '033', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0710-033-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0710', '033', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0710-033-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0710', '033', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H1170-011-000  Kaiser Permanente — Kaiser Permanente Dual Essential Plan 2 (HMO D-SNP) (GA)
-- H1170-011-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1170', '011', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1170-011-000  vision.max_coverage: CMS=575 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1170', '011', '000', 'vision', 575) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 575;


-- ──── H1170-012-000  Kaiser Permanente — Kaiser Permanente Senior Advantage Basic 2 (HMO) (GA)
-- H1170-012-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1170', '012', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1170-012-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1170', '012', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;

-- H1170-012-000  hearing.copay: CMS=30 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H1170', '012', '000', 'hearing', 30) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 30;


-- ──── H1170-014-000  Kaiser Permanente — Kaiser Permanente Senior Advantage Liberty (HMO) (GA)
-- H1170-014-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1170', '014', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1170-014-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1170', '014', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;

-- H1170-014-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H1170', '014', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H1170-017-000  Kaiser Permanente — Kaiser Permanente Sr Advantage Liberty Giveback (HMO) (GA)
-- H1170-017-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1170', '017', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1170-017-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1170', '017', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H4141-022-000  Humana — Humana Gold Plus Giveback H4141-022 (HMO) (GA)
-- H4141-022-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4141', '022', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4141-022-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4141', '022', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4141-022-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4141', '022', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H4141-023-000  Humana — Humana Gold Plus H4141-023 (HMO) (GA)
-- H4141-023-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4141', '023', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4141-023-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4141', '023', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4141-023-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4141', '023', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H5216-203-001  Humana — HumanaChoice H5216-203 (PPO) (GA)
-- H5216-203-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '203', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-203-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '203', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5216-280-001  Humana — HumanaChoice H5216-280 (PPO) (GA)
-- H5216-280-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '280', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-280-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '280', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H7617-092-000  Humana — HumanaChoice H7617-092 (PPO) (GA)
-- H7617-092-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '092', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-092-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '092', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H0439-003-002  HealthSpring — HealthSpring Preferred GA (HMO) (GA)
-- H0439-003-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '003', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-003-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '003', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-003-002  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0439', '003', '002', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H0439-011-000  HealthSpring — HealthSpring Preferred (HMO) (GA)
-- H0439-011-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '011', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-011-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '011', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-011-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0439', '011', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H0439-019-000  HealthSpring — HealthSpring Preferred Savings (HMO) (GA)
-- H0439-019-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '019', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-019-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '019', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-019-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0439', '019', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H4141-017-003  Humana — Humana Gold Plus H4141-017 (HMO) (GA)
-- H4141-017-003  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4141', '017', '003', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4141-017-003  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4141', '017', '003', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4141-017-003  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4141', '017', '003', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H5216-073-000  Humana — HumanaChoice H5216-073 (PPO) (GA)
-- H5216-073-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '073', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-073-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '073', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5453-001-000  Devoted Health — DEVOTED CHOICE 001 GA (PPO) (GA)
-- H5453-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-001-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5453', '001', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;

-- H5453-001-000  hearing.copay: CMS=30 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5453', '001', '000', 'hearing', 30) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 30;


-- ──── H5453-002-000  Devoted Health — DEVOTED CHOICE GIVEBACK 002 GA (PPO) (GA)
-- H5453-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-002-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5453', '002', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H5453-002-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5453', '002', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H5453-015-000  Devoted Health — DEVOTED C-SNP CHOICE PREMIUM 015 GA (PPO C-SNP) (GA)
-- H5453-015-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '015', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-015-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '015', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-015-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5453', '015', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5521-091-000  Aetna Medicare — Aetna Medicare Elite (PPO) (GA)
-- H5521-091-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5521', '091', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H1109-005-000  Aetna Medicare — Aetna Medicare Signature (HMO) (GA)
-- H1109-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1109', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1109-005-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1109', '005', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5302-022-000  Aetna Medicare — Aetna Medicare Signature Care (HMO) (GA)
-- H5302-022-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5302', '022', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5302-022-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5302', '022', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H0439-013-000  HealthSpring — HealthSpring Preferred (HMO) (GA)
-- H0439-013-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '013', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-013-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '013', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-013-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0439', '013', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H1608-028-000  Aetna Medicare — Aetna Medicare Enhanced (PPO) (GA)
-- H1608-028-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1608', '028', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1608-028-000  dental.max_coverage: CMS=1250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1608', '028', '000', 'dental', 1250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 1250;

-- H1608-028-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H1608', '028', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H5216-347-000  Humana — HumanaChoice H5216-347 (PPO) (GA)
-- H5216-347-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '347', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-347-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '347', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-347-000  hearing.copay: CMS=15 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5216', '347', '000', 'hearing', 15) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 15;


-- ──── H5453-010-000  Devoted Health — DEVOTED CHOICE 010 GA (PPO) (GA)
-- H5453-010-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '010', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-010-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '010', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-010-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5453', '010', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H5453-011-000  Devoted Health — DEVOTED CHOICE GIVEBACK 011 GA (PPO) (GA)
-- H5453-011-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '011', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-011-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '011', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-011-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5453', '011', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5453-017-000  Devoted Health — DEVOTED C-SNP CHOICE PREMIUM 017 GA (PPO C-SNP) (GA)
-- H5453-017-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '017', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-017-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5453', '017', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5453-017-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5453', '017', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H7617-095-000  Humana — HumanaChoice H7617-095 (PPO) (GA)
-- H7617-095-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '095', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-095-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '095', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H2293-010-000  Aetna Medicare — Aetna Medicare Elite Giveback (PPO) (GA)
-- H2293-010-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2293', '010', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H4513-030-000  HealthSpring — HealthSpring Preferred (HMO) (GA)
-- H4513-030-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '030', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-030-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '030', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-030-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '030', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H4513-033-000  HealthSpring — HealthSpring Courage (HMO) (GA)
-- H4513-033-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '033', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-033-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '033', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-033-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '033', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H4513-033-000  hearing.copay: CMS=30 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H4513', '033', '000', 'hearing', 30) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 30;


-- ──── H4513-068-003  HealthSpring — HealthSpring Preferred Savings (HMO) (GA)
-- H4513-068-003  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '068', '003', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-068-003  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '068', '003', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-068-003  vision.max_coverage: CMS=125 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '068', '003', 'vision', 125) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 125;


-- ──── H4513-079-000  HealthSpring — HealthSpring TotalCare Plus (HMO D-SNP) (GA)
-- H4513-079-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '079', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-079-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '079', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-079-000  vision.max_coverage: CMS=425 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '079', '000', 'vision', 425) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 425;


-- ──── H4513-080-000  HealthSpring — HealthSpring TotalCare (HMO D-SNP) (GA)
-- H4513-080-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '080', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-080-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '080', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-080-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '080', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H7849-153-000  HealthSpring — HealthSpring True Choice (PPO) (GA)
-- H7849-153-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7849', '153', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7849-153-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7849', '153', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7849-153-000  vision.max_coverage: CMS=175 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7849', '153', '000', 'vision', 175) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 175;


-- ──── H7917-039-000  BlueCross BlueShield of Tennessee — BlueAdvantage Freedom (PPO) (GA)
-- H7917-039-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7917', '039', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7917-039-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7917', '039', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7917-039-000  vision.max_coverage: CMS=225 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7917', '039', '000', 'vision', 225) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 225;


-- ──── H7917-040-000  BlueCross BlueShield of Tennessee — BlueAdvantage Sapphire (PPO) (GA)
-- H7917-040-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7917', '040', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7917-040-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7917', '040', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7917-040-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7917', '040', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H7917-041-000  BlueCross BlueShield of Tennessee — BlueAdvantage Extra (PPO) (GA)
-- H7917-041-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7917', '041', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7917-041-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7917', '041', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7917-041-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7917', '041', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H7917-044-000  BlueCross BlueShield of Tennessee — BlueAdvantage Total Heart and Diabetes (PPO C-SNP) (GA)
-- H7917-044-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7917', '044', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7917-044-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7917', '044', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7917-044-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7917', '044', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H0439-015-002  HealthSpring — HealthSpring Preferred (HMO) (GA)
-- H0439-015-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '015', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-015-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '015', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-015-002  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0439', '015', '002', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;

-- H0439-015-002  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0439', '015', '002', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H1170-002-000  Kaiser Permanente — Kaiser Permanente Senior Advantage Enhanced 1 (HMO) (GA)
-- H1170-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1170', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1170-002-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1170', '002', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;

-- H1170-002-000  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H1170', '002', '000', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H1170-008-000  Kaiser Permanente — Kaiser Permanente Dual Essential Plan 1 (HMO D-SNP) (GA)
-- H1170-008-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1170', '008', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1170-008-000  vision.max_coverage: CMS=575 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1170', '008', '000', 'vision', 575) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 575;


-- ──── H1170-009-000  Kaiser Permanente — Kaiser Permanente Senior Advantage Basic 1 (HMO) (GA)
-- H1170-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1170', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1170-009-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1170', '009', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;

-- H1170-009-000  hearing.copay: CMS=30 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H1170', '009', '000', 'hearing', 30) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 30;


-- ──── H1170-013-000  Kaiser Permanente — Kaiser Permanente Senior Advantage Care Plus (HMO-POS) (GA)
-- H1170-013-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1170', '013', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1170-013-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1170', '013', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;

-- H1170-013-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H1170', '013', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H1170-015-000  Kaiser Permanente — Kaiser Permanente Dual Complete (HMO D-SNP) (GA)
-- H1170-015-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1170', '015', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1170-015-000  vision.max_coverage: CMS=575 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1170', '015', '000', 'vision', 575) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 575;


-- ──── H1170-016-000  Kaiser Permanente — Kaiser Permanente Senior Advantage Standard (HMO) (GA)
-- H1170-016-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1170', '016', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1170-016-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1170', '016', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H3256-004-001  UnitedHealthcare — UHC Dual Complete GA-S2 (PPO D-SNP) (GA)
-- H3256-004-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3256', '004', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3256-004-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3256', '004', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3256-004-001  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3256', '004', '001', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H3256-005-001  UnitedHealthcare — UHC Dual Complete GA-S1 (PPO D-SNP) (GA)
-- H3256-005-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3256', '005', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3256-005-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3256', '005', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3256-005-001  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3256', '005', '001', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H3256-006-001  UnitedHealthcare — UHC Dual Complete GA-V1 (PPO D-SNP) (GA)
-- H3256-006-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3256', '006', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3256-006-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3256', '006', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3256-006-001  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3256', '006', '001', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H5322-047-001  UnitedHealthcare — AARP Medicare Advantage from UHC GA-5 (HMO-POS) (GA)
-- H5322-047-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '047', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-047-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '047', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-047-001  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5322', '047', '001', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5322-049-001  UnitedHealthcare — UHC Dual Complete GA-S3 (HMO-POS D-SNP) (GA)
-- H5322-049-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '049', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-049-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '049', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-049-001  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5322', '049', '001', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H5322-050-001  UnitedHealthcare — UHC Dual Complete GA-D2 (HMO-POS D-SNP) (GA)
-- H5322-050-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '050', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-050-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '050', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-050-001  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5322', '050', '001', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H5521-364-000  Aetna Medicare — Aetna Medicare Value Care (PPO) (GA)
-- H5521-364-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5521', '364', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5521-364-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5521', '364', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H5521-598-000  Aetna Medicare — Aetna Medicare Elite Care (PPO) (GA)
-- H5521-598-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5521', '598', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5521-598-000  hearing.copay: CMS=55 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5521', '598', '000', 'hearing', 55) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 55;


-- ──── H0439-009-000  HealthSpring — HealthSpring Preferred (HMO) (GA)
-- H0439-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-009-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '009', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-009-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0439', '009', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H0439-017-000  HealthSpring — HealthSpring Preferred Savings (HMO) (GA)
-- H0439-017-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '017', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-017-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '017', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-017-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0439', '017', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;

-- H0439-017-000  hearing.copay: CMS=30 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0439', '017', '000', 'hearing', 30) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 30;


-- ──── H5302-023-000  Aetna Medicare — Aetna Medicare Signature (HMO) (GA)
-- H5302-023-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5302', '023', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5302-023-000  vision.max_coverage: CMS=325 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5302', '023', '000', 'vision', 325) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 325;

-- H5302-023-000  hearing.copay: CMS=50 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5302', '023', '000', 'hearing', 50) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 50;


-- ──── H2293-035-000  Aetna Medicare — Aetna Medicare Chronic Care (PPO C-SNP) (GA)
-- H2293-035-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2293', '035', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2293-035-000  dental.max_coverage: CMS=1500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2293', '035', '000', 'dental', 1500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 1500;

-- H2293-035-000  hearing.copay: CMS=50 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H2293', '035', '000', 'hearing', 50) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 50;


-- ──── H4141-015-000  Humana — Humana Gold Plus H4141-015 (HMO) (GA)
-- H4141-015-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4141', '015', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4141-015-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4141', '015', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4141-015-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4141', '015', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H5302-026-000  Aetna Medicare — Aetna Medicare Chronic Care (HMO C-SNP) (GA)
-- H5302-026-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5302', '026', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5302-026-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5302', '026', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;

-- H5302-026-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5302', '026', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H0439-008-000  HealthSpring — HealthSpring Preferred (HMO) (GA)
-- H0439-008-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '008', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-008-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0439', '008', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0439-008-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0439', '008', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;

-- H0439-008-000  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0439', '008', '000', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H1112-047-000  Wellcare — Wellcare Dual Access (HMO-POS D-SNP) (GA)
-- H1112-047-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1112', '047', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1112-047-000  dental.max_coverage: CMS=4000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '047', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H1112-047-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '047', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H1112-048-000  Wellcare — Wellcare Dual Reserve (HMO-POS D-SNP) (GA)
-- H1112-048-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1112', '048', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1112-048-000  dental.max_coverage: CMS=3000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '048', '000', 'dental', 3000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 3000;

-- H1112-048-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '048', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H1112-049-000  Wellcare — Wellcare Simple (HMO-POS) (GA)
-- H1112-049-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1112', '049', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1112-049-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1112', '049', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H1608-109-000  Aetna Medicare — Aetna Medicare Elite (PPO) (GA)
-- H1608-109-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1608', '109', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1608-109-000  dental.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1608', '109', '000', 'dental', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;

-- H1608-109-000  hearing.copay: CMS=55 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H1608', '109', '000', 'hearing', 55) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 55;


-- ──── H0710-034-000  UnitedHealthcare — UHC Nursing Home Plan NC-F001 (PPO I-SNP) (NC)
-- H0710-034-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0710', '034', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0710-034-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0710', '034', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0710-034-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0710', '034', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H1036-167-000  Humana — Humana Gold Plus SNP-DE H1036-167 (HMO D-SNP) (NC)
-- H1036-167-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1036', '167', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1036-167-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1036', '167', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1036-167-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1036', '167', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H1036-307-000  Humana — Humana Dual Select H1036-307 (HMO D-SNP) (NC)
-- H1036-307-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1036', '307', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1036-307-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1036', '307', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1036-307-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1036', '307', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;

-- H1036-307-000  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H1036', '307', '000', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H1036-308-000  Humana — Humana Gold Plus - Diabetes and Heart (HMO C-SNP) (NC)
-- H1036-308-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1036', '308', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1036-308-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1036', '308', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1036-308-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1036', '308', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H1036-318-000  Humana — Humana Gold Plus Giveback H1036-318 (HMO-POS) (NC)
-- H1036-318-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1036', '318', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1036-318-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1036', '318', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1036-318-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1036', '318', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;

-- H1036-318-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H1036', '318', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H1036-331-000  Humana — Humana Gold Plus SNP-DE H1036-331 (HMO D-SNP) (NC)
-- H1036-331-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1036', '331', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1036-331-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1036', '331', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1036-331-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1036', '331', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H1036-335-002  Humana — Humana Gold Plus H1036-335 (HMO-POS) (NC)
-- H1036-335-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1036', '335', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1036-335-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1036', '335', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1036-335-002  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1036', '335', '002', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H1889-005-000  UnitedHealthcare — UHC Dual Complete NC-S001 (PPO D-SNP) (NC)
-- H1889-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1889', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1889-005-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1889', '005', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1889-005-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1889', '005', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H1889-034-000  UnitedHealthcare — UHC Dual Complete NC-S2 (PPO D-SNP) (NC)
-- H1889-034-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1889', '034', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1889-034-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1889', '034', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1889-034-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1889', '034', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H1914-007-000  Wellcare — Wellcare Simple Open (PPO) (NC)
-- H1914-007-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1914', '007', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1914-007-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1914', '007', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H1914-007-000  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H1914', '007', '000', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H1914-008-000  Wellcare — Wellcare Dual Liberty Open (PPO D-SNP) (NC)
-- H1914-008-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1914', '008', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1914-008-000  vision.max_coverage: CMS=600 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1914', '008', '000', 'vision', 600) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 600;


-- ──── H1914-009-000  Wellcare — Wellcare Assist Open (PPO) (NC)
-- H1914-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1914', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1914-009-000  dental.max_coverage: CMS=2000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1914', '009', '000', 'dental', 2000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 2000;

-- H1914-009-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1914', '009', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;

-- H1914-009-000  hearing.copay: CMS=15 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H1914', '009', '000', 'hearing', 15) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 15;


-- ──── H1914-010-000  Wellcare — Wellcare Giveback Open (PPO) (NC)
-- H1914-010-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1914', '010', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1914-010-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1914', '010', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H1914-011-000  Wellcare — Wellcare Patriot Giveback Open (PPO) (NC)
-- H1914-011-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1914', '011', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1914-011-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1914', '011', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H2001-084-000  UnitedHealthcare — AARP Medicare Advantage Access from UHC NC-23 (PPO) (NC)
-- H2001-084-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2001', '084', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2001-084-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2001', '084', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2001-084-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2001', '084', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H2406-034-000  UnitedHealthcare — AARP Medicare Advantage from UHC NC-0016 (PPO) (NC)
-- H2406-034-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2406', '034', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2406-034-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2406', '034', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2406-034-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2406', '034', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H2406-098-000  UnitedHealthcare — AARP Medicare Advantage from UHC NC-0017 (PPO) (NC)
-- H2406-098-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2406', '098', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2406-098-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2406', '098', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2406-098-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2406', '098', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H2624-001-000  HealthTeam Advantage — HealthTeam Advantage Diabetes & Heart Care (HMO C-SNP) (NC)
-- H2624-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2624', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2624-001-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2624', '001', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H3146-002-000  Aetna Medicare — Aetna Medicare Dual (HMO D-SNP) (NC)
-- H3146-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3146', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3146-002-000  vision.max_coverage: CMS=125 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3146', '002', '000', 'vision', 125) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 125;


-- ──── H3146-006-000  Aetna Medicare — Aetna Medicare Value Plus (HMO) (NC)
-- H3146-006-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3146', '006', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3146-006-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3146', '006', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H3146-021-000  Aetna Medicare — Aetna Medicare Signature Care (HMO) (NC)
-- H3146-021-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3146', '021', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3146-021-000  vision.max_coverage: CMS=125 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3146', '021', '000', 'vision', 125) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 125;


-- ──── H3146-022-000  Aetna Medicare — Aetna Medicare Full Dual Care (HMO D-SNP) (NC)
-- H3146-022-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3146', '022', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3146-022-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3146', '022', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H3146-039-000  Aetna Medicare — Aetna Medicare Enhanced (HMO) (NC)
-- H3146-039-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3146', '039', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3146-039-000  dental.max_coverage: CMS=1750 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3146', '039', '000', 'dental', 1750) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 1750;

-- H3146-039-000  vision.max_coverage: CMS=175 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3146', '039', '000', 'vision', 175) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 175;

-- H3146-039-000  hearing.copay: CMS=10 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3146', '039', '000', 'hearing', 10) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 10;


-- ──── H3404-003-001  Blue Cross and Blue Shield of North Carolina — Blue Medicare PPO Enhanced (PPO) (NC)
-- H3404-003-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3404', '003', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H3404-004-000  Blue Cross and Blue Shield of North Carolina — Blue Medicare Freedom+ (PPO) (NC)
-- H3404-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3404', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H3449-012-000  Blue Cross and Blue Shield of North Carolina — Blue Medicare Medical Only (HMO-POS) (NC)
-- H3449-012-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3449', '012', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3449-012-000  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3449', '012', '000', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H3449-023-001  Blue Cross and Blue Shield of North Carolina — Blue Medicare Essential Plus (HMO-POS) (NC)
-- H3449-023-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3449', '023', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3449-023-001  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3449', '023', '001', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H3449-024-001  Blue Cross and Blue Shield of North Carolina — Blue Medicare Enhanced (HMO-POS) (NC)
-- H3449-024-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3449', '024', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3449-024-001  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3449', '024', '001', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H3449-026-000  Blue Cross and Blue Shield of North Carolina — Blue Medicare Choice (HMO) (NC)
-- H3449-026-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3449', '026', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3449-026-000  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3449', '026', '000', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H3449-027-001  Blue Cross and Blue Shield of North Carolina — Blue Medicare Essential (HMO) (NC)
-- H3449-027-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3449', '027', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3449-027-001  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3449', '027', '001', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H4073-001-000  Wellcare — Wellcare Simple (HMO-POS) (NC)
-- H4073-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4073', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4073-001-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4073', '001', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H4073-002-000  Wellcare — Wellcare Dual Access (HMO-POS D-SNP) (NC)
-- H4073-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4073', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4073-002-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4073', '002', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H4073-003-000  Wellcare — Wellcare Dual Reserve (HMO-POS D-SNP) (NC)
-- H4073-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4073', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4073-003-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4073', '003', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;

-- H4073-003-000  hearing.copay: CMS=15 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H4073', '003', '000', 'hearing', 15) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 15;


-- ──── H4073-004-000  Wellcare — Wellcare Dual Liberty (HMO-POS D-SNP) (NC)
-- H4073-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4073', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4073-004-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4073', '004', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H4172-001-000  NHC Advantage — NHC Advantage (HMO I-SNP) (NC)
-- H4172-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4172', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4172-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4172', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4172-001-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4172', '001', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4172-003-000  NHC Advantage — Senior Care (HMO I-SNP) (NC)
-- H4172-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4172', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4172-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4172', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4172-003-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4172', '003', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H5216-017-000  Humana — HumanaChoice Giveback H5216-017 (PPO) (NC)
-- H5216-017-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '017', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-017-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '017', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5216-211-000  Humana — HumanaChoice H5216-211 (PPO) (NC)
-- H5216-211-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '211', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-211-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '211', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5216-343-000  Humana — Humana USAA Honor Giveback (PPO) (NC)
-- H5216-343-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '343', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-343-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '343', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-343-000  hearing.copay: CMS=35 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5216', '343', '000', 'hearing', 35) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 35;


-- ──── H5253-037-000  UnitedHealthcare — AARP Medicare Advantage from UHC NC-0021 (HMO-POS) (NC)
-- H5253-037-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '037', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-037-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '037', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-037-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5253', '037', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5253-038-000  UnitedHealthcare — AARP Medicare Advantage from UHC NC-0022 (HMO-POS) (NC)
-- H5253-038-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '038', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-038-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '038', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-038-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5253', '038', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5253-040-000  UnitedHealthcare — AARP Medicare Advantage Patriot No Rx NC-MA02 (HMO-POS) (NC)
-- H5253-040-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '040', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-040-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '040', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-040-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5253', '040', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H5253-041-000  UnitedHealthcare — UHC Dual Complete NC-D001 (HMO-POS D-SNP) (NC)
-- H5253-041-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '041', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-041-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '041', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-041-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5253', '041', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5253-110-000  UnitedHealthcare — AARP Medicare Advantage Giveback from UHC NC-14 (HMO-POS) (NC)
-- H5253-110-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '110', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-110-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '110', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5253-116-000  UnitedHealthcare — UHC Dual Complete NC-V001 (HMO-POS D-SNP) (NC)
-- H5253-116-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '116', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-116-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '116', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-116-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5253', '116', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5253-117-000  UnitedHealthcare — AARP Medicare Advantage from UHC NC-0015 (HMO-POS) (NC)
-- H5253-117-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '117', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-117-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '117', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-117-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5253', '117', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5253-184-000  UnitedHealthcare — UHC Dual Complete NC-S3 (HMO-POS D-SNP) (NC)
-- H5253-184-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '184', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-184-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '184', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-184-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5253', '184', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5253-189-000  UnitedHealthcare — UHC Complete Care NC-28 (HMO-POS C-SNP) (NC)
-- H5253-189-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '189', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-189-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '189', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-189-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5253', '189', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H5299-001-000  Devoted Health — DEVOTED CORE 001 NC (HMO) (NC)
-- H5299-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-001-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5299', '001', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5299-002-000  Devoted Health — DEVOTED GIVEBACK 002 NC (HMO) (NC)
-- H5299-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-002-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5299', '002', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5299-006-000  Devoted Health — DEVOTED DUAL PLUS 006 NC (HMO D-SNP) (NC)
-- H5299-006-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '006', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-006-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '006', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-006-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5299', '006', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H5299-009-000  Devoted Health — DEVOTED DUAL 009 NC (HMO D-SNP) (NC)
-- H5299-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-009-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '009', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-009-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5299', '009', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;

-- H5299-009-000  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5299', '009', '000', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H5299-013-000  Devoted Health — DEVOTED DUAL FULL 013 NC (HMO D-SNP) (NC)
-- H5299-013-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '013', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-013-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '013', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-013-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5299', '013', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H5299-015-000  Devoted Health — DEVOTED C-SNP PLUS 015 NC (HMO C-SNP) (NC)
-- H5299-015-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '015', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-015-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '015', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-015-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5299', '015', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5299-017-000  Devoted Health — DEVOTED C-SNP PREMIUM 017 NC (HMO C-SNP) (NC)
-- H5299-017-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '017', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-017-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '017', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-017-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5299', '017', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5374-001-000  Longevity Health Plan — Longevity Health Plan (HMO I-SNP) (NC)
-- H5374-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5374', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5374-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5374', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5374-001-000  vision.max_coverage: CMS=360 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5374', '001', '000', 'vision', 360) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 360;


-- ──── H5521-081-000  Aetna Medicare — Aetna Medicare Signature (PPO) (NC)
-- H5521-081-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5521', '081', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5521-170-000  Aetna Medicare — Aetna Medicare Signature Extra (PPO) (NC)
-- H5521-170-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5521', '170', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5521-170-000  hearing.copay: CMS=30 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5521', '170', '000', 'hearing', 30) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 30;


-- ──── H5521-241-000  Aetna Medicare — Aetna Medicare Eagle Giveback (PPO) (NC)
-- H5521-241-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5521', '241', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5521-348-000  Aetna Medicare — Aetna Medicare Signature Giveback (PPO) (NC)
-- H5521-348-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5521', '348', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5525-035-000  Humana — HumanaChoice Giveback H5525-035 (PPO) (NC)
-- H5525-035-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5525', '035', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5525-035-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5525', '035', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5525-036-000  Humana — HumanaChoice SNP-DE H5525-036 (PPO D-SNP) (NC)
-- H5525-036-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5525', '036', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5525-036-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5525', '036', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5525-050-000  Humana — HumanaChoice H5525-050 (PPO) (NC)
-- H5525-050-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5525', '050', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5525-050-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5525', '050', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5525-050-000  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5525', '050', '000', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H5525-065-000  Humana — Humana USAA Honor Giveback (PPO) (NC)
-- H5525-065-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5525', '065', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5525-065-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5525', '065', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5525-070-000  Humana — HumanaChoice H5525-070 (PPO) (NC)
-- H5525-070-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5525', '070', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5525-070-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5525', '070', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5525-072-000  Humana — Humana Dual Select H5525-072 (PPO D-SNP) (NC)
-- H5525-072-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5525', '072', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5525-072-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5525', '072', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5525-083-000  Humana — HumanaChoice H5525-083 (PPO) (NC)
-- H5525-083-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5525', '083', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5525-083-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5525', '083', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5525-083-000  hearing.copay: CMS=35 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5525', '083', '000', 'hearing', 35) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 35;


-- ──── H6351-001-000  Liberty Medicare Advantage — Liberty Medicare Advantage Nursing Home Plan (HMO I-SNP) (NC)
-- H6351-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6351', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6351-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6351', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6351-001-000  vision.max_coverage: CMS=450 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6351', '001', '000', 'vision', 450) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 450;


-- ──── H6351-004-000  Liberty Medicare Advantage — Liberty Medicare Advantage (HMO C-SNP) (NC)
-- H6351-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6351', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6351-004-000  vision.max_coverage: CMS=3000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6351', '004', '000', 'vision', 3000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 3000;


-- ──── H6351-005-000  Liberty Medicare Advantage — Liberty Medicare Dual Plan (HMO D-SNP) (NC)
-- H6351-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6351', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6351-005-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6351', '005', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6351-005-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6351', '005', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H7849-113-004  HealthSpring — HealthSpring True Choice (PPO) (NC)
-- H7849-113-004  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7849', '113', '004', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7849-113-004  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7849', '113', '004', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7849-113-004  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7849', '113', '004', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H9147-001-000  Blue Cross and Blue Shield of North Carolina — Healthy Blue + Medicare (HMO-POS D-SNP) (NC)
-- H9147-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9147', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H9700-003-000  Devoted Health — DEVOTED CHOICE 003 NC (PPO) (NC)
-- H9700-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9700', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9700-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9700', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9700-003-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9700', '003', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H9700-004-000  Devoted Health — DEVOTED CHOICE GIVEBACK 004 NC (PPO) (NC)
-- H9700-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9700', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9700-004-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9700', '004', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9700-004-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9700', '004', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H9700-004-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H9700', '004', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H9700-007-000  Devoted Health — DEVOTED CHOICE MA ONLY 007 NC (PPO) (NC)
-- H9700-007-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9700', '007', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9700-007-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9700', '007', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9700-007-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9700', '007', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;

-- H9700-007-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H9700', '007', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H9725-003-000  HealthSpring — HealthSpring TotalCare (HMO D-SNP) (NC)
-- H9725-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-003-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9725', '003', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H9725-005-000  HealthSpring — HealthSpring Courage (HMO) (NC)
-- H9725-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-005-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '005', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-005-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9725', '005', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;

-- H9725-005-000  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H9725', '005', '000', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H9725-009-004  HealthSpring — HealthSpring Preferred (HMO) (NC)
-- H9725-009-004  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '009', '004', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-009-004  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '009', '004', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-009-004  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9725', '009', '004', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H9725-013-000  HealthSpring — HealthSpring TotalCare Plus (HMO D-SNP) (NC)
-- H9725-013-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '013', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-013-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '013', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-013-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9725', '013', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H9725-014-000  HealthSpring — HealthSpring Preferred Select (HMO) (NC)
-- H9725-014-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '014', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-014-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '014', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-014-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9725', '014', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H9725-015-004  HealthSpring — HealthSpring Preferred Savings (HMO) (NC)
-- H9725-015-004  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '015', '004', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-015-004  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '015', '004', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-015-004  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9725', '015', '004', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H9725-017-004  HealthSpring — HealthSpring Preferred Plus (HMO) (NC)
-- H9725-017-004  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '017', '004', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-017-004  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '017', '004', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-017-004  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9725', '017', '004', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H9725-017-004  hearing.copay: CMS=15 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H9725', '017', '004', 'hearing', 15) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 15;


-- ──── H9808-004-000  HealthTeam Advantage — HealthTeam Advantage Plan I (PPO) (NC)
-- H9808-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9808', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9808-004-000  vision.max_coverage: CMS=125 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9808', '004', '000', 'vision', 125) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 125;


-- ──── H9808-005-000  HealthTeam Advantage — HealthTeam Advantage Plan II (PPO) (NC)
-- H9808-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9808', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9808-005-000  vision.max_coverage: CMS=125 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9808', '005', '000', 'vision', 125) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 125;


-- ──── H9808-009-000  HealthTeam Advantage — HealthTeam Advantage Eagle Plan (PPO) (NC)
-- H9808-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9808', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9808-009-000  vision.max_coverage: CMS=125 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9808', '009', '000', 'vision', 125) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 125;


-- ──── H9808-010-000  HealthTeam Advantage — HealthTeam Advantage Vitality Plan (PPO) (NC)
-- H9808-010-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9808', '010', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9808-010-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9808', '010', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── R0110-004-000  Humana — HumanaChoice R0110-004 (Regional PPO) (NC)
-- R0110-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R0110', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R0110-004-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R0110', '004', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R0110-004-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('R0110', '004', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── R0110-005-000  Humana — Humana Full Access R0110-005 (Regional PPO) (NC)
-- R0110-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R0110', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R0110-005-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R0110', '005', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R0110-005-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('R0110', '005', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── R0110-006-000  Humana — Humana USAA Honor Giveback (Regional PPO) (NC)
-- R0110-006-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R0110', '006', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R0110-006-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R0110', '006', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H1036-137-000  Humana — Humana Gold Plus H1036-137 (HMO-POS) (NC)
-- H1036-137-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1036', '137', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1036-137-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1036', '137', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1036-137-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1036', '137', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H3146-007-000  Aetna Medicare — Aetna Medicare Prime (HMO) (NC)
-- H3146-007-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3146', '007', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3146-007-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3146', '007', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;

-- H3146-007-000  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3146', '007', '000', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H3404-003-002  Blue Cross and Blue Shield of North Carolina — Blue Medicare PPO Enhanced (PPO) (NC)
-- H3404-003-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3404', '003', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H3449-023-002  Blue Cross and Blue Shield of North Carolina — Blue Medicare Essential Plus (HMO-POS) (NC)
-- H3449-023-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3449', '023', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3449-023-002  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3449', '023', '002', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H3449-024-002  Blue Cross and Blue Shield of North Carolina — Blue Medicare Enhanced (HMO-POS) (NC)
-- H3449-024-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3449', '024', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3449-024-002  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3449', '024', '002', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H3449-027-002  Blue Cross and Blue Shield of North Carolina — Blue Medicare Essential (HMO) (NC)
-- H3449-027-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3449', '027', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3449-027-002  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3449', '027', '002', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H4676-001-000  Troy Medicare — Troy Medicare (HMO) (NC)
-- H4676-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4676', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H4676-002-000  Troy Medicare — Troy Medicare for Dual-eligible Beneficiaries (HMO D-SNP) (NC)
-- H4676-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4676', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4676-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4676', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5299-012-000  Devoted Health — DEVOTED GIVEBACK 012 NC (HMO) (NC)
-- H5299-012-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '012', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-012-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '012', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-012-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5299', '012', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5299-016-000  Devoted Health — DEVOTED C-SNP PREMIUM 016 NC (HMO C-SNP) (NC)
-- H5299-016-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '016', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-016-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '016', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-016-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5299', '016', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H6622-057-000  Humana — Humana Gold Plus H6622-057 (HMO-POS) (NC)
-- H6622-057-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6622', '057', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6622-057-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6622', '057', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6622-057-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6622', '057', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H7849-113-001  HealthSpring — HealthSpring True Choice (PPO) (NC)
-- H7849-113-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7849', '113', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7849-113-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7849', '113', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7849-113-001  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7849', '113', '001', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H9700-001-000  Devoted Health — DEVOTED CHOICE 001 NC (PPO) (NC)
-- H9700-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9700', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9700-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9700', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9700-001-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9700', '001', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H9700-002-000  Devoted Health — DEVOTED CHOICE GIVEBACK 002 NC (PPO) (NC)
-- H9700-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9700', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9700-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9700', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9700-002-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9700', '002', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H9725-009-001  HealthSpring — HealthSpring Preferred (HMO) (NC)
-- H9725-009-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '009', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-009-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '009', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-009-001  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9725', '009', '001', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H9725-015-001  HealthSpring — HealthSpring Preferred Savings (HMO) (NC)
-- H9725-015-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '015', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-015-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '015', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-015-001  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9725', '015', '001', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H9725-017-001  HealthSpring — HealthSpring Preferred Plus (HMO) (NC)
-- H9725-017-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '017', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-017-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '017', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-017-001  vision.max_coverage: CMS=225 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9725', '017', '001', 'vision', 225) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 225;

-- H9725-017-001  hearing.copay: CMS=15 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H9725', '017', '001', 'hearing', 15) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 15;


-- ──── H2001-103-000  UnitedHealthcare — AARP Medicare Advantage Patriot No Rx NC-MA01 (PPO) (NC)
-- H2001-103-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2001', '103', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2001-103-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2001', '103', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2001-103-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2001', '103', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H3449-023-005  Blue Cross and Blue Shield of North Carolina — Blue Medicare Essential Plus (HMO-POS) (NC)
-- H3449-023-005  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3449', '023', '005', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3449-023-005  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3449', '023', '005', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H3449-024-003  Blue Cross and Blue Shield of North Carolina — Blue Medicare Enhanced (HMO-POS) (NC)
-- H3449-024-003  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3449', '024', '003', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3449-024-003  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3449', '024', '003', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H5253-185-000  UnitedHealthcare — AARP Medicare Advantage from UHC NC-24 (HMO-POS) (NC)
-- H5253-185-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '185', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-185-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '185', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-185-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5253', '185', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H5253-186-000  UnitedHealthcare — UHC Complete Care NC-25 (HMO-POS C-SNP) (NC)
-- H5253-186-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '186', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-186-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '186', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-186-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5253', '186', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H5299-014-000  Devoted Health — DEVOTED C-SNP PREMIUM 014 NC (HMO C-SNP) (NC)
-- H5299-014-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '014', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-014-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '014', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-014-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5299', '014', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5521-139-000  Aetna Medicare — Aetna Medicare Enhanced (PPO) (NC)
-- H5521-139-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5521', '139', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5521-139-000  hearing.copay: CMS=35 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5521', '139', '000', 'hearing', 35) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 35;


-- ──── H6622-025-000  Humana — Humana Gold Plus H6622-025 (HMO-POS) (NC)
-- H6622-025-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6622', '025', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6622-025-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6622', '025', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6622-025-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6622', '025', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H6622-026-000  Humana — Humana Gold Plus H6622-026 (HMO-POS) (NC)
-- H6622-026-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6622', '026', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6622-026-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6622', '026', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6622-026-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6622', '026', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H7849-113-003  HealthSpring — HealthSpring True Choice (PPO) (NC)
-- H7849-113-003  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7849', '113', '003', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7849-113-003  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7849', '113', '003', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7849-113-003  vision.max_coverage: CMS=175 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7849', '113', '003', 'vision', 175) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 175;


-- ──── H9700-008-000  Devoted Health — DEVOTED CHOICE 008 NC (PPO) (NC)
-- H9700-008-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9700', '008', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9700-008-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9700', '008', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9700-008-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9700', '008', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H9700-009-000  Devoted Health — DEVOTED CHOICE GIVEBACK 009 NC (PPO) (NC)
-- H9700-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9700', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9700-009-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9700', '009', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9700-009-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9700', '009', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H9700-009-000  hearing.copay: CMS=55 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H9700', '009', '000', 'hearing', 55) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 55;


-- ──── H9725-009-003  HealthSpring — HealthSpring Preferred (HMO) (NC)
-- H9725-009-003  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '009', '003', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-009-003  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '009', '003', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-009-003  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9725', '009', '003', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H9725-015-003  HealthSpring — HealthSpring Preferred Savings (HMO) (NC)
-- H9725-015-003  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '015', '003', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-015-003  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '015', '003', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-015-003  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9725', '015', '003', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H9725-017-003  HealthSpring — HealthSpring Preferred Plus (HMO) (NC)
-- H9725-017-003  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '017', '003', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-017-003  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '017', '003', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-017-003  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9725', '017', '003', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;

-- H9725-017-003  hearing.copay: CMS=15 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H9725', '017', '003', 'hearing', 15) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 15;


-- ──── H2001-090-000  UnitedHealthcare — AARP Medicare Advantage from UHC NC-0001 (PPO) (NC)
-- H2001-090-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2001', '090', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2001-090-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2001', '090', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2001-090-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2001', '090', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H2001-102-000  UnitedHealthcare — AARP Medicare Advantage from UHC NC-0004 (PPO) (NC)
-- H2001-102-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2001', '102', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2001-102-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2001', '102', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2001-102-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2001', '102', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H3146-001-000  Aetna Medicare — Aetna Medicare Signature (HMO) (NC)
-- H3146-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3146', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3146-001-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3146', '001', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H3449-023-004  Blue Cross and Blue Shield of North Carolina — Blue Medicare Essential Plus (HMO-POS) (NC)
-- H3449-023-004  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3449', '023', '004', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3449-023-004  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3449', '023', '004', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H8145-004-000  Humana — Humana Gold Choice H8145-004 (PFFS) (NC)
-- H8145-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8145', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8145-004-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8145', '004', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5253-079-000  UnitedHealthcare — AARP Medicare Advantage from UHC NC-0008 (HMO-POS) (NC)
-- H5253-079-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '079', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-079-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '079', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-079-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5253', '079', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5253-080-000  UnitedHealthcare — AARP Medicare Advantage from UHC NC-0009 (HMO-POS) (NC)
-- H5253-080-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '080', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-080-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '080', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-080-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5253', '080', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5253-105-000  UnitedHealthcare — AARP Medicare Advantage Giveback from UHC NC-13 (HMO-POS) (NC)
-- H5253-105-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '105', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-105-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '105', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5296-003-000  Alignment Health Plan — Alignment Health Platinum (HMO) (NC)
-- H5296-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5296', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5296-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5296', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5296-003-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5296', '003', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5296-004-000  Alignment Health Plan — Alignment Health NC Duals (HMO-POS D-SNP) (NC)
-- H5296-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5296', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5296-004-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5296', '004', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5296-004-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5296', '004', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H5296-006-000  Alignment Health Plan — Alignment Health smartHMO (HMO) (NC)
-- H5296-006-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5296', '006', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5296-006-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5296', '006', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5296-006-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5296', '006', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H5296-009-000  Alignment Health Plan — Alignment Health Heart & Diabetes NCPlus (HMO-POS C-SNP) (NC)
-- H5296-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5296', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5296-009-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5296', '009', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5296-009-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5296', '009', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H5296-010-000  Alignment Health Plan — Alignment Health Platinum Select (HMO) (NC)
-- H5296-010-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5296', '010', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5296-010-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5296', '010', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5296-010-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5296', '010', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5296-011-000  Alignment Health Plan — Alignment Health Heart & Diabetes Care (HMO C-SNP) (NC)
-- H5296-011-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5296', '011', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5296-011-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5296', '011', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5296-011-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5296', '011', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5299-018-000  Devoted Health — DEVOTED C-SNP PREMIUM 018 NC (HMO C-SNP) (NC)
-- H5299-018-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '018', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-018-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5299', '018', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5299-018-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5299', '018', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5521-236-000  Aetna Medicare — Aetna Medicare Signature (PPO) (NC)
-- H5521-236-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5521', '236', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5521-236-000  hearing.copay: CMS=50 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5521', '236', '000', 'hearing', 50) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 50;


-- ──── H7074-001-000  Alignment Health Plan — Alignment Health AVA (PPO) (NC)
-- H7074-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7074', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7074-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7074', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7074-001-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7074', '001', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H7849-113-002  HealthSpring — HealthSpring True Choice (PPO) (NC)
-- H7849-113-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7849', '113', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7849-113-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7849', '113', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7849-113-002  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7849', '113', '002', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H9700-005-000  Devoted Health — DEVOTED CHOICE 005 NC (PPO) (NC)
-- H9700-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9700', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9700-005-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9700', '005', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9700-005-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9700', '005', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H9700-006-000  Devoted Health — DEVOTED CHOICE GIVEBACK 006 NC (PPO) (NC)
-- H9700-006-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9700', '006', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9700-006-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9700', '006', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9700-006-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9700', '006', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H9725-009-002  HealthSpring — HealthSpring Preferred (HMO) (NC)
-- H9725-009-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '009', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-009-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '009', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-009-002  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9725', '009', '002', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H9725-015-002  HealthSpring — HealthSpring Preferred Savings (HMO) (NC)
-- H9725-015-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '015', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-015-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '015', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-015-002  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9725', '015', '002', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H9725-017-002  HealthSpring — HealthSpring Preferred Plus (HMO) (NC)
-- H9725-017-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '017', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-017-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9725', '017', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9725-017-002  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9725', '017', '002', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H9725-017-002  hearing.copay: CMS=15 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H9725', '017', '002', 'hearing', 15) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 15;


-- ──── H5253-187-000  UnitedHealthcare — AARP Medicare Advantage from UHC NC-26 (HMO-POS) (NC)
-- H5253-187-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '187', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-187-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '187', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-187-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5253', '187', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5253-188-000  UnitedHealthcare — UHC Complete Care NC-27 (HMO-POS C-SNP) (NC)
-- H5253-188-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '188', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-188-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '188', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-188-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5253', '188', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5521-243-000  Aetna Medicare — Aetna Medicare Signature (PPO) (NC)
-- H5521-243-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5521', '243', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5521-243-000  hearing.copay: CMS=50 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5521', '243', '000', 'hearing', 50) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 50;


-- ──── H5521-169-000  Aetna Medicare — Aetna Medicare Enhanced (PPO) (NC)
-- H5521-169-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5521', '169', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5525-034-000  Humana — Humana Full Access H5525-034 (PPO) (NC)
-- H5525-034-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5525', '034', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5525-034-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5525', '034', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H6622-061-000  Humana — Humana Gold Plus H6622-061 (HMO-POS) (NC)
-- H6622-061-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6622', '061', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6622-061-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6622', '061', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6622-061-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6622', '061', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H1036-335-001  Humana — Humana Gold Plus H1036-335 (HMO-POS) (NC)
-- H1036-335-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1036', '335', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1036-335-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1036', '335', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1036-335-001  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1036', '335', '001', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H6622-027-000  Humana — Humana Dual Select H6622-027 (HMO-POS D-SNP) (NC)
-- H6622-027-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6622', '027', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6622-027-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6622', '027', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6622-027-000  vision.max_coverage: CMS=450 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6622', '027', '000', 'vision', 450) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 450;

-- H6622-027-000  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H6622', '027', '000', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H8212-001-000  AmeriHealth Caritas VIP Care — AmeriHealth Caritas VIP Care (HMO D-SNP) (NC)
-- H8212-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8212', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8212-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8212', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8212-001-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8212', '001', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H3146-037-000  Aetna Medicare — Aetna Medicare Chronic Care (HMO C-SNP) (NC)
-- H3146-037-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3146', '037', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3146-037-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3146', '037', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H3146-044-000  Aetna Medicare — Aetna Medicare Chronic Care Value (HMO C-SNP) (NC)
-- H3146-044-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3146', '044', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3146-044-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3146', '044', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H4439-001-000  Provider Partners Health Plans — Provider Partners North Carolina Advantage Plan (HMO I-SNP) (NC)
-- H4439-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4439', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4439-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4439', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4439-001-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4439', '001', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4439-002-000  Provider Partners Health Plans — Provider Partners North Carolina Community Plan (HMO I-SNP) (NC)
-- H4439-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4439', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4439-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4439', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4439-002-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4439', '002', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4439-003-000  Provider Partners Health Plans — Provider Partners North Carolina Essential Plan (HMO I-SNP) (NC)
-- H4439-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4439', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4439-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4439', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4439-003-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4439', '003', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H6345-001-000  PruittHealth Premier — PruittHealth Premier (HMO I-SNP) (NC)
-- H6345-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6345', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6345-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6345', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6345-001-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6345', '001', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H6622-060-000  Humana — Humana Gold Plus H6622-060 (HMO-POS) (NC)
-- H6622-060-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6622', '060', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6622-060-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6622', '060', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6622-060-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6622', '060', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;

-- H6622-060-000  hearing.copay: CMS=35 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H6622', '060', '000', 'hearing', 35) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 35;


-- ──── H2406-115-000  UnitedHealthcare — AARP Medicare Advantage from UHC NC-0019 (PPO) (NC)
-- H2406-115-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2406', '115', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2406-115-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2406', '115', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2406-115-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2406', '115', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H3146-004-000  Aetna Medicare — Aetna Medicare Signature (HMO) (NC)
-- H3146-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3146', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3146-004-000  vision.max_coverage: CMS=125 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3146', '004', '000', 'vision', 125) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 125;

-- H3146-004-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3146', '004', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H3777-002-000  Experience Health — Experience Health Medicare Advantage (HMO) (NC)
-- H3777-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3777', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3777-002-000  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3777', '002', '000', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H5253-039-000  UnitedHealthcare — AARP Medicare Advantage from UHC NC-0007 (HMO-POS) (NC)
-- H5253-039-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '039', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-039-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '039', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-039-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5253', '039', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5521-609-000  Aetna Medicare — Aetna Medicare Signature (PPO) (NC)
-- H5521-609-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5521', '609', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5521-609-000  hearing.copay: CMS=55 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5521', '609', '000', 'hearing', 55) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 55;


-- ──── H5253-103-000  UnitedHealthcare — AARP Medicare Advantage from UHC NC-0011 (HMO-POS) (NC)
-- H5253-103-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '103', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-103-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '103', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-103-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5253', '103', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H5253-104-000  UnitedHealthcare — AARP Medicare Advantage from UHC NC-0012 (HMO-POS) (NC)
-- H5253-104-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '104', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-104-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5253', '104', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5253-104-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5253', '104', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5652-001-000  UnitedHealthcare — Erickson Advantage Signature (HMO-POS) (NC)
-- H5652-001-000  partb_drugs.coinsurance: CMS=0 DB=15  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5652', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5652-001-000  insulin.coinsurance: CMS=0 DB=15  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5652', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5652-001-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5652', '001', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H5652-002-000  UnitedHealthcare — Erickson Advantage Liberty no Rx (HMO-POS) (NC)
-- H5652-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5652', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5652-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5652', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5652-002-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5652', '002', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H5652-003-000  UnitedHealthcare — Erickson Advantage Guardian (HMO-POS I-SNP) (NC)
-- H5652-003-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5652', '003', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H5652-004-000  UnitedHealthcare — Erickson Advantage Champion (HMO-POS C-SNP) (NC)
-- H5652-004-000  partb_drugs.coinsurance: CMS=0 DB=15  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5652', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5652-004-000  insulin.coinsurance: CMS=0 DB=15  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5652', '004', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5652-004-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5652', '004', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H5652-006-000  UnitedHealthcare — Erickson Advantage Freedom (HMO-POS) (NC)
-- H5652-006-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5652', '006', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5652-006-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5652', '006', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5652-006-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5652', '006', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H5652-008-000  UnitedHealthcare — Erickson Advantage Liberty (HMO-POS) (NC)
-- H5652-008-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5652', '008', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5652-008-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5652', '008', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5652-008-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5652', '008', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H1036-233-000  Humana — Humana Gold Plus H1036-233 (HMO-POS) (NC)
-- H1036-233-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1036', '233', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1036-233-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1036', '233', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1036-233-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1036', '233', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H0028-032-000  Humana — Humana Gold Plus SNP-DE H0028-032 (HMO D-SNP) (TX)
-- H0028-032-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '032', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-032-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '032', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-032-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0028', '032', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H0028-041-000  Humana — Humana Gold Plus H0028-041 (HMO) (TX)
-- H0028-041-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '041', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-041-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '041', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-041-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0028', '041', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H0609-060-000  UnitedHealthcare — AARP Medicare Advantage Essentials from UHC TX-26 (HMO-POS) (TX)
-- H0609-060-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '060', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-060-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '060', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-060-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '060', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H0609-068-000  UnitedHealthcare — AARP Medicare Advantage Giveback from UHC TX-41 (HMO-POS) (TX)
-- H0609-068-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '068', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-068-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '068', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-068-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '068', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H0609-080-000  UnitedHealthcare — AARP Medicare Advantage Extras from UHC TX-48 (HMO-POS) (TX)
-- H0609-080-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '080', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-080-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '080', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-080-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '080', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H1189-003-000  CHRISTUS Health Advantage — CHRISTUS Health Medicare Complete (HMO) (TX)
-- H1189-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1189', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1189-003-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1189', '003', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H1189-004-000  CHRISTUS Health Advantage — CHRISTUS Health Medicare Plus (HMO) (TX)
-- H1189-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1189', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1189-004-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1189', '004', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H1189-008-000  CHRISTUS Health Advantage — CHRISTUS Health Medicare Guardian (HMO) (TX)
-- H1189-008-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1189', '008', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1189-008-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1189', '008', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H1278-015-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-0007 (PPO) (TX)
-- H1278-015-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '015', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-015-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '015', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-015-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1278', '015', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H2293-014-000  Aetna Medicare — Aetna Medicare Signature Extra (PPO) (TX)
-- H2293-014-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2293', '014', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H3288-008-000  Aetna Medicare — Aetna Medicare Signature (PPO) (TX)
-- H3288-008-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '008', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H4054-001-000  Provider Partners Health Plans — Provider Partners Texas Advantage Plan (HMO I-SNP) (TX)
-- H4054-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4054', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4054-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4054', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4054-001-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4054', '001', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H4461-055-000  Humana — Humana Gold Plus H4461-055 (HMO) (TX)
-- H4461-055-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '055', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-055-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '055', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-055-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '055', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H4461-068-000  Humana — Humana Gold Plus - Diabetes and Heart (HMO C-SNP) (TX)
-- H4461-068-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '068', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-068-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '068', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-068-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '068', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H4461-071-000  Humana — Humana Gold Plus SNP-DE H4461-071 (HMO D-SNP) (TX)
-- H4461-071-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '071', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-071-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '071', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-071-000  vision.max_coverage: CMS=450 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '071', '000', 'vision', 450) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 450;


-- ──── H4461-072-000  Humana — Humana Gold Plus SNP-DE H4461-072 (HMO D-SNP) (TX)
-- H4461-072-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '072', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-072-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '072', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-072-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '072', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4514-021-000  UnitedHealthcare — UHC Dual Complete TX-S003 (HMO-POS D-SNP) (TX)
-- H4514-021-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '021', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-021-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '021', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-021-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4514', '021', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5216-042-000  Humana — HumanaChoice H5216-042 (PPO) (TX)
-- H5216-042-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '042', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-042-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '042', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5216-043-005  Humana — HumanaChoice H5216-043 (PPO) (TX)
-- H5216-043-005  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '043', '005', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-043-005  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '043', '005', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5216-128-000  Humana — Humana USAA Honor Giveback (PPO) (TX)
-- H5216-128-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '128', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-128-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '128', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5216-348-000  Humana — Humana USAA Honor Giveback (PPO) (TX)
-- H5216-348-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '348', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-348-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '348', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5216-358-000  Humana — Humana Essentials Plus Giveback H5216-358 (PPO) (TX)
-- H5216-358-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '358', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-358-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '358', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5216-369-000  Humana — Humana Together in Health (PPO I-SNP) (TX)
-- H5216-369-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '369', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-369-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '369', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5322-025-000  UnitedHealthcare — UHC Dual Complete TX-D007 (HMO-POS D-SNP) (TX)
-- H5322-025-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '025', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-025-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '025', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-025-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5322', '025', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5322-038-000  UnitedHealthcare — UHC Dual Complete TX-V010 (HMO-POS D-SNP) (TX)
-- H5322-038-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '038', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-038-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '038', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-038-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5322', '038', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H6891-001-000  American Health Advantage of Texas — American Health Advantage of Texas (HMO I-SNP) (TX)
-- H6891-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6891', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6891-001-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6891', '001', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H7617-035-000  Humana — Humana Essentials Plus Giveback H7617-035 (PPO) (TX)
-- H7617-035-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '035', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-035-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '035', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H7617-062-000  Humana — Humana USAA Honor Giveback (PPO) (TX)
-- H7617-062-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '062', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-062-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '062', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H7678-006-002  Molina Healthcare of Texas, Inc. — Molina Medicare Complete Care (HMO D-SNP) (TX)
-- H7678-006-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7678', '006', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7678-006-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7678', '006', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7678-006-002  dental.max_coverage: CMS=3600 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7678', '006', '002', 'dental', 3600) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 3600;

-- H7678-006-002  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7678', '006', '002', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H8634-023-000  Blue Cross and Blue Shield of IL, NM, OK, TX — Blue Cross Medicare Advantage Complete (PPO) (TX)
-- H8634-023-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8634', '023', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8634-023-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8634', '023', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H8634-024-000  Blue Cross and Blue Shield of IL, NM, OK, TX — Blue Cross Medicare Advantage Dental Premier (PPO) (TX)
-- H8634-024-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8634', '024', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8634-024-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8634', '024', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H8634-025-000  Blue Cross and Blue Shield of IL, NM, OK, TX — Blue Cross Medicare Advantage Health Choice (PPO) (TX)
-- H8634-025-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8634', '025', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8634-025-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8634', '025', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8634-025-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H8634', '025', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H8634-026-000  Blue Cross and Blue Shield of IL, NM, OK, TX — Blue Cross Medicare Advantage Protect (PPO) (TX)
-- H8634-026-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8634', '026', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8634-026-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8634', '026', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H8849-010-002  Wellpoint — Wellpoint Full Dual Advantage (HMO D-SNP) (TX)
-- H8849-010-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8849', '010', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8849-010-002  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8849', '010', '002', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H8849-011-002  Wellpoint — Wellpoint Dual Advantage (HMO D-SNP) (TX)
-- H8849-011-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8849', '011', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8849-011-002  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8849', '011', '002', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H9706-001-000  Blue Cross and Blue Shield of Texas — Blue Cross Medicare Advantage Value (HMO) (TX)
-- H9706-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9706', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9706-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9706', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9706-001-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9706', '001', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H9706-002-000  Blue Cross and Blue Shield of Texas — Blue Cross Medicare Advantage Dual Care Plus (HMO D-SNP) (TX)
-- H9706-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9706', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9706-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9706', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9706-002-000  dental.max_coverage: CMS=4000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9706', '002', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H9706-002-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9706', '002', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H9706-007-000  Blue Cross and Blue Shield of Texas — Blue Cross Medicare Advantage Dental Value (HMO) (TX)
-- H9706-007-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9706', '007', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9706-007-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9706', '007', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9706-007-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9706', '007', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;

-- H9706-007-000  hearing.copay: CMS=35 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H9706', '007', '000', 'hearing', 35) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 35;


-- ──── R4182-001-000  Humana — HumanaChoice R4182-001 (Regional PPO) (TX)
-- R4182-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R4182', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R4182-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R4182', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── R4182-003-000  Humana — HumanaChoice R4182-003 (Regional PPO) (TX)
-- R4182-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R4182', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R4182-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R4182', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── R4182-004-000  Humana — HumanaChoice R4182-004 (Regional PPO) (TX)
-- R4182-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R4182', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R4182-004-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R4182', '004', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R4182-004-000  hearing.copay: CMS=50 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('R4182', '004', '000', 'hearing', 50) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 50;


-- ──── R6801-008-000  UnitedHealthcare — UHC Complete Care Support TX-1A (Regional PPO C-SNP) (TX)
-- R6801-008-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R6801', '008', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R6801-008-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R6801', '008', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── R6801-009-000  UnitedHealthcare — UHC Complete Care TX-29 (Regional PPO C-SNP) (TX)
-- R6801-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R6801', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R6801-009-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R6801', '009', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── R6801-011-000  UnitedHealthcare — UHC Dual Complete TX-S001 (Regional PPO D-SNP) (TX)
-- R6801-011-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R6801', '011', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R6801-011-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R6801', '011', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── R6801-012-000  UnitedHealthcare — UHC Medicare Advantage TX-0030 (Regional PPO) (TX)
-- R6801-012-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R6801', '012', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- R6801-012-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('R6801', '012', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H0174-004-000  Wellcare — Wellcare Dual Access (HMO D-SNP) (TX)
-- H0174-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0174', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0174-004-000  dental.max_coverage: CMS=3000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '004', '000', 'dental', 3000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 3000;

-- H0174-004-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '004', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H0174-022-000  Wellcare — Wellcare Dual Reserve (HMO D-SNP) (TX)
-- H0174-022-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0174', '022', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0174-022-000  dental.max_coverage: CMS=3000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '022', '000', 'dental', 3000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 3000;

-- H0174-022-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '022', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H0174-026-000  Wellcare — Wellcare Dual Liberty Sync (HMO D-SNP) (TX)
-- H0174-026-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0174', '026', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0174-026-000  dental.max_coverage: CMS=4000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '026', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H0174-026-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '026', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H0473-004-000  Humana — HumanaChoice H0473-004 (PPO) (TX)
-- H0473-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0473', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0473-004-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0473', '004', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0473-004-000  hearing.copay: CMS=35 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0473', '004', '000', 'hearing', 35) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 35;


-- ──── H1278-003-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-0001 (PPO) (TX)
-- H1278-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-003-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1278', '003', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H1278-024-000  UnitedHealthcare — AARP Medicare Advantage Giveback from UHC TX-34 (PPO) (TX)
-- H1278-024-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '024', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-024-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '024', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H2593-046-000  Wellpoint — Wellpoint Full Dual Advantage Aligned (HMO D-SNP) (TX)
-- H2593-046-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2593', '046', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2593-046-000  vision.max_coverage: CMS=375 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2593', '046', '000', 'vision', 375) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 375;


-- ──── H4506-030-000  Wellcare — Wellcare Simple Value (HMO-POS) (TX)
-- H4506-030-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4506', '030', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4506-030-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4506', '030', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H5322-046-000  UnitedHealthcare — UHC Dual Complete TX-S5 (HMO-POS D-SNP) (TX)
-- H5322-046-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '046', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-046-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '046', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-046-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5322', '046', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H7617-027-000  Humana — HumanaChoice H7617-027 (PPO) (TX)
-- H7617-027-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '027', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-027-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '027', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H8634-033-000  Blue Cross and Blue Shield of IL, NM, OK, TX — Blue Cross Medicare Advantage Preferred (PPO) (TX)
-- H8634-033-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8634', '033', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8634-033-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8634', '033', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8634-033-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H8634', '033', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H9706-005-000  Blue Cross and Blue Shield of Texas — Blue Cross Medicare Advantage Secure (HMO) (TX)
-- H9706-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9706', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9706-005-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9706', '005', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9706-005-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9706', '005', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H4513-009-000  HealthSpring — HealthSpring Courage (HMO) (TX)
-- H4513-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-009-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '009', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-009-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '009', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;

-- H4513-009-000  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H4513', '009', '000', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H4513-060-001  HealthSpring — HealthSpring TotalCare (HMO D-SNP) (TX)
-- H4513-060-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '060', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-060-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '060', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-060-001  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '060', '001', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H4513-061-001  HealthSpring — HealthSpring Preferred (HMO) (TX)
-- H4513-061-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '061', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-061-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '061', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-061-001  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '061', '001', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4513-083-001  HealthSpring — HealthSpring Preferred Savings (HMO) (TX)
-- H4513-083-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '083', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-083-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '083', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-083-001  vision.max_coverage: CMS=275 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '083', '001', 'vision', 275) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 275;


-- ──── H4513-091-000  HealthSpring — HealthSpring Preferred Full Savings (HMO) (TX)
-- H4513-091-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '091', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-091-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '091', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-091-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '091', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H7849-154-000  HealthSpring — HealthSpring True Choice (PPO) (TX)
-- H7849-154-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7849', '154', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7849-154-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7849', '154', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7849-154-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7849', '154', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;

-- H7849-154-000  hearing.copay: CMS=30 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H7849', '154', '000', 'hearing', 30) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 30;


-- ──── H8849-010-001  Wellpoint — Wellpoint Full Dual Advantage (HMO D-SNP) (TX)
-- H8849-010-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8849', '010', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8849-010-001  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8849', '010', '001', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H8849-011-001  Wellpoint — Wellpoint Dual Advantage (HMO D-SNP) (TX)
-- H8849-011-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8849', '011', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8849-011-001  vision.max_coverage: CMS=125 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8849', '011', '001', 'vision', 125) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 125;


-- ──── H0028-029-000  Humana — Humana Gold Plus H0028-029 (HMO) (TX)
-- H0028-029-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '029', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-029-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '029', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-029-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0028', '029', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H0028-036-000  Humana — Humana Gold Plus SNP-DE H0028-036 (HMO D-SNP) (TX)
-- H0028-036-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '036', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-036-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '036', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-036-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0028', '036', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H0028-039-000  Humana — Humana Gold Plus - Diabetes and Heart (HMO C-SNP) (TX)
-- H0028-039-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '039', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-039-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '039', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-039-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0028', '039', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;

-- H0028-039-000  hearing.copay: CMS=10 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0028', '039', '000', 'hearing', 10) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 10;


-- ──── H0028-070-000  Humana — Humana Gold Plus H0028-070 (HMO) (TX)
-- H0028-070-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '070', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-070-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '070', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-070-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0028', '070', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;

-- H0028-070-000  hearing.copay: CMS=15 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0028', '070', '000', 'hearing', 15) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 15;


-- ──── H0609-052-000  UnitedHealthcare — UHC Dual Complete TX-D004 (HMO-POS D-SNP) (TX)
-- H0609-052-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '052', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-052-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '052', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-052-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '052', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H1189-005-000  CHRISTUS Health Advantage — CHRISTUS Health Medicare Plus (HMO) (TX)
-- H1189-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1189', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1189-005-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1189', '005', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;

-- H1189-005-000  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H1189', '005', '000', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H1278-016-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-0008 (PPO) (TX)
-- H1278-016-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '016', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-016-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '016', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-016-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1278', '016', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H1278-027-000  UnitedHealthcare — AARP Medicare Advantage Patriot No Rx TX-MA05 (PPO) (TX)
-- H1278-027-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '027', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-027-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '027', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H2593-045-000  Wellpoint — Wellpoint Full Dual Advantage Aligned (HMO D-SNP) (TX)
-- H2593-045-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2593', '045', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2593-045-000  vision.max_coverage: CMS=450 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2593', '045', '000', 'vision', 450) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 450;


-- ──── H3288-005-000  Aetna Medicare — Aetna Medicare Signature (PPO) (TX)
-- H3288-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H4461-053-000  Humana — Humana Gold Plus H4461-053 (HMO) (TX)
-- H4461-053-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '053', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-053-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '053', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-053-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '053', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H4461-060-000  Humana — Humana Gold Plus H4461-060 (HMO) (TX)
-- H4461-060-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '060', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-060-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '060', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-060-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '060', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;

-- H4461-060-000  hearing.copay: CMS=15 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H4461', '060', '000', 'hearing', 15) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 15;


-- ──── H4461-066-000  Humana — Humana Gold Plus - Diabetes and Heart (HMO C-SNP) (TX)
-- H4461-066-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '066', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-066-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '066', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-066-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '066', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;

-- H4461-066-000  hearing.copay: CMS=10 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H4461', '066', '000', 'hearing', 10) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 10;


-- ──── H4461-069-000  Humana — Humana Gold Plus SNP-DE H4461-069 (HMO D-SNP) (TX)
-- H4461-069-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '069', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-069-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '069', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-069-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '069', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4461-070-000  Humana — Humana Gold Plus SNP-DE H4461-070 (HMO D-SNP) (TX)
-- H4461-070-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '070', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-070-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '070', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-070-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '070', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4513-074-000  HealthSpring — HealthSpring Preferred (HMO) (TX)
-- H4513-074-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '074', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-074-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '074', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-074-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '074', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H4513-075-000  HealthSpring — HealthSpring TotalCare (HMO D-SNP) (TX)
-- H4513-075-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '075', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-075-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '075', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-075-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '075', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H4513-083-007  HealthSpring — HealthSpring Preferred Savings (HMO) (TX)
-- H4513-083-007  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '083', '007', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-083-007  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '083', '007', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-083-007  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '083', '007', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H4523-034-000  Aetna Medicare — Aetna Medicare Full Dual Care (HMO D-SNP) (TX)
-- H4523-034-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4523', '034', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4523-034-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4523', '034', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H4523-041-000  Aetna Medicare — Aetna Medicare Partial Dual Care (HMO D-SNP) (TX)
-- H4523-041-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4523', '041', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4523-041-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4523', '041', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4527-001-000  UnitedHealthcare — AARP Medicare Advantage Essentials from UHC TX-11 (HMO-POS) (TX)
-- H4527-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-001-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '001', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H4527-003-000  UnitedHealthcare — UHC Dual Complete TX-V002 (HMO-POS D-SNP) (TX)
-- H4527-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-003-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '003', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H4527-024-000  UnitedHealthcare — AARP Medicare Advantage Patriot No Rx TX-MA01 (HMO-POS) (TX)
-- H4527-024-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '024', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-024-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '024', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-024-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '024', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H4527-041-000  UnitedHealthcare — UHC Complete Care TX-18 (HMO-POS C-SNP) (TX)
-- H4527-041-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '041', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-041-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '041', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-041-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '041', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H4527-048-000  UnitedHealthcare — AARP Medicare Advantage Giveback from UHC TX-35 (HMO-POS) (TX)
-- H4527-048-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '048', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-048-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '048', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-048-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '048', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H4527-054-000  UnitedHealthcare — UHC Dual Complete TX-S4 (HMO-POS D-SNP) (TX)
-- H4527-054-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '054', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-054-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '054', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-054-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '054', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H4527-056-000  UnitedHealthcare — AARP Medicare Advantage Extras from UHC TX-52 (HMO-POS) (TX)
-- H4527-056-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '056', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-056-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '056', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-056-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '056', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H4527-057-000  UnitedHealthcare — UHC Dual Complete TX-Q2 (HMO-POS D-SNP) (TX)
-- H4527-057-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '057', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-057-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '057', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-057-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '057', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5015-001-000  Texas Independence Health Plan — Texas Independence Health Plan, Inc. (HMO I-SNP) (TX)
-- H5015-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5015', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5015-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5015', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5015-001-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5015', '001', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H5015-002-000  Texas Independence Health Plan — Texas Independence Community Plan (HMO I-SNP) (TX)
-- H5015-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5015', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5015-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5015', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5015-002-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5015', '002', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H5216-043-001  Humana — HumanaChoice H5216-043 (PPO) (TX)
-- H5216-043-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '043', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-043-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '043', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5216-360-000  Humana — HumanaChoice H5216-360 (PPO) (TX)
-- H5216-360-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '360', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-360-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '360', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5294-010-000  Wellcare — Wellcare Dual Liberty (HMO D-SNP) (TX)
-- H5294-010-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5294', '010', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5294-010-000  dental.max_coverage: CMS=5000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '010', '000', 'dental', 5000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 5000;

-- H5294-010-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '010', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H5294-015-000  Wellcare — Wellcare Dual Access (HMO D-SNP) (TX)
-- H5294-015-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5294', '015', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5294-015-000  dental.max_coverage: CMS=3000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '015', '000', 'dental', 3000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 3000;

-- H5294-015-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '015', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H5294-022-000  Wellcare — Wellcare Dual Liberty Sync (HMO D-SNP) (TX)
-- H5294-022-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5294', '022', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5294-022-000  dental.max_coverage: CMS=4000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '022', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H5294-022-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '022', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H7617-040-000  Humana — HumanaChoice H7617-040 (PPO) (TX)
-- H7617-040-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '040', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-040-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '040', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H7617-059-000  Humana — HumanaChoice H7617-059 (PPO) (TX)
-- H7617-059-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '059', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-059-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '059', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H8597-001-000  Aetna Medicare — Aetna Medicare Dual Care (HMO D-SNP) (TX)
-- H8597-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8597', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8597-001-000  vision.max_coverage: CMS=275 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8597', '001', '000', 'vision', 275) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 275;


-- ──── H9706-008-000  Blue Cross and Blue Shield of Texas — Blue Cross Medicare Advantage Saver (HMO) (TX)
-- H9706-008-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9706', '008', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9706-008-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9706', '008', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H0473-005-000  Humana — HumanaChoice H0473-005 (PPO) (TX)
-- H0473-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0473', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0473-005-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0473', '005', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H2593-029-000  Wellpoint — Wellpoint Medicare Advantage 2 (HMO-POS) (TX)
-- H2593-029-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2593', '029', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2593-029-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2593', '029', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H2593-032-000  Wellpoint — Wellpoint Dual Advantage 2 (HMO D-SNP) (TX)
-- H2593-032-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2593', '032', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2593-032-000  vision.max_coverage: CMS=175 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2593', '032', '000', 'vision', 175) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 175;


-- ──── H2593-043-000  Wellpoint — Wellpoint Kidney Care (HMO-POS C-SNP) (TX)
-- H2593-043-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2593', '043', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2593-043-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2593', '043', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;

-- H2593-043-000  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H2593', '043', '000', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H4527-045-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-0020 (HMO-POS) (TX)
-- H4527-045-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '045', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-045-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '045', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-045-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '045', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H5294-014-000  Wellcare — Wellcare Patriot Simple (HMO) (TX)
-- H5294-014-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5294', '014', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5294-014-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '014', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;

-- H5294-014-000  hearing.copay: CMS=10 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5294', '014', '000', 'hearing', 10) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 10;


-- ──── H5294-016-000  Wellcare — Wellcare Assist (HMO) (TX)
-- H5294-016-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5294', '016', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5294-016-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '016', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;

-- H5294-016-000  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5294', '016', '000', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H5294-018-000  Wellcare — Wellcare Simple (HMO) (TX)
-- H5294-018-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5294', '018', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5294-018-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '018', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5294-019-000  Wellcare — Wellcare Giveback (HMO) (TX)
-- H5294-019-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5294', '019', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5294-019-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '019', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;

-- H5294-019-000  hearing.copay: CMS=50 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5294', '019', '000', 'hearing', 50) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 50;


-- ──── H5294-025-000  Wellcare — Wellcare Dual Liberty Sync (HMO D-SNP) (TX)
-- H5294-025-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5294', '025', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5294-025-000  dental.max_coverage: CMS=4000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '025', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H5294-025-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '025', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H0028-030-000  Humana — Humana Gold Plus H0028-030 (HMO) (TX)
-- H0028-030-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '030', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-030-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '030', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-030-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0028', '030', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H0609-050-000  UnitedHealthcare — AARP Medicare Advantage Essentials from UHC TX-21 (HMO-POS) (TX)
-- H0609-050-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '050', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-050-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '050', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-050-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '050', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H0609-056-000  UnitedHealthcare — AARP Medicare Advantage Patriot No Rx TX-MA03 (HMO-POS) (TX)
-- H0609-056-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '056', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-056-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '056', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H0609-058-000  UnitedHealthcare — UHC Complete Care TX-24 (HMO-POS C-SNP) (TX)
-- H0609-058-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '058', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-058-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '058', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-058-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '058', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H0609-063-000  UnitedHealthcare — AARP Medicare Advantage Extras from UHC TX-28 (HMO-POS) (TX)
-- H0609-063-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '063', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-063-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '063', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-063-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '063', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H0609-065-000  UnitedHealthcare — UHC Dual Complete TX-V007 (HMO-POS D-SNP) (TX)
-- H0609-065-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '065', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-065-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '065', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-065-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '065', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H0609-067-000  UnitedHealthcare — AARP Medicare Advantage Giveback from UHC TX-40 (HMO-POS) (TX)
-- H0609-067-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '067', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-067-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '067', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-067-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '067', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H0609-071-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-0043 (HMO-POS) (TX)
-- H0609-071-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '071', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-071-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '071', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-071-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '071', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H0609-078-000  UnitedHealthcare — AARP Medicare Advantage CareFlex from UHC TX-45 (HMO-POS) (TX)
-- H0609-078-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '078', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-078-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '078', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-078-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '078', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;

-- H0609-078-000  hearing.copay: CMS=30 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0609', '078', '000', 'hearing', 30) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 30;


-- ──── H1278-005-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-0003 (PPO) (TX)
-- H1278-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-005-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '005', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-005-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1278', '005', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H1278-026-000  UnitedHealthcare — AARP Medicare Advantage Patriot No Rx TX-MA04 (PPO) (TX)
-- H1278-026-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '026', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-026-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '026', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H1666-008-000  Blue Cross and Blue Shield of NM, TX — Blue Cross Medicare Advantage Choice Plus (PPO) (TX)
-- H1666-008-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1666', '008', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1666-008-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1666', '008', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H1666-023-000  Blue Cross and Blue Shield of NM, TX — Blue Cross Medicare Advantage Balance (PPO) (TX)
-- H1666-023-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1666', '023', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1666-023-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1666', '023', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H1666-024-000  Blue Cross and Blue Shield of NM, TX — Blue Cross Medicare Advantage Optimum (PPO) (TX)
-- H1666-024-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1666', '024', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1666-024-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1666', '024', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1666-024-000  dental.max_coverage: CMS=750 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1666', '024', '000', 'dental', 750) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 750;

-- H1666-024-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H1666', '024', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H2293-019-000  Aetna Medicare — Aetna Medicare Signature (PPO) (TX)
-- H2293-019-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2293', '019', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2293-019-000  dental.max_coverage: CMS=1500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2293', '019', '000', 'dental', 1500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 1500;


-- ──── H2593-051-000  Wellpoint — Wellpoint Full Dual Advantage 2 (HMO D-SNP) (TX)
-- H2593-051-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2593', '051', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2593-051-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2593', '051', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H3288-046-000  Aetna Medicare — Aetna Medicare Signature (PPO) (TX)
-- H3288-046-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '046', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3288-046-000  hearing.copay: CMS=70 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3288', '046', '000', 'hearing', 70) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 70;


-- ──── H3288-048-000  Aetna Medicare — Aetna Medicare Value Plus (PPO) (TX)
-- H3288-048-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '048', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H3288-051-000  Aetna Medicare — Aetna Medicare Eagle (PPO) (TX)
-- H3288-051-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '051', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3288-051-000  dental.max_coverage: CMS=1500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3288', '051', '000', 'dental', 1500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 1500;

-- H3288-051-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3288', '051', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H3467-001-000  ProCare Advantage — ProCare Advantage (HMO-POS I-SNP) (TX)
-- H3467-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3467', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3467-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3467', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3467-001-000  vision.max_coverage: CMS=775 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3467', '001', '000', 'vision', 775) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 775;


-- ──── H4461-058-000  Humana — Humana Gold Plus H4461-058 (HMO) (TX)
-- H4461-058-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '058', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-058-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '058', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-058-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '058', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;

-- H4461-058-000  hearing.copay: CMS=15 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H4461', '058', '000', 'hearing', 15) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 15;


-- ──── H4513-060-004  HealthSpring — HealthSpring TotalCare (HMO D-SNP) (TX)
-- H4513-060-004  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '060', '004', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-060-004  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '060', '004', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-060-004  vision.max_coverage: CMS=275 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '060', '004', 'vision', 275) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 275;


-- ──── H4513-061-004  HealthSpring — HealthSpring Preferred (HMO) (TX)
-- H4513-061-004  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '061', '004', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-061-004  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '061', '004', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-061-004  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '061', '004', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4513-083-004  HealthSpring — HealthSpring Preferred Savings (HMO) (TX)
-- H4513-083-004  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '083', '004', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-083-004  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '083', '004', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-083-004  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '083', '004', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H4523-001-000  Aetna Medicare — Aetna Medicare Signature Extra (HMO) (TX)
-- H4523-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4523', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4523-001-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4523', '001', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H5141-025-000  Clover Health — Clover Health Choice (PPO) (TX)
-- H5141-025-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5141', '025', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5141-025-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5141', '025', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5141-062-000  Clover Health — Clover Health Valor (PPO) (TX)
-- H5141-062-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5141', '062', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5141-062-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5141', '062', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H5141-062-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5141', '062', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H5216-351-000  Humana — Humana USAA Honor Giveback with Rx (PPO) (TX)
-- H5216-351-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '351', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-351-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '351', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5294-017-000  Wellcare — Wellcare Simple (HMO) (TX)
-- H5294-017-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5294', '017', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5294-017-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '017', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5447-002-000  Community First — Community First Medicare Advantage D-SNP (HMO D-SNP) (TX)
-- H5447-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5447', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5447-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5447', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5447-002-000  vision.max_coverage: CMS=375 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5447', '002', '000', 'vision', 375) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 375;


-- ──── H7323-007-000  Wellcare — Wellcare Simple Open (PPO) (TX)
-- H7323-007-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7323', '007', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7323-007-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7323', '007', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H7323-007-000  hearing.copay: CMS=30 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H7323', '007', '000', 'hearing', 30) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 30;


-- ──── H7617-042-000  Humana — Humana USAA Honor Giveback with Rx (PPO) (TX)
-- H7617-042-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '042', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-042-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '042', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-042-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H7617', '042', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H7678-006-001  Molina Healthcare of Texas, Inc. — Molina Medicare Complete Care (HMO D-SNP) (TX)
-- H7678-006-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7678', '006', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7678-006-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7678', '006', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7678-006-001  dental.max_coverage: CMS=4000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7678', '006', '001', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H7678-006-001  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7678', '006', '001', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H7993-003-000  Devoted Health — DEVOTED CORE 003 TX (HMO) (TX)
-- H7993-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-003-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '003', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H7993-004-000  Devoted Health — DEVOTED CORE 004 TX (HMO) (TX)
-- H7993-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-004-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '004', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-004-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '004', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H7993-012-000  Devoted Health — DEVOTED DUAL 012 TX (HMO D-SNP) (TX)
-- H7993-012-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '012', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-012-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '012', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-012-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '012', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H7993-020-000  Devoted Health — DEVOTED MA ONLY 020 TX (HMO) (TX)
-- H7993-020-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '020', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-020-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '020', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-020-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '020', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H7993-021-000  Devoted Health — DEVOTED GIVEBACK 021 TX (HMO) (TX)
-- H7993-021-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '021', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-021-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '021', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-021-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '021', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H7993-021-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H7993', '021', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H7993-033-000  Devoted Health — DEVOTED C-SNP PLUS 033 TX (HMO C-SNP) (TX)
-- H7993-033-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '033', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-033-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '033', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-033-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '033', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H7993-041-000  Devoted Health — DEVOTED DUAL FULL 041 TX (HMO D-SNP) (TX)
-- H7993-041-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '041', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-041-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '041', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-041-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '041', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H7993-046-000  Devoted Health — DEVOTED C-SNP 046 TX (HMO C-SNP) (TX)
-- H7993-046-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '046', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-046-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '046', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-046-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '046', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;

-- H7993-046-000  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H7993', '046', '000', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H8554-001-000  Blue Cross and Blue Shield of OK, TX — Blue Cross Medicare Advantage Core (HMO) (TX)
-- H8554-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8554', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8554-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8554', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8554-001-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8554', '001', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H8849-011-003  Wellpoint — Wellpoint Dual Advantage (HMO D-SNP) (TX)
-- H8849-011-003  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8849', '011', '003', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8849-011-003  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8849', '011', '003', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H9706-009-000  Blue Cross and Blue Shield of Texas — Blue Cross Medicare Advantage Value (HMO) (TX)
-- H9706-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9706', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9706-009-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9706', '009', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9706-009-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9706', '009', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H0174-006-000  Wellcare — Wellcare Dual Liberty (HMO D-SNP) (TX)
-- H0174-006-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0174', '006', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0174-006-000  dental.max_coverage: CMS=4000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '006', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H0174-006-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '006', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H0174-009-000  Wellcare — Wellcare Assist (HMO) (TX)
-- H0174-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0174', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0174-009-000  dental.max_coverage: CMS=3000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '009', '000', 'dental', 3000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 3000;

-- H0174-009-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '009', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H0174-009-000  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0174', '009', '000', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H0174-010-000  Wellcare — Wellcare Simple (HMO) (TX)
-- H0174-010-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0174', '010', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0174-010-000  dental.max_coverage: CMS=2000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '010', '000', 'dental', 2000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 2000;

-- H0174-010-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '010', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;

-- H0174-010-000  hearing.copay: CMS=15 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0174', '010', '000', 'hearing', 15) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 15;


-- ──── H0174-019-000  Wellcare — Wellcare Giveback (HMO) (TX)
-- H0174-019-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0174', '019', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0174-019-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '019', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;

-- H0174-019-000  hearing.copay: CMS=50 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0174', '019', '000', 'hearing', 50) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 50;


-- ──── H0332-001-000  KelseyCare Advantage — KelseyCare Advantage Core (HMO) (TX)
-- H0332-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0332', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0332-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0332', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0332-001-000  vision.max_coverage: CMS=125 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0332', '001', '000', 'vision', 125) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 125;


-- ──── H0332-004-000  KelseyCare Advantage — KelseyCare Advantage Freedom (HMO-POS) (TX)
-- H0332-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0332', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0332-004-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0332', '004', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0332-004-000  vision.max_coverage: CMS=175 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0332', '004', '000', 'vision', 175) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 175;

-- H0332-004-000  hearing.copay: CMS=35 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0332', '004', '000', 'hearing', 35) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 35;


-- ──── H1278-014-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-0006 (PPO) (TX)
-- H1278-014-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '014', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-014-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '014', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H1278-021-000  UnitedHealthcare — AARP Medicare Advantage Giveback from UHC TX-31 (PPO) (TX)
-- H1278-021-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '021', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-021-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '021', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H2293-016-000  Aetna Medicare — Aetna Medicare Signature (PPO) (TX)
-- H2293-016-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2293', '016', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2293-016-000  hearing.copay: CMS=70 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H2293', '016', '000', 'hearing', 70) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 70;


-- ──── H2593-048-000  Wellpoint — Wellpoint Full Dual Advantage 2 (HMO D-SNP) (TX)
-- H2593-048-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2593', '048', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2593-048-000  vision.max_coverage: CMS=325 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2593', '048', '000', 'vision', 325) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 325;


-- ──── H3288-006-000  Aetna Medicare — Aetna Medicare Signature (PPO) (TX)
-- H3288-006-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '006', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3288-006-000  hearing.copay: CMS=60 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3288', '006', '000', 'hearing', 60) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 60;


-- ──── H3288-018-000  Aetna Medicare — Aetna Medicare Value Plus (PPO) (TX)
-- H3288-018-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '018', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3288-018-000  dental.max_coverage: CMS=1000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3288', '018', '000', 'dental', 1000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 1000;

-- H3288-018-000  hearing.copay: CMS=65 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3288', '018', '000', 'hearing', 65) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 65;


-- ──── H4506-003-000  Wellcare — Wellcare TexanPlus Classic Simple (HMO-POS) (TX)
-- H4506-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4506', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4506-003-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4506', '003', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H4506-010-000  Wellcare — Wellcare TexanPlus Patriot Giveback (HMO-POS) (TX)
-- H4506-010-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4506', '010', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4506-010-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4506', '010', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H4514-007-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-0009 (HMO-POS) (TX)
-- H4514-007-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '007', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-007-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '007', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H4523-029-000  Aetna Medicare — Aetna Medicare Full Dual Care (HMO D-SNP) (TX)
-- H4523-029-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4523', '029', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4523-029-000  vision.max_coverage: CMS=375 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4523', '029', '000', 'vision', 375) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 375;


-- ──── H4523-043-000  Aetna Medicare — Aetna Medicare Partial Dual Care (HMO D-SNP) (TX)
-- H4523-043-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4523', '043', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4523-043-000  vision.max_coverage: CMS=275 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4523', '043', '000', 'vision', 275) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 275;


-- ──── H4527-037-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-0015 (HMO-POS) (TX)
-- H4527-037-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '037', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-037-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '037', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-037-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '037', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H5216-043-006  Humana — HumanaChoice H5216-043 (PPO) (TX)
-- H5216-043-006  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '043', '006', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-043-006  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '043', '006', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H7323-012-000  Wellcare — Wellcare Simple Open (PPO) (TX)
-- H7323-012-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7323', '012', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7323-012-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7323', '012', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H7617-057-000  Humana — Humana Value Choice H7617-057 (PPO) (TX)
-- H7617-057-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '057', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-057-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '057', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H8597-003-000  Aetna Medicare — Aetna Medicare Dual Care (HMO D-SNP) (TX)
-- H8597-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8597', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8597-003-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8597', '003', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H9826-003-000  Community Health Choice — Community DualCare Aligned (HMO D-SNP) (TX)
-- H9826-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9826', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9826-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9826', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9826-003-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9826', '003', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H8849-010-005  Wellpoint — Wellpoint Full Dual Advantage (HMO D-SNP) (TX)
-- H8849-010-005  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8849', '010', '005', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8849-010-005  vision.max_coverage: CMS=700 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8849', '010', '005', 'vision', 700) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 700;


-- ──── H8849-011-005  Wellpoint — Wellpoint Dual Advantage (HMO D-SNP) (TX)
-- H8849-011-005  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8849', '011', '005', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8849-011-005  vision.max_coverage: CMS=650 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8849', '011', '005', 'vision', 650) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 650;


-- ──── H8145-084-000  Humana — Humana Gold Choice H8145-084 (PFFS) (TX)
-- H8145-084-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8145', '084', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8145-084-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8145', '084', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H8145-126-000  Humana — Humana Gold Choice H8145-126 (PFFS) (TX)
-- H8145-126-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8145', '126', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8145-126-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8145', '126', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8145-126-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H8145', '126', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H0028-037-000  Humana — Humana Gold Plus H0028-037 (HMO) (TX)
-- H0028-037-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '037', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-037-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '037', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-037-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0028', '037', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H0174-017-000  Wellcare — Wellcare Giveback (HMO) (TX)
-- H0174-017-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0174', '017', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0174-017-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '017', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;

-- H0174-017-000  hearing.copay: CMS=50 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0174', '017', '000', 'hearing', 50) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 50;


-- ──── H0174-024-000  Wellcare — Wellcare Dual Liberty Sync (HMO D-SNP) (TX)
-- H0174-024-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0174', '024', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0174-024-000  dental.max_coverage: CMS=4000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '024', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H0174-024-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '024', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H1666-003-000  Blue Cross and Blue Shield of NM, TX — Blue Cross Medicare Advantage Choice Premier (PPO) (TX)
-- H1666-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1666', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1666-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1666', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1666-003-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H1666', '003', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H1666-022-000  Blue Cross and Blue Shield of NM, TX — Blue Cross Medicare Advantage Optimum (PPO) (TX)
-- H1666-022-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1666', '022', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1666-022-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1666', '022', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1666-022-000  dental.max_coverage: CMS=750 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1666', '022', '000', 'dental', 750) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 750;

-- H1666-022-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H1666', '022', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H4461-054-000  Humana — Humana Gold Plus H4461-054 (HMO) (TX)
-- H4461-054-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '054', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-054-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '054', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-054-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '054', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H4514-023-000  UnitedHealthcare — UHC Dual Complete TX-D002 (HMO-POS D-SNP) (TX)
-- H4514-023-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '023', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-023-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '023', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-023-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4514', '023', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H4527-002-000  UnitedHealthcare — AARP Medicare Advantage Essentials from UHC TX-12 (HMO-POS) (TX)
-- H4527-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-002-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '002', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H4527-039-000  UnitedHealthcare — UHC Complete Care TX-16 (HMO-POS C-SNP) (TX)
-- H4527-039-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '039', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-039-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '039', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-039-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '039', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H4527-052-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-46 (HMO-POS) (TX)
-- H4527-052-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '052', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-052-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '052', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-052-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '052', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H4527-053-000  UnitedHealthcare — AARP Medicare Advantage CareFlex from UHC TX-47 (HMO-POS) (TX)
-- H4527-053-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '053', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-053-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '053', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-053-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '053', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;

-- H4527-053-000  hearing.copay: CMS=30 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H4527', '053', '000', 'hearing', 30) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 30;


-- ──── H4527-059-000  UnitedHealthcare — AARP Medicare Advantage Extras from UHC TX-53 (HMO-POS) (TX)
-- H4527-059-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '059', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-059-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '059', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-059-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '059', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5216-432-000  Humana — Humana Full Access H5216-432 (PPO) (TX)
-- H5216-432-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '432', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-432-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '432', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-432-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5216', '432', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H7617-029-000  Humana — Humana Full Access H7617-029 (PPO) (TX)
-- H7617-029-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '029', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-029-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '029', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-029-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H7617', '029', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H8142-001-000  Baylor Scott & White Health Plan — BSW SeniorCare Advantage Select Rx (HMO-POS) (TX)
-- H8142-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8142', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8142-001-000  vision.max_coverage: CMS=185 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8142', '001', '000', 'vision', 185) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 185;

-- H8142-001-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H8142', '001', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H8142-002-000  Baylor Scott & White Health Plan — BSW SeniorCare Advantage Preferred Rx (HMO-POS) (TX)
-- H8142-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8142', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8142-002-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8142', '002', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H8142-003-000  Baylor Scott & White Health Plan — BSW SeniorCare Advantage Premium Rx (HMO-POS) (TX)
-- H8142-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8142', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8142-003-000  vision.max_coverage: CMS=125 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8142', '003', '000', 'vision', 125) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 125;


-- ──── H8142-004-000  Baylor Scott & White Health Plan — BSW SeniorCare Advantage Select (HMO-POS) (TX)
-- H8142-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8142', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8142-004-000  vision.max_coverage: CMS=125 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8142', '004', '000', 'vision', 125) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 125;


-- ──── H8142-005-000  Baylor Scott & White Health Plan — BSW SeniorCare Advantage Preferred (HMO-POS) (TX)
-- H8142-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8142', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8142-005-000  vision.max_coverage: CMS=125 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8142', '005', '000', 'vision', 125) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 125;

-- H8142-005-000  hearing.copay: CMS=15 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H8142', '005', '000', 'hearing', 15) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 15;


-- ──── H8142-006-000  Baylor Scott & White Health Plan — BSW SeniorCare Advantage Premium (HMO-POS) (TX)
-- H8142-006-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8142', '006', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8142-006-000  vision.max_coverage: CMS=125 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8142', '006', '000', 'vision', 125) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 125;


-- ──── H8142-009-000  Baylor Scott & White Health Plan — BSW SeniorCare Advantage Essentials (HMO-POS) (TX)
-- H8142-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8142', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8142-009-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8142', '009', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H0609-054-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-23 (HMO-POS) (TX)
-- H0609-054-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '054', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-054-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '054', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-054-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '054', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H5294-011-000  Wellcare — Wellcare Simple (HMO) (TX)
-- H5294-011-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5294', '011', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5294-011-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '011', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;

-- H5294-011-000  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5294', '011', '000', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H5294-013-000  Wellcare — Wellcare Assist (HMO) (TX)
-- H5294-013-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5294', '013', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5294-013-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '013', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H0174-025-000  Wellcare — Wellcare Dual Liberty Sync (HMO D-SNP) (TX)
-- H0174-025-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0174', '025', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0174-025-000  dental.max_coverage: CMS=4000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '025', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H0174-025-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '025', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H0710-020-000  UnitedHealthcare — UHC Nursing Home Plan TX-F001 (PPO I-SNP) (TX)
-- H0710-020-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0710', '020', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0710-020-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0710', '020', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0710-020-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0710', '020', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H2032-002-000  Baylor Scott & White Health Plan — BSW SeniorCare Advantage Basic (PPO) (TX)
-- H2032-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2032', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2032-002-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2032', '002', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;

-- H2032-002-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H2032', '002', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H2032-003-000  Baylor Scott & White Health Plan — BSW SeniorCare Advantage Platinum (PPO) (TX)
-- H2032-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2032', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2032-003-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2032', '003', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H0174-015-000  Wellcare — Wellcare Simple (HMO) (TX)
-- H0174-015-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0174', '015', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0174-015-000  dental.max_coverage: CMS=1500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '015', '000', 'dental', 1500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 1500;

-- H0174-015-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '015', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H0174-020-000  Wellcare — Wellcare Giveback (HMO) (TX)
-- H0174-020-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0174', '020', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0174-020-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '020', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;

-- H0174-020-000  hearing.copay: CMS=50 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0174', '020', '000', 'hearing', 50) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 50;


-- ──── H2593-031-000  Wellpoint — Wellpoint Kidney Care (HMO-POS C-SNP) (TX)
-- H2593-031-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2593', '031', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2593-031-000  vision.max_coverage: CMS=325 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2593', '031', '000', 'vision', 325) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 325;


-- ──── H3288-001-000  Aetna Medicare — Aetna Medicare Value Plus (PPO) (TX)
-- H3288-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3288-001-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3288', '001', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H4523-020-000  Aetna Medicare — Aetna Medicare Prime Care (HMO) (TX)
-- H4523-020-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4523', '020', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4523-020-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4523', '020', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H4523-038-000  Aetna Medicare — Aetna Medicare Prime Chronic Care (HMO C-SNP) (TX)
-- H4523-038-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4523', '038', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4523-038-000  vision.max_coverage: CMS=175 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4523', '038', '000', 'vision', 175) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 175;


-- ──── H5447-001-000  Community First — Community First Medicare Advantage Alamo Plan (HMO) (TX)
-- H5447-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5447', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5447-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5447', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5447-001-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5447', '001', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;

-- H5447-001-000  hearing.copay: CMS=25 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5447', '001', '000', 'hearing', 25) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 25;


-- ──── H6515-001-000  Molina Healthcare of Texas, Inc. — Molina Medicare Complete Care Plus (HMO D-SNP) (TX)
-- H6515-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6515', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6515-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6515', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6515-001-000  dental.max_coverage: CMS=4000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6515', '001', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H6515-001-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6515', '001', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H8849-001-000  Wellpoint — Wellpoint Chronic Care (HMO-POS C-SNP) (TX)
-- H8849-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8849', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8849-001-000  vision.max_coverage: CMS=325 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8849', '001', '000', 'vision', 325) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 325;


-- ──── H8849-006-000  Wellpoint — Wellpoint Select (HMO-POS) (TX)
-- H8849-006-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8849', '006', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8849-006-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8849', '006', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H8902-002-000  SCAN Health Plan — SCAN Balance Texas (HMO C-SNP) (TX)
-- H8902-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8902', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8902-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8902', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8902-002-000  vision.max_coverage: CMS=325 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8902', '002', '000', 'vision', 325) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 325;


-- ──── H8902-009-000  SCAN Health Plan — SCAN Strive Texas (HMO C-SNP) (TX)
-- H8902-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8902', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8902-009-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8902', '009', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8902-009-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8902', '009', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H8902-010-000  SCAN Health Plan — SCAN Classic Texas (HMO) (TX)
-- H8902-010-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8902', '010', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8902-010-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8902', '010', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8902-010-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8902', '010', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;

-- H8902-010-000  hearing.copay: CMS=15 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H8902', '010', '000', 'hearing', 15) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 15;


-- ──── H8902-011-000  SCAN Health Plan — SCAN MyChoice Texas (HMO) (TX)
-- H8902-011-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8902', '011', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8902-011-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8902', '011', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8902-011-000  vision.max_coverage: CMS=240 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8902', '011', '000', 'vision', 240) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 240;


-- ──── H6813-001-000  Devoted Health — DEVOTED CHOICE GIVEBACK 001 TX (PPO) (TX)
-- H6813-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6813', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6813-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6813', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6813-001-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6813', '001', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H6813-006-000  Devoted Health — DEVOTED CHOICE MA ONLY 006 TX (PPO) (TX)
-- H6813-006-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6813', '006', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6813-006-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6813', '006', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6813-006-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6813', '006', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;

-- H6813-006-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H6813', '006', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H7993-014-000  Devoted Health — DEVOTED CORE 014 TX (HMO) (TX)
-- H7993-014-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '014', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-014-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '014', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-014-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '014', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H7993-015-000  Devoted Health — DEVOTED DUAL 015 TX (HMO D-SNP) (TX)
-- H7993-015-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '015', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-015-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '015', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-015-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '015', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H7993-023-000  Devoted Health — DEVOTED C-SNP PREMIUM 023 TX (HMO C-SNP) (TX)
-- H7993-023-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '023', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-023-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '023', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-023-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '023', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H7993-024-000  Devoted Health — DEVOTED C-SNP PLUS 024 TX (HMO C-SNP) (TX)
-- H7993-024-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '024', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-024-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '024', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-024-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '024', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H7993-037-000  Devoted Health — DEVOTED DUAL FULL 037 TX (HMO D-SNP) (TX)
-- H7993-037-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '037', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-037-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '037', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-037-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '037', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H7993-048-000  Devoted Health — DEVOTED GIVEBACK 048 TX (HMO) (TX)
-- H7993-048-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '048', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-048-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '048', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-048-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '048', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H0609-051-000  UnitedHealthcare — AARP Medicare Advantage Essentials from UHC TX-22 (HMO-POS) (TX)
-- H0609-051-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '051', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-051-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '051', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-051-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '051', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H0609-055-000  UnitedHealthcare — AARP Medicare Advantage Patriot No Rx TX-MA02 (HMO-POS) (TX)
-- H0609-055-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '055', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-055-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '055', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-055-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '055', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H0609-059-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-25 (HMO-POS) (TX)
-- H0609-059-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '059', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-059-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '059', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-059-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '059', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H0609-061-000  UnitedHealthcare — AARP Medicare Advantage Extras from UHC TX-27 (HMO-POS) (TX)
-- H0609-061-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '061', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-061-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '061', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-061-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '061', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H0609-062-000  UnitedHealthcare — UHC Complete Care TX-3P (HMO-POS C-SNP) (TX)
-- H0609-062-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '062', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-062-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '062', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-062-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '062', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H0609-066-000  UnitedHealthcare — AARP Medicare Advantage Giveback from UHC TX-39 (HMO-POS) (TX)
-- H0609-066-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '066', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-066-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '066', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H0609-070-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-0042 (HMO-POS) (TX)
-- H0609-070-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '070', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-070-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '070', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-070-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '070', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H0609-077-000  UnitedHealthcare — AARP Medicare Advantage CareFlex from UHC TX-44 (HMO-POS) (TX)
-- H0609-077-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '077', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-077-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0609', '077', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0609-077-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0609', '077', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H1278-013-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-0005 (PPO) (TX)
-- H1278-013-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '013', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-013-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '013', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-013-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1278', '013', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H4523-030-000  Aetna Medicare — Aetna Medicare Full Dual Care (HMO D-SNP) (TX)
-- H4523-030-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4523', '030', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4523-030-000  vision.max_coverage: CMS=375 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4523', '030', '000', 'vision', 375) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 375;


-- ──── H4523-044-000  Aetna Medicare — Aetna Medicare Partial Dual Care (HMO D-SNP) (TX)
-- H4523-044-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4523', '044', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4523-044-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4523', '044', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H5294-024-000  Wellcare — Wellcare Dual Liberty Sync (HMO D-SNP) (TX)
-- H5294-024-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5294', '024', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5294-024-000  dental.max_coverage: CMS=4000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '024', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H5294-024-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '024', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H8597-002-000  Aetna Medicare — Aetna Medicare Dual Care (HMO D-SNP) (TX)
-- H8597-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8597', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8597-002-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8597', '002', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H0028-043-002  Humana — Humana Gold Plus H0028-043 (HMO) (TX)
-- H0028-043-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '043', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-043-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '043', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-043-002  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0028', '043', '002', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4461-062-000  Humana — Humana Gold Plus H4461-062 (HMO) (TX)
-- H4461-062-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '062', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-062-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '062', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-062-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '062', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4514-017-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-0010 (HMO-POS) (TX)
-- H4514-017-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '017', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-017-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '017', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-017-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4514', '017', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H0028-042-000  Humana — Humana Gold Plus H0028-042 (HMO) (TX)
-- H0028-042-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '042', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-042-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '042', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-042-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0028', '042', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H0332-009-000  KelseyCare Advantage — KelseyCare Advantage Signature (HMO) (TX)
-- H0332-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0332', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0332-009-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0332', '009', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0332-009-000  vision.max_coverage: CMS=125 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0332', '009', '000', 'vision', 125) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 125;

-- H0332-009-000  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0332', '009', '000', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H4461-057-000  Humana — Humana Gold Plus H4461-057 (HMO) (TX)
-- H4461-057-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '057', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-057-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '057', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-057-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '057', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H4513-064-000  HealthSpring — HealthSpring Alliance (HMO) (TX)
-- H4513-064-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '064', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-064-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '064', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-064-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '064', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H4514-014-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-001P (HMO-POS) (TX)
-- H4514-014-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '014', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-014-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '014', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-014-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4514', '014', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H4514-015-000  UnitedHealthcare — UHC Complete Care TX-2P (HMO-POS C-SNP) (TX)
-- H4514-015-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '015', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-015-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '015', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-015-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4514', '015', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H4514-022-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-4P (HMO-POS) (TX)
-- H4514-022-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '022', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-022-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '022', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-022-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4514', '022', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4523-015-000  Aetna Medicare — Aetna Medicare Signature Extra (HMO) (TX)
-- H4523-015-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4523', '015', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4523-015-000  vision.max_coverage: CMS=175 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4523', '015', '000', 'vision', 175) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 175;

-- H4523-015-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H4523', '015', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H7115-001-000  Memorial Hermann Health Plan — Memorial Hermann Advantage (HMO) (TX)
-- H7115-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7115', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7115-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7115', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7115-001-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7115', '001', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H7115-005-000  Memorial Hermann Health Plan — Memorial Hermann Dual Advantage (HMO D-SNP) (TX)
-- H7115-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7115', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7115-005-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7115', '005', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7115-005-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7115', '005', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H7115-006-000  Memorial Hermann Health Plan — Memorial Hermann Prime Value MA Only (HMO) (TX)
-- H7115-006-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7115', '006', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7115-006-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7115', '006', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7115-006-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7115', '006', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;

-- H7115-006-000  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H7115', '006', '000', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H7993-006-000  Devoted Health — DEVOTED GIVEBACK 006 TX (HMO) (TX)
-- H7993-006-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '006', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-006-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '006', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-006-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '006', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H7993-019-000  Devoted Health — DEVOTED CORE 019 TX (HMO) (TX)
-- H7993-019-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '019', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-019-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '019', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-019-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '019', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H4527-013-000  UnitedHealthcare — AARP Medicare Advantage Essentials from UHC TX-14 (HMO-POS) (TX)
-- H4527-013-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '013', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-013-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '013', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-013-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '013', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H4527-042-000  UnitedHealthcare — UHC Complete Care TX-19 (HMO-POS C-SNP) (TX)
-- H4527-042-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '042', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-042-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '042', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-042-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '042', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4527-051-000  UnitedHealthcare — AARP Medicare Advantage Giveback from UHC TX-38 (HMO-POS) (TX)
-- H4527-051-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '051', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-051-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '051', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-051-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '051', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H4527-055-000  UnitedHealthcare — AARP Medicare Advantage Extras from UHC TX-50 (HMO-POS) (TX)
-- H4527-055-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '055', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-055-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '055', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-055-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '055', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4527-058-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-51 (HMO-POS) (TX)
-- H4527-058-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '058', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-058-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '058', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-058-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '058', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H7680-002-000  Prominence Health Plan — Prominence Plus (HMO) (TX)
-- H7680-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-002-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7680', '002', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H7680-007-000  Prominence Health Plan — Prominence Dual (HMO D-SNP) (TX)
-- H7680-007-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '007', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-007-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '007', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-007-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7680', '007', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H7680-009-000  Prominence Health Plan — Prominence Extra Help (HMO) (TX)
-- H7680-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-009-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '009', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-009-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7680', '009', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H7680-011-000  Prominence Health Plan — Prominence Beyond (HMO) (TX)
-- H7680-011-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '011', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-011-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '011', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-011-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7680', '011', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H7680-014-000  Prominence Health Plan — Prominence Giveback (HMO) (TX)
-- H7680-014-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '014', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-014-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '014', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-014-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7680', '014', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H7680-016-000  Prominence Health Plan — Prominence Diabetes and Heart Care Plus (HMO C-SNP) (TX)
-- H7680-016-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '016', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-016-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '016', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-016-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7680', '016', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H7680-020-000  Prominence Health Plan — Prominence Diabetes and Heart Giveback (HMO C-SNP) (TX)
-- H7680-020-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '020', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-020-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '020', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-020-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7680', '020', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H1189-009-000  CHRISTUS Health Advantage — CHRISTUS Health Medicare Plus (HMO) (TX)
-- H1189-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1189', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1189-009-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1189', '009', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H1666-006-000  Blue Cross and Blue Shield of NM, TX — Blue Cross Medicare Advantage Choice Plus (PPO) (TX)
-- H1666-006-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1666', '006', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1666-006-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1666', '006', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H0028-046-000  Humana — Humana Gold Plus H0028-046 (HMO) (TX)
-- H0028-046-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '046', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-046-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '046', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-046-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0028', '046', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;

-- H0028-046-000  hearing.copay: CMS=15 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0028', '046', '000', 'hearing', 15) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 15;


-- ──── H1278-010-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-0004 (PPO) (TX)
-- H1278-010-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '010', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-010-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '010', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-010-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1278', '010', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H2293-017-000  Aetna Medicare — Aetna Medicare Signature (PPO) (TX)
-- H2293-017-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2293', '017', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2293-017-000  dental.max_coverage: CMS=2000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2293', '017', '000', 'dental', 2000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 2000;


-- ──── H2593-053-000  Wellpoint — Wellpoint Full Dual Advantage (HMO D-SNP) (TX)
-- H2593-053-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2593', '053', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2593-053-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2593', '053', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H3288-009-000  Aetna Medicare — Aetna Medicare Enhanced (PPO) (TX)
-- H3288-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3288-009-000  dental.max_coverage: CMS=1500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3288', '009', '000', 'dental', 1500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 1500;


-- ──── H4461-052-000  Humana — Humana Gold Plus H4461-052 (HMO) (TX)
-- H4461-052-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '052', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-052-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '052', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-052-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '052', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H4513-060-002  HealthSpring — HealthSpring TotalCare (HMO D-SNP) (TX)
-- H4513-060-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '060', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-060-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '060', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-060-002  vision.max_coverage: CMS=275 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '060', '002', 'vision', 275) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 275;


-- ──── H4513-061-002  HealthSpring — HealthSpring Preferred (HMO) (TX)
-- H4513-061-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '061', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-061-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '061', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-061-002  vision.max_coverage: CMS=325 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '061', '002', 'vision', 325) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 325;


-- ──── H4513-083-002  HealthSpring — HealthSpring Preferred Savings (HMO) (TX)
-- H4513-083-002  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '083', '002', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-083-002  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '083', '002', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-083-002  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '083', '002', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H4513-092-000  HealthSpring — HealthSpring Preferred Full Savings (HMO) (TX)
-- H4513-092-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '092', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-092-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '092', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-092-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '092', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H4513-098-000  HealthSpring — HealthSpring Achieve (HMO C-SNP) (TX)
-- H4513-098-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '098', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-098-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '098', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-098-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '098', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H4523-027-000  Aetna Medicare — Aetna Medicare Signature Care (HMO) (TX)
-- H4523-027-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4523', '027', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4523-027-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4523', '027', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;

-- H4523-027-000  hearing.copay: CMS=30 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H4523', '027', '000', 'hearing', 30) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 30;


-- ──── H4527-015-000  UnitedHealthcare — UHC Dual Complete TX-D003 (HMO-POS D-SNP) (TX)
-- H4527-015-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '015', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-015-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '015', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-015-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '015', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5216-350-000  Humana — HumanaChoice Giveback H5216-350 (PPO) (TX)
-- H5216-350-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '350', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-350-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '350', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5294-021-000  Wellcare — Wellcare Dual Liberty Sync (HMO D-SNP) (TX)
-- H5294-021-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5294', '021', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5294-021-000  dental.max_coverage: CMS=4000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '021', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H5294-021-000  vision.max_coverage: CMS=600 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '021', '000', 'vision', 600) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 600;


-- ──── H5322-026-000  UnitedHealthcare — UHC Dual Complete TX-V005 (HMO-POS D-SNP) (TX)
-- H5322-026-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '026', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-026-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5322', '026', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5322-026-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5322', '026', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H7617-041-000  Humana — HumanaChoice Giveback H7617-041 (PPO) (TX)
-- H7617-041-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '041', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-041-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '041', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H8133-005-000  Blue Cross and Blue Shield of Texas — Blue Cross Medicare Advantage Basic (HMO) (TX)
-- H8133-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8133', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8133-005-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8133', '005', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8133-005-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8133', '005', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H2593-047-000  Wellpoint — Wellpoint Full Dual Advantage Aligned (HMO D-SNP) (TX)
-- H2593-047-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2593', '047', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2593-047-000  vision.max_coverage: CMS=450 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2593', '047', '000', 'vision', 450) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 450;


-- ──── H5294-023-000  Wellcare — Wellcare Dual Liberty Sync (HMO D-SNP) (TX)
-- H5294-023-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5294', '023', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5294-023-000  dental.max_coverage: CMS=4000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '023', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H5294-023-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5294', '023', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H2593-044-000  Wellpoint — Wellpoint Full Dual Advantage Aligned (HMO D-SNP) (TX)
-- H2593-044-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2593', '044', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2593-044-000  vision.max_coverage: CMS=450 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2593', '044', '000', 'vision', 450) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 450;


-- ──── H7993-001-000  Devoted Health — DEVOTED CORE 001 TX (HMO) (TX)
-- H7993-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-001-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '001', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H7993-002-000  Devoted Health — DEVOTED PREMIUM 002 TX (HMO) (TX)
-- H7993-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-002-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '002', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H7993-010-000  Devoted Health — DEVOTED DUAL 010 TX (HMO D-SNP) (TX)
-- H7993-010-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '010', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-010-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '010', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-010-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '010', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H7993-030-000  Devoted Health — DEVOTED C-SNP PREMIUM 030 TX (HMO C-SNP) (TX)
-- H7993-030-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '030', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-030-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '030', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-030-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '030', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H7993-031-000  Devoted Health — DEVOTED C-SNP PLUS 031 TX (HMO C-SNP) (TX)
-- H7993-031-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '031', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-031-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '031', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-031-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '031', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H7993-040-000  Devoted Health — DEVOTED DUAL FULL 040 TX (HMO D-SNP) (TX)
-- H7993-040-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '040', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-040-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '040', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-040-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '040', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H8133-001-000  Blue Cross and Blue Shield of Texas — Blue Cross Medicare Advantage Basic (HMO) (TX)
-- H8133-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8133', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8133-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8133', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8133-001-000  hearing.copay: CMS=35 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H8133', '001', '000', 'hearing', 35) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 35;


-- ──── H9826-004-000  Community Health Choice — Community DualCare Access (HMO D-SNP) (TX)
-- H9826-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9826', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9826-004-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H9826', '004', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H9826-004-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H9826', '004', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H0028-043-001  Humana — Humana Gold Plus H0028-043 (HMO) (TX)
-- H0028-043-001  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '043', '001', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-043-001  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '043', '001', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-043-001  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0028', '043', '001', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H0028-059-000  Humana — Humana Gold Plus H0028-059 (HMO) (TX)
-- H0028-059-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '059', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-059-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '059', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-059-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0028', '059', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;

-- H0028-059-000  hearing.copay: CMS=15 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0028', '059', '000', 'hearing', 15) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 15;


-- ──── H0028-060-000  Humana — Humana Gold Plus - Diabetes and Heart (HMO C-SNP) (TX)
-- H0028-060-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '060', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-060-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '060', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-060-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0028', '060', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H0174-014-000  Wellcare — Wellcare Simple (HMO) (TX)
-- H0174-014-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0174', '014', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0174-014-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '014', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H0174-018-000  Wellcare — Wellcare Giveback (HMO) (TX)
-- H0174-018-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0174', '018', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0174-018-000  hearing.copay: CMS=50 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0174', '018', '000', 'hearing', 50) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 50;


-- ──── H0174-023-000  Wellcare — Wellcare Dual Liberty Sync (HMO D-SNP) (TX)
-- H0174-023-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0174', '023', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0174-023-000  dental.max_coverage: CMS=4000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '023', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H0174-023-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '023', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H1278-025-000  UnitedHealthcare — AARP Medicare Advantage Patriot No Rx TX-MA06 (PPO) (TX)
-- H1278-025-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '025', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-025-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1278', '025', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1278-025-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1278', '025', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H2032-001-000  Baylor Scott & White Health Plan — BSW SeniorCare Advantage (PPO) (TX)
-- H2032-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2032', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2032-001-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2032', '001', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;

-- H2032-001-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H2032', '001', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H2293-025-000  Aetna Medicare — Aetna Medicare Enhanced (PPO) (TX)
-- H2293-025-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2293', '025', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2293-025-000  dental.max_coverage: CMS=1500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2293', '025', '000', 'dental', 1500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 1500;


-- ──── H3288-002-000  Aetna Medicare — Aetna Medicare Value Plus (PPO) (TX)
-- H3288-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3288-002-000  dental.max_coverage: CMS=1000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3288', '002', '000', 'dental', 1000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 1000;

-- H3288-002-000  hearing.copay: CMS=35 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3288', '002', '000', 'hearing', 35) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 35;


-- ──── H3288-016-000  Aetna Medicare — Aetna Medicare Signature (PPO) (TX)
-- H3288-016-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '016', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H3467-002-000  ProCare Advantage — ProCare Advantage - Kidney Care (HMO-POS C-SNP) (TX)
-- H3467-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3467', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3467-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3467', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3467-002-000  vision.max_coverage: CMS=325 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3467', '002', '000', 'vision', 325) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 325;


-- ──── H3467-005-000  ProCare Advantage — ProCare Advantage - Diabetes Care Management (HMO-POS C-SNP) (TX)
-- H3467-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3467', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3467-005-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3467', '005', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3467-005-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3467', '005', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4461-050-000  Humana — Humana Gold Plus H4461-050 (HMO) (TX)
-- H4461-050-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '050', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-050-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '050', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-050-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '050', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4461-051-000  Humana — Humana Total Complete H4461-051 (HMO) (TX)
-- H4461-051-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '051', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-051-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '051', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-051-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '051', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H4461-067-000  Humana — Humana Gold Plus - Diabetes and Heart (HMO C-SNP) (TX)
-- H4461-067-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '067', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-067-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '067', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-067-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '067', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H4513-060-005  HealthSpring — HealthSpring TotalCare (HMO D-SNP) (TX)
-- H4513-060-005  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '060', '005', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-060-005  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '060', '005', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-060-005  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '060', '005', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H4513-061-005  HealthSpring — HealthSpring Preferred (HMO) (TX)
-- H4513-061-005  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '061', '005', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-061-005  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '061', '005', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-061-005  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '061', '005', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4513-083-005  HealthSpring — HealthSpring Preferred Savings (HMO) (TX)
-- H4513-083-005  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '083', '005', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-083-005  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '083', '005', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-083-005  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '083', '005', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H4523-021-000  Aetna Medicare — Aetna Medicare Prime Care (HMO) (TX)
-- H4523-021-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4523', '021', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4523-021-000  vision.max_coverage: CMS=175 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4523', '021', '000', 'vision', 175) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 175;


-- ──── H4523-039-000  Aetna Medicare — Aetna Medicare Prime Chronic Total (HMO C-SNP) (TX)
-- H4523-039-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4523', '039', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4523-039-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4523', '039', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H5163-003-000  Verda Health Plan of Texas — Verda Noble Care (HMO) (TX)
-- H5163-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5163', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5163-003-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5163', '003', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5163-004-000  Verda Health Plan of Texas — Verda Noble Chronic Care (HMO C-SNP) (TX)
-- H5163-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5163', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5163-004-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5163', '004', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H5216-431-000  Humana — Humana Direct Choice Giveback (PPO) (TX)
-- H5216-431-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '431', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-431-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '431', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-431-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H5216', '431', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H7787-001-000  HealthSpring — HealthSpring True Choice Savings (PPO) (TX)
-- H7787-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7787', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7787-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7787', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7787-001-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7787', '001', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H8142-007-000  Baylor Scott & White Health Plan — BSW SeniorCare Advantage Select Rx (HMO-POS) (TX)
-- H8142-007-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8142', '007', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8142-007-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8142', '007', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H8142-007-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H8142', '007', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H8142-008-000  Baylor Scott & White Health Plan — BSW SeniorCare Advantage Select (HMO-POS) (TX)
-- H8142-008-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8142', '008', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8142-008-000  vision.max_coverage: CMS=125 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8142', '008', '000', 'vision', 125) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 125;


-- ──── H8142-010-000  Baylor Scott & White Health Plan — BSW SeniorCare Advantage Essentials (HMO-POS) (TX)
-- H8142-010-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8142', '010', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8142-010-000  vision.max_coverage: CMS=130 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8142', '010', '000', 'vision', 130) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 130;


-- ──── H8634-022-000  Blue Cross and Blue Shield of IL, NM, OK, TX — Blue Cross Medicare Advantage Classic (PPO) (TX)
-- H8634-022-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8634', '022', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8634-022-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8634', '022', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8634-022-000  hearing.copay: CMS=50 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H8634', '022', '000', 'hearing', 50) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 50;


-- ──── H5216-352-000  Humana — Humana Value Choice H5216-352 (PPO) (TX)
-- H5216-352-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '352', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-352-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '352', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H7617-043-000  Humana — Humana Value Choice H7617-043 (PPO) (TX)
-- H7617-043-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '043', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-043-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '043', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-043-000  hearing.copay: CMS=30 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H7617', '043', '000', 'hearing', 30) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 30;


-- ──── H7680-001-000  Prominence Health Plan — Prominence Plus (HMO) (TX)
-- H7680-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-001-000  vision.max_coverage: CMS=225 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7680', '001', '000', 'vision', 225) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 225;


-- ──── H7680-012-000  Prominence Health Plan — Prominence Giveback (HMO) (TX)
-- H7680-012-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '012', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-012-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '012', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-012-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7680', '012', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H7680-015-000  Prominence Health Plan — Prominence Diabetes and Heart Giveback (HMO C-SNP) (TX)
-- H7680-015-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '015', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-015-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '015', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-015-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7680', '015', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H7680-017-000  Prominence Health Plan — Prominence Dual (HMO D-SNP) (TX)
-- H7680-017-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '017', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-017-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '017', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-017-000  vision.max_coverage: CMS=290 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7680', '017', '000', 'vision', 290) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 290;


-- ──── H7680-018-000  Prominence Health Plan — Prominence Extra Help (HMO) (TX)
-- H7680-018-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '018', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-018-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '018', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-018-000  vision.max_coverage: CMS=195 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7680', '018', '000', 'vision', 195) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 195;


-- ──── H7680-019-000  Prominence Health Plan — Prominence Beyond (HMO-POS) (TX)
-- H7680-019-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '019', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-019-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7680', '019', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7680-019-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7680', '019', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H0783-004-000  Humana — Humana Gold Plus H0783-004 (HMO) (TX)
-- H0783-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0783', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0783-004-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0783', '004', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0783-004-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0783', '004', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H2032-004-000  Baylor Scott & White Health Plan — BSW SeniorCare Advantage (PPO) (TX)
-- H2032-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2032', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2032-004-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2032', '004', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H0062-011-000  Wellcare — Wellcare Superior HealthPlan Dual Align (HMO D-SNP) (TX)
-- H0062-011-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0062', '011', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0062-011-000  dental.max_coverage: CMS=4000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0062', '011', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H0062-011-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0062', '011', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H6515-002-000  Molina Healthcare of Texas, Inc. — Molina Medicare Complete Care Plus (HMO D-SNP) (TX)
-- H6515-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6515', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6515-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6515', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6515-002-000  dental.max_coverage: CMS=4000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6515', '002', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H6515-002-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6515', '002', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H3288-011-000  Aetna Medicare — Aetna Medicare Signature (PPO) (TX)
-- H3288-011-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '011', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H0028-035-000  Humana — Humana Gold Plus H0028-035 (HMO) (TX)
-- H0028-035-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '035', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-035-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '035', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-035-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0028', '035', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H0174-016-000  Wellcare — Wellcare Simple (HMO) (TX)
-- H0174-016-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0174', '016', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0174-016-000  dental.max_coverage: CMS=2000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '016', '000', 'dental', 2000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 2000;

-- H0174-016-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '016', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H0174-016-000  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0174', '016', '000', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H0174-021-000  Wellcare — Wellcare Giveback (HMO) (TX)
-- H0174-021-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0174', '021', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0174-021-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0174', '021', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;

-- H0174-021-000  hearing.copay: CMS=50 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H0174', '021', '000', 'hearing', 50) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 50;


-- ──── H2406-039-000  UnitedHealthcare — AARP Medicare Advantage Essentials from UHC EP-1 (PPO) (TX)
-- H2406-039-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2406', '039', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2406-039-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2406', '039', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2406-039-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2406', '039', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H2406-050-000  UnitedHealthcare — UHC Dual Complete TX-D001 (PPO D-SNP) (TX)
-- H2406-050-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2406', '050', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2406-050-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2406', '050', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2406-050-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2406', '050', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H2406-119-000  UnitedHealthcare — AARP Medicare Advantage Giveback from UHC EP-2 (PPO) (TX)
-- H2406-119-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2406', '119', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2406-119-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2406', '119', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2406-119-000  vision.max_coverage: CMS=150 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2406', '119', '000', 'vision', 150) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 150;


-- ──── H2406-121-000  UnitedHealthcare — AARP Medicare Advantage Extras from UHC EP-3 (PPO) (TX)
-- H2406-121-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2406', '121', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2406-121-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2406', '121', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2406-121-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2406', '121', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H2406-135-000  UnitedHealthcare — AARP Medicare Advantage from UHC EP-4 (PPO) (TX)
-- H2406-135-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2406', '135', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2406-135-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2406', '135', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2406-135-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H2406', '135', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H3288-007-000  Aetna Medicare — Aetna Medicare Enhanced (PPO) (TX)
-- H3288-007-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '007', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3288-007-000  dental.max_coverage: CMS=1000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3288', '007', '000', 'dental', 1000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 1000;


-- ──── H3407-001-000  El Paso Health Medicare Advantage — El Paso Health Medicare Advantage Dual (HMO D-SNP) (TX)
-- H3407-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3407', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3407-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3407', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3407-001-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3407', '001', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H3407-002-000  El Paso Health Medicare Advantage — El Paso Health Total (HMO) (TX)
-- H3407-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3407', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3407-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3407', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3407-002-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3407', '002', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H3407-003-000  El Paso Health Medicare Advantage — El Paso Health Giveback (HMO) (TX)
-- H3407-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3407', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3407-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3407', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3407-003-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3407', '003', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H4461-061-000  Humana — Humana Gold Plus H4461-061 (HMO) (TX)
-- H4461-061-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '061', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-061-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '061', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-061-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '061', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4513-060-003  HealthSpring — HealthSpring TotalCare (HMO D-SNP) (TX)
-- H4513-060-003  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '060', '003', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-060-003  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '060', '003', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-060-003  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '060', '003', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4513-061-003  HealthSpring — HealthSpring Preferred (HMO) (TX)
-- H4513-061-003  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '061', '003', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-061-003  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '061', '003', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-061-003  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '061', '003', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H4513-083-003  HealthSpring — HealthSpring Preferred Savings (HMO) (TX)
-- H4513-083-003  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '083', '003', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-083-003  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '083', '003', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-083-003  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '083', '003', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H4513-093-000  HealthSpring — HealthSpring Preferred Full Savings (HMO) (TX)
-- H4513-093-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '093', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-093-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '093', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-093-000  vision.max_coverage: CMS=125 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '093', '000', 'vision', 125) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 125;


-- ──── H4523-042-000  Aetna Medicare — Aetna Medicare Signature (HMO) (TX)
-- H4523-042-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4523', '042', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4523-042-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4523', '042', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;

-- H4523-042-000  hearing.copay: CMS=50 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H4523', '042', '000', 'hearing', 50) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 50;


-- ──── H4527-005-000  UnitedHealthcare — AARP Medicare Advantage from UHC TX-0013 (HMO-POS) (TX)
-- H4527-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-005-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '005', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-005-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '005', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H4527-040-000  UnitedHealthcare — UHC Complete Care TX-17 (HMO-POS C-SNP) (TX)
-- H4527-040-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '040', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-040-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4527', '040', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4527-040-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4527', '040', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5216-353-000  Humana — HumanaChoice H5216-353 (PPO) (TX)
-- H5216-353-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '353', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-353-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '353', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5216-433-000  Humana — HumanaChoice Giveback H5216-433 (PPO) (TX)
-- H5216-433-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '433', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5216-433-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5216', '433', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H5472-001-000  Alignment Health Plan — Alignment Health the ONE + Walgreens (HMO-POS) (TX)
-- H5472-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5472', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5472-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5472', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5472-001-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5472', '001', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5472-002-000  Alignment Health Plan — Alignment Health Heart & Diabetes (HMO-POS C-SNP) (TX)
-- H5472-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5472', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5472-002-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5472', '002', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5472-002-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5472', '002', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H5472-003-000  Alignment Health Plan — Alignment Health smartHMO (HMO-POS) (TX)
-- H5472-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5472', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5472-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5472', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5472-003-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5472', '003', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H5472-004-000  Alignment Health Plan — Alignment Health Heart & Diabetes Plus (HMO-POS C-SNP) (TX)
-- H5472-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5472', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5472-004-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5472', '004', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5472-004-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5472', '004', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H5472-007-000  Alignment Health Plan — Alignment Health Dual Select+ (HMO-POS D-SNP) (TX)
-- H5472-007-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5472', '007', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5472-007-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5472', '007', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5472-007-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5472', '007', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H5472-009-000  Alignment Health Plan — Alignment Health Total Dual+ (HMO-POS D-SNP) (TX)
-- H5472-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5472', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5472-009-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5472', '009', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5472-009-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5472', '009', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H5472-010-000  Alignment Health Plan — Alignment Health smartSavings (HMO-POS) (TX)
-- H5472-010-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5472', '010', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5472-010-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5472', '010', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5472-010-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5472', '010', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;


-- ──── H6515-003-000  Molina Healthcare of Texas, Inc. — Molina Medicare Complete Care Plus (HMO D-SNP) (TX)
-- H6515-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6515', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6515-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6515', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6515-003-000  dental.max_coverage: CMS=4000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6515', '003', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H6515-003-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6515', '003', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H7617-063-000  Humana — HumanaChoice H7617-063 (PPO) (TX)
-- H7617-063-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '063', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7617-063-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7617', '063', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H7993-007-000  Devoted Health — DEVOTED CORE 007 TX (HMO) (TX)
-- H7993-007-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '007', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-007-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '007', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-007-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '007', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H7993-008-000  Devoted Health — DEVOTED GIVEBACK 008 TX (HMO) (TX)
-- H7993-008-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '008', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-008-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '008', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-008-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '008', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H7993-017-000  Devoted Health — DEVOTED DUAL 017 TX (HMO D-SNP) (TX)
-- H7993-017-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '017', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-017-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '017', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-017-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '017', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H7993-027-000  Devoted Health — DEVOTED C-SNP 027 TX (HMO C-SNP) (TX)
-- H7993-027-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '027', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-027-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '027', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-027-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '027', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H7993-028-000  Devoted Health — DEVOTED C-SNP PREMIUM 028 TX (HMO C-SNP) (TX)
-- H7993-028-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '028', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-028-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '028', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-028-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '028', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H7993-029-000  Devoted Health — DEVOTED C-SNP PLUS 029 TX (HMO C-SNP) (TX)
-- H7993-029-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '029', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-029-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '029', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-029-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '029', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H7993-038-000  Devoted Health — DEVOTED DUAL FULL 038 TX (HMO D-SNP) (TX)
-- H7993-038-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '038', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-038-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H7993', '038', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H7993-038-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H7993', '038', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H8332-004-000  Aetna Medicare — Aetna Medicare Prime (HMO) (TX)
-- H8332-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8332', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8332-004-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8332', '004', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;

-- H8332-004-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H8332', '004', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H8849-010-004  Wellpoint — Wellpoint Full Dual Advantage (HMO D-SNP) (TX)
-- H8849-010-004  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8849', '010', '004', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8849-010-004  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8849', '010', '004', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H8849-011-004  Wellpoint — Wellpoint Dual Advantage (HMO D-SNP) (TX)
-- H8849-011-004  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8849', '011', '004', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8849-011-004  vision.max_coverage: CMS=275 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8849', '011', '004', 'vision', 275) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 275;


-- ──── H0028-072-000  Humana — Humana Gold Plus H0028-072 (HMO) (TX)
-- H0028-072-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '072', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-072-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0028', '072', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0028-072-000  vision.max_coverage: CMS=450 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0028', '072', '000', 'vision', 450) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 450;


-- ──── H4461-049-000  Humana — Humana Total Complete H4461-049 (HMO) (TX)
-- H4461-049-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '049', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-049-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4461', '049', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4461-049-000  vision.max_coverage: CMS=400 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4461', '049', '000', 'vision', 400) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 400;


-- ──── H4514-016-000  UnitedHealthcare — UHC Dual Complete TX-D01P (HMO-POS D-SNP) (TX)
-- H4514-016-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '016', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-016-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '016', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-016-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4514', '016', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H4514-018-000  UnitedHealthcare — UHC Dual Complete TX-V01P (HMO-POS D-SNP) (TX)
-- H4514-018-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '018', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-018-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '018', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-018-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4514', '018', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H4523-037-000  Aetna Medicare — Aetna Medicare Prime Chronic Care (HMO C-SNP) (TX)
-- H4523-037-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4523', '037', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4523-037-000  vision.max_coverage: CMS=100 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4523', '037', '000', 'vision', 100) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 100;

-- H4523-037-000  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H4523', '037', '000', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H5163-001-000  Verda Health Plan of Texas — Verda Noble Care (HMO) (TX)
-- H5163-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5163', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5163-001-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5163', '001', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H5163-002-000  Verda Health Plan of Texas — Verda Noble Chronic Care (HMO C-SNP) (TX)
-- H5163-002-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H5163', '002', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H5163-002-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H5163', '002', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H8849-003-000  Wellpoint — Wellpoint Chronic Care (HMO-POS C-SNP) (TX)
-- H8849-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8849', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8849-003-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8849', '003', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H8849-009-000  Wellpoint — Wellpoint Select (HMO-POS) (TX)
-- H8849-009-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8849', '009', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8849-009-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8849', '009', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;

-- H8849-009-000  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H8849', '009', '000', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H4523-031-000  Aetna Medicare — Aetna Medicare Signature (HMO) (TX)
-- H4523-031-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4523', '031', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4523-031-000  vision.max_coverage: CMS=125 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4523', '031', '000', 'vision', 125) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 125;

-- H4523-031-000  hearing.copay: CMS=55 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H4523', '031', '000', 'hearing', 55) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 55;


-- ──── H4513-026-000  HealthSpring — HealthSpring Preferred (HMO) (TX)
-- H4513-026-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '026', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-026-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '026', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-026-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '026', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4513-027-000  HealthSpring — HealthSpring TotalCare (HMO D-SNP) (TX)
-- H4513-027-000  partb_drugs.coinsurance: CMS=0 DB=15  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '027', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-027-000  insulin.coinsurance: CMS=0 DB=15  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '027', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-027-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '027', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;


-- ──── H4513-083-006  HealthSpring — HealthSpring Preferred Savings (HMO) (TX)
-- H4513-083-006  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '083', '006', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-083-006  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4513', '083', '006', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4513-083-006  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4513', '083', '006', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H1189-010-000  CHRISTUS Health Advantage — CHRISTUS Health Medicare Plus (HMO) (TX)
-- H1189-010-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H1189', '010', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H1189-010-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H1189', '010', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H3288-003-000  Aetna Medicare — Aetna Medicare Value Plus (PPO) (TX)
-- H3288-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3288-003-000  dental.max_coverage: CMS=1000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3288', '003', '000', 'dental', 1000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 1000;


-- ──── H3288-047-000  Aetna Medicare — Aetna Medicare Enhanced (PPO) (TX)
-- H3288-047-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '047', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3288-047-000  dental.max_coverage: CMS=1000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3288', '047', '000', 'dental', 1000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 1000;

-- H3288-047-000  hearing.copay: CMS=40 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3288', '047', '000', 'hearing', 40) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 40;


-- ──── H3868-001-000  UnitedHealthcare — UHC Dual Complete TX-Y1 (HMO-POS D-SNP) (TX)
-- H3868-001-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3868', '001', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3868-001-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3868', '001', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3868-001-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3868', '001', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;


-- ──── H4514-024-000  UnitedHealthcare — UHC Dual Complete TX-Q3 (HMO-POS D-SNP) (TX)
-- H4514-024-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '024', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-024-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4514', '024', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4514-024-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4514', '024', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H4523-024-000  Aetna Medicare — Aetna Medicare Prime Care (HMO) (TX)
-- H4523-024-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4523', '024', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4523-024-000  vision.max_coverage: CMS=200 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4523', '024', '000', 'vision', 200) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 200;

-- H4523-024-000  hearing.copay: CMS=30 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H4523', '024', '000', 'hearing', 30) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 30;


-- ──── H6515-004-000  Molina Healthcare of Texas, Inc. — Molina Medicare Complete Care Plus (HMO D-SNP) (TX)
-- H6515-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6515', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6515-004-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6515', '004', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6515-004-000  dental.max_coverage: CMS=4000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6515', '004', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H6515-004-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6515', '004', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;


-- ──── H8849-005-000  Wellpoint — Wellpoint Lung Care (HMO-POS C-SNP) (TX)
-- H8849-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H8849', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H8849-005-000  vision.max_coverage: CMS=300 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H8849', '005', '000', 'vision', 300) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 300;

-- H8849-005-000  hearing.copay: CMS=20 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H8849', '005', '000', 'hearing', 20) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 20;


-- ──── H0473-003-000  Humana — HumanaChoice H0473-003 (PPO) (TX)
-- H0473-003-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0473', '003', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0473-003-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0473', '003', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;


-- ──── H2293-026-000  Aetna Medicare — Aetna Medicare Signature (PPO) (TX)
-- H2293-026-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H2293', '026', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H2293-026-000  hearing.copay: CMS=65 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H2293', '026', '000', 'hearing', 65) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 65;


-- ──── H3288-004-000  Aetna Medicare — Aetna Medicare Value Plus (PPO) (TX)
-- H3288-004-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H3288', '004', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H3288-004-000  dental.max_coverage: CMS=2000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H3288', '004', '000', 'dental', 2000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 2000;

-- H3288-004-000  hearing.copay: CMS=45 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, copay) VALUES ('H3288', '004', '000', 'hearing', 45) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET copay = 45;


-- ──── H4523-028-000  Aetna Medicare — Aetna Medicare Full Dual (HMO D-SNP) (TX)
-- H4523-028-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H4523', '028', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H4523-028-000  vision.max_coverage: CMS=350 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H4523', '028', '000', 'vision', 350) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 350;


-- ──── H0062-012-000  Wellcare — Wellcare Superior HealthPlan Dual Align (HMO D-SNP) (TX)
-- H0062-012-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H0062', '012', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H0062-012-000  dental.max_coverage: CMS=5000 DB=0  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0062', '012', '000', 'dental', 5000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 5000;

-- H0062-012-000  vision.max_coverage: CMS=500 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H0062', '012', '000', 'vision', 500) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 500;


-- ──── H6515-005-000  Molina Healthcare of Texas, Inc. — Molina Medicare Complete Care Plus (HMO D-SNP) (TX)
-- H6515-005-000  partb_drugs.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6515', '005', '000', 'partb_drugs', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6515-005-000  insulin.coinsurance: CMS=0 DB=20  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, coinsurance) VALUES ('H6515', '005', '000', 'insulin', 0) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET coinsurance = 0;

-- H6515-005-000  dental.max_coverage: CMS=4000 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6515', '005', '000', 'dental', 4000) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 4000;

-- H6515-005-000  vision.max_coverage: CMS=250 DB=None  [safe]
INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, max_coverage) VALUES ('H6515', '005', '000', 'vision', 250) ON CONFLICT (contract_id, plan_id, segment_id, benefit_category) DO UPDATE SET max_coverage = 250;



-- COMMIT;  -- uncomment when verified
-- ROLLBACK;
