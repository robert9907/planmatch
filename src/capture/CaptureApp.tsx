import { useEffect, useRef, useState } from 'react';
import type { ExtractedItem, PharmacyChoice, SnapPharmacyRead } from '@/types/capture';
import {
  confirmCapture,
  fileToJpegBase64,
  searchPharmacies,
  submitCapture,
  type PharmacyCandidate,
} from '@/lib/captureApi';

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
  | 'missed' // the phone reloaded the page while its camera was open
  | 'failed' // didn't send (signal) → try again
  | 'confirm' // is this your pharmacy? is this your doctor?
  | 'pick-pharmacy' // a different pharmacy
  | 'card-ask' // last thing: Medicare card?
  | 'card-got'
  | 'finish';

type Photo = { base64: string; mimeType: string };
type CameraFor = 'bottle' | 'more' | 'card';

// Android (and sometimes iPhone) closes the browser in the background
// while its camera app is open; on return the page reloads and every
// in-memory answer is gone — the bottles are saved server-side, but the
// count, the pharmacy/doctor reads and "I'm all done" vanish. The visit's
// progress is kept in sessionStorage (this tab only, cleared when the tab
// closes) so a reload picks up where the client was. No photos stored.
interface SavedVisit {
  savedCount: number;
  cardDone: boolean;
  label: string;
  medNames: string[];
  pharmacyRead: SnapPharmacyRead | null;
  prescribers: string[];
  prescriberReadings: string[];
  pharmacyAnswer: 'ask' | 'yes' | 'changed';
  chosenPharmacy: PharmacyChoice | null;
  doctorAnswers: Record<string, 'yes' | 'no'>;
  /** Set while the phone's camera is open; still set after a reload means
   *  the picture never came back. */
  cameraOpenFor: CameraFor | null;
  step: Step;
}

const visitKey = (token: string) => `snap_visit_${token}`;

function loadVisit(token: string | null): SavedVisit | null {
  if (!token) return null;
  try {
    const raw = sessionStorage.getItem(visitKey(token));
    return raw ? (JSON.parse(raw) as SavedVisit) : null;
  } catch {
    return null;
  }
}

function saveVisit(token: string, visit: SavedVisit): void {
  try {
    sessionStorage.setItem(visitKey(token), JSON.stringify(visit));
  } catch {
    /* storage blocked — the visit still works, just without a safety net */
  }
}

// Screens that are safe to land back on after a reload.
const RESUMABLE: Step[] = ['start', 'got', 'more', 'many', 'confirm', 'card-ask', 'card-got', 'finish'];

function resumeStep(v: SavedVisit): Step {
  if (v.cameraOpenFor) return 'missed';
  if (RESUMABLE.includes(v.step)) return v.step;
  return v.savedCount > 0 ? 'got' : 'start';
}

// Validity of the capture link itself, checked once on mount.
type LinkState = 'checking' | 'ok' | 'expired' | 'unknown';

