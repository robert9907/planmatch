// scripts/backfill-drug-ndcs.ts
//
// Backfill pm_drug_ndc for the brand-injectables and high-volume
// brand-tablets the agent quote screen needs to look up by rxcui.
// pm_drug_ndc starts with ~28 rows in plan-match-prod (most of them
// generics from the original landscape import), so any client whose
// session carries Ozempic/Mounjaro/Eliquis/etc. lands at
// `lookupDrugCost(...).source === 'unavailable'`.
//
// Strategy:
//   1. For each seed (brand_name, anchor_rxcui):
//      a. Resolve the anchor's term type (tty) via /properties.json.
//      b. If the anchor is at IN/MIN/PIN level (no NDCs of its own),
//         walk /related?tty=SCD+SBD+GPCK+BPCK to get every descendant
//         that DOES carry NDCs.
//      c. If the anchor returns nothing (some retired rxcuis),
//         fall back to /drugs.json?name=<brand> to find SBDs by name.
//   2. For each descendant SCD/SBD/GPCK/BPCK rxcui, fetch
//      /rxcui/{rxcui}/ndcs.json.
//   3. Parse each NDC's brand / strength / dose form from the
//      RxNorm name string (using the same heuristics
//      api/rxnorm-search.ts uses).
//   4. Upsert rows into pm_drug_ndc with onConflict:'rxcui,ndc' so
//      re-runs are idempotent.
//
// Run:
//   npx tsx scripts/backfill-drug-ndcs.ts          (dry run, no writes)
//   npx tsx scripts/backfill-drug-ndcs.ts --write  (live insert)
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the env.
// .env.local is loaded automatically when present.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

