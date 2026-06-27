// Diagnostic: which AGENTBASE_* env vars are loaded and what shape are they?
// Never prints the actual secret — only length, prefix, and presence.

import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  const lines = readFileSync('.env.local', 'utf8').split('\n');
  console.log(`.env.local: ${lines.length} lines total`);
  const agentLines = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.includes('AGENTBASE') || line.includes('SUPABASE'));
  console.log(`Lines containing AGENTBASE or SUPABASE: ${agentLines.length}`);
  for (const { line, i } of agentLines) {
    const eq = line.indexOf('=');
    if (eq === -1) {
      console.log(`  line ${i + 1}: (no =) ${line.slice(0, 40)}...`);
      continue;
    }
    const name = line.slice(0, eq);
    const valLen = line.length - eq - 1;
    const valStart = line.slice(eq + 1, eq + 9);
    console.log(`  line ${i + 1}: ${name} = (len=${valLen}, starts="${valStart}...")`);
  }

  console.log('\nApplying regex parser:');
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && (m[1].includes('AGENTBASE') || m[1].includes('SUPABASE'))) {
      console.log(`  parsed: ${m[1]} (len=${m[3].length})`);
      if (!process.env[m[1]]) process.env[m[1]] = m[3];
    }
  }

  console.log('\nFinal process.env values:');
  for (const k of Object.keys(process.env).sort()) {
    if (k.includes('AGENTBASE') || (k.startsWith('SUPABASE_') && !k.includes('PROD'))) {
      const v = process.env[k] ?? '';
      console.log(`  ${k}: len=${v.length}, starts="${v.slice(0, 8)}..."`);
    }
  }
}
