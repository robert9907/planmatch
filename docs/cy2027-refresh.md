# CY2027 Landscape + SNP refresh procedure

**When:** Late September 2026, when CMS drops CY2027 files.
**Why this note exists:** The 2026-08-12 D-SNP population fix (PR #1)
depends on the CY2026 CMS "Partial Dual" column semantic. A CMS column
rename in CY2027 would produce NULL populations across every row rather
than a loud failure — the ingest reads `r['Partial Dual']` by name, and
a missing key evaluates to `undefined` which the mapper turns into
`null`. Every downstream filter treats NULL as "unmapped, permissive"
(the rollout policy), so a silent rename would look like every plan
suddenly accepts every population — the exact class of bug this fix
just cleaned up.

## What lands in late September

1. **Landscape files** (Plan directory, benefits, formulary, provider
   networks). Ingested by `scripts/cms-sync-2026.ts` and the consumer
   pipeline. These will need a `cms-sync-2027.ts` fork or an argument
   to select year.
2. **SNP Comprehensive Report** — monthly XLSX at
   `https://www.cms.gov/files/zip/snp-comprehensive-report-YYYY-MM.zip`.
   The first CY2027 SNP report typically drops early October, one
   cycle after Landscape.

## Procedure

### 1. Download the first CY2027 SNP XLSX

```bash
mkdir -p _tmp/cms-sync/snp-report/SNP_2027_10   # first CY2027 month
curl -sSL -o /tmp/snp-2027-10-zip.zip \
  'https://www.cms.gov/files/zip/snp-comprehensive-report-2027-10.zip'
unzip -o /tmp/snp-2027-10-zip.zip -d _tmp/cms-sync/snp-report/
```

### 2. Confirm the Partial Dual column still exists

Before running the ingest, verify the CY2027 SNP report uses the same
column headers we hardcode. If any of these are missing or renamed,
STOP and update the ingest before running:

```bash
fnm exec --using=22 -- npx tsx -e '
import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
const wb = XLSX.read(readFileSync("_tmp/cms-sync/snp-report/SNP_2027_10/SNP_2027_10.xlsx"), { type: "buffer" });
const ws = wb.Sheets["SNP_REPORT_PART_17"];  // sheet name is a hardcoded assumption too
const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);
console.log("columns:", Object.keys(rows[0] ?? {}));
console.log("Partial Dual distinct values:", new Set(rows.map(r => r["Partial Dual"])));
'
```

Expected columns (per CY2026 schema): `Contract Number, Contract Name,
Organization Type, Plan ID, SEGMENT_ID, Plan Name, Plan Type,
Geographic Name, State(s), Enrollment, Special Needs Plan Type,
Specialty Diseases, Integration Status, Applicable Integrated Plan,
Partial Dual, DSNP Only Contract`.
Expected "Partial Dual" values: `"No"`, `"Yes"`, `""`.

**If Partial Dual is renamed** (e.g. to "Partial Dual Only" as CMS uses
in some other filings), update `import-snp-comprehensive-report.ts` line
~135 to read the new key BEFORE running. A silent rename would map
every D-SNP row to NULL populations.

### 3. Run the ingest against the new file

```bash
fnm exec --using=22 -- npx tsx scripts/import-snp-comprehensive-report.ts \
  --snp-xlsx _tmp/cms-sync/snp-report/SNP_2027_10/SNP_2027_10.xlsx
```

The ingest is idempotent. It applies migration 017 inline (create-or-
replace on the trigger + function) so a fresh DB clone bootstraps
correctly. Updates `dsnp_accepted_populations` per row; the trigger
derives `dsnp_eligible_tiers` automatically.

### 4. Confirm the audit passes

The last block of the ingest runs ground-truth assertions and a
Coordination-Only consistency check. It exits with code 1 on any
failure. Watch for:

```
═══ Ground-truth assertions ═══
  ✓ H1036-307: pops + tiers + integration all match
  ✓ H5296-004: pops + tiers + integration all match
  ✓ H5253-041: pops + tiers + integration all match
  ✓ H4073-003: pops + tiers + integration all match

  Coordination-Only + Partial=No rows missing >=1 of {QMB,SLMB,QI}: 0
  ✓ Coordination-Only consistency clean

✓ ingest audit clean
```

**If any of the 4 ground-truth assertions fail, DO NOT proceed.** The
plans H1036-307, H5296-004, H5253-041 (all Partial Dual=No) and
H4073-003 (Partial Dual=Yes) are hardcoded reference points sourced
from HealthSherpa 2026-08 filings. In CY2027:

- If any of the four plans is no longer offered (contract discontinued
  or renumbered), remove that assertion line and add a replacement
  plan whose acceptance list you can verify against HealthSherpa or
  Medicare.gov Plan Compare.
- If a plan still exists but its populations differ from CY2026, that
  might be a legitimate CY2027 filing change OR a CMS schema change.
  Cross-check on HealthSherpa before adjusting the assertion.
- If ALL 4 assertions fail simultaneously with the same shape (e.g.
  every plan now shows NULL populations), that's the CMS column
  rename scenario — fix the ingest before adjusting assertions.

The Coordination-Only rule is data-driven and should hold as long as
CMS's semantic doesn't change. If it starts failing, dig into which
plans are contradicting before relaxing the rule.

### 5. Verify sample counts against production

Optional but recommended sanity check — pick 2-3 counties and confirm
the D-SNP dropdown counts look right:

```bash
for c in 'NC:Wake' 'TX:Hale' 'GA:Fulton'; do
  st=${c%%:*}; ct=${c##*:}
  n=$(curl -s "https://agent.generationhealth.me/api/plans?state=$st&county=$ct&limit=2000" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); dsnp=sum(1 for p in d["plans"] if p.get("snp_type")=="D-SNP"); print(f"{len(d[\"plans\"])} plans, {dsnp} D-SNP")')
  echo "$st $ct: $n"
done
```

CY2026 baseline (as of 2026-08-12): Wake 76/19, Hale 38/11, Fulton
89/26. CY2027 numbers will drift with the plan universe; a
year-over-year change of ±10 plans per county is normal. A drop to
zero D-SNPs anywhere is a red flag.

## Related

- Migration `scripts/migrations/017_dsnp_populations_canonical.sql`
- Ingest `scripts/import-snp-comprehensive-report.ts` (mapping at
  line ~135, audit at the bottom of `main()`)
- Consumer mirror `~/Code/plan-match/supabase/migrations/202608131200_dsnp_populations_canonical.sql`
- Consumer read path `~/Code/plan-match/packages/brain/src/plan-brain.ts:filterPlanPool`
- Full Phase 1/2 diagnosis: PR
  [robert9907/planmatch#1](https://github.com/robert9907/planmatch/pull/1)
