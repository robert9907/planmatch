import { useEffect, useRef, useState } from 'react';
import type { ExtractedItem } from '@/types/capture';
import { fileToJpegBase64, submitCapture } from '@/lib/captureApi';

// The Snap Link page. Built for a 67-year-old on an old phone: one
// instruction per screen, big type, big buttons, no jargon ("label",
// "upload", "submit", "error" never appear). The page decides when a
// second photo of the same bottle is needed — the client never has to.

type Step =
  | 'start' // take a picture of one pill bottle
  | 'reading' // waiting on the reader
  | 'got' // "Got it: Gabapentin 300 mg" → next bottle / all done
  | 'more' // turn the bottle, one more picture of the same bottle
  | 'many' // several bottles in one photo → one at a time
  | 'blurry' // nothing readable → try again
  | 'failed' // didn't send (signal) → try again
  | 'card-ask' // last thing: Medicare card?
  | 'card-got'
  | 'finish';

type Photo = { base64: string; mimeType: string };
type CameraFor = 'bottle' | 'more' | 'card';

// Validity of the capture link itself, checked once on mount.
type LinkState = 'checking' | 'ok' | 'expired' | 'unknown';

export function CaptureApp() {
  const token = readTokenFromPath();
  const [linkState, setLinkState] = useState<LinkState>('checking');
  const [firstName, setFirstName] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('start');
  const [label, setLabel] = useState<string>('');
  const [bottleCount, setBottleCount] = useState(0);
  const [savedCount, setSavedCount] = useState(0);
  const [cardDone, setCardDone] = useState(false);
  const [failMessage, setFailMessage] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraFor = useRef<CameraFor>('bottle');
  // The first photo of a bottle is held in memory (never stored) in case
  // a second picture of the same bottle is needed.
  const firstPhoto = useRef<Photo | null>(null);
  // What to resend if the connection drops.
  const pending = useRef<{ photos: Photo[]; kind: CameraFor } | null>(null);

  // Check the link before showing the camera, and pick up the client's
  // first name for the greeting. capture-poll is read-only.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch(`/api/capture-poll?token=${encodeURIComponent(token)}`);
        if (cancelled) return;
        if (resp.status === 404) {
          setLinkState('unknown');
          return;
        }
        if (!resp.ok) {
          setLinkState('ok'); // transient blip — don't strand a good link
          return;
        }
        const body = (await resp.json()) as { status?: string; client_name?: string | null };
        if (cancelled) return;
        const first = (body?.client_name ?? '').trim().split(/\s+/)[0] ?? '';
        if (first) setFirstName(first.charAt(0).toUpperCase() + first.slice(1).toLowerCase());
        setLinkState(body?.status === 'expired' ? 'expired' : 'ok');
      } catch {
        if (!cancelled) setLinkState('ok');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) {
    return (
      <Shell>
        <Center>
          <h1 style={h1}>This link isn't complete</h1>
          <p style={para}>Please text Rob and he'll send you a new one.</p>
        </Center>
      </Shell>
    );
  }

  if (linkState === 'checking') {
    return (
      <Shell>
        <Center>
          <p style={para}>One moment…</p>
        </Center>
      </Shell>
    );
  }

  if (linkState === 'expired' || linkState === 'unknown') {
    return (
      <Shell>
        <Center>
          <h1 style={h1}>This link has expired</h1>
          <p style={para}>
            Please text Rob and he'll send you a new one. Anything you already sent is safe.
          </p>
        </Center>
      </Shell>
    );
  }

  function openCamera(forWhat: CameraFor) {
    cameraFor.current = forWhat;
    const input = fileInputRef.current;
    if (!input) return;
    input.value = ''; // same file twice must still fire onChange
    input.click();
  }

  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const kind = cameraFor.current;
    setStep('reading');
    const photo = await fileToJpegBase64(file);
    const photos = kind === 'more' && firstPhoto.current ? [firstPhoto.current, photo] : [photo];
    await send(photos, kind);
  }

  async function send(photos: Photo[], kind: CameraFor) {
    pending.current = { photos, kind };
    setStep('reading');
    try {
      const resp = await submitCapture(
        photos.length === 1
          ? { token: token!, image_base64: photos[0].base64, mime_type: photos[0].mimeType }
          : {
              token: token!,
              images: photos.map((ph) => ({ image_base64: ph.base64, mime_type: ph.mimeType })),
            },
      );
      pending.current = null;
      const g = resp.guidance;
      const readable = g ? g.readable : resp.extracted.some((x) => x.type !== 'unknown');

      if (kind === 'card') {
        if (resp.extracted.some((x) => x.type === 'medicare_card')) {
          setCardDone(true);
          setStep('card-got');
        } else {
          setStep('blurry');
          cameraFor.current = 'card';
        }
        return;
      }

      if (!readable) {
        // A second picture that adds nothing still keeps the first read.
        if (kind === 'more') {
          firstPhoto.current = null;
          setStep('got');
        } else {
          setStep('blurry');
        }
        return;
      }

      const meds = resp.extracted.filter((x) => x.type === 'medication');
      setLabel(describe(resp.extracted));

      if (kind === 'bottle' && g?.needs_more) {
        firstPhoto.current = photos[0];
        setSavedCount((n) => n + 1);
        setStep('more');
        return;
      }

      firstPhoto.current = null;
      if (kind === 'bottle') setSavedCount((n) => n + Math.max(1, meds.length));
      if (kind === 'bottle' && (g?.bottle_count ?? meds.length) > 1) {
        setBottleCount(g?.bottle_count ?? meds.length);
        setStep('many');
        return;
      }
      setStep('got');
    } catch (err) {
      const msg = friendlyError(err);
      if (msg === EXPIRED) {
        setLinkState('expired');
        return;
      }
      setFailMessage(msg);
      setStep('failed');
    }
  }

  function retrySend() {
    const p = pending.current;
    if (p) void send(p.photos, p.kind);
    else setStep('start');
  }

  function allDone() {
    firstPhoto.current = null;
    setStep(cardDone ? 'finish' : 'card-ask');
  }

  return (
    <Shell>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => void handleFilePick(e)}
        style={{ display: 'none' }}
      />

      {step === 'start' && (
        <div>
          <h1 style={h1}>{firstName ? `Hi ${firstName}!` : 'Hi there!'}</h1>
          <p style={para}>Let's take a picture of your pill bottles, one bottle at a time.</p>
          <p style={para}>Hold the bottle close so the words fill the screen.</p>
          <BigButton onClick={() => openCamera('bottle')}>Take a picture of a pill bottle</BigButton>
          {savedCount > 0 && (
            <QuietButton onClick={allDone}>I'm all done</QuietButton>
          )}
        </div>
      )}

      {step === 'reading' && (
        <Center>
          <Spinner />
          <h1 style={{ ...h1, marginTop: 24 }}>Reading your picture…</h1>
          <p style={para}>This takes a few seconds.</p>
        </Center>
      )}

      {step === 'got' && (
        <div>
          <Check />
          <h1 style={{ ...h1, textAlign: 'center' }}>Got it!</h1>
          {label && <p style={{ ...big, textAlign: 'center' }}>{label}</p>}
          <BigButton onClick={() => openCamera('bottle')}>Next bottle</BigButton>
          <SecondButton onClick={allDone}>I'm all done</SecondButton>
        </div>
      )}

      {step === 'more' && (
        <div>
          <h1 style={h1}>Almost done</h1>
          {label && <p style={big}>{label}</p>}
          <p style={para}>
            Turn the bottle a little and take one more picture of the <strong>same bottle</strong>.
          </p>
          <TurnBottle />
          <BigButton onClick={() => openCamera('more')}>Take one more picture</BigButton>
          <QuietButton
            onClick={() => {
              firstPhoto.current = null;
              setStep('got');
            }}
          >
            Skip
          </QuietButton>
        </div>
      )}

      {step === 'many' && (
        <div>
          <Check />
          <h1 style={{ ...h1, textAlign: 'center' }}>I see {bottleCount} bottles</h1>
          <p style={para}>
            I saved what I could read. For the best results, let's do them one at a time.
          </p>
          <BigButton onClick={() => openCamera('bottle')}>Next bottle</BigButton>
          <SecondButton onClick={allDone}>I'm all done</SecondButton>
        </div>
      )}

      {step === 'blurry' && (
        <div>
          <h1 style={h1}>That one came out blurry</h1>
          <p style={para}>Let's try again. Hold the phone still and close to the words.</p>
          <BigButton onClick={() => openCamera(cameraFor.current === 'card' ? 'card' : 'bottle')}>
            Try again
          </BigButton>
          <QuietButton
            onClick={() => {
              if (cameraFor.current === 'card') setStep('finish');
              else setStep(savedCount > 0 ? 'got' : 'start');
              setLabel('');
            }}
          >
            Skip this one
          </QuietButton>
        </div>
      )}

      {step === 'failed' && (
        <div>
          <h1 style={h1}>That didn't go through</h1>
          <p style={para}>{failMessage}</p>
          <BigButton onClick={retrySend}>Try again</BigButton>
        </div>
      )}

      {step === 'card-ask' && (
        <div>
          <h1 style={h1}>One last thing</h1>
          <p style={para}>Do you have your red, white and blue Medicare card handy?</p>
          <MedicareCardPicture />
          <BigButton onClick={() => openCamera('card')}>Take a picture of my Medicare card</BigButton>
          <SecondButton onClick={() => setStep('finish')}>Not right now</SecondButton>
        </div>
      )}

      {step === 'card-got' && (
        <div>
          <Check />
          <h1 style={{ ...h1, textAlign: 'center' }}>Got your Medicare card!</h1>
          <BigButton onClick={() => setStep('finish')}>I'm all done</BigButton>
        </div>
      )}

      {step === 'finish' && (
        <Center>
          <Check />
          <h1 style={h1}>{firstName ? `Thank you, ${firstName}!` : 'Thank you!'}</h1>
          <p style={para}>Rob has everything you sent. You can close this page now.</p>
          <QuietButton onClick={() => setStep('start')}>I have another bottle</QuietButton>
        </Center>
      )}
    </Shell>
  );
}

