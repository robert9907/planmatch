// Browser-side Twilio Video publisher. Wraps getDisplayMedia + room
// connect so the UI layer only deals with start/stop semantics.
//
// The 30-minute idle kill is a safety net — the broker normally stops
// manually, but if Rob forgets to click Stop and walks away from his
// laptop, this timer tears the room down so Twilio minutes don't
// accumulate. "Idle" here just means "share has been active this long"
// — we don't track actual user interaction; a 30-minute cap on any
// single share is the simpler and strictly-safer bound.

import {
  connect as twilioConnect,
  LocalVideoTrack,
  type Room,
} from 'twilio-video';

const IDLE_KILL_MS = 30 * 60 * 1000;

export interface ShareStartResult {
  roomId: string;
  brokerToken: string;
  smsFailed: boolean;
  smsError?: string;
  link: string;
}

export interface ActiveShare {
  roomId: string;
  room: Room;
  stream: MediaStream;
  track: LocalVideoTrack;
  stop: (reason?: string) => Promise<void>;
}

export async function startScreenShare(params: {
  clientPhone: string;
  clientFirstName?: string;
  brokerName?: string;
  onEnded: (reason: string) => void;
}): Promise<{ active: ActiveShare; share: ShareStartResult }> {
  // Browser captures first — prompts the user for the tab/window picker.
  // If they cancel, we never hit the server, so no Twilio room gets
  // orphaned in "in-progress" state waiting for a publisher that
  // doesn't exist.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 15, max: 30 } },
    // We don't capture audio — the Twilio Voice call is the audio
    // channel. Including audio here would double-capture and cause
    // echo on the viewer side.
    audio: false,
  });

  // Now book the room.
  const res = await fetch('/api/screen-share-start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientPhone: params.clientPhone,
      clientFirstName: params.clientFirstName,
      brokerName: params.brokerName,
    }),
  });
  if (!res.ok) {
    stream.getTracks().forEach((t) => t.stop());
    const body = await res.text();
    throw new Error(`screen-share-start ${res.status}: ${body.slice(0, 200)}`);
  }
  const share = (await res.json()) as ShareStartResult;

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('No video track in getDisplayMedia stream');
  }
  const localTrack = new LocalVideoTrack(videoTrack, { name: 'screen' });

  const room = await twilioConnect(share.brokerToken, {
    name: share.roomId,
    tracks: [localTrack],
  });

  let stopped = false;
  async function stop(reason = 'manual') {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(idleTimer);
    videoTrack.removeEventListener('ended', onBrowserStop);
    try { localTrack.stop(); } catch { /* noop */ }
    try { stream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    try { room.disconnect(); } catch { /* noop */ }
    try {
      await fetch('/api/screen-share-stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: share.roomId }),
      });
    } catch { /* server completion is best-effort */ }
    params.onEnded(reason);
  }

  // User clicking Chrome's built-in "Stop sharing" pill fires 'ended'
  // on the MediaStreamTrack. Hook it so the UI state matches reality.
  function onBrowserStop() { void stop('browser_stop'); }
  videoTrack.addEventListener('ended', onBrowserStop);

  // Idle auto-kill at 30 min.
  const idleTimer = window.setTimeout(() => {
    void stop('idle_timeout');
  }, IDLE_KILL_MS);

  return {
    active: { roomId: share.roomId, room, stream, track: localTrack, stop },
    share,
  };
}
