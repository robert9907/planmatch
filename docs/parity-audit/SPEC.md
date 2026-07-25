# Plan Match vs. Medicare Plan Finder — CMS Parity Audit

**Version:** 2.0
**Date:** July 23, 2026
**Author:** GenerationHealth.me
**Target Pass Rate:** ≥ 98.9% field-level parity with Medicare Plan Finder
**Scope:** Plan Match Agent + Plan Match Consumer vs. Medicare Plan Finder (medicare.gov)
**Markets:** North Carolina, Texas, Georgia

### Changelog (v1.0 → v2.0)

| # | Fix | Impact |
|---|---|---|
| 1 | **Partial LIS eliminated** — IRA §11404 collapsed partial LIS (Levels 1/2/3) into full LIS effective January 1, 2024. Profiles 3, 8, 24 corrected. | Profiles, Section 5.2, diff-engine LIS logic |
| 2 | **Part D deductible** — $590 was 2025; 2026 standard deductible is **$615**. | Section 3.2, Section 5.1, field matrix |
| 3 | **Part D OOP cap** — $2,000 was 2025; 2026 TrOOP/RxMOOP is **$2,100**. | Section 3.8, Section 5.1, all drug phase references |
| 4 | **ICL eliminated** — Initial Coverage Limit ended in 2025; replaced by RxMOOP structure. | Section 3.8 restructured |
| 5 | **Coverage Gap/Donut Hole eliminated** — Ended in 2025 under IRA Part D redesign. | Section 3.8, Section 5.1 |
| 6 | **Tier 5 ≠ $35 cap** — $35 insulin cap is insulin-specific (IRA §11101), not all specialty drugs. | Field #58 note corrected |
| 7 | **Oxbryta withdrawn** — Pfizer voluntarily pulled voxelotor globally September 25, 2024. Profile 22 replaced with crizanlizumab (Adakveo). | Profile 22 |
| 8 | **IRA negotiated drug prices** — 10 MFP drugs effective January 1, 2026. New Section 5.7. Eliquis, Entresto, Jardiance, Farxiga, NovoLog cross-referenced. | New section, profile audit focus notes |
| 9 | **Wegovy/GLP-1 coverage** — TROA + Medicare GLP-1 Bridge ($50/month) launched in 2026. Profile 19 updated. | Profile 19 |
| 10 | **22 DB column gaps** — Documented from Claude Code sanity-check. New Section 9 with priority tiers. | New section |
| 11 | **2026 LIS copay amounts** — Updated to CMS October 2025 LIS memo figures. | Section 5.2 |
| 12 | **Part A/B 2026 reference numbers** — Added to Appendix B for cross-validation. | Appendix B |
| 13 | **Field count fixed** — Scoring formula referenced "87 fields"; corrected to 94. | Section 1.2 |

> **Full v2.0 spec text lives in this doc.** For narrative content beyond what appears in code (audit-focus paragraphs, methodology, reference tables), see Rob's authoritative v2.0 markdown in the audit archive. This doc holds the deltas + reference numbers that the parity-audit code depends on. To reconstitute the full spec, pipe the v2.0 paste into this file.

---

## 2026 CMS Reference Numbers (Appendix B)

The `scripts/parity-audit/lib/` modules hardcode these values. When CMS publishes updated figures for CY2027, update in one place: `pm-snapshot.ts` (`partDOopCap`), `types.ts` (comment), and here.

| Parameter | 2026 Value | Source |
|---|---|---|
| Part A Inpatient Deductible | $1,736 | CMS Fact Sheet (Nov 2025) |
| Part B Standard Monthly Premium | $202.90 | CMS Fact Sheet (Nov 2025) |
| Part B Annual Deductible | $283 | CMS Fact Sheet (Nov 2025) |
| Part D Standard Max Deductible | **$615** | CMS Annual |
| Part D OOP Cap (RxMOOP / TrOOP) | **$2,100** | IRA / CMS Annual |
| Part D Catastrophic Cost-Sharing | $0 | IRA (effective 2025+) |
| Part D Insulin Cap | $35/month per product | IRA §11101 |
| Part D Vaccine Cost-Sharing | $0 | IRA §11101 |
| LIS Copay (≤100% FPL) | $1.60 generic / $4.90 brand | CMS Oct 2025 LIS Memo |
| LIS Copay (>100%–150% FPL) | $5.10 generic / $12.65 brand | CMS Oct 2025 LIS Memo |
| LIS Copay (QMB + full Medicaid) | $4.90 per Rx | CMS Oct 2025 LIS Memo |
| LIS Income Threshold (150% FPL) | $23,940 individual / $32,460 couple | 2026 FPL |
| LIS Resource Limit | $18,090 individual / $36,100 couple | CMS Oct 2025 LIS Memo |
| IRA MFP Drugs (Round 1) | 10 drugs | Effective January 1, 2026 |
| IRA MFP Drugs (Round 2) | 15 drugs (incl. Ozempic, Wegovy) | Effective January 1, 2027 |

