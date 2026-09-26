#!/usr/bin/env node
/**
 * Guard: never prefix "Dr." onto a provider name unconditionally.
 *
 * The bug. src/lib/plan-brain-explanations.ts builds the Gate 1
 * provider lines the agent's Compare screen renders. It used to do:
 *
 *     const label = `Dr. ${providerLastName(p.name)}`;
 *
 * and providerLastName STRIPS the credential — CREDENTIAL_SUFFIX_RE
 * matches NP, PA-C, RN, FNP, APRN and CNM among others. So
 * "Jane Smith, NP" rendered as "Dr. Smith": the credential proving she
 * is not a physician was removed, and the claim she is one was added.
 * A broker read that to a beneficiary mid-call.
 *
 * The same defect existed independently in the consumer monorepo's
 * Top 4 screen and was fixed there separately. This repo has no
 * packages/ directory and does not depend on @plan-match/shared, so
 * the rule is duplicated rather than imported — which is exactly why
 * it needs a guard on this side too.
 *
 * Fails the build if a "Dr. " prefix is applied to anything other than
 * a literal, or if the credential-gated helper disappears.
 */
import { readFileSync } from 'node:fs';

const FILE = 'src/lib/plan-brain-explanations.ts';
const src = readFileSync(FILE, 'utf8');
const problems = [];

// 1. An interpolated "Dr. ${...}" is allowed in exactly one place:
//    inside providerLabel(), which applies it only after checking the
//    credential against DOCTORAL_CREDENTIALS. Anywhere else is the
//    original bug reappearing. A plain "Dr. Klein" in a doc comment or
//    an example string is fine; interpolation outside the helper is not.
const labelStart = src.indexOf('function providerLabel(');
const labelEnd = labelStart >= 0 ? src.indexOf('\n}', labelStart) : -1;
const inProviderLabel = (charIndex) =>
  labelStart >= 0 && labelEnd > labelStart &&
  charIndex > labelStart && charIndex < labelEnd;

let offset = 0;
src.split('\n').forEach((line, i) => {
  const lineStart = offset;
  offset += line.length + 1;
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
  if (!/`Dr\.\s*\$\{/.test(line)) return;
  if (inProviderLabel(lineStart)) return; // the one sanctioned site
  problems.push({
    line: i + 1,
    text: trimmed,
    why: 'interpolates a name into a hardcoded "Dr." prefix outside providerLabel()',
  });
});

// 1b. The sanctioned site must actually be credential-gated.
if (labelStart >= 0 && labelEnd > labelStart) {
  const body = src.slice(labelStart, labelEnd);
  if (/`Dr\.\s*\$\{/.test(body) && !/DOCTORAL_CREDENTIALS\.has\(/.test(body)) {
    problems.push({
      line: 0,
      text: '(providerLabel)',
      why: 'applies "Dr." without checking DOCTORAL_CREDENTIALS',
    });
  }
}

// 2. The credential-gated helper and its allowlist must still exist.
if (!/function providerLabel\s*\(/.test(src)) {
  problems.push({ line: 0, text: '(missing)', why: 'providerLabel() is gone' });
}
if (!/const DOCTORAL_CREDENTIALS\s*=\s*new Set\(/.test(src)) {
  problems.push({ line: 0, text: '(missing)', why: 'DOCTORAL_CREDENTIALS set is gone' });
}

// 3. buildGate1Explanations must route through providerLabel.
const gate1 = src.slice(src.indexOf('export function buildGate1Explanations'));
const gate1Body = gate1.slice(0, gate1.indexOf('\n}\n') + 1);
if (gate1Body && !/providerLabel\(/.test(gate1Body)) {
  problems.push({
    line: 0,
    text: '(buildGate1Explanations)',
    why: 'no longer calls providerLabel()',
  });
}

if (problems.length > 0) {
  console.error('\nPROVIDER HONORIFIC GUARD FAILED\n');
  console.error('"Dr." must be earned from the filed credential, never assumed.');
  console.error('A nurse practitioner or PA called "Dr." is a claim about someone\'s');
  console.error('licensure that the data does not support.\n');
  for (const p of problems) {
    console.error(`  ${FILE}${p.line ? ':' + p.line : ''}`);
    console.error(`    ${p.text}`);
    console.error(`    -> ${p.why}\n`);
  }
  process.exit(1);
}

console.log('OK  provider honorific is credential-gated in ' + FILE);
