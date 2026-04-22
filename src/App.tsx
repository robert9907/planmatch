import { useState } from 'react';
import { Topbar } from '@/components/layout/Topbar';
import { Sidebar } from '@/components/layout/Sidebar';
import { TabColumn } from '@/components/layout/TabColumn';
import { NotepadPanel } from '@/components/layout/NotepadPanel';
import { CaptureApp } from '@/capture/CaptureApp';
import { Step1ClientLookup } from '@/components/steps/Step1ClientLookup';
import { Step2Intake } from '@/components/steps/Step2Intake';
import { Step3Medications } from '@/components/steps/Step3Medications';
import { Step4Providers } from '@/components/steps/Step4Providers';
import { Step5BenefitFilters } from '@/components/steps/Step5BenefitFilters';
import { Step6QuoteDelivery } from '@/components/steps/Step6QuoteDelivery';
import { ProviderVerificationDrawer } from '@/components/verification/ProviderVerificationDrawer';
import { useCaptureSession } from '@/hooks/useCaptureSession';
import { useVerificationsQueue } from '@/hooks/useVerificationsQueue';
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
  const [verificationsOpen, setVerificationsOpen] = useState(false);
  const [activeStep, setActiveStep] = useState(1);
  const capture = useCaptureSession();
  const verificationsQueue = useVerificationsQueue();

  const advance = () => setActiveStep((n) => Math.min(n + 1, WORKFLOW_STEPS.length));

  return (
    <div className="flex flex-col" style={{ height: '100vh', background: 'var(--warm)' }}>
      <Topbar onOpenNotes={() => setNotesOpen(true)} />

      <div className="flex flex-1 min-h-0">
        <Sidebar
          activeStep={activeStep}
          onStepClick={setActiveStep}
          pendingVerifications={verificationsQueue.pendingCount}
          onOpenVerifications={() => setVerificationsOpen(true)}
        />

        <main className="flex-1 overflow-y-auto" style={{ padding: 24 }}>
          <div style={{ maxWidth: 1040 }}>
            {activeStep === 1 && <Step1ClientLookup onAdvance={advance} />}
            {activeStep === 2 && <Step2Intake onAdvance={advance} />}
            {activeStep === 3 && <Step3Medications capture={capture} onAdvance={advance} />}
            {activeStep === 4 && <Step4Providers capture={capture} onAdvance={advance} />}
            {activeStep === 5 && <Step5BenefitFilters onAdvance={advance} />}
            {activeStep === 6 && <Step6QuoteDelivery />}
          </div>
        </main>

        <TabColumn open={notesOpen} onToggle={() => setNotesOpen((v) => !v)} />
        <NotepadPanel open={notesOpen} onClose={() => setNotesOpen(false)} />
      </div>

      <ProviderVerificationDrawer
        open={verificationsOpen}
        onClose={() => setVerificationsOpen(false)}
        queue={verificationsQueue}
      />
    </div>
  );
}
