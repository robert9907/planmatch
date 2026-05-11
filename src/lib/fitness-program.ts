// Resolve the consumer-visible fitness program brand for a plan. Port
// of the consumer module at apps/web/src/lib/fitness-program.ts so the
// agent surfaces the same brand names ("Go365" for Humana, "Renew
// Active" for UHC, etc.) instead of a generic "Yes".
//
// Precedence:
//   1. pm_plan_benefits fitness row description, when it names a known
//      program. Wins over the carrier heuristic.
//   2. Carrier / parent_organization heuristic:
//        Humana                              → Go365
//        United / UHC / AARP                 → Renew Active
//        Blue / BCBS                         → Silver&Fit
//        everything else                     → SilverSneakers
//
// Substring-based, case-insensitive. Callers should pass any of:
//   - pm_plans.carrier
//   - pm_plans.parent_organization
//   - both concatenated (recommended) — NC Blue Cross plans have
//     carrier="Blue Cross and Blue Shield of NC" but
//     parent_organization="CuraCor Solutions Corp.", so only the
//     concatenation reliably reveals the Blue family.

export type FitnessProgramName =
  | 'Go365'
  | 'Renew Active'
  | 'Silver&Fit'
  | 'SilverSneakers';

const KNOWN_PROGRAMS: ReadonlyArray<string> = [
  'Go365',
  'Renew Active',
  'SilverSneakers',
  'Silver&Fit',
  'Silver and Fit',
  'One Pass',
];

function normalize(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isHumanaFamily(carrier: string | null | undefined): boolean {
  return normalize(carrier).includes('humana');
}

function isUhcFamily(carrier: string | null | undefined): boolean {
  const c = normalize(carrier);
  return c.includes('united') || c.startsWith('uhc') || c.includes('uhc') || c.includes('aarp');
}

function isBlueFamily(carrier: string | null | undefined): boolean {
  const c = (carrier ?? '').toLowerCase();
  return c.includes('blue') || c.includes('bcbs');
}

export function fitnessProgramForCarrier(
  carrierOrParentOrg: string | null | undefined,
): FitnessProgramName {
  if (isHumanaFamily(carrierOrParentOrg)) return 'Go365';
  if (isUhcFamily(carrierOrParentOrg)) return 'Renew Active';
  if (isBlueFamily(carrierOrParentOrg)) return 'Silver&Fit';
  return 'SilverSneakers';
}

export function resolveFitnessProgram(
  description: string | null | undefined,
  carrierOrParentOrg: string | null | undefined,
): string {
  const desc = description ?? '';
  for (const p of KNOWN_PROGRAMS) {
    if (
      new RegExp(
        `\\b${p.replace(/&/g, '\\s*&\\s*').replace(/\s+/g, '\\s+')}\\b`,
        'i',
      ).test(desc)
    ) {
      return p === 'Silver and Fit' ? 'Silver&Fit' : p;
    }
  }
  return fitnessProgramForCarrier(carrierOrParentOrg);
}
