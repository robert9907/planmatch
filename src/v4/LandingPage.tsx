// Landing page — v4 redesign of Step 1.
//
// Hero + search + stats + Recent Sessions + Needs Attention + Quick
// Start + AEP Progress. Backed by /api/clients/search (which already
// returns the AgentBase client rows). Non-live affordances that need
// schema the clients table doesn't have yet (needs_review,
// session_status) render an honest empty state instead of invented
// data — same rule I've held all along.

import { useEffect, useMemo, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import {
  fetchClientDetail,
  fetchClientStats,
  fetchRecentClients,
  searchClients,
  type AgentBaseClient,
} from '@/lib/agentbase';

interface Props {
  onPickClient: () => void;
  onStartNew: () => void;
}

export function LandingPage({ onPickClient, onStartNew }: Props) {
  const updateClient = useSession((s) => s.updateClient);
  const addMedication = useSession((s) => s.addMedication);
  const addProvider = useSession((s) => s.addProvider);
  const removeMedication = useSession((s) => s.removeMedication);
  const removeProvider = useSession((s) => s.removeProvider);
  const setCurrentPlanId = useSession((s) => s.setCurrentPlanId);
  const setMode = useSession((s) => s.setMode);
  const existingMeds = useSession((s) => s.medications);
  const existingProvs = useSession((s) => s.providers);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AgentBaseClient[]>([]);
  const [recentClients, setRecentClients] = useState<AgentBaseClient[]>([]);
  const [totalClients, setTotalClients] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [hydrating, setHydrating] = useState(false);

  // Recent + stats are independent of the search input so typing in the
  // search box doesn't blank the Recent Sessions card. Both fire once on
  // mount; search results below override the dropdown when q is non-empty.
  useEffect(() => {
    const controller = new AbortController();
    fetchRecentClients(5, controller.signal).then((list) => {
      if (!controller.signal.aborted) setRecentClients(list);
    });
    fetchClientStats(controller.signal).then((stats) => {
      if (!controller.signal.aborted && stats) setTotalClients(stats.total);
    });
    return () => controller.abort();
  }, []);

  // Debounced search. Empty query keeps Recent Sessions visible without
  // an extra fetch; a typed query overrides the dropdown.
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const list = await searchClients(query, controller.signal);
        if (!controller.signal.aborted) setResults(list);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 300);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  const today = useMemo(() => {
    return new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
  }, []);

  const stats = useMemo(() => {
    // "Active Clients" is the real count from /api/agentbase-clients?stats.
    // The others stay "—" until session_status / needs_review ship on the
    // clients table — no invented numbers.
    return {
      active: totalClients,
      enrolled: null as number | null,
      pending: null as number | null,
      needsAttention: null as number | null,
    };
  }, [totalClients]);

  async function pickClient(c: AgentBaseClient) {
    if (hydrating) return;
    setHydrating(true);
    try {
      // Clear prior session medications / providers so we never mix two
      // clients. Same pattern as the legacy Step1.
      for (const m of existingMeds) removeMedication(m.id);
      for (const p of existingProvs) removeProvider(p.id);

      // Seed the client block immediately so Intake isn't blank if the
      // detail fetch is slow.
      updateClient({
        name: c.name,
        phone: c.phone,
        dob: c.dob,
        zip: c.zip,
        county: c.county,
        state: c.state ?? null,
        planType: c.plan_type,
        medicaidConfirmed: c.medicaid_confirmed,
      });
      if (c.current_plan_id) {
        setCurrentPlanId(c.current_plan_id);
        setMode('annual_review');
      } else {
        setCurrentPlanId(null);
        setMode('new_quote');
      }

      // Pull meds + providers in the background. fetchClientDetail can
      // return null on transient failures — skip the hydration and
      // carry on with what the summary row already gave us.
      const detail = await fetchClientDetail(c.id);
      if (!detail) { onPickClient(); return; }
      for (const m of detail.medications) {
        addMedication({
          name: m.name,
          rxcui: m.rxcui || undefined,
          dosageInstructions: [m.dose, m.frequency].filter(Boolean).join(' · ') || undefined,
          source: 'manual',
          confidence: 'high',
        });
      }
      for (const p of detail.providers) {
        addProvider({
          name: p.name,
          specialty: p.specialty || undefined,
          npi: p.npi || undefined,
          address: p.address || undefined,
          phone: p.phone || undefined,
          source: 'manual',
        });
      }
      onPickClient();
    } finally {
      setHydrating(false);
    }
  }

  // Search results take precedence when the user has typed something;
  // otherwise show the dedicated Recent Sessions list.
  const showingSearch = query.trim().length > 0;
  const dropdown = showingSearch ? results : recentClients;
  const recent = dropdown.slice(0, 5);
  const bookSize = totalClients ?? recentClients.length;

  return (
    <div className="scroll">
      <div className="hero">
        <div className="hero-g">
          Good morning, <span>{firstName()}</span>
        </div>
        <div className="hero-s">
          {today} · {bookSize} client{bookSize === 1 ? '' : 's'} in your book
        </div>
        <div className="sb-wrap">
          <div className="si">⌕</div>
          <input
            className="sb"
            placeholder="Search clients by name, phone, or ZIP…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="sa">
          <button type="button" className="btn sea" onClick={onStartNew}>
            + New Client
          </button>
          <button
            type="button"
            className="btn out"
            disabled={recent.length === 0 || hydrating}
            onClick={() => recent[0] && pickClient(recent[0])}
          >
            Resume Last Session
          </button>
          <button type="button" className="btn out" disabled>
            Annual Review Queue
          </button>
        </div>
      </div>

      <div className="stats">
        <StatCard icon="📋" iconCls="bl" value={fmtStat(stats.active)} label="Active Clients" />
        <StatCard icon="✓" iconCls="gr" value={fmtStat(stats.enrolled)} label="Enrolled This Month" />
        <StatCard icon="⏱" iconCls="am" value={fmtStat(stats.pending)} label="Quotes Pending" />
        <StatCard icon="⚠" iconCls="rd" value={fmtStat(stats.needsAttention)} label="Need Attention" />
      </div>

      <div className="lmain">
        {/* Recent Sessions (or live search results when query is non-empty) */}
        <div className="card">
          <div className="chdr">
            <div className="cht">{showingSearch ? 'Search Results' : 'Recent Sessions'}</div>
            <div className="chact">
              {showingSearch
                ? loading
                  ? 'Searching…'
                  : `${results.length} match${results.length === 1 ? '' : 'es'}`
                : `${recentClients.length} shown`}
            </div>
          </div>
          {recent.length === 0 && !loading ? (
            <div style={{ padding: '16px', fontSize: 12, color: 'var(--v4-g500)' }}>
              {showingSearch
                ? <>No clients match <strong>{query}</strong>.</>
                : <>No clients yet. Click <strong>+ New Client</strong> to start a session.</>}
            </div>
          ) : (
            recent.map((c) => <RecentRow key={c.id} c={c} onPick={() => pickClient(c)} />)
          )}
        </div>

        {/* Needs Attention */}
        <div className="card">
          <div className="chdr">
            <div className="cht">Needs Attention</div>
            <div className="chact">{isAepWindow() ? 'AEP active' : 'pending schema'}</div>
          </div>
          {isAepWindow() ? (
            <div style={{ padding: '14px 16px', fontSize: 12, color: 'var(--v4-g700)', lineHeight: 1.5 }}>
              <div style={{ fontWeight: 600, color: 'var(--v4-g900)', marginBottom: 4 }}>
                Giveback plan — re-evaluate at AEP
              </div>
              <div style={{ color: 'var(--v4-g500)' }}>
                Clients enrolled in Part B giveback plans (
                <code style={{ fontFamily: 'var(--v4-fm)', fontSize: 11 }}>giveback_plan_enrolled</code>
                ) surface here during Oct 15 – Dec 7. The flag rides through
                agentbase-sync; AgentBase needs to expose it back via
                /api/agentbase-clients before the list can populate. Until then
                the agent should manually review last-quarter giveback enrollments.
              </div>
            </div>
          ) : (
            <div style={{ padding: '14px 16px', fontSize: 12, color: 'var(--v4-g500)', lineHeight: 1.5 }}>
              Needs-attention alerts (tier change, network drop, follow-up)
              light up here once the <code style={{ fontFamily: 'var(--v4-fm)', fontSize: 11 }}>clients.needs_review</code>
              {' '}column lands in AgentBase. Giveback re-evaluation reminders
              activate automatically during AEP (Oct 15 – Dec 7).
            </div>
          )}
          <div className="chdr" style={{ marginTop: 4, borderTop: '1px solid var(--v4-g100)' }}>
            <div className="cht">Quick Start</div>
          </div>
          <div className="qsg">
            <button type="button" className="qsc" onClick={onStartNew}>
              <div className="qsi">🏥</div>
              <div className="qsn">Medicare Advantage</div>
              <div className="qss">MAPD · MA · SNP</div>
            </button>
            <button type="button" className="qsc" disabled>
              <div className="qsi">🛡️</div>
              <div className="qsn">Medigap</div>
              <div className="qss">Plans G · N</div>
            </button>
            <button type="button" className="qsc" disabled>
              <div className="qsi">💊</div>
              <div className="qsn">Part D</div>
              <div className="qss">Standalone Drug</div>
            </button>
            <button type="button" className="qsc" disabled>
              <div className="qsi">🏛️</div>
              <div className="qsn">ACA</div>
              <div className="qss">Under 65 · SEP</div>
            </button>
          </div>
        </div>

        {/* AEP Progress */}
        <AepProgress totalClients={bookSize} />
      </div>
    </div>
  );
}

