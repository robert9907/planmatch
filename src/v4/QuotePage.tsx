// Quote & Delivery — v4 page shell.
//
// Reuses the existing Step6QuoteDelivery body (which owns ModeToggle,
// finalist refetch, QuoteDeliveryV4 rendering, ScreenShareBar,
// ClientDeliveryCard, ComplianceChecklist, BrokerActions, and the
// SaveSessionButton that wraps /api/agentbase-sync) inside the v4
// phdr + sticky bbar. The user gets the mockup chrome without us
// re-implementing the tangle of logic that Step6 already handles.

import { useEffect } from 'react';
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
  const mode = useSession((s) => s.mode);
  const setMode = useSession((s) => s.setMode);

  // The v4 flow always lands on the side-by-side table. LandingPage
  // flips mode='annual_review' whenever the hydrated client has a
  // current_plan_id (to enable the CMS-import path elsewhere); that
  // branch isn't part of the v4 Quote screen. Force new_quote here
  // so the finalist table renders. Annual Review CMS import stays
  // accessible via the legacy Step6 ModeToggle rendered inside.
  useEffect(() => {
    if (mode !== 'new_quote') setMode('new_quote');
  }, [mode, setMode]);
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
