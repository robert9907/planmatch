// useScreenShare — tiny zustand store that tracks the currently
// active Twilio Video screen-share + a thin start/stop API.
//
// Lives outside src/lib/session.ts on purpose: session is persisted to
// localStorage (notes); the active screen share is volatile session
// state (browser MediaStream, Room, timers) that should never be
// rehydrated. A page refresh kills the share whether we like it or
// not because getDisplayMedia can't be silently re-acquired.
//
// Two consumers today:
//   • A "Share Screen" button on QuotePage that calls start()/stop()
//   • MiniSoftphone (mounted in WorkflowShell) that reads `active` to
//     drive the combined "Sharing + On call" status indicator and
//     the End-all button
// A future BrokerActions overlay could read the same store without
// new wiring.

import { create } from 'zustand';
import {
  startScreenShare,
  type ActiveShare,
  type ShareStartResult,
} from '@/lib/screenShare';

interface ScreenShareState {
  /** The live ActiveShare handle when sharing, null when idle. */
  active: ActiveShare | null;
  /** Result returned by /api/screen-share-start (roomId + watch link
   *  + sms status). Surfaced so the Share button can show "SMS sent
   *  to (828) 555-0100" without re-fetching. */
  result: ShareStartResult | null;
  /** Starting state — true between user click and Twilio Room ready. */
  starting: boolean;
  /** Last error string. Cleared on successful start. */
  error: string | null;
  /** Begin a share. Caller supplies the dial target + name so the
   *  SMS body has the right greeting. */
  start: (params: {
    clientPhone: string;
    clientFirstName?: string;
    brokerName?: string;
  }) => Promise<void>;
  /** Stop whichever share is currently active. */
  stop: (reason?: string) => Promise<void>;
}

export const useScreenShareStore = create<ScreenShareState>((set, get) => ({
  active: null,
  result: null,
  starting: false,
  error: null,

  start: async (params) => {
    const current = get();
    if (current.active || current.starting) return;
    set({ starting: true, error: null });
    try {
      const { active, share } = await startScreenShare({
        clientPhone: params.clientPhone,
        clientFirstName: params.clientFirstName,
        brokerName: params.brokerName,
        // The lib calls onEnded for browser-stop / idle-timeout. Wire
        // it back into the store so the UI flips to idle.
        onEnded: () => {
          set({ active: null, result: null, starting: false });
        },
      });
      set({ active, result: share, starting: false, error: null });
    } catch (err) {
      console.warn('[screen-share] start failed:', (err as Error).message);
      set({ starting: false, error: (err as Error).message });
    }
  },

  stop: async (reason = 'manual') => {
    const { active } = get();
    if (!active) return;
    try {
      await active.stop(reason);
    } catch (err) {
      console.warn('[screen-share] stop failed:', (err as Error).message);
    }
    // active.stop calls onEnded which already flips state to idle —
    // but defensively clear here in case the lib's onEnded didn't fire
    // (e.g. it was overridden somewhere).
    set({ active: null, result: null, starting: false });
  },
}));
