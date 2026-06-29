-- dsnp-food-card-import.sql
-- Generated 2026-06-29T23:20:48.722Z from
-- /Users/robertsimm/Downloads/dsnp-food-card-capture - D-SNP Food Card Capture.csv
-- Target: pbp_benefits_v2 (NOT the pbp_benefits view)
-- Project: rpcbrkmvalvdmroqzpaq (plan-match-prod)
-- Rows: 54 (32 food_card + 22 otc_allowance)
-- Provenance: source='manual' (top priority for food_card/otc_allowance per api/plans.ts:372-377)
-- Description prefix: '[manual_capture_2026-06-29]'
-- Amount lands in copay (read path source of truth per api/plans.ts:412), plus copay_max (annual cap) and coverage_amount (semantic).
-- tier_id left NULL — does not collide with existing tier_id='0' placeholder rows, manual source wins priority.

BEGIN;

-- H5422-019 GA Anthem Blue Cross and Blue Shield → food_card $110.00/mo (raw=$110/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H5422', '019', '0', 2026, 'food_card', 110.00, 1320.00, 110.00, 'manual', '[manual_capture_2026-06-29] $110.00 per month — Anthem Everyday Options Allowance: combined Assistive Devices + Healthy Foods + OTC + Utilities, $110/mo. Source: shop.anthem.com. ZIP 30303.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H8390-015 GA CareSource → food_card $240.00/mo (raw=$240/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H8390', '015', '0', 2026, 'food_card', 240.00, 2880.00, 240.00, 'manual', '[manual_capture_2026-06-29] $240.00 per month — CareSource Healthy Benefits+ card $240/mo: OTC + supplemental dental/vision/hearing. Healthy food, utilities & other items only for members with qualifying chronic conditions (SSBCI). Rolls over monthly. Source: 2026 Summary of Benefits. ZIP 30303.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H8390-017 GA CareSource → food_card $196.00/mo (raw=$196/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H8390', '017', '0', 2026, 'food_card', 196.00, 2352.00, 196.00, 'manual', '[manual_capture_2026-06-29] $196.00 per month — CareSource Healthy Benefits+ card $196/mo: OTC + supplemental dental/vision/hearing. Healthy food, utilities & other items only for members with qualifying chronic conditions (SSBCI). Rolls over monthly. Source: 2026 Summary of Benefits. ZIP 30303.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H5216-206 GA Humana → food_card $0.00/mo (raw=$0/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H5216', '206', '0', 2026, 'food_card', 0.00, 0.00, 0.00, 'manual', '[manual_capture_2026-06-29] $0.00 per month — No food/OTC flex card on this plan; OTC listed as Not Covered. Source: 2026 CMS plan-benefit data.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H3291-002 GA PruittHealth Premier → food_card $250.00/mo (raw=$250/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H3291', '002', '0', 2026, 'food_card', 250.00, 3000.00, 250.00, 'manual', '[manual_capture_2026-06-29] $250.00 per month — PruittHealth Healthy Living Flex Card $250/mo: OTC, fitness, personal care, home maintenance. Groceries, utilities & rent/mortgage only for chronically-ill members (SSBCI). Source: pruitthealthpremier.com 2026. ZIP 30303.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H2406-052 GA UnitedHealthcare → food_card $52.00/mo (raw=$52/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H2406', '052', '0', 2026, 'food_card', 52.00, 624.00, 52.00, 'manual', '[manual_capture_2026-06-29] $52.00 per month — UnitedHealthcare UCard: combined OTC + healthy food + utilities credit, loaded monthly. Source: uhc.com plan finder. ZIP 30303.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H3256-004 GA UnitedHealthcare → food_card $184.00/mo (raw=$184/monthly, seg=1)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H3256', '004', '1', 2026, 'food_card', 184.00, 2208.00, 184.00, 'manual', '[manual_capture_2026-06-29] $184.00 per month — UnitedHealthcare UCard: combined OTC + healthy food + utilities credit, loaded monthly. Source: uhc.com plan finder. ZIP 30303.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H3256-004 GA UnitedHealthcare → food_card $184.00/mo (raw=$184/monthly, seg=2)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H3256', '004', '2', 2026, 'food_card', 184.00, 2208.00, 184.00, 'manual', '[manual_capture_2026-06-29] $184.00 per month — UnitedHealthcare UCard: combined OTC + healthy food + utilities credit, loaded monthly. Source: uhc.com plan finder. ZIP 30303.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H3256-005 GA UnitedHealthcare → food_card $96.00/mo (raw=$96/monthly, seg=1)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H3256', '005', '1', 2026, 'food_card', 96.00, 1152.00, 96.00, 'manual', '[manual_capture_2026-06-29] $96.00 per month — UnitedHealthcare UCard: combined OTC + healthy food + utilities credit, loaded monthly. Source: uhc.com plan finder. ZIP 30303.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H3256-005 GA UnitedHealthcare → food_card $96.00/mo (raw=$96/monthly, seg=2)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H3256', '005', '2', 2026, 'food_card', 96.00, 1152.00, 96.00, 'manual', '[manual_capture_2026-06-29] $96.00 per month — UnitedHealthcare UCard: combined OTC + healthy food + utilities credit, loaded monthly. Source: uhc.com plan finder. ZIP 30303.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H3256-006 GA UnitedHealthcare → food_card $65.00/mo (raw=$65/monthly, seg=1)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H3256', '006', '1', 2026, 'food_card', 65.00, 780.00, 65.00, 'manual', '[manual_capture_2026-06-29] $65.00 per month — UnitedHealthcare UCard: combined OTC + healthy food + utilities credit, loaded monthly. Source: uhc.com plan finder. ZIP 30303.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H3256-006 GA UnitedHealthcare → food_card $65.00/mo (raw=$65/monthly, seg=2)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H3256', '006', '2', 2026, 'food_card', 65.00, 780.00, 65.00, 'manual', '[manual_capture_2026-06-29] $65.00 per month — UnitedHealthcare UCard: combined OTC + healthy food + utilities credit, loaded monthly. Source: uhc.com plan finder. ZIP 30303.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H5322-049 GA UnitedHealthcare → food_card $240.00/mo (raw=$240/monthly, seg=1)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H5322', '049', '1', 2026, 'food_card', 240.00, 2880.00, 240.00, 'manual', '[manual_capture_2026-06-29] $240.00 per month — UnitedHealthcare UCard: combined OTC + healthy food + utilities credit, loaded monthly. Source: uhc.com plan finder. ZIP 30303.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H5322-049 GA UnitedHealthcare → food_card $240.00/mo (raw=$240/monthly, seg=2)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H5322', '049', '2', 2026, 'food_card', 240.00, 2880.00, 240.00, 'manual', '[manual_capture_2026-06-29] $240.00 per month — UnitedHealthcare UCard: combined OTC + healthy food + utilities credit, loaded monthly. Source: uhc.com plan finder. ZIP 30303.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H5322-050 GA UnitedHealthcare → food_card $131.00/mo (raw=$131/monthly, seg=1)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H5322', '050', '1', 2026, 'food_card', 131.00, 1572.00, 131.00, 'manual', '[manual_capture_2026-06-29] $131.00 per month — UnitedHealthcare UCard: combined OTC + healthy food + utilities credit, loaded monthly. Source: uhc.com plan finder. ZIP 30303.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H5322-050 GA UnitedHealthcare → food_card $131.00/mo (raw=$131/monthly, seg=2)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H5322', '050', '2', 2026, 'food_card', 131.00, 1572.00, 131.00, 'manual', '[manual_capture_2026-06-29] $131.00 per month — UnitedHealthcare UCard: combined OTC + healthy food + utilities credit, loaded monthly. Source: uhc.com plan finder. ZIP 30303.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H0111-004 GA Wellcare → food_card $0.00/mo (raw=$0/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H0111', '004', '0', 2026, 'food_card', 0.00, 0.00, 0.00, 'manual', '[manual_capture_2026-06-29] $0.00 per month — No OTC or food allowance; this PPO D-SNP offers a $1/mo Part B giveback instead. Source: Wellcare 2026 plan finder.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H1112-006 GA Wellcare → otc_allowance $119.00/mo (raw=$119/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H1112', '006', '0', 2026, 'otc_allowance', 119.00, 1428.00, 119.00, 'manual', '[manual_capture_2026-06-29] $119.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $119/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 30303.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H1112-033 GA Wellcare → otc_allowance $199.00/mo (raw=$199/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H1112', '033', '0', 2026, 'otc_allowance', 199.00, 2388.00, 199.00, 'manual', '[manual_capture_2026-06-29] $199.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $199/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 30303.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H1112-046 GA Wellcare → otc_allowance $65.00/mo (raw=$65/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H1112', '046', '0', 2026, 'otc_allowance', 65.00, 780.00, 65.00, 'manual', '[manual_capture_2026-06-29] $65.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $65/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 30303.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H1112-047 GA Wellcare → otc_allowance $91.00/mo (raw=$91/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H1112', '047', '0', 2026, 'otc_allowance', 91.00, 1092.00, 91.00, 'manual', '[manual_capture_2026-06-29] $91.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $91/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 30060.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H1112-048 GA Wellcare → otc_allowance $32.00/mo (raw=$32/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H1112', '048', '0', 2026, 'otc_allowance', 32.00, 384.00, 32.00, 'manual', '[manual_capture_2026-06-29] $32.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $32/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 30060.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H6351-005 NC Liberty Medicare Advantage → food_card $0.00/mo (raw=$0/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H6351', '005', '0', 2026, 'food_card', 0.00, 0.00, 0.00, 'manual', '[manual_capture_2026-06-29] $0.00 per month — No OTC/food/flex allowance found in 2026 CMS plan-benefit data (new plan). Recommend confirming with the plan if this figure is critical.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H5253-041 NC UnitedHealthcare → food_card $230.00/mo (raw=$230/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H5253', '041', '0', 2026, 'food_card', 230.00, 2760.00, 230.00, 'manual', '[manual_capture_2026-06-29] $230.00 per month — UnitedHealthcare UCard: combined OTC + healthy food + utilities credit, loaded monthly. Source: uhc.com plan finder. ZIP 27601.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H5253-116 NC UnitedHealthcare → food_card $71.00/mo (raw=$71/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H5253', '116', '0', 2026, 'food_card', 71.00, 852.00, 71.00, 'manual', '[manual_capture_2026-06-29] $71.00 per month — UnitedHealthcare UCard: combined OTC + healthy food + utilities credit, loaded monthly. Source: uhc.com plan finder. ZIP 27601.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H5253-184 NC UnitedHealthcare → food_card $331.00/mo (raw=$331/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H5253', '184', '0', 2026, 'food_card', 331.00, 3972.00, 331.00, 'manual', '[manual_capture_2026-06-29] $331.00 per month — UnitedHealthcare UCard: combined OTC + healthy food + utilities credit, loaded monthly. Source: uhc.com plan finder. ZIP 27601.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H4073-004 NC Wellcare → otc_allowance $207.00/mo (raw=$207/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H4073', '004', '0', 2026, 'otc_allowance', 207.00, 2484.00, 207.00, 'manual', '[manual_capture_2026-06-29] $207.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $207/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 27601.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H6515-001 TX Molina Healthcare of Texas, Inc. → food_card $145.00/mo (raw=$145/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H6515', '001', '0', 2026, 'food_card', 145.00, 1740.00, 145.00, 'manual', '[manual_capture_2026-06-29] $145.00 per month — Molina MyChoice card $145/mo: combined allowance for OTC, OTC hearing aids, non-medical transportation & utilities. Food & produce included for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 78205.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H6515-002 TX Molina Healthcare of Texas, Inc. → food_card $137.00/mo (raw=$137/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H6515', '002', '0', 2026, 'food_card', 137.00, 1644.00, 137.00, 'manual', '[manual_capture_2026-06-29] $137.00 per month — Molina MyChoice card $137/mo: combined allowance for OTC, OTC hearing aids, non-medical transportation & utilities. Food & produce included for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 75201.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H6515-003 TX Molina Healthcare of Texas, Inc. → food_card $100.00/mo (raw=$100/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H6515', '003', '0', 2026, 'food_card', 100.00, 1200.00, 100.00, 'manual', '[manual_capture_2026-06-29] $100.00 per month — Molina MyChoice card $100/mo: combined allowance for OTC, OTC hearing aids, non-medical transportation & utilities. Food & produce included for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 79901.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H6515-004 TX Molina Healthcare of Texas, Inc. → food_card $73.00/mo (raw=$73/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H6515', '004', '0', 2026, 'food_card', 73.00, 876.00, 73.00, 'manual', '[manual_capture_2026-06-29] $73.00 per month — Molina MyChoice card $73/mo: combined allowance for OTC, OTC hearing aids, non-medical transportation & utilities. Food & produce included for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 77002.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H6515-005 TX Molina Healthcare of Texas, Inc. → food_card $168.00/mo (raw=$168/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H6515', '005', '0', 2026, 'food_card', 168.00, 2016.00, 168.00, 'manual', '[manual_capture_2026-06-29] $168.00 per month — Molina MyChoice card $168/mo: combined allowance for OTC, OTC hearing aids, non-medical transportation & utilities. Food & produce included for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 78501.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H4514-023 TX UnitedHealthcare → food_card $53.00/mo (raw=$53/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H4514', '023', '0', 2026, 'food_card', 53.00, 636.00, 53.00, 'manual', '[manual_capture_2026-06-29] $53.00 per month — UnitedHealthcare UCard: combined OTC + healthy food + utilities credit, loaded monthly. Source: uhc.com plan finder. ZIP 78701.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H0062-011 TX Wellcare → otc_allowance $173.00/mo (raw=$173/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H0062', '011', '0', 2026, 'otc_allowance', 173.00, 2076.00, 173.00, 'manual', '[manual_capture_2026-06-29] $173.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $173/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 75201.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H0062-012 TX Wellcare → otc_allowance $177.00/mo (raw=$177/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H0062', '012', '0', 2026, 'otc_allowance', 177.00, 2124.00, 177.00, 'manual', '[manual_capture_2026-06-29] $177.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $177/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 78501.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H0174-004 TX Wellcare → otc_allowance $87.00/mo (raw=$87/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H0174', '004', '0', 2026, 'otc_allowance', 87.00, 1044.00, 87.00, 'manual', '[manual_capture_2026-06-29] $87.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $87/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 77002.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H0174-006 TX Wellcare → otc_allowance $123.00/mo (raw=$123/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H0174', '006', '0', 2026, 'otc_allowance', 123.00, 1476.00, 123.00, 'manual', '[manual_capture_2026-06-29] $123.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $123/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 77002.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H0174-022 TX Wellcare → otc_allowance $69.00/mo (raw=$69/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H0174', '022', '0', 2026, 'otc_allowance', 69.00, 828.00, 69.00, 'manual', '[manual_capture_2026-06-29] $69.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $69/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 77002.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H0174-023 TX Wellcare → otc_allowance $112.00/mo (raw=$112/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H0174', '023', '0', 2026, 'otc_allowance', 112.00, 1344.00, 112.00, 'manual', '[manual_capture_2026-06-29] $112.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $112/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 75002.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H0174-024 TX Wellcare → otc_allowance $112.00/mo (raw=$112/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H0174', '024', '0', 2026, 'otc_allowance', 112.00, 1344.00, 112.00, 'manual', '[manual_capture_2026-06-29] $112.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $112/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 78701.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H0174-025 TX Wellcare → otc_allowance $112.00/mo (raw=$112/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H0174', '025', '0', 2026, 'otc_allowance', 112.00, 1344.00, 112.00, 'manual', '[manual_capture_2026-06-29] $112.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $112/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 76501.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H0174-026 TX Wellcare → otc_allowance $114.00/mo (raw=$114/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H0174', '026', '0', 2026, 'otc_allowance', 114.00, 1368.00, 114.00, 'manual', '[manual_capture_2026-06-29] $114.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $114/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 79714.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H5294-010 TX Wellcare → otc_allowance $174.00/mo (raw=$174/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H5294', '010', '0', 2026, 'otc_allowance', 174.00, 2088.00, 174.00, 'manual', '[manual_capture_2026-06-29] $174.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $174/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 78520.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H5294-015 TX Wellcare → otc_allowance $62.00/mo (raw=$62/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H5294', '015', '0', 2026, 'otc_allowance', 62.00, 744.00, 62.00, 'manual', '[manual_capture_2026-06-29] $62.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $62/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 78501.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H5294-021 TX Wellcare → otc_allowance $176.00/mo (raw=$176/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H5294', '021', '0', 2026, 'otc_allowance', 176.00, 2112.00, 176.00, 'manual', '[manual_capture_2026-06-29] $176.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $176/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 78520.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H5294-022 TX Wellcare → otc_allowance $172.00/mo (raw=$172/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H5294', '022', '0', 2026, 'otc_allowance', 172.00, 2064.00, 172.00, 'manual', '[manual_capture_2026-06-29] $172.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $172/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 78401.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H5294-023 TX Wellcare → otc_allowance $172.00/mo (raw=$172/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H5294', '023', '0', 2026, 'otc_allowance', 172.00, 2064.00, 172.00, 'manual', '[manual_capture_2026-06-29] $172.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $172/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 79401.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H5294-024 TX Wellcare → otc_allowance $172.00/mo (raw=$172/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H5294', '024', '0', 2026, 'otc_allowance', 172.00, 2064.00, 172.00, 'manual', '[manual_capture_2026-06-29] $172.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $172/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 76634.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H5294-025 TX Wellcare → otc_allowance $172.00/mo (raw=$172/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H5294', '025', '0', 2026, 'otc_allowance', 172.00, 2064.00, 172.00, 'manual', '[manual_capture_2026-06-29] $172.00 per month — Wellcare Spendables card: combined OTC + Dental/Vision/Hearing allowance $172/mo, rolls over within plan year. No separate grocery/food line in plan finder. Source: Wellcare 2026 plan finder. ZIP 79019.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H2593-032 TX Wellpoint → food_card $50.00/mo (raw=$50/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H2593', '032', '0', 2026, 'food_card', 50.00, 600.00, 50.00, 'manual', '[manual_capture_2026-06-29] $50.00 per month — Wellpoint Everyday Options Allowance (Benefits Mastercard) $50/mo: Assistive Devices + OTC products. Healthy Foods & Utilities only for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 77002.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H2593-044 TX Wellpoint → food_card $215.00/mo (raw=$215/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H2593', '044', '0', 2026, 'food_card', 215.00, 2580.00, 215.00, 'manual', '[manual_capture_2026-06-29] $215.00 per month — Wellpoint Everyday Options Allowance (Benefits Mastercard) $215/mo: Assistive Devices + OTC products. Healthy Foods & Utilities only for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 77701.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H2593-045 TX Wellpoint → food_card $200.00/mo (raw=$200/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H2593', '045', '0', 2026, 'food_card', 200.00, 2400.00, 200.00, 'manual', '[manual_capture_2026-06-29] $200.00 per month — Wellpoint Everyday Options Allowance (Benefits Mastercard) $200/mo: Assistive Devices + OTC products. Healthy Foods & Utilities only for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 78401.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H2593-046 TX Wellpoint → food_card $175.00/mo (raw=$175/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H2593', '046', '0', 2026, 'food_card', 175.00, 2100.00, 175.00, 'manual', '[manual_capture_2026-06-29] $175.00 per month — Wellpoint Everyday Options Allowance (Benefits Mastercard) $175/mo: Assistive Devices + OTC products. Healthy Foods & Utilities only for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 79714.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H2593-047 TX Wellpoint → food_card $160.00/mo (raw=$160/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H2593', '047', '0', 2026, 'food_card', 160.00, 1920.00, 160.00, 'manual', '[manual_capture_2026-06-29] $160.00 per month — Wellpoint Everyday Options Allowance (Benefits Mastercard) $160/mo: Assistive Devices + OTC products. Healthy Foods & Utilities only for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 79401.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H2593-048 TX Wellpoint → food_card $165.00/mo (raw=$165/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H2593', '048', '0', 2026, 'food_card', 165.00, 1980.00, 165.00, 'manual', '[manual_capture_2026-06-29] $165.00 per month — Wellpoint Everyday Options Allowance (Benefits Mastercard) $165/mo: Assistive Devices + OTC products. Healthy Foods & Utilities only for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 77002.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H2593-051 TX Wellpoint → food_card $125.00/mo (raw=$125/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H2593', '051', '0', 2026, 'food_card', 125.00, 1500.00, 125.00, 'manual', '[manual_capture_2026-06-29] $125.00 per month — Wellpoint Everyday Options Allowance (Benefits Mastercard) $125/mo: Assistive Devices + OTC products. Healthy Foods & Utilities only for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 78205.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H2593-053 TX Wellpoint → food_card $175.00/mo (raw=$175/monthly, seg=0)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H2593', '053', '0', 2026, 'food_card', 175.00, 2100.00, 175.00, 'manual', '[manual_capture_2026-06-29] $175.00 per month — Wellpoint Everyday Options Allowance (Benefits Mastercard) $175/mo: Assistive Devices + OTC products. Healthy Foods & Utilities only for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 78501.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H8849-010 TX Wellpoint → food_card $180.00/mo (raw=$180/monthly, seg=1)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H8849', '010', '1', 2026, 'food_card', 180.00, 2160.00, 180.00, 'manual', '[manual_capture_2026-06-29] $180.00 per month — Wellpoint Everyday Options Allowance (Benefits Mastercard) $180/mo: Assistive Devices + OTC products. Healthy Foods & Utilities only for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 77002.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H8849-010 TX Wellpoint → food_card $180.00/mo (raw=$180/monthly, seg=2)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H8849', '010', '2', 2026, 'food_card', 180.00, 2160.00, 180.00, 'manual', '[manual_capture_2026-06-29] $180.00 per month — Wellpoint Everyday Options Allowance (Benefits Mastercard) $180/mo: Assistive Devices + OTC products. Healthy Foods & Utilities only for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 77002.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H8849-010 TX Wellpoint → food_card $180.00/mo (raw=$180/monthly, seg=4)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H8849', '010', '4', 2026, 'food_card', 180.00, 2160.00, 180.00, 'manual', '[manual_capture_2026-06-29] $180.00 per month — Wellpoint Everyday Options Allowance (Benefits Mastercard) $180/mo: Assistive Devices + OTC products. Healthy Foods & Utilities only for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 77002.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H8849-010 TX Wellpoint → food_card $180.00/mo (raw=$180/monthly, seg=5)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H8849', '010', '5', 2026, 'food_card', 180.00, 2160.00, 180.00, 'manual', '[manual_capture_2026-06-29] $180.00 per month — Wellpoint Everyday Options Allowance (Benefits Mastercard) $180/mo: Assistive Devices + OTC products. Healthy Foods & Utilities only for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 77002.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H8849-011 TX Wellpoint → food_card $80.00/mo (raw=$80/monthly, seg=1)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H8849', '011', '1', 2026, 'food_card', 80.00, 960.00, 80.00, 'manual', '[manual_capture_2026-06-29] $80.00 per month — Wellpoint Everyday Options Allowance (Benefits Mastercard) $80/mo: Assistive Devices + OTC products. Healthy Foods & Utilities only for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 77002.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H8849-011 TX Wellpoint → food_card $80.00/mo (raw=$80/monthly, seg=2)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H8849', '011', '2', 2026, 'food_card', 80.00, 960.00, 80.00, 'manual', '[manual_capture_2026-06-29] $80.00 per month — Wellpoint Everyday Options Allowance (Benefits Mastercard) $80/mo: Assistive Devices + OTC products. Healthy Foods & Utilities only for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 77002.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H8849-011 TX Wellpoint → food_card $80.00/mo (raw=$80/monthly, seg=3)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H8849', '011', '3', 2026, 'food_card', 80.00, 960.00, 80.00, 'manual', '[manual_capture_2026-06-29] $80.00 per month — Wellpoint Everyday Options Allowance (Benefits Mastercard) $80/mo: Assistive Devices + OTC products. Healthy Foods & Utilities only for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 77002.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H8849-011 TX Wellpoint → food_card $80.00/mo (raw=$80/monthly, seg=4)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H8849', '011', '4', 2026, 'food_card', 80.00, 960.00, 80.00, 'manual', '[manual_capture_2026-06-29] $80.00 per month — Wellpoint Everyday Options Allowance (Benefits Mastercard) $80/mo: Assistive Devices + OTC products. Healthy Foods & Utilities only for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 77002.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

-- H8849-011 TX Wellpoint → food_card $80.00/mo (raw=$80/monthly, seg=5)
INSERT INTO pbp_benefits_v2 (contract_id, plan_id, segment_id, plan_year, benefit_type, copay, copay_max, coverage_amount, source, description)
VALUES ('H8849', '011', '5', 2026, 'food_card', 80.00, 960.00, 80.00, 'manual', '[manual_capture_2026-06-29] $80.00 per month — Wellpoint Everyday Options Allowance (Benefits Mastercard) $80/mo: Assistive Devices + OTC products. Healthy Foods & Utilities only for chronically-ill members (SSBCI). No rollover. Source: 2026 Summary of Benefits. ZIP 77002.')
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id, ''))
DO UPDATE SET copay = EXCLUDED.copay, copay_max = EXCLUDED.copay_max, coverage_amount = EXCLUDED.coverage_amount, source = EXCLUDED.source, description = EXCLUDED.description;

COMMIT;

-- ─── Verification ───────────────────────────────────────────────
-- 1. Inserted-row counts by benefit_type (this batch)
SELECT benefit_type, COUNT(*)
FROM pbp_benefits_v2
WHERE source = 'manual' AND description LIKE '[manual_capture_2026-06-29]%'
GROUP BY benefit_type;

-- 2. D-SNP coverage across NC/TX/GA
SELECT
  COUNT(DISTINCT (p.contract_id || '-' || p.plan_id))                                       AS total_dsnps,
  COUNT(DISTINCT CASE WHEN b.benefit_type = 'food_card'     THEN (p.contract_id || '-' || p.plan_id) END) AS has_food_card,
  COUNT(DISTINCT CASE WHEN b.benefit_type = 'otc_allowance' THEN (p.contract_id || '-' || p.plan_id) END) AS has_otc_allowance
FROM pm_plans p
LEFT JOIN pbp_benefits_v2 b
  ON p.contract_id = b.contract_id AND p.plan_id = b.plan_id
  AND b.benefit_type IN ('food_card', 'otc_allowance')
WHERE p.snp_type = 'D-SNP' AND p.state IN ('NC', 'TX', 'GA');
