// CMS Medicare Beneficiary Identifier (MBI) validator — agent-app copy.
//
// This repo is separate from the consumer Plan Match. Both apps share
// the CMS character-class rules, so this file is a deliberate duplicate
// of the consumer canonical.
//
// 11 characters, positions strictly typed per CMS spec:
//   C1  num(1-9)         — no leading zero
//   C2  alpha            — no S L O I B Z
//   C3  alphanum         — alpha restrictions apply
//   C4  num
//   C5  alpha
//   C6  alphanum
//   C7  num
//   C8  alpha
//   C9  alpha
//   C10 num
//   C11 num
//
// Letter class [AC-HJKMNP-RT-Y] is the 20 CMS-legal letters:
//   A C D E F G H J K M N P Q R T U V W X Y   (excludes S L O I B Z).
// A prior version of this file used [AC-HJKMNP-RTVWXY], which also
// excluded U — that silently rejected ~24% of valid MBIs at intake.
//
// This file MUST stay identical to:
//   • ~/Code/plan-match/apps/web/src/lib/mbiValidation.ts     (frontend)
//   • ~/Code/plan-match/api/_lib/mbi.ts                       (serverless)
// The test-vector table in each repo's *.test.ts file is the drift
// alarm — changing the regex in one copy without updating vectors
// elsewhere breaks that copy's tests.

export const MBI_REGEX =
  /^[1-9][AC-HJKMNP-RT-Y][0-9AC-HJKMNP-RT-Y][0-9][AC-HJKMNP-RT-Y][0-9AC-HJKMNP-RT-Y][0-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y][0-9]{2}$/;

/** Strip non-alphanumeric and uppercase. Returns null for empty or
 *  non-string input so callers can distinguish "typed nothing" from
 *  "typed something that normalized to empty". */
export function normalizeMbi(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return cleaned.length === 0 ? null : cleaned;
}

/** True iff normalized input matches the CMS MBI format. */
export function isValidMbi(raw: unknown): boolean {
  const normalized = normalizeMbi(raw);
  if (normalized === null) return false;
  return MBI_REGEX.test(normalized);
}

/** Display-safe MBI: eight bullets + last 2 chars. Full value only
 *  enters the DOM behind an explicit reveal action. */
export function maskMbi(raw: unknown): string {
  const normalized = normalizeMbi(raw);
  if (!normalized) return '';
  if (normalized.length < 2) return '••••••••';
  return '••••••••' + normalized.slice(-2);
}
