// Top-level layout for the v4 redesign. Renders the fixed navy global
// header + the workflow step nav + whichever page component is active.
// All legacy Sidebar / TabColumn / NotepadPanel chrome is gone; those
// affordances are either folded into page cards (Notes becomes a card
// on Landing) or deferred.
//
// Step gating: the user can click any completed step or the next step
// to move forward; future steps are disabled until their prerequisite
// session fields exist (client.name for Intake, medications.length > 0
// for Providers, etc). Keeping the gating here (not in each page) so
// nav behaves consistently.

import type { ReactNode } from 'react';
import { BROKER } from '@/lib/constants';
import { V4_CSS } from './styles';
import type { Client, Medication, Provider } from '@/types/session';
import { MiniSoftphone } from '@/components/MiniSoftphone';
import { useSession } from '@/hooks/useSession';
import { useScreenShareStore } from '@/hooks/useScreenShare';

export type WorkflowStepId = 'landing' | 'intake' | 'meds' | 'provs' | 'extras' | 'quote';

const STEPS: { id: WorkflowStepId; label: string; numeral: string }[] = [
  { id: 'landing', label: 'Home',        numeral: '⌂' },
  { id: 'intake',  label: 'Intake',      numeral: '1' },
  { id: 'meds',    label: 'Medications', numeral: '2' },
  { id: 'provs',   label: 'Providers',   numeral: '3' },
  { id: 'extras',  label: 'Extras',      numeral: '4' },
  { id: 'quote',   label: 'Quote',       numeral: '5' },
];

// Step is "completable" when the session has enough data to leave it.
// If you're ON a later step you can always click back to an earlier one;
// you can only click FORWARD to a step whose prerequisites are met.
export interface CompletionInput {
  client: Client;
  medications: Medication[];
  providers: Provider[];
  selectedFinalists: string[];
}
export function stepCompletion(session: CompletionInput): Record<WorkflowStepId, boolean> {
  return {
    landing: true, // always reachable
    intake: Boolean(session.client.name && session.client.zip && session.client.planType),
    meds: session.medications.length > 0,
    provs: session.providers.length > 0,
    extras: session.selectedFinalists.length > 0,
    quote: false, // final step — never "done"
  };
}

interface ShellProps {
  active: WorkflowStepId;
  completed: Record<WorkflowStepId, boolean>;
  onNavigate: (id: WorkflowStepId) => void;
  children: ReactNode;
  // Topbar-right slot so pages can drop in extra actions (e.g. a
  // "Verifications" bell) without the shell knowing about them.
  headerRight?: ReactNode;
}

export function WorkflowShell({
  active,
  completed,
  onNavigate,
  children,
  headerRight,
}: ShellProps) {
  const activeIdx = STEPS.findIndex((s) => s.id === active);
  return (
    <div className="pm4">
      <style>{V4_CSS}</style>
      <div className="ghdr">
        <div className="ghdr-l">
          <button
            type="button"
            className="logo"
            style={{ background: 'transparent', border: 'none' }}
            onClick={() => onNavigate('landing')}
          >
            Plan<span>Match</span>
          </button>
          <div className="spills">
            <span className="sp on">NC</span>
            <span className="sp">TX</span>
            <span className="sp">GA</span>
          </div>
        </div>
        <div className="ghdr-r">
          {headerRight}
          <a
            className="ghdr-btn"
            href="https://agentbase.generationhealth.me"
            target="_blank"
            rel="noopener"
            style={{ textDecoration: 'none' }}
          >
            AgentBase ↗
          </a>
          <div className="broker-b">
            <div className="bav">{initials(BROKER.name)}</div>
            <div>
              <div className="bn">{BROKER.name}</div>
              <div className="bnpn">#{brokerNpn(BROKER.license)}</div>
            </div>
          </div>
        </div>
      </div>
      <div className="wnav">
        {STEPS.map((s, i) => {
          const isActive = s.id === active;
          const isDone = completed[s.id] && i < activeIdx;
          // Forward clicks only allowed when all previous steps are done
          // (or the step itself is already marked done). Backward clicks
          // and same-step are always allowed.
          const canGoForward = i <= activeIdx
            ? true
            : STEPS.slice(1, i).every((prior) => completed[prior.id]);
          return (
            <button
              key={s.id}
              type="button"
              className={`wstep${isActive ? ' active' : ''}${isDone ? ' done' : ''}`}
              disabled={!canGoForward}
              onClick={() => onNavigate(s.id)}
            >
              <span className="wnum">{isDone ? '✓' : s.numeral}</span>
              {s.label}
            </button>
          );
        })}
      </div>
      <div className="page">{children}</div>
      <ShellSoftphone />
    </div>
  );
}

// Pulls client name/phone from the session and the screen-share state
// from useScreenShareStore. Mounted once at the shell level so the
// dock persists across Intake → Meds → Providers → Extras → Quote.
function ShellSoftphone() {
  const client = useSession((s) => s.client);
  const shareActive = useScreenShareStore((s) => Boolean(s.active));
  const stopShare = useScreenShareStore((s) => s.stop);
  return (
    <MiniSoftphone
      clientName={client.name || null}
      clientPhone={client.phone || null}
      shareActive={shareActive}
      onEndShare={() => { void stopShare('end_all'); }}
    />
  );
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .slice(0, 2)
    .join('');
}

function brokerNpn(license: string): string {
  // BROKER.license is "NC #10447418" in constants; pull the digit run.
  const m = license.match(/\d{5,}/);
  return m?.[0] ?? license;
}
