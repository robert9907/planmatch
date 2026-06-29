// Mirror the post-fix useResolveRxcuis chain in isolation and call the
// live /api/library/drug-search endpoint for each variant. Confirms
// Repatha Sureclick lands on rxcui 1665900 and Fluoxetine 40 MCG flips
// to 313989.

const LIBRARY_URL = 'https://planmatch.generationhealth.me';

const STRENGTH_RE =
  /\s+\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?\s*(?:mg|mcg|g|ml|%|meq|units?|iu)\b.*$/gi;
const RELEASE_RE = /\s+(?:XR|ER|CR|SR|IR|DR|XL|MR|PA|LA|SA)\b/gi;
const DOSE_INSTR_RE =
  /\s+(?:daily|bid|tid|qid|qd|qod|qhs|prn|po|sl|im|iv|sc|hs|am|pm)\b.*$/gi;
const DEVICE_SUBBRAND_RE =
  /\b(?:Sureclick|Pushtronex|FlexPen|FlexTouch|KwikPen|SoloStar|Solostar|HumaPen|InPen|Tempo|Cyltezo|Mounjaro\s+KwikPen)\b/gi;

const TRAILING_STRIP_TOKENS = new Set([
  'TAB', 'CAP', 'CAPS', 'TABLET', 'CAPSULE', 'INJ', 'SOL', 'SOLN',
  'SUSP', 'CRM', 'OINT', 'GEL', 'PATCH', 'SPRAY',
  'PEN', 'SYRINGE', 'PFS', 'VIAL', 'KIT', 'AUTOINJ', 'INJECTOR', 'AUTO',
  'HCL', 'HBR', 'SODIUM', 'POTASSIUM', 'SULFATE', 'SUCCINATE',
  'MALEATE', 'BESYLATE', 'MESYLATE', 'FUMARATE', 'TARTRATE',
  'CITRATE', 'ACETATE', 'PHOSPHATE',
  'CALCIUM', 'CHLORIDE', 'BROMIDE', 'CARBONATE', 'OXIDE',
  'GLUCONATE', 'STEARATE', 'NITRATE', 'BITARTRATE', 'MALATE',
  'HYDROCHLORIDE', 'HYDROBROMIDE', 'DIHYDROCHLORIDE',
  'ER', 'XR', 'XL', 'SR', 'CR', 'DR', 'IR', 'LA', 'SA', 'CD',
]);

function progressiveTrailingStrips(name: string): string[] {
  const out: string[] = [];
  let s = name.trim();
  while (true) {
    const m = s.match(/^(.+?)\s+(\S+)$/);
    if (!m) break;
    const lastToken = m[2].toUpperCase().replace(/[.,;:]+$/g, '');
    if (!TRAILING_STRIP_TOKENS.has(lastToken)) break;
    s = m[1].trim();
    out.push(s);
  }
  return out;
}