function StatCard({
  icon, iconCls, value, label,
}: { icon: string; iconCls: string; value: string; label: string }) {
  return (
    <div className="sc">
      <div className={`sci ${iconCls}`}>{icon}</div>
      <div>
        <div className="scn">{value}</div>
        <div className="scl">{label}</div>
      </div>
    </div>
  );
}

function RecentRow({ c, onPick }: { c: AgentBaseClient; onPick: () => void }) {
  const age = dobToAge(c.dob);
  const location = [c.city || c.county, c.state].filter(Boolean).join(', ');
  // session_status isn't a real column yet — derive a lightweight
  // placeholder from year + current_plan_id so the badge is honest
  // about what we can and can't tell.
  const badge =
    c.current_plan_id ? { cls: 'e' as const, text: 'Enrolled' }
    : c.year ? { cls: 'p' as const, text: 'Pending' }
    : { cls: 'p' as const, text: 'New' };
  const initials = (c.first_name[0] ?? '').toUpperCase() + (c.last_name[0] ?? '').toUpperCase();
  return (
    <button type="button" className="sr" onClick={onPick}>
      <div className="sra">{initials || '—'}</div>
      <div className="sri">
        <div className="srn">{c.name}</div>
        <div className="srd">
          {age ? `${age} · ` : ''}
          {location}{location ? ' · ' : ''}
          {c.plan_type}
        </div>
      </div>
      <div className="srr">
        <div className={`srs ${badge.cls}`}>{badge.text}</div>
        {c.last_contact_at && (
          <div className="srt">{relativeTime(c.last_contact_at)}</div>
        )}
      </div>
    </button>
  );
}

