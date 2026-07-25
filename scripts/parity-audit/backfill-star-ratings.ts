#!/usr/bin/env tsx
// Backfill pm_plans.star_rating from cached MPF JSONs. Every cached
// plan-detail response carries plan_card.overall_star_rating.rating
// (0-5 scale); we mirror that into pm_plans.star_rating for every
// scope plan currently null.
//
// The 2026-07-25 audit surfaced 50 F2 fails on ident.starRating —
// pm_plans.star_rating is null for a large chunk of MA/MAPD plans.
// MPF returns 4.0-5.0 for the same plans. This backfill closes that
// gap without any code change on either app.
//
// Cache-only pass (no network). If a plan's cached JSON doesn't have
// a rating (unlikely but possible), skip and count.
//
// Modes:
//   default   → dry-run summary
//   --state   → scope filter (default NC,TX,GA)
//   --write   → execute UPDATEs

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MPF_CACHE_DIR = path.join(REPO_ROOT, '_tmp', 'parity-audit', 'mpf');

const sb = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false } });

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const stateArg = args.find((a) => a.startsWith('--state='))?.slice(8)
  ?? (args.includes('--state') ? args[args.indexOf('--state') + 1] : null);
const STATES = (stateArg ?? 'NC,TX,GA').split(',').map((s) => s.trim().toUpperCase());

// Sweep every cached MPF file for star ratings — one row per contract-plan-segment.
function loadCachedStars(): Map<string, number> {
  const out = new Map<string, number>();
  if (!existsSync(MPF_CACHE_DIR)) return out;
  const profileDirs = readdirSync(MPF_CACHE_DIR).filter((d) => statSync(path.join(MPF_CACHE_DIR, d)).isDirectory());
  for (const pd of profileDirs) {
    const dir = path.join(MPF_CACHE_DIR, pd);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'snapshot.json');
    for (const f of files) {
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      const card = (raw as { plan_card?: Record<string, unknown> })?.plan_card;
      if (!card) continue;
      const rating = (card.overall_star_rating as { rating?: number | null } | undefined)?.rating;
      if (rating == null) continue;
      const contract = String(card.contract_id ?? '');
      const plan = String(card.plan_id ?? '');
      const segment = String(card.segment_id ?? '0').replace(/^0+/, '') || '0';
      const key = `${contract}-${plan}-${segment}`;
      if (!out.has(key)) out.set(key, rating);
    }
  }
  return out;
}

async function main() {
  console.log(`=== ${WRITE ? 'WRITE' : 'DRY-RUN'} MODE ===`);
  console.log(`States: ${STATES.join(',')}`);

  const stars = loadCachedStars();
  console.log(`Loaded ${stars.size} distinct (contract, plan, segment) star ratings from MPF cache\n`);

  let updated = 0;
  let alreadyPopulated = 0;
  let notInCache = 0;

  for (const st of STATES) {
    let from = 0;
    const nullPlans: Array<{ id: string; contract_id: string; plan_id: string; segment_id: string }> = [];
    while (true) {
      const r = await sb.from('pm_plans')
        .select('id, contract_id, plan_id, segment_id, star_rating')
        .eq('state', st)
        .not('plan_type', 'ilike', '%pdp%')
        .is('star_rating', null)
        .range(from, from + 999);
      const c = r.data ?? [];
      for (const row of c as any[]) nullPlans.push(row);
      if (c.length < 1000) break; from += 1000;
    }
    console.log(`  ${st}: ${nullPlans.length} pm_plans rows with null star_rating`);

    let matched = 0;
    for (const p of nullPlans) {
      const key = `${p.contract_id}-${p.plan_id}-${p.segment_id}`;
      const rating = stars.get(key);
      if (rating == null) { notInCache++; continue; }
      matched++;
      if (WRITE) {
        const u = await sb.from('pm_plans').update({ star_rating: rating }).eq('id', p.id);
        if (!u.error) updated++;
      }
    }
    console.log(`    matched to MPF cache: ${matched}`);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total UPDATEs ${WRITE ? 'applied' : 'planned'}: ${WRITE ? updated : ' (dry-run)'}`);
  console.log(`Scope plans missing from MPF cache: ${notInCache}`);
  void alreadyPopulated;
}

main().catch((e) => { console.error(e); process.exit(1); });
