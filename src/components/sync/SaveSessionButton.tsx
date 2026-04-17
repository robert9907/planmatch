import { useState } from 'react';
import { useSession } from '@/hooks/useSession';
import { DISCLAIMERS } from '@/lib/compliance';
import { buildSyncPayload, type AgentBaseSyncResponse, type AgentBaseSyncStatus } from '@/types/agentbaseSync';

export function SaveSessionButton() {
  const client = useSession((s) => s.client);
  const sessionId = useSession((s) => s.sessionId);
  const startedAt = useSession((s) => s.startedAt);
  const mode = useSession((s) => s.mode);
  const medications = useSession((s) => s.medications);
  const providers = useSession((s) => s.providers);
  const plansCompared = useSession((s) => s.plansCompared);
  const recommendation = useSession((s) => s.recommendation);
  const complianceChecked = useSession((s) => s.complianceChecked);
  const disclaimersConfirmed = useSession((s) => s.disclaimersConfirmed);
  const notes = useSession((s) => s.notes);
  const selectedFinalists = useSession((s) => s.selectedFinalists);

  const [status, setStatus] = useState<AgentBaseSyncStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [agentbaseId, setAgentbaseId] = useState<string | null>(null);

  const canSave = !!client.name && !!client.phone;

  async function save() {
    if (!canSave) {
      setError('Client name and phone are required before saving.');
      setStatus('error');
      return;
    }

    setStatus('saving');
    setError(null);

    const payload = buildSyncPayload({
      client,
      sessionId,
      startedAt,
      mode,
      medications,
      providers,
      plansCompared: plansCompared.length ? plansCompared : selectedFinalists,
      recommendation,
      complianceChecked,
      disclaimersConfirmed,
      notes,
      expectedDisclaimerIds: DISCLAIMERS.map((d) => d.id),
    });

    try {
      const r = await fetch('/api/agentbase-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await r.json().catch(() => ({}))) as AgentBaseSyncResponse;
      if (!r.ok || body.ok === false) {
        setError(body.error ?? `AgentBase returned ${r.status}`);
        setStatus('error');
        return;
      }
      setAgentbaseId(body.session_id ?? null);
      setStatus('saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
      setStatus('error');
    }
  }

  return (
    <div
      className="pm-surface"
      style={{
        padding: 14,
        borderColor:
          status === 'saved'
            ? 'var(--sage)'
            : status === 'error'
              ? 'var(--red)'
              : 'var(--w2)',
        background:
          status === 'saved'
            ? 'var(--sl)'
            : status === 'error'
              ? 'var(--rt)'
              : 'var(--wh)',
      }}
    >
      <div className="flex items-start justify-between gap-3" style={{ flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div
            className="uppercase font-semibold"
            style={{
              color:
                status === 'saved'
                  ? 'var(--sage)'
                  : status === 'error'
                    ? 'var(--red)'
                    : 'var(--i3)',
              fontSize: 10,
              letterSpacing: '0.08em',
            }}
          >
            Save to AgentBase CRM
          </div>
          <div className="font-lora" style={{ fontSize: 15, marginTop: 4 }}>
            {statusHeadline(status, client.name)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--i2)', marginTop: 4 }}>
            {statusBody(status, agentbaseId)}
          </div>
          {error && (
            <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6 }}>
              {error}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={save}
          disabled={!canSave || status === 'saving'}
          className="pm-btn pm-btn-primary"
          style={{
            height: 40,
            padding: '0 18px',
            opacity: !canSave || status === 'saving' ? 0.6 : 1,
          }}
        >
          {buttonLabel(status)}
        </button>
      </div>

      {!canSave && (
        <div style={{ fontSize: 11, color: 'var(--i3)', marginTop: 6 }}>
          Client name and phone are required — complete Step 1 / Step 2 first.
        </div>
      )}
    </div>
  );
}

function statusHeadline(status: AgentBaseSyncStatus, clientName: string): string {
  const nameFragment = clientName ? ` for ${clientName.split(/\s+/)[0]}` : '';
  switch (status) {
    case 'saving':
      return `Saving session${nameFragment}…`;
    case 'saved':
      return `Session${nameFragment} saved · awaiting your approval in AgentBase`;
    case 'error':
      return 'Save failed';
    default:
      return `Ready to hand off to AgentBase${nameFragment}`;
  }
}

function statusBody(status: AgentBaseSyncStatus, agentbaseId: string | null): string {
  switch (status) {
    case 'saved':
      return agentbaseId
        ? `AgentBase session id ${agentbaseId}. Open AgentBase → the header will be flashing amber. Approve there to write this to the client record.`
        : 'Open AgentBase and look for the flashing amber PlanMatch Pending button.';
    case 'error':
      return 'Nothing has been written to AgentBase. You can retry below once the underlying issue is resolved.';
    case 'saving':
      return 'Posting payload through /api/agentbase-sync to AgentBase.';
    default:
      return 'Sends the full session payload — client, meds, providers, finalists, compliance, notes — to AgentBase as a pending record that you approve there.';
  }
}

function buttonLabel(status: AgentBaseSyncStatus): string {
  switch (status) {
    case 'saving':
      return 'Saving…';
    case 'saved':
      return 'Save again';
    case 'error':
      return 'Retry save';
    default:
      return 'Save session →';
  }
}
