interface Props {
  pendingCount: number;
  onOpen: () => void;
}

// Sits below the workflow-step list in the Sidebar. Inert (muted) when
// there's nothing to verify; flashes amber when ≥1 provider is in the
// queue. Clicking opens the verification drawer.
export function VerificationSidebarPill({ pendingCount, onOpen }: Props) {
  const active = pendingCount > 0;

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!active}
      className="flex items-center justify-between"
      style={{
        width: '100%',
        height: 36,
        padding: '0 10px',
        borderRadius: 8,
        border: `1px solid ${active ? 'var(--amb)' : 'var(--w2)'}`,
        background: active ? 'var(--at)' : 'var(--wh)',
        color: active ? 'var(--amb)' : 'var(--i3)',
        fontSize: 12,
        fontWeight: 700,
        cursor: active ? 'pointer' : 'default',
        animation: active ? 'pmVerifyPulse 1.6s ease-in-out infinite' : 'none',
      }}
      title={
        active
          ? `${pendingCount} provider${pendingCount === 1 ? '' : 's'} awaiting verification`
          : 'No providers pending verification'
      }
    >
      <span className="flex items-center gap-2">
        <span aria-hidden>⚕️</span>
        <span>Verifications</span>
      </span>
      <span
        style={{
          minWidth: 22,
          padding: '1px 6px',
          textAlign: 'center',
          borderRadius: 999,
          background: active ? 'var(--amb)' : 'var(--w2)',
          color: active ? '#fff' : 'var(--i3)',
          fontSize: 11,
          fontWeight: 800,
        }}
      >
        {pendingCount}
      </span>
    </button>
  );
}
