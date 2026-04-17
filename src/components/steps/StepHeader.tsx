interface StepHeaderProps {
  number: number;
  title: string;
  subtitle: string;
  right?: React.ReactNode;
}

export function StepHeader({ number, title, subtitle, right }: StepHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <div
          className="uppercase font-semibold"
          style={{ color: 'var(--i3)', fontSize: 10, letterSpacing: '0.08em' }}
        >
          Step {number}
        </div>
        <h1 className="font-lora" style={{ fontSize: 22, marginTop: 2 }}>
          {title}
        </h1>
        <p style={{ color: 'var(--i2)', fontSize: 13, marginTop: 4 }}>{subtitle}</p>
      </div>
      {right && <div style={{ flexShrink: 0 }}>{right}</div>}
    </div>
  );
}
