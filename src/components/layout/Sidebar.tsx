import { WORKFLOW_STEPS, BROKER } from '@/lib/constants';
import { useSession } from '@/hooks/useSession';

interface SidebarProps {
  activeStep: number;
  onStepClick: (stepId: number) => void;
}

export function Sidebar({ activeStep, onStepClick }: SidebarProps) {
  const medCount = useSession((s) => s.medications.length);
  const providerCount = useSession((s) => s.providers.length);
  const mode = useSession((s) => s.mode);
  const startedAt = useSession((s) => s.startedAt);

  const progress = Math.round((activeStep / WORKFLOW_STEPS.length) * 100);

  return (
    <aside
      className="flex flex-col border-r"
      style={{
        width: 240,
        background: 'var(--wh)',
        borderColor: 'var(--w2)',
        color: 'var(--ink)',
      }}
    >
      <div className="px-4 pt-4 pb-3">
        <div
          className="uppercase font-semibold"
          style={{ color: 'var(--i3)', fontSize: 10, letterSpacing: '0.08em' }}
        >
          Workflow
        </div>

        <div
          className="mt-2 overflow-hidden"
          style={{ height: 4, borderRadius: 999, background: 'var(--w2)' }}
        >
          <div
            style={{
              width: `${progress}%`,
              height: '100%',
              background: 'var(--sage)',
              transition: 'width 160ms ease',
            }}
          />
        </div>

        <div style={{ color: 'var(--i2)', fontSize: 11 }} className="mt-1">
          Step {activeStep} of {WORKFLOW_STEPS.length} · {progress}%
        </div>
      </div>

      <nav className="px-2 flex-1 overflow-y-auto">
        {WORKFLOW_STEPS.map((step) => {
          const active = step.id === activeStep;
          const done = step.id < activeStep;
          return (
            <button
              key={step.id}
              type="button"
              onClick={() => onStepClick(step.id)}
              className="w-full flex items-center gap-2 text-left"
              style={{
                padding: '8px 10px',
                marginBottom: 2,
                borderRadius: 8,
                background: active ? 'var(--sl)' : 'transparent',
                border: active ? '1px solid var(--sm)' : '1px solid transparent',
                color: active ? 'var(--ink)' : 'var(--i2)',
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                cursor: 'pointer',
              }}
            >
              <span
                className="grid place-items-center font-semibold"
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  fontSize: 11,
                  background: done ? 'var(--sage)' : active ? 'var(--sage)' : 'var(--w2)',
                  color: done || active ? '#fff' : 'var(--i2)',
                }}
              >
                {done ? '✓' : step.id}
              </span>
              {step.label}
            </button>
          );
        })}
      </nav>

      <div
        className="px-4 py-3 border-t text-xs"
        style={{ borderColor: 'var(--w2)', color: 'var(--i2)' }}
      >
        <div
          className="uppercase font-semibold mb-1"
          style={{ color: 'var(--i3)', fontSize: 10, letterSpacing: '0.08em' }}
        >
          Session
        </div>
        <Row k="Mode" v={mode === 'annual_review' ? 'Annual Review' : 'New Quote'} />
        <Row k="Meds" v={medCount.toString()} />
        <Row k="Providers" v={providerCount.toString()} />
        <Row k="Started" v={new Date(startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} />

        <div
          className="mt-3 pt-3 border-t"
          style={{ borderColor: 'var(--w2)', color: 'var(--i3)' }}
        >
          <div className="font-semibold" style={{ color: 'var(--i2)' }}>{BROKER.name}</div>
          <div>{BROKER.license}</div>
          <div>{BROKER.phone}</div>
        </div>
      </div>
    </aside>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between" style={{ marginTop: 2 }}>
      <span>{k}</span>
      <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{v}</span>
    </div>
  );
}