// ─── Env ──────────────────────────────────────────────────────────
function loadEnv() {
  if (!existsSync('.env.local')) return;
  const lines = readFileSync('.env.local', 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const writeMode = process.argv.includes('--write');

// ─── Targets ──────────────────────────────────────────────────────
//
// Seed rxcuis as listed in the task. Some are at IN/MIN level and
// some are direct SCD/SBD — the resolver below handles both. Where
// the anchor rxcui is invalid in current RxNav (Mounjaro 2570625,
// Zepbound 2605373), we fall back to a brand-name search.

interface Seed {
  brand: string;
  anchorRxcui: string;
  /** Override brand-name search when the anchor is invalid. */
  fallbackName?: string;
}

const SEEDS: Seed[] = [
  { brand: 'Ozempic',   anchorRxcui: '1991306' },                     // SCD level
  { brand: 'Mounjaro',  anchorRxcui: '2570625', fallbackName: 'Mounjaro' },
  { brand: 'Zepbound',  anchorRxcui: '2605373', fallbackName: 'Zepbound' },
  { brand: 'Jardiance', anchorRxcui: '1545653' },                     // IN
  { brand: 'Eliquis',   anchorRxcui: '1364430' },                     // IN
  { brand: 'Xarelto',   anchorRxcui: '1114195' },                     // IN
  { brand: 'Entresto',  anchorRxcui: '1656339' },                     // MIN
  { brand: 'Farxiga',   anchorRxcui: '1486436' },                     // MIN (Xigduo combos)
  // Farxiga's ingredient-only rxcui is 1488564 (dapagliflozin alone).
  // Add explicitly so we cover both single-ingredient + combo SBDs.
  { brand: 'Farxiga',   anchorRxcui: '1488564' },
];

// ─── RxNav helpers ────────────────────────────────────────────────
const RXNAV = 'https://rxnav.nlm.nih.gov/REST';
const NDC_TTYS = new Set(['SCD', 'SBD', 'GPCK', 'BPCK']);

interface Concept { rxcui: string; tty: string; name: string; }

async function rxnavJson(path: string): Promise<unknown> {
  const r = await fetch(`${RXNAV}/${path}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`RxNav ${path} → ${r.status}`);
  return r.json();
}

async function getProperties(rxcui: string): Promise<{ tty: string; name: string } | null> {
  try {
    const b = (await rxnavJson(`rxcui/${rxcui}/properties.json`)) as { properties?: { tty?: string; name?: string } };
    if (!b.properties?.tty) return null;
    return { tty: b.properties.tty, name: b.properties.name ?? '' };
  } catch {
    return null;
  }
}

async function getDescendants(rxcui: string): Promise<Concept[]> {
  try {
    const b = (await rxnavJson(`rxcui/${rxcui}/related.json?tty=SCD+SBD+GPCK+BPCK`)) as {
      relatedGroup?: { conceptGroup?: { tty?: string; conceptProperties?: { rxcui: string; name: string }[] }[] };
    };
    const out: Concept[] = [];
    for (const g of b.relatedGroup?.conceptGroup ?? []) {
      for (const c of g.conceptProperties ?? []) {
        out.push({ rxcui: c.rxcui, tty: g.tty ?? '', name: c.name });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function searchByBrandName(name: string): Promise<Concept[]> {
  try {
    const b = (await rxnavJson(`drugs.json?name=${encodeURIComponent(name)}`)) as {
      drugGroup?: { conceptGroup?: { tty?: string; conceptProperties?: { rxcui: string; name: string }[] }[] };
    };
    const out: Concept[] = [];
    for (const g of b.drugGroup?.conceptGroup ?? []) {
      const tty = g.tty ?? '';
      if (!NDC_TTYS.has(tty)) continue;
      for (const c of g.conceptProperties ?? []) {
        out.push({ rxcui: c.rxcui, tty, name: c.name });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function getNdcs(rxcui: string): Promise<string[]> {
  try {
    const b = (await rxnavJson(`rxcui/${rxcui}/ndcs.json`)) as { ndcGroup?: { ndcList?: { ndc?: string[] } } };
    return b.ndcGroup?.ndcList?.ndc ?? [];
  } catch {
    return [];
  }
}

// ─── Drug-name parsing ────────────────────────────────────────────
//
// Lift the brand / strength / dose-form out of the RxNorm canonical
// name so pm_drug_ndc.drug_name renders meaningfully on the agent UI.
// Mirrors api/rxnorm-search.ts enrich() so Ozempic-shaped names
// produce {name: "Ozempic", strength: "0.25 MG", form: "Pen Injector"}.

interface Parsed { drug_name: string; strength: string; form: string; isInjectable: boolean; }

function parseRxName(raw: string, brand: string): Parsed {
  const bracket = raw.match(/\[([^\]]+)\]\s*$/);
  const noBracket = bracket ? raw.slice(0, bracket.index).trim() : raw;
  const brandFromBracket = bracket?.[1]?.trim();

  const strengthMatch = noBracket.match(/(\d+(?:\.\d+)?\s*(?:MG|MCG|G|ML|%|UNT|UNIT|IU)(?:\s*\/\s*\d+(?:\.\d+)?\s*(?:MG|MCG|G|ML|UNT|UNIT|IU)?)?)/i);
  const strength = strengthMatch?.[1]?.replace(/\s+/g, ' ').trim() ?? '';

  const formMatch = noBracket.match(/\b(Oral Tablet|Oral Capsule|Chewable Tablet|Oral Solution|Oral Suspension|Oral Powder|Oral Pellet|Pen Injector|Prefilled Syringe|Auto-Injector|Injectable Solution|Injection|Inhaler|Inhalation Aerosol|Inhalation Powder|Patch|Topical Cream|Topical Gel|Topical Ointment|Topical Spray|Eye Drops|Ophthalmic Solution|Subcutaneous Solution|Extended Release Oral Tablet|Extended Release Oral Capsule)\b/i);
  const form = formMatch?.[1] ?? 'Unknown';

  const isInjectable = /Pen Injector|Auto-Injector|Prefilled Syringe|Injectable|Injection|Subcutaneous/i.test(noBracket);

  return {
    drug_name: brandFromBracket || brand,
    strength,
    form,
    isInjectable,
  };
}

// ─── Quantities ──────────────────────────────────────────────────
//
// /api/drug-costs sends quantity to Medicare.gov so it can compute a
// per-month price. For this backfill we use conservative defaults
// keyed on the form; if a specific drug's regimen differs from the
// default the price calc will be off but the (rxcui, ndc) bridge
// still works — that's the only thing pm_drug_ndc exists to provide.
function defaultQuantities(parsed: Parsed): { q30: number; q90: number } {
  if (parsed.isInjectable) {
    // Subcutaneous GLP-1 / GIP injectables (Ozempic, Mounjaro,
    // Zepbound, Trulicity) are once-weekly. 4 doses / 30 days,
    // 12 doses / 90 days.
    return { q30: 4, q90: 12 };
  }
  // Oral tablets default to once-daily. The Medicare.gov calc will
  // adjust per-fill if the prescription specifies otherwise.
  return { q30: 30, q90: 90 };
}

// ─── Resolver ─────────────────────────────────────────────────────
//
// Strategy: merge results from (a) the descendant walk and (b) the
// brand-name search, then dedupe. This catches a footgun discovered
// during the first run — Ozempic's SCD anchor 1991306 carries no
// NDCs of its own AND only has one SBD descendant (1991311), but
// /drugs.json?name=Ozempic surfaces SEVEN SBDs covering all the pen
// concentrations. Without the brand-name merge we'd insert 0 rows
// for Ozempic even though every other brand worked.
async function resolveSeed(seed: Seed): Promise<Concept[]> {
  const props = await getProperties(seed.anchorRxcui);
  const merged = new Map<string, Concept>();

  if (props) {
    // Anchor itself is NDC-bearing → use it.
    if (NDC_TTYS.has(props.tty)) {
      merged.set(seed.anchorRxcui, { rxcui: seed.anchorRxcui, tty: props.tty, name: props.name });
    }
    // Walk descendants regardless of anchor tty.
    for (const d of await getDescendants(seed.anchorRxcui)) {
      if (!merged.has(d.rxcui)) merged.set(d.rxcui, d);
    }
  }

  // Brand-name search as a supplementary source. Always run it for
  // seeds with a known brand (every entry in SEEDS — `seed.brand`
  // is the canonical name). This catches Ozempic-shaped cases where
  // the descendant walk misses sibling SBDs.
  for (const c of await searchByBrandName(seed.fallbackName ?? seed.brand)) {
    if (!merged.has(c.rxcui)) merged.set(c.rxcui, c);
  }

  return [...merged.values()];
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  const sb = createClient(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const allRows: Array<{
    rxcui: string; ndc: string; drug_name: string; strength: string; form: string;
    package_type: string; package_size: number; package_unit: string;
    default_quantity_30: number; default_quantity_90: number;
  }> = [];

  for (const seed of SEEDS) {
    console.log(`\n${seed.brand} (anchor ${seed.anchorRxcui})`);
    const concepts = await resolveSeed(seed);
    console.log(`  ${concepts.length} NDC-bearing concept(s)`);
    if (concepts.length === 0) continue;

    for (const c of concepts) {
      const ndcs = await getNdcs(c.rxcui);
      if (ndcs.length === 0) continue;
      const parsed = parseRxName(c.name, seed.brand);
      const { q30, q90 } = defaultQuantities(parsed);
      console.log(`    ${c.rxcui} [${c.tty}] ${c.name} → ${ndcs.length} NDC(s)`);
      for (const ndc of ndcs) {
        allRows.push({
          rxcui: c.rxcui,
          ndc,
          drug_name: parsed.drug_name,
          strength: parsed.strength,
          form: parsed.form ? `DRUG_FORM_${parsed.form.toUpperCase().replace(/[^A-Z]/g, '_')}` : 'DRUG_FORM_UNKNOWN',
          package_type: 'PACKAGE_TYPE_UNSPECIFIED',
          package_size: 0,
          package_unit: 'N/A',
          default_quantity_30: q30,
          default_quantity_90: q90,
        });
      }
      // Polite ~5 RPS rate limit on RxNav.
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // Dedupe by (rxcui, ndc).
  const seen = new Set<string>();
  const deduped = allRows.filter((r) => {
    const k = `${r.rxcui}::${r.ndc}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  console.log(`\nTotal rows to upsert: ${deduped.length} (deduped from ${allRows.length})`);
  if (deduped.length === 0) {
    console.log('Nothing to write.');
    return;
  }

  if (!writeMode) {
    console.log('\nDry-run — sample rows:');
    for (const r of deduped.slice(0, 5)) {
      console.log(`  ${r.rxcui} ${r.ndc} ${r.drug_name} ${r.strength} ${r.form}`);
    }
    console.log('\nRun with --write to insert into pm_drug_ndc.');
    return;
  }

  // Live upsert. onConflict on the natural key (rxcui, ndc) so re-runs
  // refresh existing rows without breaking.
  const BATCH = 500;
  for (let i = 0; i < deduped.length; i += BATCH) {
    const batch = deduped.slice(i, i + BATCH);
    const { error } = await sb
      .from('pm_drug_ndc')
      .upsert(batch, { onConflict: 'rxcui,ndc' });
    if (error) {
      console.error(`Batch ${i}-${i + batch.length} failed:`, error.message);
      process.exit(1);
    }
    console.log(`  upserted ${i + batch.length}/${deduped.length}`);
  }
  console.log(`\n✓ Backfill complete. ${deduped.length} (rxcui, ndc) rows written.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