---

## IRA MFP Drugs — 2026 (Section 5.7)

The first 10 IRA-negotiated drug prices took effect January 1, 2026. Plan Match cost estimates must reflect Maximum Fair Prices, not pre-negotiation list prices. `scripts/parity-audit/fixtures/ira-mfp-drugs.ts` holds the canonical set for matching.

| Drug | Condition | MFP (30-day) | Prior List Price | Discount |
|---|---|---|---|---|
| Eliquis (apixaban) | Blood clots, AFib | $231 | $521 | 56% |
| Jardiance (empagliflozin) | Diabetes, CKD, HF | Negotiated | — | 38–79% |
| Xarelto (rivaroxaban) | Blood clots | $197 | $517 | 62% |
| Januvia (sitagliptin) | Diabetes | Negotiated | — | 38–79% |
| Farxiga (dapagliflozin) | Diabetes, CKD, HF | Negotiated | — | 38–79% |
| Entresto (sacubitril/valsartan) | Heart failure | Negotiated | — | 38–79% |
| Enbrel (etanercept) | RA, autoimmune | Negotiated | — | 38–79% |
| Imbruvica (ibrutinib) | Cancer | Negotiated | — | 38–79% |
| Stelara (ustekinumab) | Autoimmune | Negotiated | — | 38–79% |
| Fiasp/NovoLog (insulin aspart) | Diabetes | Negotiated | — | 38–79% |

**Round 2 (2027):** Ozempic, Wegovy, Rybelsus (semaglutide) among 15 additional drugs — update `IRA_MFP_DRUGS_2027` when CY2027 planning starts.

---

## DB Column Gaps (Section 9)

22 columns Plan Match doesn't expose today. Diff engine emits F2 (Missing Field) for each. Theoretical parity ceiling before value-mismatch checks: ~76.6%.

### Priority 1 — API mapping only (no import needed)

| # | Field | Spec Field # | Effort |
|---|---|---|---|
| 1 | Part B Premium Reduction (Giveback) | 9 | Low |
| 2 | Medical Deductible (Out-of-Network) | 12 | Low |
| 3 | Drug Deductible Tier Exceptions | 14 | Low |

### Priority 2 — pbp_benefits parse

| # | Field | Spec Field # | Effort |
|---|---|---|---|
| 4 | Cardiac Rehabilitation Copay | 41 | Medium |
| 5 | Pulmonary Rehabilitation Copay | 42 | Medium |
| 6 | Home Health Copay | 44 | Medium |
| 7 | Dialysis Copay | 47 | Medium |
| 8 | Worldwide Emergency Coverage | 93 | Medium |
| 9 | Nurse Hotline / 24/7 Access | 94 | Low |

### Priority 3 — Formulary schema

| # | Field | Spec Field # | Effort |
|---|---|---|---|
| 10 | Tier 6 Preferred Pharmacy Copay | 59 | Medium |
| 11 | Tier 6 Standard Pharmacy Copay | 59 | Medium |
| 12–17 | Mail Order 90-Day per Tier (T1–T6) | 60 | Medium |
| 18 | Specialty Pharmacy Required (per drug) | 72 | Medium |

### Priority 4 — Supplemental expansion

| # | Field | Spec Field # | Effort |
|---|---|---|---|
| 19 | Food Card Grocery Restriction Detail | 89 | Low |
| 20 | Caregiver Support | 90 | Medium |
| 21 | In-Home Support Services | 91 | Medium |
| 22 | Acupuncture | 92 | Medium |

Close Priority 1 first (day 1 — API mapping only). Priority 2 mirrors the food-card sprint pattern (DELETE+INSERT from pbp_benefits source). Priority 3 = formulary schema migration. Total effort: 5–8 days for all 22.

---

## LIS/Dual Overrides (Section 5.2 — post-IRA §11404)