function buildNameVariants(rawName: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (s: string): void => {
    const t = s.trim().replace(/\s+/g, ' ');
    if (t.length < 2) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  const name = rawName.trim();
  add(name);
  const noSubbrand = name.replace(DEVICE_SUBBRAND_RE, ' ').replace(/\s+/g, ' ').trim();
  if (noSubbrand !== name) add(noSubbrand);
  const parens = name.match(/^([^(]+?)\s*\(([^)]+)\)/);
  if (parens) { add(parens[2]); add(parens[1]); }
  for (const v of [...out]) {
    const noInstr = v.replace(DOSE_INSTR_RE, '').trim();
    if (noInstr !== v) add(noInstr);
    const noStrength = noInstr.replace(STRENGTH_RE, '').trim();
    if (noStrength !== noInstr) add(noStrength);
    const noRelease = noStrength.replace(RELEASE_RE, '').trim();
    if (noRelease !== noStrength) add(noRelease);
    const stripped = v.replace(DOSE_INSTR_RE, '').replace(STRENGTH_RE, '').replace(RELEASE_RE, '').trim();
    if (stripped !== v) add(stripped);
  }
  for (const v of [...out]) if (v.includes('-')) add(v.replace(/-/g, ' '));
  for (const v of [...out]) for (const next of progressiveTrailingStrips(v)) add(next);
  return out;
}

function parseStrengthMg(raw: string): number | null {
  const m = raw.match(/(\d+(?:\.\d+)?)\s*(MG|MCG|G|ML|%)/i);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = m[2].toUpperCase();
  if (unit === 'MCG') return v / 1000;
  if (unit === 'G') return v * 1000;
  return v;
}

function parseStrengthUnit(raw: string): string | null {
  const m = raw.match(/(\d+(?:\.\d+)?)\s*(MG|MCG|G|ML|%)/i);
  return m ? m[2].toUpperCase() : null;
}

interface LibDrug {
  rxcui: string;
  name: string;
  strength?: string;
  dose_form?: string;
}

function pickBest(results: LibDrug[], rawStrength: string): LibDrug | null {
  if (results.length === 0) return null;
  const target = parseStrengthMg(rawStrength);
  if (target == null) return results[0];
  const exact = results.find((r) => {
    const s = parseStrengthMg(r.name);
    return s != null && Math.abs(s - target) < 0.0001;
  });
  if (exact) return exact;
  const inputUnit = parseStrengthUnit(rawStrength);
  if (inputUnit === 'MCG' || inputUnit === 'MG') {
    const alt = inputUnit === 'MCG' ? target * 1000 : target / 1000;
    const altMatch = results.find((r) => {
      const s = parseStrengthMg(r.name);
      return s != null && Math.abs(s - alt) < 0.0001;
    });
    if (altMatch) return altMatch;
  }
  return results[0];
}

async function searchDrug(query: string): Promise<LibDrug[]> {
  const r = await fetch(`${LIBRARY_URL}/api/library/drug-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit: 6 }),
  });
  if (!r.ok) return [];
  const d = (await r.json()) as { drugs?: LibDrug[] };
  return d.drugs ?? [];
}

async function resolve(name: string, strength: string): Promise<LibDrug | null> {
  const variants = buildNameVariants(name);
  console.log(`  name="${name}"  strength="${strength}"`);
  console.log(`  variants generated: ${variants.length}`);
  for (const v of variants) console.log(`    • "${v}"`);
  for (const v of variants) {
    const results = await searchDrug(v);
    if (results.length === 0) {
      console.log(`    "${v}" → 0`);
      continue;
    }
    const best = pickBest(results, strength);
    if (best?.rxcui) {
      console.log(`    "${v}" → ${results.length} results → pickBest → rxcui=${best.rxcui}  name=${best.name}`);
      return best;
    }
    console.log(`    "${v}" → ${results.length} results → pickBest none-strength`);
  }
  return null;
}

async function main() {
  console.log('\n══ Bug 1: Repatha Sureclick ══');
  const r1 = await resolve('Repatha Sureclick SOLN AUTO-INJ 140MG/ML', '');
  console.log('  → final:', r1 ? `${r1.rxcui} ${r1.name}` : 'NULL (still No RxNorm match)');

  console.log('\n══ Bug 2: Pramipexole 1MG ══');
  const r2 = await resolve('Pramipexole Dihydrochloride TAB 1MG', '1MG');
  console.log('  → final:', r2 ? `${r2.rxcui} ${r2.name}` : 'NULL');

  console.log('\n══ Bug 3: Fluoxetine HCL CAP 40mcg (broker typo) ══');
  const r3 = await resolve('Fluoxetine HCL CAP 40mcg', '40mcg');
  console.log('  → final:', r3 ? `${r3.rxcui} ${r3.name}` : 'NULL');

  console.log('\n══ Sanity: Levothyroxine 50 MCG (legitimate MCG, should NOT flip) ══');
  const r4 = await resolve('Levothyroxine TAB 50MCG', '50MCG');
  console.log('  → final:', r4 ? `${r4.rxcui} ${r4.name}` : 'NULL');
}

main().catch((err) => { console.error(err); process.exit(1); });
