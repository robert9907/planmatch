import { useSession } from '@/hooks/useSession';
import { StepHeader } from './StepHeader';
import type { PlanType, StateCode } from '@/types/session';

interface Step2Props {
  onAdvance: () => void;
}

// ZIP prefix → {county, state} lookup for Rob's three states. Small cheat table
// for demo — Phase 2 will swap this for a proper ZIP lookup (ZCTAs → county).
const ZIP_MAP: Record<string, { county: string; state: StateCode }> = {
  '277': { county: 'Durham', state: 'NC' },
  '275': { county: 'Wake', state: 'NC' },
  '282': { county: 'Mecklenburg', state: 'NC' },
  '274': { county: 'Guilford', state: 'NC' },
  '270': { county: 'Forsyth', state: 'NC' },
  '287': { county: 'Buncombe', state: 'NC' },
  '770': { county: 'Harris', state: 'TX' },
  '787': { county: 'Travis', state: 'TX' },
  '782': { county: 'Bexar', state: 'TX' },
  '752': { county: 'Dallas', state: 'TX' },
  '303': { county: 'Fulton', state: 'GA' },
  '300': { county: 'DeKalb', state: 'GA' },
  '314': { county: 'Chatham', state: 'GA' },
};

const PLAN_TYPES: { value: PlanType; label: string; body: string }[] = [
  { value: 'DSNP', label: 'D-SNP', body: 'Dual eligible (Medicare + Medicaid)' },
  { value: 'MAPD', label: 'MAPD', body: 'Medicare Advantage with Part D' },
  { value: 'MA', label: 'MA', body: 'Medicare Advantage, no drug coverage' },
  { value: 'PDP', label: 'PDP', body: 'Standalone Part D' },
  { value: 'MEDSUPP', label: 'Medigap', body: 'Supplement on top of Original Medicare' },
];