function describe(items: ExtractedItem[]): string {
  const meds = items.filter((x) => x.type === 'medication');
  if (meds.length === 1 && meds[0].type === 'medication') {
    const m = meds[0];
    return [titleCase(m.drug_name), m.strength ? prettyStrength(m.strength) : '']
      .filter(Boolean)
      .join(' ');
  }
  if (meds.length > 1) return `${meds.length} medications`;
  if (items.some((x) => x.type === 'medicare_card')) return 'Medicare card';
  return '';
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .trim();
}

function prettyStrength(s: string): string {
  return s.replace(/\s*(mg|mcg|ml|g)\b/i, (_m, u: string) => ` ${u.toLowerCase()}`).trim();
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--warm)',
        color: 'var(--ink)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '14px 20px',
          borderBottom: '1px solid var(--w2)',
          background: 'var(--wh)',
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 7,
            background: 'var(--sage)',
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
            fontWeight: 700,
            fontSize: 12,
          }}
        >
          PM
        </div>
        <div>
          <div style={{ fontFamily: 'Lora, serif', fontWeight: 600, fontSize: 15 }}>
            Generation Health
          </div>
          <div style={{ fontSize: 11, color: 'var(--i2)' }}>
            Rob Simm · Medicare broker
          </div>
        </div>
      </header>
      <main style={{ flex: 1, maxWidth: 480, width: '100%', margin: '0 auto', padding: 20 }}>
        {children}
      </main>
      <footer
        style={{
          padding: '12px 20px',
          textAlign: 'center',
          color: 'var(--i2)',
          fontSize: 15,
          lineHeight: 1.4,
          borderTop: '1px solid var(--w2)',
        }}
      >
        Your photos are only shared with Rob and deleted after 24 hours.
      </footer>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div style={{ textAlign: 'center', paddingTop: 24 }}>{children}</div>;
}

function BigButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} style={bigBtn}>
      {children}
    </button>
  );
}

function SecondButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} style={secondBtn}>
      {children}
    </button>
  );
}

function QuietButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} style={quietBtn}>
      {children}
    </button>
  );
}

function Check() {
  return (
    <div
      aria-hidden
      style={{
        width: 84,
        height: 84,
        borderRadius: '50%',
        background: 'var(--sage)',
        color: '#fff',
        display: 'grid',
        placeItems: 'center',
        margin: '8px auto 16px',
        fontSize: 44,
        fontWeight: 700,
      }}
    >
      ✓
    </div>
  );
}

function Spinner() {
  return (
    <div
      aria-hidden
      style={{
        width: 64,
        height: 64,
        margin: '0 auto',
        borderRadius: '50%',
        border: '7px solid var(--sm)',
        borderTopColor: 'var(--sage)',
        animation: 'snapspin 0.9s linear infinite',
      }}
    >
      <style>{'@keyframes snapspin{to{transform:rotate(360deg)}}'}</style>
    </div>
  );
}

// A pill bottle with a curved "turn it" arrow — tells Margaret what to do
// without the word "label".
function TurnBottle() {
  return (
    <svg viewBox="0 0 220 150" role="img" aria-label="Turn the bottle a little" style={{ display: 'block', width: 220, maxWidth: '70%', margin: '8px auto 4px' }}>
      <rect x="80" y="18" width="60" height="18" rx="4" fill="var(--i3)" />
      <rect x="72" y="36" width="76" height="100" rx="12" fill="#E9A23B" />
      <rect x="72" y="62" width="76" height="48" fill="#fff" />
      <line x1="80" y1="74" x2="140" y2="74" stroke="var(--i3)" strokeWidth="3" />
      <line x1="80" y1="86" x2="128" y2="86" stroke="var(--i3)" strokeWidth="3" />
      <line x1="80" y1="98" x2="134" y2="98" stroke="var(--i3)" strokeWidth="3" />
      <path d="M40 120 Q110 158 180 120" fill="none" stroke="var(--sage)" strokeWidth="6" strokeLinecap="round" />
      <path d="M168 108 L184 118 L170 132" fill="none" stroke="var(--sage)" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MedicareCardPicture() {
  return (
    <svg viewBox="0 0 240 150" role="img" aria-label="A Medicare card" style={{ display: 'block', width: 240, maxWidth: '75%', margin: '8px auto 4px' }}>
      <rect x="2" y="2" width="236" height="146" rx="12" fill="#fff" stroke="var(--w3)" strokeWidth="2" />
      <rect x="2" y="2" width="236" height="34" rx="12" fill="#2B5BA8" />
      <rect x="2" y="24" width="236" height="12" fill="#2B5BA8" />
      <text x="120" y="25" textAnchor="middle" fontSize="13" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif">MEDICARE</text>
      <line x1="18" y1="60" x2="130" y2="60" stroke="var(--i3)" strokeWidth="5" />
      <line x1="18" y1="84" x2="160" y2="84" stroke="var(--i3)" strokeWidth="5" />
      <line x1="18" y1="108" x2="110" y2="108" stroke="var(--i3)" strokeWidth="5" />
      <rect x="2" y="126" width="236" height="10" fill="#C0392B" />
    </svg>
  );
}

const EXPIRED = 'This link has expired. Please text Rob and he will send you a new one.';

// Never show the server's wording to the client.
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  let detail = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed && typeof parsed.error === 'string') detail = parsed.error;
  } catch {
    // Not JSON — keep the raw text for matching, never for display.
  }
  const lower = detail.toLowerCase();
  if (lower.includes('not found') || lower.includes('expired')) return EXPIRED;
  return 'Check that you have signal, then tap Try again.';
}

