// priority-keys — the extras toggles the agent's Priorities screen
// offers, split out of PrioritiesScreen.tsx so code that needs the KEYS
// does not have to import a React component to get them.
//
// The split exists for one concrete reason: the Gate 3 classification
// invariant (every key is either gated or explicitly excused — see
// EXTRAS_GATE_KEYS / NON_GATE_PRIORITY_KEYS in src/lib/plan-brain.ts)
// has a compile-time assertion in AgentV3App, but a compile-time
// assertion only fires if someone runs tsc. The runtime test in
// scripts/tests/priority-key-classification.test.ts asserts it against
// PRIORITY_OPTIONS — the list a broker actually sees — and that test
// runs under `tsx --test`, which cannot load a .tsx that pulls in React
// and the atoms stylesheet.
//
// PrioritiesScreen re-exports both symbols, so existing imports of the
// form `import { PrioritiesScreen, type PriorityKey } from
// './PrioritiesScreen'` keep working unchanged.

export interface PriorityToggle {
  key: PriorityKey;
  label: string;
  icon: string;
}

export type PriorityKey =
  | 'dental'
  | 'vision'
  | 'hearing'
  | 'otc'
  | 'fitness'
  | 'transportation'
  | 'telehealth'
  | 'healthy_foods'
  | 'partb_giveback';

export const PRIORITY_OPTIONS: PriorityToggle[] = [
  { key: 'dental',         label: 'Dental',           icon: '🦷' },
  { key: 'vision',         label: 'Vision',           icon: '👁' },
  { key: 'hearing',        label: 'Hearing aids',     icon: '👂' },
  { key: 'otc',            label: 'OTC allowance',    icon: '🛒' },
  { key: 'fitness',        label: 'Gym / Fitness',    icon: '🏋️' },
  { key: 'transportation', label: 'Transportation',   icon: '🚗' },
  { key: 'telehealth',     label: 'Telehealth',       icon: '📺' },
  { key: 'healthy_foods',  label: 'Healthy foods',    icon: '🥦' },
  { key: 'partb_giveback', label: 'Part B giveback',  icon: '↩️' },
];
