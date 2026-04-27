// Quote & Delivery — v4 page shell.
//
// Reuses the existing Step6QuoteDelivery body (which owns ModeToggle,
// finalist refetch, QuoteDeliveryV4 rendering, ScreenShareBar,
// ClientDeliveryCard, ComplianceChecklist, BrokerActions, and the
// SaveSessionButton that wraps /api/agentbase-sync) inside the v4
// phdr + sticky bbar. The user gets the mockup chrome without us
// re-implementing the tangle of logic that Step6 already handles.

import { useMemo, useState } from 'react';
import { Step6QuoteDelivery } from '@/components/steps/Step6QuoteDelivery';
import { useSession } from '@/hooks/useSession';
import { useScreenShareStore } from '@/hooks/useScreenShare';
import { usePrintableQuote } from '@/hooks/usePrintableQuote';
import { generateQuotePdf } from '@/lib/quotePdf';
import { BROKER } from '@/lib/constants';

interface Props {
  onBack: () => void;
}

export function QuotePage({ onBack }: Props) {
  const client = useSession((s) => s.client);
  const medications = useSession((s) => s.medications);
  const providers = useSession((s) => s.providers);
  const selectedFinalists = useSession((s) => s.selectedFinalists);

  // No mode override here. The legacy version forced new_quote on
  // every mount, which stomped the LandingPage's auto-flip into
  // Annual Review for clients with a current_plan_id. The new flow
  // uses isAnnualReview as a flag the broker can flip from Step6's
  // toggle; QuoteDeliveryV4 reads it directly to drive AEP-specific
  // copy. Same QuoteDeliveryV4 body renders either way.

  // Screen-share state lives in a top-level zustand store so the
  // shell-level MiniSoftphone can show a combined "Sharing + On call"
  // status without prop-drilling. Start/stop is invoked from the
  // bbar button below.
  const shareActive = useScreenShareStore((s) => Boolean(s.active));
  const shareStarting = useScreenShareStore((s) => s.starting);
  const startShare = useScreenShareStore((s) => s.start);
  const stopShare = useScreenShareStore((s) => s.stop);
  const shareError = useScreenShareStore((s) => s.error);
  const canShare = useMemo(
    () => Boolean(client.phone && /\d/.test(client.phone)),
    [client.phone],
  );

  // Print Quote — generates a multi-page professional PDF from the
  // snapshot QuoteDeliveryV4 publishes into usePrintableQuote.
  // Falls back to window.print() when the snapshot isn't ready (brain
  // still loading or no plans). Two actions: download + open in new
  // tab; the broker can email/save from the new tab.
  const printableSnapshot = usePrintableQuote((s) => s.snapshot);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  function handlePrint() {
    setPrintError(null);
    if (!printableSnapshot) {
      // Brain hasn't published a snapshot yet. Fall back to the
      // browser's native print so the broker can still get something.
      window.print();
      return;
    }
    setPrinting(true);
    try {
      const { url, filename } = generateQuotePdf(printableSnapshot);
      // Trigger a download.
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Also open in a new tab so the broker can preview / print
      // from the browser's native PDF viewer.
      window.open(url, '_blank', 'noopener');
      // Revoke the object URL after a short delay so the new tab has
      // time to load it.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      console.error('[print-quote] generation failed:', err);
      setPrintError((err as Error).message ?? 'PDF generation failed');
    } finally {
      setPrinting(false);
    }
  }
  return (
    <>
      <div className="scroll">
        <div className="phdr">
          <div className="ptitle">Quote &amp; Delivery</div>
          <div className="psub">
            Side-by-side comparison sorted by total Rx cost. Current plan benchmarked left.
          </div>
          {client.name && (
            <div className="pclient">
              <strong>{client.name}</strong>
              {client.county ? ` · ${client.county}, ${client.state} ${client.zip}` : ''}
              {client.planType ? ` · ${client.planType}` : ''}
              {medications.length > 0 ? ` · ${medications.length} med${medications.length === 1 ? '' : 's'}` : ''}
              {providers.length > 0 ? ` · ${providers.length} provider${providers.length === 1 ? '' : 's'}` : ''}
            </div>
          )}
        </div>
        <div className="cnt">
          <Step6QuoteDelivery />
        </div>
      </div>
      <div className="bbar">
        <div className="bbar-info">
          <strong>{selectedFinalists.length}</strong> finalist{selectedFinalists.length === 1 ? '' : 's'} compared · <strong>{client.name || 'No client'}</strong>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {shareError && (
            <span style={{ fontSize: 10, color: '#a32d2d', marginRight: 4 }}>
              {shareError}
            </span>
          )}
          <button
            type="button"
            className="btn out"
            disabled={!canShare || shareStarting}
            title={canShare ? '' : 'Add a client phone number first'}
            onClick={() => {
              if (shareActive) {
                void stopShare('manual');
                return;
              }
              if (!client.phone) return;
              void startShare({
                clientPhone: client.phone,
                clientFirstName: client.name?.split(/\s+/)[0],
                brokerName: BROKER.name,
              });
            }}
          >
            {shareActive ? '● Sharing — Stop' : shareStarting ? 'Starting…' : 'Share Screen'}
          </button>
          <button type="button" className="btn out" onClick={onBack}>← Back</button>
          <button
            type="button"
            className="btn pri"
            disabled={printing}
            onClick={handlePrint}
            title={printableSnapshot ? 'Generate a printable PDF' : 'Plan Brain still loading — fallback to browser print'}
          >
            {printing ? 'Generating PDF…' : 'Print Quote'}
          </button>
        </div>
        {printError && (
          <div style={{ position: 'absolute', right: 16, top: -22, fontSize: 11, color: '#a32d2d' }}>
            {printError}
          </div>
        )}
      </div>
    </>
  );
}
