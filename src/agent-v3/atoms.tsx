// Shared visual atoms ported from reference/plan-match-agent-v3.jsx.
// Inline styles preserved verbatim where possible so the mockup's
// pixel layout survives the port. Tokens used:
//   --hero       #0d2f5e
//   --seafoam    #83f0f9
//   --brand-blue #0071e3
// Hard-coded throughout because the mockup did the same; keeping them
// inline keeps the diff against the mockup readable for review.

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useState,
} from 'react';
import { FADE_SLIDE_IN } from './styles';

export function fmt(n: number): string {
  return '$' + n.toLocaleString();
}

export function Container({
  children,
  wide,
}: {
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      style={{
        maxWidth: wide ? 920 : 660,
        margin: '0 auto',
        padding: '40px 18px',
      }}
    >
      {children}
    </div>
  );
}

export function Header({ title, sub }: { title: string; sub?: string }) {
  return (
    <div style={{ textAlign: 'center', marginBottom: 30 }}>
      <div
        style={{
          fontFamily: "'Fraunces', Georgia, serif",
          fontSize: 26,
          color: '#0d2f5e',
          fontWeight: 700,
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      {sub && <div style={{ color: '#64748b', fontSize: 14 }}>{sub}</div>}
    </div>
  );
}

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: 'white',
        borderRadius: 14,
        padding: 22,
        boxShadow: '0 2px 12px rgba(13,47,94,0.05)',
        border: '1px solid rgba(13,47,94,0.05)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Field({
  label,
  value,
  badge,
}: {
  label: string;
  value: ReactNode;
  badge?: string;
}) {
  return (
    <div>
      <label
        style={{
          display: 'block',
          fontSize: 10,
          fontWeight: 600,
          color: '#64748b',
          marginBottom: 4,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </label>
      <div
        style={{
          background: '#f8fafc',
          border: '1px solid rgba(13,47,94,0.05)',
          borderRadius: 8,
          padding: '10px 12px',
          fontSize: 14,
          fontWeight: 600,
          color: '#0d2f5e',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minHeight: 40,
        }}
      >
        {value || <span style={{ color: '#cbd5e1', fontWeight: 500 }}>—</span>}
        {badge && (
          <span
            style={{
              marginLeft: 'auto',
              background: '#d1fae5',
              color: '#065f46',
              fontSize: 10,
              fontWeight: 600,
              padding: '2px 7px',
              borderRadius: 10,
            }}
          >
            {badge}
          </span>
        )}
      </div>
    </div>
  );
}

// Editable variant of Field — same chrome, but renders an input. Used
// by IntakeScreen so the broker can fill the form before kicking the
// rest of the workflow. Kept here so the v3 atoms set is the single
// source of truth for the form-row look.
export function FieldInput({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  inputMode,
  maxLength,
  badge,
  rightHint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'tel' | 'email' | 'date';
  inputMode?: 'text' | 'numeric' | 'tel' | 'email';
  maxLength?: number;
  badge?: string;
  rightHint?: ReactNode;
}) {
  return (
    <div>
      <label
        style={{
          display: 'block',
          fontSize: 10,
          fontWeight: 600,
          color: '#64748b',
          marginBottom: 4,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
        }}
      >
        {label}
        {rightHint && (
          <span style={{ marginLeft: 8, fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: '#94a3b8' }}>
            {rightHint}
          </span>
        )}
      </label>
      <div
        style={{
          background: '#f8fafc',
          border: '1px solid rgba(13,47,94,0.05)',
          borderRadius: 8,
          padding: '4px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minHeight: 40,
        }}
      >
        <input
          type={type}
          inputMode={inputMode}
          maxLength={maxLength}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontSize: 14,
            fontWeight: 600,
            color: '#0d2f5e',
            padding: '6px 0',
            width: '100%',
          }}
        />
        {badge && (
          <span
            style={{
              background: '#d1fae5',
              color: '#065f46',
              fontSize: 10,
              fontWeight: 600,
              padding: '2px 7px',
              borderRadius: 10,
              whiteSpace: 'nowrap',
            }}
          >
            {badge}
          </span>
        )}
      </div>
    </div>
  );
}

export function GreenDot() {
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: '#34d399',
        display: 'inline-block',
      }}
    />
  );
}

export function MedIcon({
  tier,
  children,
}: {
  tier: number;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        width: 40,
        height: 40,
        borderRadius: 10,
        background:
          tier >= 3
            ? 'linear-gradient(135deg, #fef3c7, #fde68a)'
            : 'linear-gradient(135deg, #d1fae5, #a7f3d0)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 18,
      }}
    >
      {children}
    </div>
  );
}