export function CaptureApp() {
  const token = readTokenFromPath();
  const [restored] = useState(() => loadVisit(token));
  const [linkState, setLinkState] = useState<LinkState>('checking');
  const [firstName, setFirstName] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(() => (restored ? resumeStep(restored) : 'start'));
  const [label, setLabel] = useState<string>(restored?.label ?? '');
  const [bottleCount, setBottleCount] = useState(0);
  const [savedCount, setSavedCount] = useState(restored?.savedCount ?? 0);
  const [cardDone, setCardDone] = useState(restored?.cardDone ?? false);
  const [failMessage, setFailMessage] = useState<string>('');
  // Collected across the visit for the pharmacy / doctor check at the end.
  const [medNames, setMedNames] = useState<string[]>(restored?.medNames ?? []);
  const [pharmacyRead, setPharmacyRead] = useState<SnapPharmacyRead | null>(restored?.pharmacyRead ?? null);
  const [prescribers, setPrescribers] = useState<string[]>(restored?.prescribers ?? []);
  // Every bottle's prescriber as printed — the server merges them by last
  // name at the end of the visit (one bottle often prints only part).
  const [prescriberReadings, setPrescriberReadings] = useState<string[]>(restored?.prescriberReadings ?? []);
  const [pharmacyAnswer, setPharmacyAnswer] = useState<'ask' | 'yes' | 'changed'>(restored?.pharmacyAnswer ?? 'ask');
  const [chosenPharmacy, setChosenPharmacy] = useState<PharmacyChoice | null>(restored?.chosenPharmacy ?? null);
  const [doctorAnswers, setDoctorAnswers] = useState<Record<string, 'yes' | 'no'>>(restored?.doctorAnswers ?? {});
  // Which picture the camera was open for when the page reloaded.
  const [missedFor, setMissedFor] = useState<CameraFor>(restored?.cameraOpenFor ?? 'bottle');
  const cameraOpenFor = useRef<CameraFor | null>(null);
  const [confirmSending, setConfirmSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraFor = useRef<CameraFor>('bottle');
  // The first photo of a bottle is held in memory (never stored) in case
  // a second picture of the same bottle is needed.
  const firstPhoto = useRef<Photo | null>(null);
  // What to resend if the connection drops.
  const pending = useRef<{ photos: Photo[]; kind: CameraFor } | null>(null);

  // Keep the visit's progress so a reload (phone camera app) resumes it.
  useEffect(() => {
    if (!token) return;
    saveVisit(token, {
      savedCount,
      cardDone,
      label,
      medNames,
      pharmacyRead,
      prescribers,
      prescriberReadings,
      pharmacyAnswer,
      chosenPharmacy,
      doctorAnswers,
      cameraOpenFor: cameraOpenFor.current,
      step,
    });
  }, [token, step, savedCount, cardDone, label, medNames, pharmacyRead, prescribers, prescriberReadings, pharmacyAnswer, chosenPharmacy, doctorAnswers]);

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
    // Recorded before the camera app opens: if the page is reloaded while
    // it's up, the restore sees this and asks for the picture again.
    cameraOpenFor.current = forWhat;
    if (token) saveVisit(token, { ...currentVisit(), cameraOpenFor: forWhat });
    input.value = ''; // same file twice must still fire onChange
    input.click();
  }

  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    cameraOpenFor.current = null;
    if (token) {
      const v = loadVisit(token);
      if (v) saveVisit(token, { ...v, cameraOpenFor: null });
    }
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
      if (resp.snap) {
        const snap = resp.snap;
        if (snap.med_names.length) {
          setMedNames((prev) => Array.from(new Set([...prev, ...snap.med_names])));
        }
        if (snap.pharmacy?.name) {
          setPharmacyRead((prev) => (!prev || (!prev.npi && snap.pharmacy?.npi) ? snap.pharmacy : prev));
        }
        if (snap.prescribers.length) {
          setPrescriberReadings((prev) => Array.from(new Set([...prev, ...snap.prescribers])));
          setPrescribers((prev) => {
            const seen = new Set(prev.map((x) => lastName(x)));
            const add = snap.prescribers.filter((x) => {
              const k = lastName(x);
              if (!k || seen.has(k)) return false;
              seen.add(k);
              return true;
            });
            return add.length ? [...prev, ...add] : prev;
          });
        }
      }
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

  function currentVisit(): SavedVisit {
    return {
      savedCount,
      cardDone,
      label,
      medNames,
      pharmacyRead,
      prescribers,
      prescriberReadings,
      pharmacyAnswer,
      chosenPharmacy,
      doctorAnswers,
      cameraOpenFor: null,
      step,
    };
  }

  function retrySend() {
    const p = pending.current;
    if (p) void send(p.photos, p.kind);
    else setStep('start');
  }

  function allDone() {
    firstPhoto.current = null;
    if ((pharmacyRead?.name || prescribers.length > 0) && pharmacyAnswer === 'ask') {
      setStep('confirm');
      return;
    }
    // Already answered earlier in the visit: bottles added since then get
    // the same pharmacy instead of the one printed on their label.
    if (pharmacyAnswer !== 'ask') {
      void sendConfirm();
      return;
    }
    setStep(cardDone ? 'finish' : 'card-ask');
  }

  async function sendConfirm() {
    setConfirmSending(true);
    const pharmacy: PharmacyChoice | null =
      pharmacyAnswer === 'changed'
        ? chosenPharmacy
        : pharmacyAnswer === 'yes' && pharmacyRead?.name
        ? {
            npi: pharmacyRead.npi,
            name: titleCase(pharmacyRead.name),
            city: pharmacyRead.city,
            state: pharmacyRead.state,
            zip: pharmacyRead.zip,
            phone: pharmacyRead.phone,
          }
        : null;
    try {
      await confirmCapture({
        token: token!,
        med_names: medNames,
        pharmacy,
        declined_prescribers: prescribers.filter((p) => doctorAnswers[p] === 'no'),
        prescriber_readings: prescriberReadings,
      });
    } catch {
      // The bottles are already saved; a missed answer is not worth
      // stranding the client on an error screen.
    } finally {
      setConfirmSending(false);
      setStep(cardDone ? 'finish' : 'card-ask');
    }
  }

  const doctorsAnswered = prescribers.every((p) => doctorAnswers[p]);
  const pharmacyAnswered = !pharmacyRead?.name || pharmacyAnswer !== 'ask';

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
          <p style={para}>
            Hold the bottle about a hand's width from your phone, in good light. Tap the words on your screen
            so they look sharp, then hold still.
          </p>
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
          <h1 style={h1}>Now turn it to the barcode</h1>
          {label && <p style={big}>{label}</p>}
          <p style={para}>
            Turn the <strong>same bottle</strong> around to the side with the barcode and take one more picture.
            The number under the barcode tells us how much medicine you get.
          </p>
          <TurnBottle />
          <BigButton onClick={() => openCamera('more')}>Take a picture of the barcode side</BigButton>
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
          <p style={para}>
            Let's try again. Hold the bottle about a hand's width away — any closer and the phone can't focus.
            Tap the words on your screen so they look sharp, then hold still.
          </p>
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

      {step === 'missed' && (
        <div>
          <h1 style={h1}>Your picture didn't come through</h1>
          <p style={para}>
            Your phone closed this page while the camera was open. Anything you already sent is safe — just take
            that picture again.
          </p>
          <BigButton onClick={() => openCamera(missedFor)}>Take the picture again</BigButton>
          <QuietButton
            onClick={() => {
              if (missedFor === 'card') setStep('finish');
              else setStep(savedCount > 0 ? 'got' : 'start');
              setMissedFor('bottle');
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

      {step === 'confirm' && (
        <div>
          <h1 style={h1}>Just two quick checks</h1>
          {pharmacyRead?.name && (
            <div style={card}>
              <p style={eyebrow}>IS THIS YOUR PHARMACY?</p>
              <p style={big}>
                {pharmacyAnswer === 'changed' && chosenPharmacy ? chosenPharmacy.name : titleCase(pharmacyRead.name)}
              </p>
              {pharmacyAnswer !== 'changed' && pharmacyRead.address && <p style={para}>{pharmacyRead.address}</p>}
              {pharmacyAnswer === 'changed' && chosenPharmacy?.address1 && (
                <p style={para}>{[chosenPharmacy.address1, chosenPharmacy.city].filter(Boolean).join(', ')}</p>
              )}
              {pharmacyRead.npi && pharmacyAnswer === 'ask' && <p style={tag}>✓ Found on the national pharmacy list</p>}
              {pharmacyAnswer === 'ask' ? (
                <>
                  <BigButton onClick={() => setPharmacyAnswer('yes')}>Yes, that's my pharmacy</BigButton>
                  <SecondButton onClick={() => setStep('pick-pharmacy')}>No, it's a different one</SecondButton>
                </>
              ) : (
                <SavedRow onClick={() => setPharmacyAnswer('ask')}>Pharmacy saved</SavedRow>
              )}
            </div>
          )}
          {prescribers.map((p) => (
            <div key={p} style={card}>
              <p style={eyebrow}>IS THIS YOUR DOCTOR?</p>
              <p style={big}>{prettyPerson(p)}</p>
              {!doctorAnswers[p] ? (
                <>
                  <BigButton onClick={() => setDoctorAnswers((a) => ({ ...a, [p]: 'yes' }))}>Yes, that's my doctor</BigButton>
                  <SecondButton onClick={() => setDoctorAnswers((a) => ({ ...a, [p]: 'no' }))}>Not my doctor</SecondButton>
                </>
              ) : (
                <SavedRow onClick={() => setDoctorAnswers((a) => { const n = { ...a }; delete n[p]; return n; })}>
                  {doctorAnswers[p] === 'yes' ? 'Doctor saved' : "Got it — we'll leave them off"}
                </SavedRow>
              )}
            </div>
          ))}
          {pharmacyAnswered && doctorsAnswered && (
            <BigButton onClick={() => void sendConfirm()}>{confirmSending ? 'Saving…' : 'Continue'}</BigButton>
          )}
        </div>
      )}

      {step === 'pick-pharmacy' && (
        <PharmacyPicker
          state={pharmacyRead?.state ?? null}
          zip={pharmacyRead?.zip ?? null}
          onBack={() => setStep('confirm')}
          onPick={(ph) => {
            setChosenPharmacy(ph);
            setPharmacyAnswer('changed');
            setStep('confirm');
          }}
        />
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
          <Lockdown />
          <QuietButton onClick={() => setStep('start')}>I have another bottle</QuietButton>
        </Center>
      )}
    </Shell>
  );
}

// "KOMBIZ KLEIN DO" → "Kombiz Klein, DO" — the credential stays capitals.
const CREDENTIALS = new Set(['MD', 'DO', 'NP', 'PA', 'PA-C', 'FNP', 'APRN', 'DNP', 'DPM', 'OD', 'DDS', 'DMD', 'RN', 'PHD', 'PHARMD']);
function prettyPerson(raw: string): string {
  const words = raw.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  const creds: string[] = [];
  while (words.length > 1 && CREDENTIALS.has(words[words.length - 1].replace(/\./g, '').toUpperCase())) {
    creds.unshift(words.pop()!.replace(/\./g, '').toUpperCase());
  }
  const name = words
    .map((w) => (w.length <= 2 && w.endsWith('.') ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
  return creds.length ? `${name}, ${creds.join(', ')}` : name;
}

function lastName(raw: string): string {
  const parts = raw
    .replace(/^(dr\.?|doctor)\s+/i, '')
    .replace(/,.*$/, '')
    .split(/\s+/)
    .filter(Boolean);
  return (parts[parts.length - 1] ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

function PharmacyPicker({
  state,
  zip,
  onBack,
  onPick,
}: {
  state: string | null;
  zip: string | null;
  onBack: () => void;
  onPick: (p: PharmacyChoice) => void;
}) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<PharmacyCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2 && !zip) return;
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(() => {
      void searchPharmacies({ q: text, zip: zip ?? undefined, state }).then((r) => {
        if (!cancelled) {
          setRows(r.slice(0, 8));
          setLoading(false);
        }
      });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, zip, state]);
  return (
    <div>
      <QuietButton onClick={onBack}>← Back</QuietButton>
      <h1 style={h1}>Where do you get your medicine?</h1>
      <label style={{ display: 'block' }}>
        <span style={para}>Type the name of your pharmacy</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
          style={{
            display: 'block',
            width: '100%',
            minHeight: 60,
            marginTop: 8,
            padding: '12px 16px',
            fontSize: 22,
            borderRadius: 14,
            border: '2px solid var(--w3)',
            boxSizing: 'border-box',
          }}
        />
      </label>
      {loading && <p style={para}>Looking…</p>}
      {rows.map((r) => (
        <SecondButton
          key={r.npi}
          onClick={() =>
            onPick({ npi: r.npi, name: r.name, address1: r.address1, city: r.city, state: r.state, zip: r.zip, phone: r.phone, mailOrder: r.mailOrder })
          }
        >
          {r.name}
          {r.address1 ? <span style={{ display: 'block', fontSize: 18, fontWeight: 400 }}>{[r.address1, r.city].filter(Boolean).join(', ')}</span> : null}
        </SecondButton>
      ))}
      <SecondButton onClick={() => onPick({ name: 'Mail order pharmacy', mailOrder: true })}>
        I get my medicine by mail
      </SecondButton>
    </div>
  );
}

function SavedRow({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ ...secondBtn, background: 'var(--sm)', border: 'none', color: 'var(--ink)' }}
    >
      ✓ {children}
    </button>
  );
}

// The phone → lock picture: the client's information is locked down.
function Lockdown() {
  return (
    <div
      style={{
        marginTop: 22,
        borderRadius: 18,
        background: '#0E2C55',
        color: '#fff',
        padding: 18,
        textAlign: 'left',
      }}
    >
      <style>{'@keyframes snapflow{0%{transform:translateX(-30px);opacity:0}30%{opacity:1}100%{transform:translateX(170px);opacity:0}}'}</style>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span aria-hidden style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(255,255,255,0.14)', display: 'grid', placeItems: 'center' }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="2" width="10" height="20" rx="2.5" /><path d="M11 18h2" /></svg>
        </span>
        <span style={{ flex: 1, position: 'relative', height: 4, margin: '0 12px', borderRadius: 2, background: 'rgba(255,255,255,0.15)', overflow: 'hidden' }}>
          <span style={{ position: 'absolute', top: 0, left: 0, width: 30, height: 4, borderRadius: 2, background: '#00CEA1', animation: 'snapflow 1.8s ease-in-out infinite' }} />
        </span>
        <span aria-hidden style={{ width: 44, height: 44, borderRadius: 12, background: '#C8A24A', display: 'grid', placeItems: 'center' }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0E2C55" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></svg>
        </span>
      </div>
      <p style={{ fontSize: 21, fontWeight: 700, margin: '14px 0 6px' }}>Your information is on lockdown</p>
      <p style={{ fontSize: 18, lineHeight: 1.4, color: '#C9D6EA', margin: 0 }}>
        Encrypted the moment it leaves your phone, and only shared with Rob.
      </p>
    </div>
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

const card: React.CSSProperties = {
  background: 'var(--wh)',
  border: '2px solid var(--w2)',
  borderRadius: 18,
  padding: 18,
  margin: '0 0 18px',
};

const eyebrow: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  letterSpacing: '0.04em',
  color: 'var(--i2)',
  margin: '0 0 6px',
};

const tag: React.CSSProperties = {
  display: 'inline-block',
  fontSize: 17,
  fontWeight: 600,
  color: 'var(--sage)',
  margin: '0 0 4px',
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
