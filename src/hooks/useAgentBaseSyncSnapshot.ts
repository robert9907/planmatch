// useAgentBaseSyncSnapshot — Zustand store that holds the most recent
// SyncInput payload built by QuoteDeliveryV4 for its recommended
// column. SaveSessionButton consumes this so saving a session also
// fires the structured AgentBase write (client_medications +
// client_providers) instead of leaving them in the pending JSONB blob.
//
// QuoteDeliveryV4 publishes whenever:
//   • The recommendedColId changes (broker switches the gold-badge
//     column via weight presets, current-plan picker, etc.).
//   • The medContext / providerContext arrays update because the user
//     added or removed a med / provider.
//   • The Plan Brain re-ranks (new finalists, weight override).
//
// Cleared on unmount so a stale snapshot from a different client's
// session can't fire after the broker navigates away.

import { create } from 'zustand';
import type { SyncInput } from './useAgentBaseRecommend';

interface SnapshotStore {
  snapshot: SyncInput | null;
  setSnapshot: (s: SyncInput | null) => void;
}

export const useAgentBaseSyncSnapshot = create<SnapshotStore>((set) => ({
  snapshot: null,
  setSnapshot: (snapshot) => set({ snapshot }),
}));
