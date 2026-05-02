// useSoftphone — React hook wrapping a Twilio Voice Device for
// browser-based calling from PlanMatch.
//
// Flow:
//   1. The Device is NOT constructed on mount. `new Device()` builds an
//      AudioHelper that probes audio in/out, which Chrome's autoplay
//      policy treats as needing a user gesture; constructing on mount
//      logs "The AudioContext was not allowed to start" in the console
//      every page load. We defer construction to the first call() so
//      the Device is born inside the click handler's gesture chain.
//   2. call(phoneNumber) → ensureDevice() (lazy mint + register) →
//      Device.connect({ params: { To } }) — the TwiML App on AgentBase
//      routes the call via <Dial>{To}</Dial>.
//   3. State machine: idle → connecting → ringing → connected →
//      on-hold → idle.
//   4. Token auto-refresh ~5 minutes before expiry; updateToken() on
//      the live Device avoids tearing down an active call.
//   5. Fail-soft: any error logs + sets `error`, never throws past
//      the hook boundary so the Quote page render is never crashed
//      by a softphone hiccup.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Device, type Call } from '@twilio/voice-sdk';

export type SoftphoneState =
  | 'unavailable'  // SDK init failed (env / token / permissions)
  | 'idle'         // device ready, no active call
  | 'connecting'   // call() invoked, waiting for accept
  | 'ringing'      // ringing (outbound) or incoming
  | 'connected'    // call up
  | 'on-hold';     // muted-locally counts as connected; this is the
                   // explicit hold state (a /api/softphone-hold could
                   // route to <Dial><Conference>… for true hold; for
                   // now we treat hold as "muted both ways" — broker
                   // mutes self + sends DTMF or noop on far end).

interface TokenResponse {
  token: string;
  identity: string;
  ttlSeconds: number;
  twimlAppSid: string;
}

interface UseSoftphoneArgs {
  /** Default broker identity for the token. Server caps to 64 chars. */
  identity?: string;
  /** Reserved for future use. Device construction is now lazy (first
   *  call), so passing false is a no-op — kept for call-site stability
   *  with the previous mount-time-init API. */
  enabled?: boolean;
}

interface UseSoftphoneApi {
  state: SoftphoneState;
  /** True when an active call is muted (local mic suppressed). */
  muted: boolean;
  /** Seconds since the call connected. 0 when not connected. */
  duration: number;
  /** Last error message — null when healthy. */
  error: string | null;
  /** Identity the active token was minted under. */
  identity: string | null;
  call: (phoneNumber: string) => Promise<void>;
  hangup: () => void;
  toggleMute: () => void;
  toggleHold: () => void;
  sendDtmf: (digit: string) => void;
}

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min early

function normalizeForDial(raw: string): string {
  // Mirror api/_lib/twilio.normalizePhone but client-side. Twilio
  // accepts E.164 in the To param; the TwiML App routes via <Dial>.
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits;
}