function readTokenFromPath(): string | null {
  if (typeof window === 'undefined') return null;
  const m = window.location.pathname.match(/^\/capture\/([^/?#]+)/);
  return m ? m[1] : null;
}

const h1: React.CSSProperties = {
  fontFamily: 'Lora, serif',
  fontSize: 30,
  lineHeight: 1.2,
  fontWeight: 600,
  margin: '8px 0 14px',
  color: 'var(--ink)',
};

const para: React.CSSProperties = {
  fontSize: 21,
  lineHeight: 1.45,
  color: 'var(--ink)',
  margin: '0 0 14px',
};

const big: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  lineHeight: 1.3,
  color: 'var(--ink)',
  margin: '0 0 14px',
};

const bigBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  minHeight: 68,
  padding: '18px 16px',
  marginTop: 22,
  borderRadius: 14,
  border: 'none',
  background: 'var(--sage)',
  color: '#fff',
  fontSize: 22,
  fontWeight: 700,
  lineHeight: 1.25,
  cursor: 'pointer',
};

const secondBtn: React.CSSProperties = {
  ...bigBtn,
  marginTop: 14,
  background: 'var(--wh)',
  color: 'var(--ink)',
  border: '2px solid var(--w3)',
};

const quietBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  minHeight: 56,
  marginTop: 14,
  background: 'none',
  border: 'none',
  color: 'var(--i2)',
  fontSize: 20,
  textDecoration: 'underline',
  cursor: 'pointer',
};
