// Design tokens for the 2026 Compare-screen reskin.
//
// Sourced from the /mnt/user-data/outputs/planmatch-wired.html reference
// (also archived at _tmp/mockup/planmatch-wired.html). The old inline
// palette in CompareScreen.tsx (NAVY / SEAFOAM / etc.) stays put for
// surfaces that haven't been reskinned yet — H2HView, Container/Header/
// Nav shell — so both palettes coexist during the migration.
//
// Fonts assume the app has Inter + IBM Plex Mono loaded globally. The
// existing screen was on DM Sans + JetBrains Mono; both stacks fall
// back cleanly to system-ui / ui-monospace so a missing @font-face is
// visible-but-not-broken.

export const TOKENS = {
  // Backgrounds
  paper: '#F7F8FA',
  card: '#FFFFFF',

  // Ink
  ink: '#0F172A',
  muted: '#64748B',
  muted2: '#94A0B2',

  // Lines
  line: '#E6E9EF',
  lineStrong: '#D3D8E2',

  // Navy stack (dark surfaces)
  navy950: '#0A1220',
  navy800: '#122036',
  navy700: '#1A2C48',
  navyLine: '#1E2C46',
  navyRow: '#16223A',
  navyChipBorder: '#2A3B57',
  navyText: '#EAF0F6',
  navyTextMuted: '#8FA0B8',
  navyTextDim: '#B9C6D8',

  // Mint accent (rank, success, live)
  mint700: '#0B7A5A',
  mint600: '#0F9E77',
  mint100: '#E4F7EF',
  mintOnDark: '#7FE0C4',
  mintOnMint: '#04231A',

  // Amber accent (pending / verification)
  amber700: '#9A5B0A',
  amber100: '#FBEEDC',
} as const;

export const FONT = {
  label: "'Inter', system-ui, sans-serif",
  num: "'IBM Plex Mono', ui-monospace, monospace",
} as const;