export function Step2Intake({ onAdvance }: Step2Props) {
  const client = useSession((s) => s.client);
  const updateClient = useSession((s) => s.updateClient);

  function patch<K extends keyof typeof client>(key: K, value: (typeof client)[K]) {
    updateClient({ [key]: value });
  }

  function onZipChange(raw: string) {
    const zip = raw.replace(/\D/g, '').slice(0, 5);
    const patchObj: Partial<typeof client> = { zip };
    if (zip.length >= 3) {
      const hit = ZIP_MAP[zip.slice(0, 3)];
      if (hit && !client.county) patchObj.county = hit.county;
      if (hit && !client.state) patchObj.state = hit.state;
    }
    updateClient(patchObj);
  }

  function onPhoneChange(raw: string) {
    const digits = raw.replace(/\D/g, '').slice(0, 10);
    let formatted = digits;
    if (digits.length >= 4 && digits.length < 7) {
      formatted = `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    } else if (digits.length >= 7) {
      formatted = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    patch('phone', formatted);
  }

  const requiredReady =
    !!client.name && !!client.phone && !!client.zip && !!client.state && !!client.planType;

  const age = ageFromDob(client.dob);

  return (
    <div className="flex flex-col gap-4">
      <StepHeader
        number={2}
        title="Client intake"
        subtitle="Everything here drives eligibility — state narrows the plan set, plan type narrows it again, Medicaid confirms D-SNP eligibility."
      />

      <div className="pm-surface" style={{ padding: 16 }}>
        <FieldRow label="Full name" required>
          <input
            type="text"
            value={client.name}
            onChange={(e) => patch('name', e.target.value)}
            placeholder="Dorothy Hayes"
            style={inputStyle}
          />
        </FieldRow>

        <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <FieldRow label="Phone" required>
            <input
              type="tel"
              value={client.phone}
              onChange={(e) => onPhoneChange(e.target.value)}
              placeholder="(828) 555-1212"
              style={inputStyle}
            />
          </FieldRow>

          <FieldRow
            label="Date of birth"
            hint={age !== null ? `${age} years old` : undefined}
          >
            <input
              type="date"
              value={client.dob}
              onChange={(e) => patch('dob', e.target.value)}
              style={inputStyle}
            />
          </FieldRow>
        </div>

        <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          <FieldRow label="ZIP" required>
            <input
              type="text"
              inputMode="numeric"
              value={client.zip}
              onChange={(e) => onZipChange(e.target.value)}
              placeholder="27713"
              style={inputStyle}
            />
          </FieldRow>

          <FieldRow label="County">
            <input
              type="text"
              value={client.county}
              onChange={(e) => patch('county', e.target.value)}
              placeholder="Durham"
              style={inputStyle}
            />
          </FieldRow>

          <FieldRow label="State" required>
            <div className="flex gap-1">
              {(['NC', 'TX', 'GA'] as StateCode[]).map((s) => {
                const active = client.state === s;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => patch('state', s)}
                    className="pm-btn"
                    style={{
                      flex: 1,
                      height: 36,
                      background: active ? 'var(--sage)' : 'var(--wh)',
                      color: active ? '#fff' : 'var(--ink)',
                      borderColor: active ? 'var(--sage)' : 'var(--w2)',
                    }}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </FieldRow>
        </div>

        <div style={{ marginTop: 14 }}>
          <FieldLabel label="Plan type" required />
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginTop: 6 }}>
            {PLAN_TYPES.map((pt) => {
              const active = client.planType === pt.value;
              return (
                <button
                  key={pt.value}
                  type="button"
                  onClick={() => patch('planType', pt.value)}
                  className="text-left"
                  style={{
                    padding: '10px 12px',
                    borderRadius: 10,
                    border: `1px solid ${active ? 'var(--sage)' : 'var(--w2)'}`,
                    background: active ? 'var(--sl)' : 'var(--wh)',
                    cursor: 'pointer',
                    color: 'var(--ink)',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, color: active ? 'var(--sage)' : 'var(--ink)' }}>
                    {pt.label}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--i2)', marginTop: 2, lineHeight: 1.3 }}>
                    {pt.body}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginTop: 16,
            padding: 12,
            borderRadius: 10,
            border: `1px solid ${client.medicaidConfirmed ? 'var(--sage)' : 'var(--w2)'}`,
            background: client.medicaidConfirmed ? 'var(--sl)' : 'var(--wh)',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={client.medicaidConfirmed}
            onChange={(e) => patch('medicaidConfirmed', e.target.checked)}
            style={{ width: 18, height: 18, accentColor: 'var(--sage)' }}
          />
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Medicaid eligibility confirmed</div>
            <div style={{ fontSize: 11, color: 'var(--i2)' }}>
              Required for D-SNP enrollment. Verify the Medicaid card is current.
            </div>
          </div>
        </label>
      </div>

      <div className="flex items-center justify-between">
        <div style={{ color: 'var(--i3)', fontSize: 12 }}>
          {requiredReady ? '✓ Intake complete' : '* Required: name, phone, ZIP, state, plan type'}
        </div>
        <button
          type="button"
          onClick={onAdvance}
          disabled={!requiredReady}
          className="pm-btn pm-btn-primary"
          style={{ opacity: requiredReady ? 1 : 0.5 }}
        >
          Continue to medications →
        </button>
      </div>
    </div>
  );
}

function ageFromDob(dob: string): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

function FieldRow({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
        <FieldLabel label={label} required={required} />
        {hint && <span style={{ color: 'var(--i3)', fontSize: 11 }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function FieldLabel({ label, required }: { label: string; required?: boolean }) {
  return (
    <label
      className="uppercase font-semibold"
      style={{ color: 'var(--i3)', fontSize: 10, letterSpacing: '0.08em' }}
    >
      {label}
      {required && <span style={{ color: 'var(--red)', marginLeft: 3 }}>*</span>}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 36,
  padding: '0 10px',
  borderRadius: 8,
  border: '1px solid var(--w2)',
  background: 'var(--warm)',
  color: 'var(--ink)',
  fontSize: 14,
  outline: 'none',
  fontFamily: 'inherit',
};