export function TierBadge({ tier }: { tier: number | null }) {
  const t = tier ?? 0;
  return (
    <div
      style={{
        padding: '2px 8px',
        borderRadius: 12,
        fontSize: 10,
        fontWeight: 600,
        background: t >= 3 ? '#fef3c7' : t > 0 ? '#d1fae5' : '#f1f5f9',
        color: t >= 3 ? '#92400e' : t > 0 ? '#065f46' : '#94a3b8',
      }}
    >
      {t > 0 ? `Tier ${t}` : 'Tier ?'}
    </div>
  );
}

export function AgentInsight({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) {
  return (
    <div
      style={{
        background: 'linear-gradient(135deg, #0d2f5e, #1a4a8a)',
        borderRadius: 10,
        padding: '12px 16px',
        border: '1px solid rgba(131,240,249,0.2)',
        marginTop: 12,
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}
      >
        <span style={{ fontSize: 12 }}>🧠</span>
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            color: '#83f0f9',
            letterSpacing: 1,
            textTransform: 'uppercase',
          }}
        >
          {title || 'Broker Brain — Agent Only'}
        </span>
      </div>
      <div
        style={{
          color: 'rgba(255,255,255,0.85)',
          fontSize: 11,
          lineHeight: 1.6,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function Nav({
  onBack,
  onNext,
  nextLabel,
  nextDisabled,
}: {
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: onBack ? 'space-between' : 'flex-end',
        marginTop: 24,
      }}
    >
      {onBack && (
        <button type="button" onClick={onBack} style={SEC_BTN}>
          ← Back
        </button>
      )}
      {onNext && (
        <button
          type="button"
          onClick={onNext}
          disabled={nextDisabled}
          style={{
            ...PRI_BTN,
            opacity: nextDisabled ? 0.4 : 1,
            cursor: nextDisabled ? 'default' : 'pointer',
          }}
        >
          {nextLabel || 'Continue →'}
        </button>
      )}
    </div>
  );
}

export const PRI_BTN: CSSProperties = {
  background: 'linear-gradient(135deg, #0d2f5e, #1a4a8a)',
  color: 'white',
  border: 'none',
  borderRadius: 9,
  padding: '12px 24px',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
};

export const SEC_BTN: CSSProperties = {
  background: 'transparent',
  color: '#0d2f5e',
  border: '1.5px solid rgba(13,47,94,0.12)',
  borderRadius: 9,
  padding: '12px 20px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

export function AnimCounter({
  target,
  delay = 0,
  prefix = '$',
}: {
  target: number;
  delay?: number;
  prefix?: string;
}) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    const to = window.setTimeout(() => {
      const start = performance.now();
      const tick = (now: number) => {
        const p = Math.min((now - start) / 1200, 1);
        setVal(Math.round((1 - Math.pow(1 - p, 3)) * target));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, delay);
    return () => window.clearTimeout(to);
  }, [target, delay]);
  return (
    <span>
      {prefix}
      {val.toLocaleString()}
    </span>
  );
}

const BADGE_BASE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '3px 10px',
  borderRadius: 16,
  fontSize: 11,
  fontWeight: 600,
};

// 5-star rating glyph row. Half-stars rendered with the unicode "½".
// Single point of formatting so PinnedPlan + SwipeCard + CompareScreen
// agree on the visual.
export function Stars({ rating }: { rating: number }) {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  const empty = 5 - full - (half ? 1 : 0);
  return (
    <span style={{ color: '#f0a500', fontSize: 11, letterSpacing: 1 }}>
      {'★'.repeat(full)}
      {half ? '½' : ''}
      {'☆'.repeat(empty)}
    </span>
  );
}

// Benefit badge — small pill used on PinnedPlan + SwipeCard + Compare.
// `good` controls the green-vs-muted treatment; the spec uses it to
// flag when an extra is meaningfully better than the comparison plan.
export function BenBadge({
  icon,
  label,
  value,
  good,
}: {
  icon: string;
  label: string;
  value: string;
  good?: boolean;
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        background: good ? 'rgba(5,150,105,0.05)' : 'rgba(239,68,68,0.03)',
        border: good
          ? '1px solid rgba(5,150,105,0.18)'
          : '1px solid rgba(239,68,68,0.1)',
        borderRadius: 18,
        padding: '4px 10px',
      }}
    >
      <span style={{ fontSize: 12 }}>{icon}</span>
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          color: good ? '#059669' : '#94a3b8',
          textTransform: 'uppercase',
          letterSpacing: 0.3,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: good ? '#065f46' : '#6b7280',
        }}
      >
        {value}
      </span>
    </div>
  );
}

