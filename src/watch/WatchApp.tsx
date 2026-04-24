// WatchApp — mobile-friendly viewer for a broker's live screen share.
//
// URL shape: /watch/<roomId>
//   · No auth. The roomId is the secret (unguessable base36, issued by
//     /api/screen-share-start and delivered by SMS only to the one
//     client phone we're trying to show).
//   · The page fetches a viewer-only Twilio Video access token, connects
//     to the room, and attaches whatever VideoTrack the broker publishes
//     to a full-bleed <video> element.
//   · No download, no login, no controls beyond a back-to-home link if
//     the share ends.

import { useEffect, useRef, useState } from 'react';
import {
  connect as twilioConnect,
  type Room,
  type RemoteTrack,
  type RemoteVideoTrack,
  type RemoteParticipant,
} from 'twilio-video';

type Status =
  | 'loading'
  | 'connecting'
  | 'waiting_for_broker'
  | 'live'
  | 'ended'
  | 'not_found'
  | 'error';

export function WatchApp() {
  const roomId = roomIdFromPath();
  const [status, setStatus] = useState<Status>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const videoWrapRef = useRef<HTMLDivElement | null>(null);
  const roomRef = useRef<Room | null>(null);

  useEffect(() => {
    if (!roomId) {
      setStatus('not_found');
      return;
    }
    let disposed = false;

    async function join() {
      setStatus('connecting');
      try {
        const tokenRes = await fetch(
          `/api/screen-share-token?room=${encodeURIComponent(roomId!)}`,
        );
        if (tokenRes.status === 404) {
          setStatus('not_found');
          return;
        }
        if (tokenRes.status === 410) {
          setStatus('ended');
          return;
        }
        if (!tokenRes.ok) {
          const body = await tokenRes.text();
          throw new Error(`token ${tokenRes.status}: ${body.slice(0, 200)}`);
        }
        const { token } = (await tokenRes.json()) as { token: string };

        const room = await twilioConnect(token, {
          name: roomId!,
          audio: false,
          video: false, // viewer doesn't publish anything
        });
        if (disposed) {
          room.disconnect();
          return;
        }
        roomRef.current = room;

        // Attach existing broker tracks (if they published before we joined).
        room.participants.forEach((p) => attachParticipant(p));
        room.on('participantConnected', attachParticipant);
        room.on('participantDisconnected', () => {
          // Broker dropped — most likely clicked Stop Sharing. Show the
          // ended state unless other participants are still publishing.
          if (room.participants.size === 0) setStatus('ended');
        });
        room.on('disconnected', (_r, err) => {
          if (err) setErrorMsg(err.message);
          setStatus('ended');
        });
        setStatus(room.participants.size === 0 ? 'waiting_for_broker' : 'live');
      } catch (err) {
        if (disposed) return;
        setErrorMsg((err as Error).message);
        setStatus('error');
      }
    }

    function attachParticipant(participant: RemoteParticipant) {
      participant.tracks.forEach((pub) => {
        if (pub.track && pub.track.kind === 'video') attachVideo(pub.track as RemoteVideoTrack);
      });
      participant.on('trackSubscribed', (track: RemoteTrack) => {
        if (track.kind === 'video') attachVideo(track as RemoteVideoTrack);
      });
    }

    function attachVideo(track: RemoteVideoTrack) {
      const el = track.attach();
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.objectFit = 'contain';
      el.setAttribute('playsinline', 'true');
      const wrap = videoWrapRef.current;
      if (!wrap) return;
      // Clear any prior track elements — only one screen track at a time.
      while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
      wrap.appendChild(el);
      setStatus('live');
    }

    void join();

    return () => {
      disposed = true;
      const room = roomRef.current;
      if (room) {
        try { room.disconnect(); } catch { /* noop */ }
      }
    };
  }, [roomId]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      <div
        style={{
          padding: '10px 16px',
          fontSize: 13,
          background: '#0d2f5e',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          borderBottom: '1px solid rgba(255,255,255,.08)',
        }}
      >
        <span
          style={{
            fontFamily: 'Fraunces, Georgia, serif',
            fontSize: 16,
            fontWeight: 700,
          }}
        >
          Plan<span style={{ color: '#83f0f9' }}>Match</span>
        </span>
        <span style={{ opacity: 0.7 }}>· Live screen share</span>
        <StatusDot status={status} />
      </div>

      <div
        ref={videoWrapRef}
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#000',
          minHeight: 0,
        }}
      >
        {status !== 'live' && <StatusOverlay status={status} errorMsg={errorMsg} />}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: Status }) {
  const active = status === 'live';
  return (
    <span
      style={{
        marginLeft: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: active ? '#2ecc71' : status === 'ended' ? '#868e96' : '#e67e22',
        }}
      />
      {active ? 'Connected' : status === 'ended' ? 'Ended' : status === 'waiting_for_broker' ? 'Waiting' : status}
    </span>
  );
}

function StatusOverlay({ status, errorMsg }: { status: Status; errorMsg: string | null }) {
  const msg = (() => {
    switch (status) {
      case 'loading':
      case 'connecting': return 'Connecting…';
      case 'waiting_for_broker':
        return 'Waiting for the broker to start sharing…';
      case 'ended':
        return 'The share has ended. You can close this tab.';
      case 'not_found':
        return "This link isn't valid or has expired.";
      case 'error':
        return errorMsg ? `Error: ${errorMsg}` : 'Unable to connect.';
      default: return '';
    }
  })();
  return (
    <div
      style={{
        padding: 20,
        maxWidth: 360,
        textAlign: 'center',
        fontSize: 15,
        lineHeight: 1.5,
        color: 'rgba(255,255,255,.85)',
      }}
    >
      {msg}
    </div>
  );
}

function roomIdFromPath(): string | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.pathname.match(/^\/watch\/([A-Za-z0-9_-]+)\/?$/);
  return match?.[1] ?? null;
}
