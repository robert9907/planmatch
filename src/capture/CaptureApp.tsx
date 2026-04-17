import { useEffect, useRef, useState } from 'react';
import type { ExtractedItem } from '@/types/capture';
import { fileToBase64, submitCapture } from '@/lib/captureApi';

type Screen = 'welcome' | 'camera' | 'preview' | 'done';

interface SentItem {
  id: string;
  preview: string;
  extracted: ExtractedItem[];
  error?: string;
  sentAt: number;
}

export function CaptureApp() {
  const token = readTokenFromPath();
  const [screen, setScreen] = useState<Screen>('welcome');
  const [capturedFile, setCapturedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<ExtractedItem[]>([]);
  const [processingState, setProcessingState] = useState<'idle' | 'uploading' | 'extracting' | 'ready' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sentItems, setSentItems] = useState<SentItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  if (!token) {
    return (
      <Shell>
        <div style={{ padding: 24, textAlign: 'center' }}>
          <h1 style={headerStyle}>Missing capture link</h1>
          <p style={{ color: 'var(--i2)' }}>
            This link looks incomplete. Please ask Rob to text you a new one.
          </p>
        </div>
      </Shell>
    );
  }

  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const url = URL.createObjectURL(file);
    setCapturedFile(file);
    setPreviewUrl(url);
    setExtracted([]);
    setErrorMessage(null);
    setProcessingState('idle');
    setScreen('preview');
  }

  async function handleSend() {
    if (!capturedFile) return;
    setProcessingState('uploading');
    setErrorMessage(null);
    try {
      const { base64, mimeType } = await fileToBase64(capturedFile);
      setProcessingState('extracting');
      const resp = await submitCapture({ token: token!, image_base64: base64, mime_type: mimeType });
      setExtracted(resp.extracted);
      setSentItems((prev) => [
        ...prev,
        {
          id: resp.item_id,
          preview: previewUrl ?? '',
          extracted: resp.extracted,
          error: resp.error,
          sentAt: Date.now(),
        },
      ]);
      setProcessingState('ready');
      setScreen('done');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setProcessingState('error');
    }
  }

  function handleRetake() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setCapturedFile(null);
    setPreviewUrl(null);
    setExtracted([]);
    setErrorMessage(null);
    setProcessingState('idle');
    setScreen('camera');
    requestAnimationFrame(() => fileInputRef.current?.click());
  }

  function handleAnother() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setCapturedFile(null);
    setPreviewUrl(null);
    setExtracted([]);
    setErrorMessage(null);
    setProcessingState('idle');
    setScreen('camera');
    requestAnimationFrame(() => fileInputRef.current?.click());
  }

  return (
    <Shell>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFilePick}
        style={{ display: 'none' }}
      />

      {screen === 'welcome' && (
        <WelcomeScreen onOpenCamera={() => fileInputRef.current?.click()} />
      )}

      {screen === 'camera' && (
        <CameraScreen onOpenCamera={() => fileInputRef.current?.click()} />
      )}

      {screen === 'preview' && previewUrl && (
        <PreviewScreen
          previewUrl={previewUrl}
          extracted={extracted}
          processingState={processingState}
          errorMessage={errorMessage}
          onRetake={handleRetake}
          onSend={handleSend}
        />
      )}

      {screen === 'done' && (
        <DoneScreen sentItems={sentItems} onAnother={handleAnother} />
      )}
    </Shell>
  );
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
          color: 'var(--i3)',
          fontSize: 11,
          borderTop: '1px solid var(--w2)',
        }}
      >
        Your photos are only shared with Rob and deleted after 24 hours.
      </footer>
    </div>
  );
}

function WelcomeScreen({ onOpenCamera }: { onOpenCamera: () => void }) {
  return (
    <div style={{ paddingTop: 12 }}>
      <h1 style={headerStyle}>Hi! Let's photograph your medications.</h1>
      <p style={paragraphStyle}>
        Rob asked you to take a few quick photos of your medication bottles so he can help
        find the best Medicare plan for you. It's OK to take one bottle at a time, or line
        them up in a bowl and photograph them together.
      </p>
      <ol style={{ ...paragraphStyle, paddingLeft: 20 }}>
        <li>Tap the green button below.</li>
        <li>Your camera will open — aim at the label, then press the shutter.</li>
        <li>Review what was read and tap <strong>Send to Rob</strong>.</li>
      </ol>
      <button type="button" onClick={onOpenCamera} style={primaryBtn}>
        Open camera
      </button>
      <div style={{ marginTop: 16, textAlign: 'center', color: 'var(--i3)', fontSize: 12 }}>
        No login needed. Just the link Rob texted you.
      </div>
    </div>
  );
}

function CameraScreen({ onOpenCamera }: { onOpenCamera: () => void }) {
  return (
    <div style={{ paddingTop: 20 }}>
      <h1 style={headerStyle}>Opening your camera…</h1>
      <p style={paragraphStyle}>
        If the camera didn't pop up automatically, tap the button below and choose
        <strong> Take photo</strong>.
      </p>
      <button type="button" onClick={onOpenCamera} style={primaryBtn}>
        Open camera
      </button>
    </div>
  );
}