// Compact metric block used inside the PinnedPlan row.
export function MiniMetric({
  label,
  value,
  sub,
  highlight,
  isStatus,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
  isStatus?: boolean;
}) {
  return (
    <div
      style={{
        background: isStatus
          ? 'rgba(5,150,105,0.06)'
          : highlight
            ? 'rgba(131,240,249,0.1)'
            : 'rgba(255,255,255,0.7)',
        borderRadius: 7,
        padding: '7px 8px',
        textAlign: 'center',
        minWidth: 68,
        border: isStatus
          ? '1px solid rgba(5,150,105,0.15)'
          : highlight
            ? '1px solid rgba(131,240,249,0.2)'
            : '1px solid rgba(13,47,94,0.06)',
      }}
    >
      <div
        style={{
          fontSize: 8,
          color: '#64748b',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.3,
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: isStatus ? 13 : 14,
          fontWeight: 800,
          color: isStatus ? '#059669' : '#0d2f5e',
          fontFamily: "'Fraunces', Georgia, serif",
        }}
      >
        {value}
      </div>
      {sub && <div style={{ fontSize: 8, color: '#94a3b8' }}>{sub}</div>}
    </div>
  );
}

// Larger metric card used inside SwipeCard. `comp` + `better` render a
// "↓ vs $X" delta line vs the current plan.
export function MetricCard({
  label,
  value,
  sub,
  comp,
  better,
  isStatus,
  isWarning,
}: {
  label: string;
  value: string;
  sub?: string;
  comp?: number;
  better?: boolean;
  isStatus?: boolean;
  isWarning?: boolean;
}) {
  const tint = isStatus
    ? 'rgba(5,150,105,0.05)'
    : isWarning
      ? 'rgba(239,68,68,0.04)'
      : better
        ? 'rgba(5,150,105,0.04)'
        : 'rgba(239,68,68,0.03)';
  const border = isStatus
    ? '1px solid rgba(5,150,105,0.15)'
    : isWarning
      ? '1px solid rgba(239,68,68,0.15)'
      : '1px solid rgba(13,47,94,0.04)';
  const valueColor = isStatus
    ? '#059669'
    : isWarning
      ? '#ef4444'
      : better
        ? '#059669'
        : '#ef4444';
  return (
    <div
      style={{
        background: tint,
        borderRadius: 8,
        padding: '9px 6px',
        textAlign: 'center',
        border,
      }}
    >
      <div
        style={{
          fontSize: 9,
          color: '#64748b',
          fontWeight: 600,
          textTransform: 'uppercase',
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 800,
          color: valueColor,
          fontFamily: "'Fraunces', Georgia, serif",
        }}
      >
        {value}
      </div>
      {sub && <div style={{ fontSize: 9, color: '#94a3b8' }}>{sub}</div>}
      {comp != null && !isStatus && !isWarning && (
        <div
          style={{
            fontSize: 8,
            color: better ? '#059669' : '#ef4444',
            fontWeight: 600,
            marginTop: 1,
          }}
        >
          {better ? `↓ vs $${comp}` : `↑ vs $${comp}`}
        </div>
      )}
    </div>
  );
}

// Resolving badge with a 3-stage animation: Queued → Checking → Verified.
// Used by ProvidersScreen rows. Pure visual — the actual network check
// is wired separately. Kept here because IntakeScreen also references it
// for the future MBI-verification microflow.
export function ResolvingStatus({ delay }: { delay: number }) {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const t1 = window.setTimeout(() => setStage(1), delay);
    const t2 = window.setTimeout(() => setStage(2), delay + 800);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [delay]);
  if (stage === 0)
    return (
      <span style={{ ...BADGE_BASE, background: '#f1f5f9', color: '#94a3b8' }}>
        ⏳ Queued
      </span>
    );
  if (stage === 1)
    return (
      <span style={{ ...BADGE_BASE, background: '#fef3c7', color: '#92400e' }}>
        <span className="pma3-pulsedot" /> Checking…
      </span>
    );
  return (
    <span
      style={{
        ...BADGE_BASE,
        background: '#d1fae5',
        color: '#065f46',
        animation: `${FADE_SLIDE_IN} 0.3s ease`,
      }}
    >
      ✓ Verified
    </span>
  );
}
