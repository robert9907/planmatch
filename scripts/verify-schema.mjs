#!/usr/bin/env node
// Verifies the capture_sessions table is live in Supabase.
// Run AFTER applying supabase/migrations/001_capture_sessions.sql:
//   node scripts/verify-schema.mjs
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local
// (run `npx vercel env pull .env.local` first if you don't have one).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(__dirname, '..', '.env.local'));

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('✗ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  console.error('  Run: npx vercel env pull .env.local');
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

console.log(`\n→ Supabase: ${url}`);
console.log('→ Probing capture_sessions with an insert…');

const probeToken = `probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const { data: inserted, error: insertErr } = await supabase
  .from('capture_sessions')
  .insert({
    token: probeToken,
    status: 'waiting',
    client_phone: '+15550000000',
    client_name: '__probe__',
  })
  .select('id, token, status, item_count, payload, expires_at')
  .single();

if (insertErr) {
  const missing =
    insertErr.code === '42P01' ||
    insertErr.code === 'PGRST205' ||
    /does not exist|schema cache/i.test(insertErr.message);
  console.error(`\n✗ capture_sessions is NOT ready.`);
  console.error(`  code: ${insertErr.code}`);
  console.error(`  message: ${insertErr.message}`);
  if (missing) {
    console.error('\n→ The table does not exist. Apply the migration:');
    console.error('  https://supabase.com/dashboard/project/wyyasqvouvdcovttzfnv/sql/new');
    console.error('  Paste supabase/migrations/001_capture_sessions.sql → Run.');
  }
  process.exit(1);
}

console.log(`✓ capture_sessions exists and accepts inserts.`);
console.log(`✓ insert works (status=${inserted.status}, item_count=${inserted.item_count}).`);
console.log(`✓ expires_at default fires (${inserted.expires_at}).`);

const { error: updateErr } = await supabase
  .from('capture_sessions')
  .update({ payload: [{ id: 'test', created_at: new Date().toISOString(), image_url: '', extracted: [] }] })
  .eq('id', inserted.id);
if (updateErr) {
  console.error('\n✗ update failed.');
  console.error(`  code: ${updateErr.code}`);
  console.error(`  message: ${updateErr.message}`);
  process.exit(1);
}
console.log('✓ payload update works (generated item_count recomputes).');

const { error: deleteErr } = await supabase.from('capture_sessions').delete().eq('id', inserted.id);
if (deleteErr) {
  console.warn(`! cleanup failed (probe row ${inserted.id} remains): ${deleteErr.message}`);
} else {
  console.log('✓ probe row cleaned up.');
}

console.log('\n✅ capture_sessions is ready for Phase 3. Retry /api/capture-start.');

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const body = fs.readFileSync(filePath, 'utf8');
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)?\s*$/);
    if (!match) continue;
    const [, k, rawV] = match;
    if (process.env[k]) continue;
    let v = rawV ?? '';
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[k] = v;
  }
}
