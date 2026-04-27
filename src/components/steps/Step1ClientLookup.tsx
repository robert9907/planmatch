import { useEffect, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import {
  fetchClientDetail,
  searchClients,
  type AgentBaseClient,
  type AgentBaseClientDetail,
} from '@/lib/agentbase';
import type { StateCode } from '@/types/session';
import { StepHeader } from './StepHeader';

interface Step1Props {
  onAdvance: () => void;
}

export function Step1ClientLookup({ onAdvance }: Step1Props) {
  const client = useSession((s) => s.client);
  const updateClient = useSession((s) => s.updateClient);
  const setCurrentPlanId = useSession((s) => s.setCurrentPlanId);
  const setIsAnnualReview = useSession((s) => s.setIsAnnualReview);
  const addMedication = useSession((s) => s.addMedication);
  const addProvider = useSession((s) => s.addProvider);
  const medications = useSession((s) => s.medications);
  const providers = useSession((s) => s.providers);
  const removeMedication = useSession((s) => s.removeMedication);
  const removeProvider = useSession((s) => s.removeProvider);
  const resetSession = useSession((s) => s.resetSession);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AgentBaseClient[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<AgentBaseClient | null>(null);
  const [hydrating, setHydrating] = useState(false);
  const [hydrated, setHydrated] = useState<AgentBaseClientDetail | null>(null);
  const [mode, setLocalMode] = useState<'search' | 'new'>('search');
  const [confirmingClear, setConfirmingClear] = useState(false);

  // 300ms debounced search against /api/clients/search.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const list = await searchClients(query, controller.signal);
        if (!controller.signal.aborted) setResults(list);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  const hasSelection = !!selected;

  async function applyClient(c: AgentBaseClient) {
    // Surface the pick instantly; hydrate + fill the session in the
    // background so Step 1 feels snappy on slow networks.
    setSelected(c);
    setHydrated(null);
    setHydrating(true);

    // Wipe any meds / providers from a prior client so we don't mix
    // two people's records. The reset below is targeted (keeps the
    // Zustand instance alive); the "Clear session" button does a full
    // resetSession().
    for (const m of medications) removeMedication(m.id);
    for (const p of providers) removeProvider(p.id);

    // Fill the Client block from the summary row first so Step 2 is
    // already populated before the detail fetch completes.
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
      setIsAnnualReview(true);
    } else {
      setCurrentPlanId(null);
      setIsAnnualReview(false);
    }

    // Full fetch → hydrate meds + providers.
    try {
      const detail = await fetchClientDetail(c.id);
      if (!detail) return;
      setHydrated(detail);
      for (const med of detail.medications) {
        if (!med.name.trim()) continue;
        addMedication({
          name: med.name,
          rxcui: med.rxcui || undefined,
          dosageInstructions: [med.dose, med.frequency].filter(Boolean).join(' · ') || undefined,
          source: 'manual',
        });
      }
      for (const pr of detail.providers) {
        if (!pr.name.trim()) continue;
        addProvider({
          name: pr.name,
          npi: pr.npi || undefined,
          specialty: pr.specialty || undefined,
          address: pr.address || undefined,
          phone: pr.phone || undefined,
          source: 'manual',
          networkStatus: {},
        });
      }
    } finally {
      setHydrating(false);
    }
  }

  function startNewClient() {
    setLocalMode('new');
    setSelected(null);
    setHydrated(null);
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
    setIsAnnualReview(false);
  }

  function clearSession() {
    resetSession();
    setQuery('');
    setResults([]);
    setSelected(null);
    setHydrated(null);
    setLocalMode('search');
    setConfirmingClear(false);
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
          <button
            type="button"
            onClick={() => setConfirmingClear(true)}
            className="pm-btn"
            style={{
              height: 40,
              color: 'var(--red)',
              borderColor: 'var(--red)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
            title="Clear current session and start fresh"
          >
            <CloseIcon />
            Clear session
          </button>
        </div>

        {mode === 'new' ? (
          <NewClientCard client={client} onAdvance={onAdvance} />
        ) : (
          <div className="flex flex-col gap-2">
            {results.length === 0 && !loading && (
              <div style={{ color: 'var(--i3)', fontSize: 13, padding: '12px 2px' }}>
                {query.trim()
                  ? <>No clients match "{query}". Try a different name, or click <strong>+ New client</strong>.</>
                  : 'Start typing a name, phone, or ZIP to pull up a client.'}
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
            <div style={{ minWidth: 0 }}>
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
                {selected!.phone}
                {selected!.county && ` · ${selected!.county}`}
                {selected!.state && `, ${selected!.state}`}
                {' · '}{selected!.plan_type}
              </div>
              {selected!.carrier || selected!.plan ? (
                <div style={{ color: 'var(--i2)', fontSize: 12, marginTop: 6 }}>
                  Current: {selected!.carrier} {selected!.plan}
                </div>
              ) : null}
              <div style={{ color: 'var(--i3)', fontSize: 11, marginTop: 8 }}>
                {hydrating
                  ? 'Loading medications + providers from AgentBase…'
                  : hydrated
                    ? `${hydrated.medications.length} meds · ${hydrated.providers.length} providers pre-loaded.`
                    : 'Basics loaded. Step 2 will open pre-filled.'}
              </div>
            </div>
            <button type="button" onClick={onAdvance} className="pm-btn pm-btn-primary">
              Continue →
            </button>
          </div>
        </div>
      )}

      {confirmingClear && (
        <ClearSessionDialog
          onCancel={() => setConfirmingClear(false)}
          onConfirm={clearSession}
        />
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
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{client.name}</div>
          <div style={{ fontSize: 12, color: 'var(--i2)' }}>
            {client.phone}
            {client.zip && ` · ${client.zip}`}
            {client.plan_type && ` · ${client.plan_type}`}
            {client.medicaid_confirmed && ' · Medicaid ✓'}
          </div>
        </div>
        {client.last_contact_at && (
          <span style={{ fontSize: 11, color: 'var(--i3)', flexShrink: 0, marginLeft: 12 }}>
            updated {new Date(client.last_contact_at).toLocaleDateString()}
          </span>
        )}
      </div>
    </button>
  );
}

function NewClientCard({
  client,
  onAdvance,
}: {
  client: { name: string; phone: string; state: StateCode | null };
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

function ClearSessionDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(16, 24, 40, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 20,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--wh)',
          borderRadius: 14,
          padding: 22,
          maxWidth: 380,
          width: '100%',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.25)',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)' }}>
          Clear current session?
        </div>
        <div style={{ fontSize: 13, color: 'var(--i2)', marginTop: 8, lineHeight: 1.4 }}>
          Removes the selected client, medications, providers, benefit
          filters, and any finalist picks. Starts fresh at Step 1 with
          a new session timestamp. Notes are preserved.
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 18,
          }}
        >
          <button type="button" onClick={onCancel} className="pm-btn">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="pm-btn"
            style={{ color: 'var(--red)', borderColor: 'var(--red)' }}
          >
            Clear session
          </button>
        </div>
      </div>
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

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </svg>
  );
}
