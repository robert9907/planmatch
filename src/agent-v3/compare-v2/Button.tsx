// Compare-screen button system.
//
// Replaces the three ad-hoc treatments that shipped on the SlotCell
// action row (mint-tint / navy-fill / mint-outline at identical width)
// with a three-tier ladder where rank is carried by WEIGHT, not hue:
//
//   primary    solid mint    the action that commits — Enroll
//   secondary  mint tint     a meaningful next step — Send quote
//   quiet      hairline      reference + utility — Summary, Head-to-head
//
// Visual states live in AGENT_V3_CSS as `.pma3-btn*` rules rather than
// inline styles, so :hover / :active / :focus-visible / :disabled are
// real pseudo-classes instead of React state. Everything else in
// agent-v3 stays inline; this is the one place it's worth the CSS.
//
// Hard rules enforced here:
//   • labels never wrap  (white-space: nowrap on the base class)
//   • one primary per card
//   • a disabled button always carries a `title` saying what enables it

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type BtnTier = 'primary' | 'secondary' | 'quiet';
export type BtnSize = 'md' | 'sm';

export function Btn({
  tier = 'quiet',
  size = 'sm',
  block = false,
  className,
  children,
  ...rest
}: {
  tier?: BtnTier;
  size?: BtnSize;
  /** Full width of its container. The default on the board cards. */
  block?: boolean;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = [
    'pma3-btn',
    `pma3-btn--${tier}`,
    `pma3-btn--${size}`,
    block ? 'pma3-btn--block' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={classes} {...rest}>
      {children}
    </button>
  );
}