Partial LIS was eliminated by IRA §11404 effective January 1, 2024. All qualifying individuals now receive full LIS at two income-band tiers.

| Test | Expected Result |
|---|---|
| Full LIS, income ≤100% FPL | ≤$1.60 generic / ≤$4.90 brand per fill |
| Full LIS, >100%–150% FPL | ≤$5.10 generic / ≤$12.65 brand per fill |
| Full LIS + QMB | ≤$4.90 per fill (any drug) |
| Full LIS — after $2,100 TrOOP | $0 for all covered drugs |
| Full LIS — Part D deductible | $0 (waived) |
| Full LIS — Part D premium | $0 if plan ≤ benchmark; otherwise LIS pays up to benchmark |
| Full dual (QMB) — medical copays | $0 (QMB prohibits balance billing) |
| SLMB — medical copays | Standard plan amounts (SLMB covers Part B premium only) |
| SLMB — drug copays | Full LIS schedule (auto-qualifies) |
| QDWI — medical copays | Standard plan amounts (QDWI covers Part A premium only) |
| QDWI — drug copays | Depends on **separate LIS application**; NOT automatic |

---

## Part B vs Part D Drug Classification (Section 5.3)

| Drug | Correct Classification | Setting Dependency |
|---|---|---|
| Keytruda (pembrolizumab) | Part B | Provider-administered infusion |
| Herceptin (trastuzumab) | Part B | Provider-administered infusion |
| Eylea (aflibercept) | Part B | Provider-administered injection |
| Lupron Depot | Part B | Provider-administered injection |
| Xgeva (denosumab) 120mg | Part B | Provider-administered injection |
| Prolia (denosumab) 60mg | Part B (usually) | May be Part D if self-administered |
| Invega Sustenna | Part B | Provider-administered injection |
| Epoetin alfa (in dialysis) | Part B | Dialysis setting |
| Darzalex (daratumumab) | Part B | Provider-administered infusion |
| Zoledronic Acid | Part B | Provider-administered infusion |
| Leqembi (lecanemab) | Part B | Provider-administered infusion |
| **Crizanlizumab (Adakveo)** | **Part B** | Provider-administered IV infusion (replaces withdrawn Oxbryta) |
| Benlysta — IV infusion | Part B | Provider-administered |
| Benlysta — SC injection | Part D | Self-administered |
| Radicava — IV infusion | Part B | Provider-administered |
| Radicava — oral | Part D | Self-administered |
| Filgrastim — office | Part B | Incident-to |
| Filgrastim — home | Part D | Self-administered |
| Ibrance (palbociclib) | Part D | Oral |
| Tagrisso (osimertinib) | Part D | Oral |
| Xtandi (enzalutamide) | Part D | Oral |
| Revlimid (lenalidomide) | Part D | Oral |
| Biktarvy | Part D | Oral |
| Humira | Part D | Self-administered SC |
| Ozempic/Wegovy | Part D | Self-administered SC |

Diff engine treats "not on Part D formulary" as PASS for drugs with `part: 'part-b'` (correct — they shouldn't be there).

---

## Field Matrix, Scoring, Methodology

Sections 3.1–3.13 (94-field matrix), Section 4 (three-way comparison protocol, F1–F10 fail codes, severity weights), Section 5.1 (IRA provisions), Section 5.4–5.6 (ESRD, SNF boundaries, MOOP stress test), and Sections 6–8 (deliverables, timeline, automation) live in Rob's authoritative v2.0 paste. Types in `scripts/parity-audit/types.ts` mirror the field structure. Fail-code + severity table in `scripts/parity-audit/README.md`.

## Beneficiary Profiles (Section 2)

25 profiles authored as typed constants in `scripts/parity-audit/fixtures/profiles.ts`. Each profile encodes: demographics, medicaid status, LIS, ESRD/disability, drug list (with Part B/D classification and MFP flag), audit focus. Complexity scores match Appendix C. Post-v2 changes:

- Profile 3 (Dorothy): `lis: 'none'` — income exceeds 150% FPL, non-Medicaid; no LIS
- Profile 8 (Evelyn): `lis: 'full'` — SLMB auto-qualifies for full LIS
- Profile 22 (Shirley): Oxbryta replaced with Crizanlizumab (Adakveo) as Part B drug
- Profile 24 (Martha): `lis: 'full'` — QDWI + separately qualified via SSA
