import { useState } from 'react';
import { Topbar } from '@/components/layout/Topbar';
import { Sidebar } from '@/components/layout/Sidebar';
import { TabColumn } from '@/components/layout/TabColumn';
import { NotepadPanel } from '@/components/layout/NotepadPanel';
import { CaptureApp } from '@/capture/CaptureApp';
import { CaptureButton } from '@/components/capture/CaptureButton';
import { CapturePanel } from '@/components/capture/CapturePanel';
import { useCaptureSession } from '@/hooks/useCaptureSession';
import { WORKFLOW_STEPS } from '@/lib/constants';

export default function App() {
  if (isCaptureRoute()) return <CaptureApp />;
  return <BrokerApp />;
}

function isCaptureRoute(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.startsWith('/capture/');
}

function BrokerApp() {
  const [notesOpen, setNotesOpen] = useState(false);
  const [activeStep, setActiveStep] = useState(1);
  const capture = useCaptureSession();

  const currentStep = WORKFLOW_STEPS.find((s) => s.id === activeStep);
  const isCaptureStep = activeStep === 3 || activeStep === 4;

  return (
    <div className="flex flex-col" style={{ height: '100vh', background: 'var(--warm)' }}>
      <Topbar onOpenNotes={() => setNotesOpen(true)} />

      <div className="flex flex-1 min-h-0">
        <Sidebar activeStep={activeStep} onStepClick={setActiveStep} />

        <main className="flex-1 overflow-y-auto" style={{ padding: 24 }}>
          <div style={{ maxWidth: 960, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="pm-surface" style={{ padding: 24 }}>
              <div
                className="uppercase font-semibold"
                style={{ color: 'var(--i3)', fontSize: 10, letterSpacing: '0.08em' }}
              >
                Step {activeStep}
              </div>
              <h1 className="font-lora" style={{ fontSize: 22, marginTop: 4 }}>
                {currentStep?.label}
              </h1>
              <p style={{ color: 'var(--i2)', marginTop: 8, fontSize: 14 }}>
                {isCaptureStep
                  ? 'Send Dorothy a photo-capture link. Claude Vision reads each label, you approve each item, and it lands in your session.'
                  : 'Foundation shell is live. Step components land in Phase 4 — switch to Medications or Providers to demo the photo-capture flow.'}
              </p>
            </div>

            {isCaptureStep && (
              <div className="flex flex-col gap-3">
                <CaptureButton capture={capture} />
                <CapturePanel
                  capture={capture}
                  accept={activeStep === 3 ? 'medication' : activeStep === 4 ? 'provider' : 'any'}
                />
              </div>
            )}

            {!isCaptureStep && (
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}
              >
                <PhaseCard title="Theme" body="Night/day toggle persists to localStorage." status="ready" />
                <PhaseCard title="Session store" body="Zustand covers client, meds, providers, notes, mode." status="ready" />
                <PhaseCard title="Notepad" body="Sliding panel with 10-point quick-add." status="ready" />
                <PhaseCard title="Layout" body="Topbar · Sidebar · TabColumn shell." status="ready" />
                <PhaseCard title="Photo capture" body="Twilio SMS + Claude Vision live. Try Step 3 or 4." status="ready" />
                <PhaseCard title="Step components" body="Full intake/meds/providers/filters/quote." status="next" />
              </div>
            )}
          </div>
        </main>

        <TabColumn open={notesOpen} onToggle={() => setNotesOpen((v) => !v)} />
        <NotepadPanel open={notesOpen} onClose={() => setNotesOpen(false)} />
      </div>
    </div>
  );
}

function PhaseCard({
  title,
  body,
  status,
}: {
  title: string;
  body: string;
  status: 'ready' | 'next';
}) {
  const ready = status === 'ready';
  return (
    <div
      style={{
        border: `1px solid ${ready ? 'var(--sm)' : 'var(--w2)'}`,
        background: ready ? 'var(--sl)' : 'var(--wh)',
        borderRadius: 10,
        padding: 12,
      }}
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold" style={{ fontSize: 13, color: 'var(--ink)' }}>
          {title}
        </span>
        <span
          className="uppercase font-semibold"
          style={{
            fontSize: 9,
            letterSpacing: '0.08em',
            color: ready ? 'var(--sage)' : 'var(--i3)',
          }}
        >
          {ready ? 'Ready' : 'Next'}
        </span>
      </div>
      <div style={{ color: 'var(--i2)', fontSize: 12, marginTop: 4, lineHeight: 1.4 }}>
        {body}
      </div>
    </div>
  );
}