export function useSoftphone(args: UseSoftphoneArgs = {}): UseSoftphoneApi {
  const { identity: requestedIdentity } = args;

  // Initial state is 'idle' (not 'unavailable') so the AgentBar phone
  // button + PhonePanel "Call" button render in their ready styling
  // before the Device exists. The first call() invocation will lazily
  // mint the token and construct the Device; if that fails we flip to
  // 'unavailable' at that point.
  const [state, setState] = useState<SoftphoneState>('idle');
  const [muted, setMuted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<string | null>(null);

  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const durationTimerRef = useRef<number | null>(null);

  // Token fetch helper — the same call is used for initial mint AND
  // refresh, so we centralize URL building + error mapping here.
  const fetchToken = useCallback(async (): Promise<TokenResponse> => {
    const qs = requestedIdentity
      ? `?identity=${encodeURIComponent(requestedIdentity)}`
      : '';
    const res = await fetch(`/api/softphone-token${qs}`, { cache: 'no-store' });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`softphone-token ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as TokenResponse;
  }, [requestedIdentity]);

  // Schedule a refresh just before token expiry. The Voice SDK's
  // updateToken() swaps the credential without disconnecting an
  // active call.
  const scheduleRefresh = useCallback((ttlSeconds: number) => {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
    }
    const refreshAt = Math.max(15_000, ttlSeconds * 1000 - TOKEN_REFRESH_BUFFER_MS);
    refreshTimerRef.current = window.setTimeout(async () => {
      try {
        const fresh = await fetchToken();
        if (deviceRef.current) {
          deviceRef.current.updateToken(fresh.token);
        }
        scheduleRefresh(fresh.ttlSeconds);
      } catch (err) {
        // Refresh failure is non-fatal as long as the device is idle —
        // the next call() attempt will re-init from scratch via the
        // useEffect cleanup if the device errored out.
        console.warn('[softphone] token refresh failed:', (err as Error).message);
      }
    }, refreshAt);
  }, [fetchToken]);

  // Lazy device construction — runs from inside the call() handler so
  // the AudioHelper that `new Device()` builds is created from a user
  // gesture. Subsequent calls reuse the same Device.
  const ensureDevice = useCallback(async (): Promise<Device | null> => {
    if (deviceRef.current) return deviceRef.current;
    try {
      const tk = await fetchToken();
      const device = new Device(tk.token, {
        // Keep the codec list small — Opus is the modern default,
        // PCMU is the universal fallback.
        codecPreferences: ['opus' as Call.Codec, 'pcmu' as Call.Codec],
        // Don't auto-answer incoming calls; the broker may not want
        // a stray call to interrupt a screen-share.
        allowIncomingWhileBusy: false,
      });

      device.on('registered', () => {
        setState((s) => (s === 'unavailable' ? 'idle' : s));
        setError(null);
      });
      device.on('error', (err) => {
        console.warn('[softphone] device error:', err?.message ?? err);
        setError(err?.message ?? 'softphone error');
        // Don't set 'unavailable' on every transient error — most
        // are recoverable (network blip during refresh, codec
        // negotiation hiccup). Only flip to unavailable when we
        // genuinely lose the device.
      });
      device.on('incoming', (call: Call) => {
        // PlanMatch is broker-outbound-only; reject incoming calls
        // so a stray AgentBase route doesn't ring the broker
        // mid-quote. A future build can hook this for a "ringing"
        // toast; for now keep the contract narrow.
        call.reject();
      });

      await device.register();
      deviceRef.current = device;
      setIdentity(tk.identity);
      scheduleRefresh(tk.ttlSeconds);
      return device;
    } catch (err) {
      console.warn('[softphone] init failed:', (err as Error).message);
      setError((err as Error).message);
      setState('unavailable');
      return null;
    }
  }, [fetchToken, scheduleRefresh]);

  // Cleanup-only effect — destroys the lazily-constructed Device on
  // unmount / hot reload so we don't leak a ghost that keeps fielding
  // incoming calls.
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (durationTimerRef.current !== null) {
        window.clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
      }
      if (callRef.current) {
        try { callRef.current.disconnect(); } catch { /* noop */ }
        callRef.current = null;
      }
      const device = deviceRef.current;
      if (device) {
        try { device.destroy(); } catch { /* noop */ }
      }
      deviceRef.current = null;
    };
  }, []);

  // Wire a fresh Call object to our state machine + timers. Pulled
  // out so call() and a future incoming-call path share one path.
  const attachCall = useCallback((call: Call) => {
    callRef.current = call;
    setState('connecting');
    setMuted(false);
    setDuration(0);

    call.on('ringing', () => setState('ringing'));
    call.on('accept', () => {
      setState('connected');
      const startedAt = Date.now();
      if (durationTimerRef.current !== null) window.clearInterval(durationTimerRef.current);
      durationTimerRef.current = window.setInterval(() => {
        setDuration(Math.floor((Date.now() - startedAt) / 1000));
      }, 1000);
    });
    const onEnd = () => {
      if (durationTimerRef.current !== null) {
        window.clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
      }
      callRef.current = null;
      setState('idle');
      setMuted(false);
      setDuration(0);
    };
    call.on('disconnect', onEnd);
    call.on('cancel', onEnd);
    call.on('reject', onEnd);
    call.on('error', (err) => {
      console.warn('[softphone] call error:', err?.message ?? err);
      setError(err?.message ?? 'call error');
      onEnd();
    });
  }, []);

  const call = useCallback(async (phoneNumber: string) => {
    setError(null);
    if (callRef.current) {
      // Already on a call — caller must hang up first. This guards
      // against an accidental double-click on a phone number link
      // launching a second outbound while the first is still up.
      return;
    }
    const to = normalizeForDial(phoneNumber);
    if (!to || !/^\+\d{10,15}$/.test(to)) {
      setError(`invalid phone number: ${phoneNumber}`);
      return;
    }
    // Lazy mint inside the click-handler chain so AudioContext can
    // start. ensureDevice handles its own setError on failure.
    const device = await ensureDevice();
    if (!device) return;
    try {
      // Twilio.Device.connect returns a Promise<Call>. The TwiML App
      // sees `params.To` and dials it via <Dial><Number>{To}</Number>.
      const newCall = await device.connect({ params: { To: to } });
      attachCall(newCall);
    } catch (err) {
      console.warn('[softphone] connect failed:', (err as Error).message);
      setError((err as Error).message);
    }
  }, [ensureDevice, attachCall]);

  const hangup = useCallback(() => {
    const c = callRef.current;
    if (!c) return;
    try { c.disconnect(); } catch (err) {
      console.warn('[softphone] disconnect failed:', (err as Error).message);
    }
  }, []);

  const toggleMute = useCallback(() => {
    const c = callRef.current;
    if (!c) return;
    const next = !muted;
    try {
      c.mute(next);
      setMuted(next);
    } catch (err) {
      console.warn('[softphone] mute failed:', (err as Error).message);
    }
  }, [muted]);

  // Hold here means "mute both directions" — the SDK doesn't expose
  // a true hold without a TwiML App that supports <Conference>. The
  // broker's perception is the same: silence on both ends, the
  // client doesn't hear "Rob is on hold" hold music. A future build
  // can promote this to a real hold via a server-side Conference
  // route on AgentBase.
  const toggleHold = useCallback(() => {
    const c = callRef.current;
    if (!c) return;
    if (state === 'on-hold') {
      try { c.mute(false); } catch { /* noop */ }
      setMuted(false);
      setState('connected');
    } else if (state === 'connected') {
      try { c.mute(true); } catch { /* noop */ }
      setMuted(true);
      setState('on-hold');
    }
  }, [state]);

  const sendDtmf = useCallback((digit: string) => {
    const c = callRef.current;
    if (!c) return;
    if (!/^[0-9*#]$/.test(digit)) return;
    try {
      c.sendDigits(digit);
    } catch (err) {
      console.warn('[softphone] sendDigits failed:', (err as Error).message);
    }
  }, []);

  return {
    state,
    muted,
    duration,
    error,
    identity,
    call,
    hangup,
    toggleMute,
    toggleHold,
    sendDtmf,
  };
}

// Format a duration in seconds as MM:SS. Exported so the dock + the
// MiniSoftphone can render the same string from different places.
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
