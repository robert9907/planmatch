# network-check extractor still needs real HAR

**Issue:** The `extractCoverage()` function in `api/network-check.ts` uses three speculative
response shapes because a real HAR capture of `POST /plans/search?providers=<NPI>` was not
available when the extractor was written.

## What was tried (2026-05-09 Claude Code session)

### Step 1 — Probe script written

`scripts/probe-network-check.mjs` was created. It:

1. Launches Chromium via `@sparticuz/chromium` (same Akamai-bypass pattern as `api/drug-costs.ts`)
2. Warms `https://www.medicare.gov/plan-compare/` for 6 s
3. POSTs `https://www.medicare.gov/api/v1/data/plan-compare/plans/search?zip=27713&fips=37063&plan_type=PLAN_TYPE_MAPD&year=2026&lang=en&providers=1619976297`
   with body `{npis:[],prescriptions:[],lis:"LIS_NO_HELP",starRatings:[],organizationNames:[]}`
4. Writes the full JSON response to `_tmp/network-probe.json`
5. Prints top-level keys, `plans[]` sample, and every JSON path where NPI `1619976297` appears

### Step 2 — Both probe attempts failed (Akamai 403)

The sandbox environment is blocked at the network level by Akamai before cookies can do anything:

```
response status: 403
Body sample: Host not in allowlist
```

Retried after a 30 s wait — same result. The block is host-based, not session-based; it
cannot be bypassed by cookie warming in a sandboxed CI/cloud environment.

### Step 3 — Consumer-side source search

Searched this repo for references to `pm_provider_network_cache`, `verify-provider`,
`FindProviders`, and `plan-compare/provider`.

Found:
- `src/lib/networkCheck.ts` — browser-side reader of `pm_provider_network_cache`; mirrors
  the consumer repo's `apps/web/src/hooks/useProviderNetworkStatus.ts` (read-only hook, not a writer)
- `api/network-check.ts` — the server-side writer; the `extractCoverage()` function in question

**No consumer-side writer code is present in this repo.** CLAUDE.md names two sibling repos
(`robert9907/agentbase-crm`, `robert9907/gh-command-center-v2`) but neither is the consumer
Medicare app. The consumer app's GitHub URL is not recorded in CLAUDE.md or commit history.

## What is needed

1. **Run the probe from a non-blocked host** (local dev machine or GitHub Actions with a
   residential/datacenter IP that Akamai allows):

   ```bash
   node scripts/probe-network-check.mjs --npi 1619976297 --zip 27713 --fips 37063
   # writes _tmp/network-probe.json
   ```

2. **Check `_tmp/network-probe.json`** for the path where `1619976297` appears. The probe
   script already reports this — look for output like:
   ```
   Found 2 path(s):
     plans[0].provider_coverage.1619976297.npi
     plans[3].provider_coverage.1619976297.npi
   ```

3. **Update `extractCoverage()` in `api/network-check.ts`** to match the confirmed path as
   the primary branch (before the current three speculative fallbacks). Add a comment citing
   this file/session as the source.

## Current speculative shapes (in priority order as written)

| Shape | Key(s) checked | Example |
|-------|---------------|---------|
| A | `providers_in_network`, `providers_covered`, `provider_in_network`, `provider_covered`, `all_providers_in_network` | `plan.providers_in_network: true` |
| B | `provider_coverage`, `providers_coverage`, `providersCoverage` (map keyed by NPI) | `plan.provider_coverage["1619976297"].covered: true` |
| C | `providers[]`, `in_network_providers[]`, `practitioners[]` array of `{npi, in_network}` | `plan.providers[0].npi === "1619976297"` |

Shape B (map keyed by NPI with nested `covered` boolean) is the most architecturally consistent
with an API that accepts multiple NPIs via `?providers=NPI1,NPI2`. It was listed as "observed"
in the original code comment, suggesting it may be the real shape — but this needs confirmation.

## Assign to

@robert9907 — please run the probe from your local machine and follow the three steps above.