function PreviewScreen({
  previewUrl,
  extracted,
  processingState,
  errorMessage,
  onRetake,
  onSend,
}: {
  previewUrl: string;
  extracted: ExtractedItem[];
  processingState: 'idle' | 'uploading' | 'extracting' | 'ready' | 'error';
  errorMessage: string | null;
  onRetake: () => void;
  onSend: () => void;
}) {
  const sending = processingState === 'uploading' || processingState === 'extracting';

  return (
    <div>
      <h1 style={headerStyle}>Looks good?</h1>
      <img
        src={previewUrl}
        alt="Captured label"
        style={{
          width: '100%',
          borderRadius: 12,
          border: '1px solid var(--w2)',
          background: 'var(--w2)',
          maxHeight: 360,
          objectFit: 'contain',
        }}
      />

      {extracted.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--i3)',
              fontWeight: 600,
              marginBottom: 4,
            }}
          >
            What Rob will see
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {extracted.map((e, i) => (
              <ExtractedBlock key={i} item={e} />
            ))}
          </div>
        </div>
      )}

      {errorMessage && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            background: 'var(--rt)',
            color: 'var(--red)',
            borderRadius: 8,
            fontSize: 13,
          }}
        >
          {errorMessage}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button
          type="button"
          onClick={onRetake}
          disabled={sending}
          style={{ ...secondaryBtn, flex: 1 }}
        >
          Retake
        </button>
        <button
          type="button"
          onClick={onSend}
          disabled={sending}
          style={{ ...primaryBtn, flex: 1, marginTop: 0 }}
        >
          {processingState === 'uploading'
            ? 'Uploading…'
            : processingState === 'extracting'
              ? 'Reading label…'
              : 'Send to Rob'}
        </button>
      </div>
    </div>
  );
}

function DoneScreen({ sentItems, onAnother }: { sentItems: SentItem[]; onAnother: () => void }) {
  return (
    <div>
      <div style={{ textAlign: 'center', paddingTop: 8, paddingBottom: 16 }}>
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            background: 'var(--sage)',
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
            margin: '0 auto',
            fontSize: 36,
          }}
        >
          ✓
        </div>
        <h1 style={{ ...headerStyle, marginTop: 12 }}>Sent to Rob!</h1>
        <p style={paragraphStyle}>
          Rob can see what you sent in his PlanMatch screen. You can send more bottles
          anytime while this link is open.
        </p>
      </div>

      {sentItems.length > 0 && (
        <div>
          <div
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--i3)',
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            What you've sent
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sentItems.map((item) => (
              <li
                key={item.id}
                style={{
                  padding: 10,
                  borderRadius: 10,
                  border: '1px solid var(--w2)',
                  background: 'var(--wh)',
                  display: 'flex',
                  gap: 10,
                }}
              >
                {item.preview && (
                  <img
                    src={item.preview}
                    alt=""
                    style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 6 }}
                  />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
                    {item.extracted[0]?.type === 'medication'
                      ? item.extracted[0].drug_name
                      : item.extracted[0]?.type === 'provider'
                        ? item.extracted[0].provider_name
                        : 'Photo sent'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--i2)' }}>
                    {new Date(item.sentAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button type="button" onClick={onAnother} style={primaryBtn}>
        Send another photo
      </button>
    </div>
  );
}

function ExtractedBlock({ item }: { item: ExtractedItem }) {
  if (item.type === 'medication') {
    return (
      <div
        style={{
          padding: 10,
          borderRadius: 10,
          background: 'var(--sl)',
          border: '1px solid var(--sm)',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {item.drug_name}
          {item.strength ? ` · ${item.strength}` : ''}
        </div>
        {item.dosage_instructions && (
          <div style={{ fontSize: 12, color: 'var(--i2)', marginTop: 2 }}>
            {item.dosage_instructions}
          </div>
        )}
        {item.prescribing_physician && (
          <div style={{ fontSize: 12, color: 'var(--i2)' }}>
            Prescribed by {item.prescribing_physician}
          </div>
        )}
      </div>
    );
  }
  if (item.type === 'provider') {
    return (
      <div
        style={{
          padding: 10,
          borderRadius: 10,
          background: 'var(--pt)',
          border: '1px solid var(--pur)',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {item.provider_name}
          {item.credentials ? `, ${item.credentials}` : ''}
        </div>
        {item.specialty && (
          <div style={{ fontSize: 12, color: 'var(--i2)' }}>{item.specialty}</div>
        )}
      </div>
    );
  }
  return (
    <div
      style={{
        padding: 10,
        borderRadius: 10,
        background: 'var(--at)',
        border: '1px solid var(--amb)',
        color: 'var(--amb)',
        fontSize: 12,
      }}
    >
      Couldn't read this label clearly — try another angle or retake the photo.
    </div>
  );
}

function readTokenFromPath(): string | null {
  if (typeof window === 'undefined') return null;
  const m = window.location.pathname.match(/^\/capture\/([^/?#]+)/);
  return m ? m[1] : null;
}

const headerStyle: React.CSSProperties = {
  fontFamily: 'Lora, serif',
  fontSize: 22,
  fontWeight: 600,
  margin: '4px 0 12px',
  color: 'var(--ink)',
};

const paragraphStyle: React.CSSProperties = {
  fontSize: 15,
  lineHeight: 1.45,
  color: 'var(--i2)',
  margin: '0 0 14px',
};

const primaryBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  minHeight: 52,
  padding: '14px 16px',
  marginTop: 20,
  borderRadius: 10,
  border: 'none',
  background: 'var(--sage)',
  color: '#fff',
  fontSize: 17,
  fontWeight: 600,
  cursor: 'pointer',
};

const secondaryBtn: React.CSSProperties = {
  display: 'inline-block',
  minHeight: 48,
  padding: '12px 16px',
  borderRadius: 10,
  border: '1px solid var(--w2)',
  background: 'var(--wh)',
  color: 'var(--ink)',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
};
