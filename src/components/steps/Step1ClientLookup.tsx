import { useEffect, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import { searchClients, type AgentBaseClient } from '@/lib/agentbase';
import { StepHeader } from './StepHeader';

interface Step1Props {
  onAdvance: () => void;
}

export function Step1ClientLookup({ onAdvance }: Step1Props) {
  const client = useSession((s) => s.client);
  const updateClient = useSession((s) => s.updateClient);
  const setCurrentPlanId = useSession((s) => s.setCurrentPlanId);
  const storeSetMode = useSession((s) => s.setMode);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AgentBaseClient[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<AgentBaseClient | null>(null);
  const [mode, setLocalMode] = useState<'search' | 'new'>('search');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const list = await searchClients(query);
        if (!cancelled) setResults(list);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const hasSelection = !!selected;

  function applyClient(c: AgentBaseClient) {
    setSelected(c);
    updateClient({
      name: c.name,
      phone: c.phone,
      dob: c.dob,
      zip: c.zip,
      county: c.county,
      state: c.state,
      planType: c.plan_type,
      medicaidConfirmed: c.medicaid_confirmed,
    });
    if (c.current_plan_id) {
      setCurrentPlanId(c.current_plan_id);
      storeSetMode('annual_review');
    } else {
      setCurrentPlanId(null);
      storeSetMode('new_quote');
    }
  }

  function startNewClient() {
    setLocalMode('new');
    setSelected(null);
    updateClient({
      name: '',
      phone: '',
      dob: '',
      zip: '',
      county: '',
      state: null,
      planType: null,
      medicaidConfirmed: false,
    });
    setCurrentPlanId(null);
    storeSetMode('new_quote');
  }

  return (
    <div className="flex flex-col gap-4">
      <StepHeader
        number={1}
        title="Client lookup"
        subtitle="Search AgentBase for an existing client, or start a brand-new intake."
      />

      <div className="pm-surface" style={{ padding: 16 }}>
        <div className="flex items-center gap-2 mb-3">
          <div
            className="flex items-center gap-2 flex-1"
            style={{
              height: 40,
              padding: '0 12px',
              borderRadius: 10,
              background: 'var(--warm)',
              border: '1px solid var(--w2)',
            }}
          >
            <SearchIcon />
            <input
              type="search"
              placeholder="Search by name, phone, or ZIP…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLocalMode('search');
              }}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                fontSize: 14,
                color: 'var(--ink)',
                fontFamily: 'inherit',
              }}
            />
            {loading && (
              <span style={{ color: 'var(--i3)', fontSize: 11 }}>searching…</span>
            )}
          </div>
          <button
            type="button"
            onClick={startNewClient}
            className={mode === 'new' ? 'pm-btn pm-btn-primary' : 'pm-btn'}
            style={{ height: 40 }}
          >
            + New client
          </button>
        </div>

        {mode === 'new' ? (
          <NewClientCard client={client} onAdvance={onAdvance} />
        ) : (
          <div className="flex flex-col gap-2">
            {results.length === 0 && !loading && (
              <div style={{ color: 'var(--i3)', fontSize: 13, padding: '12px 2px' }}>
                No clients match "{query}". Try a different name, or click{' '}
                <strong>+ New client</strong>.
              </div>
            )}
            {results.map((c) => (
              <ClientRow
                key={c.id}
                client={c}
                selected={selected?.id === c.id}
                onSelect={() => applyClient(c)}
              />
            ))}
          </div>
        )}
      </div>

      {hasSelection && (
        <div
          className="pm-surface"
          style={{ padding: 16, background: 'var(--sl)', borderColor: 'var(--sm)' }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div
                className="uppercase font-semibold"
                style={{ color: 'var(--sage)', fontSize: 10, letterSpacing: '0.08em' }}
              >
                {selected!.current_plan_id ? 'Annual review · existing client' : 'Existing client'}
              </div>
              <div className="font-lora" style={{ fontSize: 18, marginTop: 4 }}>
                {selected!.name}
              </div>
              <div style={{ color: 'var(--i2)', fontSize: 13, marginTop: 2 }}>
                {selected!.phone} · {selected!.county}, {selected!.state} · {selected!.plan_type}
              </div>
              <div style={{ color: 'var(--i2)', fontSize: 12, marginTop: 8 }}>
                {selected!.notes_summary}
              </div>
            </div>
            <button type="button" onClick={onAdvance} className="pm-btn pm-btn-primary">
              Continue →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ClientRow({
  client,
  selected,
  onSelect,
}: {
  client: AgentBaseClient;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="text-left"
      style={{
        padding: 10,
        borderRadius: 10,
        background: selected ? 'var(--sl)' : 'var(--wh)',
        border: `1px solid ${selected ? 'var(--sage)' : 'var(--w2)'}`,
        cursor: 'pointer',
        color: 'var(--ink)',
      }}
    >
      <div className="flex items-center justify-between">
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{client.name}</div>
          <div style={{ fontSize: 12, color: 'var(--i2)' }}>
            {client.phone} · {client.zip} · {client.plan_type}
            {client.medicaid_confirmed && ' · Medicaid ✓'}
          </div>
        </div>
        <span style={{ fontSize: 11, color: 'var(--i3)' }}>
          last contact {new Date(client.last_contact_at).toLocaleDateString()}
        </span>
      </div>
    </button>
  );
}

function NewClientCard({
  client,
  onAdvance,
}: {
  client: ReturnType<typeof useSession.getState>['client'];
  onAdvance: () => void;
}) {
  const complete = client.name && client.phone && client.state;
  return (
    <div
      className="flex items-center justify-between"
      style={{
        padding: 12,
        borderRadius: 10,
        border: '1px dashed var(--sage)',
        background: 'var(--warm)',
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>New client — no match in AgentBase</div>
        <div style={{ fontSize: 12, color: 'var(--i2)', marginTop: 2 }}>
          {complete
            ? 'Intake will open pre-filled with what you\'ve entered.'
            : 'Go to Step 2 to capture intake details.'}
        </div>
      </div>
      <button type="button" onClick={onAdvance} className="pm-btn pm-btn-primary">
        Start intake →
      </button>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--i2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
