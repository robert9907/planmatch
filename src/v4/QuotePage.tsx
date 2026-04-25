// Quote & Delivery — v4 page shell.
//
// Reuses the existing Step6QuoteDelivery body (which owns ModeToggle,
// finalist refetch, QuoteDeliveryV4 rendering, ScreenShareBar,
// ClientDeliveryCard, ComplianceChecklist, BrokerActions, and the
// SaveSessionButton that wraps /api/agentbase-sync) inside the v4
// phdr + sticky bbar. The user gets the mockup chrome without us
// re-implementing the tangle of logic that Step6 already handles.

import { useEffect, useRef } from 'react';
import { Step6QuoteDelivery } from '@/components/steps/Step6QuoteDelivery';
import { useSession } from '@/hooks/useSession';

interface Props {
  onBack: () => void;
}

export function QuotePage({ onBack }: Props) {
  const client = useSession((s) => s.client);
  const medications = useSession((s) => s.medications);
  const providers = useSession((s) => s.providers);
  const selectedFinalists = useSession((s) => s.selectedFinalists);
  const setMode = useSession((s) => s.setMode);

  // Force new_quote ONCE on first mount — LandingPage flips mode to
  // annual_review when the hydrated client has a current_plan_id, but
  // the v4 Quote screen always opens on the side-by-side table.
  // Critically, after this initial reset the user must be free to
  // toggle into Annual Review via Step6's ModeToggle without us
  // immediately reverting. Watching `mode` in the dep array (the old
  // bug) caused the toggle to flash and re-mount NewQuoteMode every
  // time the user clicked Annual Review.
  const initialModeForced = useRef(false);
  useEffect(() => {
    if (initialModeForced.current) return;
    initialModeForced.current = true;
    setMode('new_quote');
  }, [setMode]);
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
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn out" onClick={onBack}>← Back</button>
          <button type="button" className="btn pri" onClick={() => window.print()}>Print Quote</button>
        </div>
      </div>
    </>
  );
}