function AepProgress({ totalClients }: { totalClients: number }) {
  const { daysLeft, windowCopy } = aepStatus();
  // Counts are stubs until the clients table tracks session_status.
  const reviewed = 0, enrolled = 0, needChange = 0;
  const pct = (n: number) => (totalClients > 0 ? Math.round((n / totalClients) * 100) : 0);
  return (
    <div className="card span2">
      <div className="chdr">
        <div className="cht">AEP 2027 Progress</div>
        <div className="chact">{windowCopy}{daysLeft != null ? ` · ${daysLeft} days` : ''}</div>
      </div>
      <div className="aep">
        <AepRow label="Reviewed" value={`${reviewed}/${totalClients}`} pct={pct(reviewed)} barCls="g" />
        <AepRow label="Enrolled" value={`${enrolled}/${totalClients}`} pct={pct(enrolled)} barCls="n" />
        <AepRow label="Need Change" value={String(needChange)} pct={pct(needChange)} barCls="a" />
      </div>
    </div>
  );
}

function AepRow({ label, value, pct, barCls }: { label: string; value: string; pct: number; barCls: 'g' | 'n' | 'a' }) {
  return (
    <div className="aepr">
      <div className="aepm">
        <div className="aepl">{label}</div>
        <div className="aepv">{value}</div>
      </div>
      <div className="aepbw"><div className={`aepb ${barCls}`} style={{ width: `${pct}%` }} /></div>
      <div className="aepp">{pct}%</div>
    </div>
  );
}

// ─── tiny helpers ───────────────────────────────────────────────────

function firstName(): string {
  return 'Rob';
}

function fmtStat(n: number | null): string {
  return n == null ? '—' : String(n);
}

function dobToAge(dob: string): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const monthDiff = now.getMonth() - d.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < d.getDate())) age -= 1;
  return age;
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = Date.now();
  const diffMs = now - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}


// True when today falls inside the current AEP window (Oct 15 – Dec 7).
// Used to flip the Needs Attention card into "review giveback enrollments"
// mode without waiting for AgentBase schema changes.
function isAepWindow(now: Date = new Date()): boolean {
  const yr = now.getFullYear();
  const start = new Date(yr, 9, 15);
  const end = new Date(yr, 11, 7, 23, 59, 59);
  return now >= start && now <= end;
}

function aepStatus(): { daysLeft: number | null; windowCopy: string } {
  // 2027 AEP runs Oct 15 – Dec 7 2026. Before it opens: countdown.
  // During: days remaining. After: OEP.
  const start = new Date(2026, 9, 15);
  const end = new Date(2026, 11, 7);
  const now = new Date();
  if (now < start) {
    const days = Math.ceil((start.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    return { daysLeft: days, windowCopy: `Opens Oct 15` };
  }
  if (now > end) return { daysLeft: null, windowCopy: 'OEP Jan 1 – Mar 31' };
  const days = Math.ceil((end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  return { daysLeft: days, windowCopy: `Oct 15 – Dec 7` };
}
