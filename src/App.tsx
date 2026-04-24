import { useMemo, useState } from 'react';
import { CaptureApp } from '@/capture/CaptureApp';
import { WatchApp } from '@/watch/WatchApp';
import { ProviderVerificationDrawer } from '@/components/verification/ProviderVerificationDrawer';
import { useCaptureSession } from '@/hooks/useCaptureSession';
import { useVerificationsQueue } from '@/hooks/useVerificationsQueue';
import { useResolveRxcuis } from '@/hooks/useResolveRxcuis';
import { useSession } from '@/hooks/useSession';
import { stepCompletion, WorkflowShell, type WorkflowStepId } from '@/v4/WorkflowShell';
import { LandingPage } from '@/v4/LandingPage';
import { IntakePage } from '@/v4/IntakePage';
import { MedsPage } from '@/v4/MedsPage';
import { ProvidersPage } from '@/v4/ProvidersPage';
import { ExtrasPage } from '@/v4/ExtrasPage';
import { QuotePage } from '@/v4/QuotePage';

export default function App() {
  if (isCaptureRoute()) return <CaptureApp />;
  if (isWatchRoute()) return <WatchApp />;
  return <BrokerApp />;
}

function isCaptureRoute(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.startsWith('/capture/');
}

function isWatchRoute(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.startsWith('/watch/');
}

// The broker app now lives entirely inside the v4 WorkflowShell — top
// navy header + step nav, then one of six page components. Previous
// Sidebar / TabColumn / NotepadPanel chrome is retired; the
// ProviderVerificationDrawer stays because it's a global modal, not a
// nav peer.
function BrokerApp() {
  const [active, setActive] = useState<WorkflowStepId>('landing');
  const [verificationsOpen, setVerificationsOpen] = useState(false);
  const capture = useCaptureSession();
  const verificationsQueue = useVerificationsQueue();
  // Backfill missing rxcuis so photo-capture / CRM-hydrated meds can be
  // matched against pm_formulary — otherwise their badges render red.
  useResolveRxcuis();

  const client = useSession((s) => s.client);
  const medications = useSession((s) => s.medications);
  const providers = useSession((s) => s.providers);
  const selectedFinalists = useSession((s) => s.selectedFinalists);

  const completed = useMemo(
    () => stepCompletion({ client, medications, providers, selectedFinalists }),
    [client, medications, providers, selectedFinalists],
  );

  const headerRight = verificationsQueue.pendingCount > 0 ? (
    <button
      type="button"
      className="ghdr-btn"
      onClick={() => setVerificationsOpen(true)}
    >
      ⚕ {verificationsQueue.pendingCount} pending
    </button>
  ) : null;

  return (
    <>
      <WorkflowShell
        active={active}
        completed={completed}
        onNavigate={setActive}
        headerRight={headerRight}
      >
        {active === 'landing' && (
          <LandingPage
            onPickClient={() => setActive('intake')}
            onStartNew={() => setActive('intake')}
          />
        )}
        {active === 'intake' && (
          <IntakePage
            onBack={() => setActive('landing')}
            onContinue={() => setActive('meds')}
          />
        )}
        {active === 'meds' && (
          <MedsPage
            capture={capture}
            onBack={() => setActive('intake')}
            onContinue={() => setActive('provs')}
          />
        )}
        {active === 'provs' && (
          <ProvidersPage
            capture={capture}
            onBack={() => setActive('meds')}
            onContinue={() => setActive('extras')}
          />
        )}
        {active === 'extras' && (
          <ExtrasPage
            onBack={() => setActive('provs')}
            onContinue={() => setActive('quote')}
          />
        )}
        {active === 'quote' && <QuotePage onBack={() => setActive('extras')} />}
      </WorkflowShell>
      <ProviderVerificationDrawer
        open={verificationsOpen}
        onClose={() => setVerificationsOpen(false)}
        queue={verificationsQueue}
      />
    </>
  );
}
