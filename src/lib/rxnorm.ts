export interface RxNormDrug {
  rxcui: string;
  name: string;
  synonym?: string;
  tty?: string;
}

const BASE_URL = 'https://rxnav.nlm.nih.gov/REST';

export async function searchDrug(query: string, signal?: AbortSignal): Promise<RxNormDrug[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const url = `${BASE_URL}/drugs.json?name=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`RxNorm ${res.status}`);
  const body = await res.json();

  const groups = body?.drugGroup?.conceptGroup ?? [];
  const seen = new Set<string>();
  const out: RxNormDrug[] = [];

  for (const group of groups) {
    const tty = group?.tty;
    const concepts = group?.conceptProperties ?? [];
    for (const c of concepts) {
      if (!c?.rxcui || !c?.name) continue;
      if (seen.has(c.rxcui)) continue;
      seen.add(c.rxcui);
      out.push({
        rxcui: String(c.rxcui),
        name: String(c.name),
        synonym: c.synonym ? String(c.synonym) : undefined,
        tty: tty ? String(tty) : undefined,
      });
    }
  }

  return prioritize(out, q);
}

function prioritize(drugs: RxNormDrug[], query: string): RxNormDrug[] {
  const lq = query.toLowerCase();
  const rank = (d: RxNormDrug): number => {
    const n = d.name.toLowerCase();
    if (n === lq) return 0;
    if (n.startsWith(lq)) return 1;
    if (d.tty === 'SBD' || d.tty === 'SCD') return 2;
    if (d.tty === 'IN' || d.tty === 'MIN') return 3;
    return 4;
  };
  return [...drugs].sort((a, b) => rank(a) - rank(b)).slice(0, 20);
}
