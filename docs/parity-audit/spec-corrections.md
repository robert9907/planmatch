# Parity Audit Spec — Corrections Log

> **SUPERSEDED (2026-07-23) — see `SPEC.md` v2.0.** Rob's v2.0 spec incorporates
> all C1–C6 corrections below plus 7 additional structural fixes (IRA §11404
> partial-LIS elimination, $2,100 TrOOP, $615 Part D deductible, IRA MFP Round 1,
> Oxbryta withdrawal, Wegovy GLP-1 pathway, DB column gap Section 9). This log is
> retained for CMS audit-evidence chain of custody: it shows the v1→v2 audit
> reasoning trail.

Source: `Plan Match vs. Medicare Plan Finder — CMS Parity Audit` v1.0 (2026-07-23).

This log tracks factual corrections to the spec. Apply these when regenerating the reference doc; the audit code (`scripts/parity-audit/`) already treats reality per this log.

---

## C1 — Section 3.8 Field 61 (Initial Coverage Limit)

**Spec says:** `Initial Coverage Limit (ICL) — $5,030 for 2026 (verify)`

**Reality (CY2026 post-IRA):** ICL as a distinct phase does not exist. The Inflation Reduction Act §11201 (effective CY2025) collapsed the 4-phase Part D structure into 3 phases:

1. Deductible (up to plan-set amount, max $590 CY2025 / verify CY2026 max)
2. Initial Coverage (tier-based cost-sharing until beneficiary hits OOP cap)
3. Catastrophic ($0 beneficiary cost-sharing)

There is no ICL threshold, no coverage gap, no "5% coinsurance" catastrophic phase.

**Correction:** Rename Field 61 to `Part D OOP Cap`. Value = $2,000 for CY2025; CMS-indexed for CY2026 (verify against CY2026 Part D Annual Redesign Memo — expected ~$2,100).

**Impact:** Diff engine (Section 3.8) treats "ICL" as N/A. Snapshot type has no `initialCoverageLimit` field.

---

## C2 — Section 3.8 Field 62 (Coverage Gap / Donut Hole)

**Spec says:** `Coverage Gap / Donut Hole Rules — Post-IRA: manufacturer discount + plan share, $2,000 OOP cap`

**Reality (CY2026):** The coverage gap ("donut hole") was eliminated by IRA §11201 effective CY2025. There is no coverage gap phase. Manufacturer discount is now applied within the Initial Coverage phase per the redesigned plan structure — beneficiary-facing behavior is: pay tier copay/coinsurance until $2,000 TrOOP hit, then $0.

**Correction:** Delete Field 62. Merge its intent into Field 63 (OOP cap enforcement).

**Impact:** Diff engine (Section 3.8) does not check for gap-phase cost-sharing. Snapshot type has no `coverageGap` field.

---

## C3 — Section 5.1 IRA Provisions block (Insulin $35 cap)

**Spec says:** Treats `Insulin $35 cap` as a plan-level field to compare.

**Reality:** The $35 insulin cap is a validation rule imposed on all Part D plans by IRA §11406 — beneficiary copay for any covered insulin product cannot exceed $35/month. It is not a field the plan exposes; it is a constraint the plan must satisfy.

**Correction:** Reframe as validation rule in diff engine:
- For each drug in profile flagged as insulin: assert `pm.tierCopay ≤ 35` and `mpf.tierCopay ≤ 35`.
- If either exceeds $35, that is an IRA compliance error, not a parity mismatch.

**Impact:** `PlanSnapshot` type does not include `insulinCap` field. Diff engine adds insulin-copay validation as a separate check with fail code F8 (IRA provision error).

---

## C4 — Section 5.3 Prolia Part B vs Part D classification

**Spec says:** `Prolia (denosumab) 60mg — Part B (usually) — May be Part D if self-administered`

**Reality:** Correct nuance, but the Plan Match formulary lookup is patient-agnostic — it does not know whether Prolia will be provider-administered (Part B) or self-injected (Part D). For a beneficiary who administers at a physician office, Prolia is Part B and the Part D formulary lookup returns "not on formulary" (correct). For self-inject, it returns a Part D tier.

**Correction:** Add advisory note to diff engine: when Prolia appears in a profile drug list, the reference expectation is Part B (Field 46), and Part D formulary "not covered" is PASS, not FAIL. If broker workflow needs the Part D path, add per-profile flag `prolia.administrationSetting: 'office' | 'home'`.

**Impact:** Diff engine treats Prolia + Zoledronic Acid + Xgeva formulary "not covered" as PASS when patient's expected administration route is office/clinic.

Same nuance applies to: Benlysta (IV = Part B, SC = Part D), Radicava (IV = Part B, oral = Part D), Filgrastim (office = Part B, home = Part D). All flagged in `fixtures/drug-classification.ts`.

---

## C5 — Section 3.3 Fields 19 & 21 (Inpatient day limits, Psych day limits)

**Spec says:** Includes `Inpatient Hospital — Day Limit` and `Psychiatric Inpatient — Day Limit` as auditable fields.

**Reality:** The medicare.gov `/api/v1/data/plan-compare` API does not return day limits as structured fields. Plan Finder surfaces them only via free-text description parsing on the ma_benefits[] rows. Parsing is brittle — carrier wording drifts each year.

**Correction:** Mark Fields 19 and 21 as `non-authoritative via scraper`. Diff engine emits status `N/A` for these fields with note `"day_limit not extracted from MPF API — requires manual PBP review"`. Do not count in parity rate denominator.

**Impact:** Effective field count is 92 (not 94). Parity rate math uses 92 as denominator per plan.

---

## C6 — Section 3.3 Field 21 (Psychiatric Inpatient day limit note)

**Spec says:** `190-day lifetime limit (Original Medicare)`

**Reality:** The 190-day lifetime psych inpatient limit applies to freestanding psychiatric hospitals under Original Medicare. It does not apply to psych units within general acute hospitals, and MA plans have variable treatment. The 190-day figure is a beneficiary-education fact, not a plan-benefit field.

**Correction:** Move the "190-day" reference to a footnote in the profile-narrative section; remove from field checklist.

**Impact:** Same as C5 — Field 21 is N/A.

---

## Post-corrections field count

Original spec: 94 fields.
After C5 removes Fields 19 + 21: **92 auditable fields**.

Section 3.9 per-drug checks unchanged (6 per drug × N drugs × M plans).

Weighted parity target: ≥ 98.9% unweighted / ≥ 97.5% weighted against 92 fields.
