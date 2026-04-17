import { useMemo } from 'react';
import { useSession } from '@/hooks/useSession';
import {
  DISCLAIMERS,
  SECTIONS,
  allComplianceItemIds,
  renderDisclaimerBody,
  totalComplianceItems,
} from '@/lib/compliance';
import { plansForClient } from '@/lib/cmsPlans';
import { BROKER } from '@/lib/constants';
import { ComplianceItem } from './ComplianceItem';
import { DisclaimerCard } from './DisclaimerCard';

export function ComplianceChecklist() {
  const client = useSession((s) => s.client);
  const complianceChecked = useSession((s) => s.complianceChecked);
  const disclaimersConfirmed = useSession((s) => s.disclaimersConfirmed);
  const toggleComplianceItem = useSession((s) => s.toggleComplianceItem);
  const confirmDisclaimer = useSession((s) => s.confirmDisclaimer);

  const eligiblePlans = useMemo(
    () => plansForClient({ state: client.state, planType: client.planType, county: client.county }),
    [client.state, client.planType, client.county],
  );

  const orgCount = useMemo(
    () => new Set(eligiblePlans.map((p) => p.carrier)).size,
    [eligiblePlans],
  );
  const planCount = eligiblePlans.length;

  const allItemIds = useMemo(allComplianceItemIds, []);
  const checkedCount = allItemIds.filter((id) => complianceChecked.includes(id)).length;
  const disclaimerCount = DISCLAIMERS.filter((d) => disclaimersConfirmed.includes(d.id)).length;

  const total = totalComplianceItems();
  const done = checkedCount + disclaimerCount;
  const percent = Math.round((done / total) * 100);
  const ready = done === total;

  return (
    <div className="pm-surface" style={{ padding: 16 }}>
      <Header done={done} total={total} percent={percent} ready={ready} />

      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <SectionHeader title="Required disclaimers" subtitle="Verbatim — no paraphrase." />
        {DISCLAIMERS.map((def) => (
          <DisclaimerCard
            key={def.id}
            def={def}
            renderedBody={renderDisclaimerBody(def, {
              orgCount,
              planCount,
              planType: client.planType,
            })}
            confirmed={disclaimersConfirmed.includes(def.id)}
            onConfirm={() => confirmDisclaimer(def.id)}
          />
        ))}
      </div>

      <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {SECTIONS.map((section) => {
          const sectionIds = section.items.map((i) => i.id);
          const sectionDone = sectionIds.filter((id) => complianceChecked.includes(id)).length;
          return (
            <div key={section.key}>
              <SectionHeader
                title={section.title}
                subtitle={`${sectionDone}/${section.items.length} checked`}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                {section.items.map((item) => (
                  <ComplianceItem
                    key={item.id}
                    def={item}
                    checked={complianceChecked.includes(item.id)}
                    onToggle={() => toggleComplianceItem(item.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <EnrollGate ready={ready} done={done} total={total} />
    </div>
  );
}

function Header({
  done,
  total,
  percent,
  ready,
}: {
  done: number;
  total: number;
  percent: number;
  ready: boolean;
}) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div
            className="uppercase font-semibold"
            style={{ color: 'var(--i3)', fontSize: 10, letterSpacing: '0.08em' }}
          >
            CMS compliance checklist
          </div>
          <h2 className="font-lora" style={{ fontSize: 18, marginTop: 2 }}>
            Finish this before enrolling
          </h2>
          <p style={{ fontSize: 12, color: 'var(--i2)', marginTop: 4 }}>
            16 items · 3 verbatim disclaimers + 13 discussion topics across 6 sections. Every item
            must be confirmed before the Enroll Now gate opens.
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div
            style={{
              fontFamily: 'Lora, serif',
              fontSize: 26,
              fontWeight: 700,
              color: ready ? 'var(--sage)' : 'var(--ink)',
            }}
          >
            {done}
            <span style={{ fontSize: 14, color: 'var(--i3)', fontWeight: 400 }}>/{total}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--i3)' }}>{percent}% complete</div>
        </div>
      </div>

      <div
        style={{
          marginTop: 10,
          height: 6,
          borderRadius: 999,
          background: 'var(--w2)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${percent}%`,
            height: '100%',
            background: ready ? 'var(--sage)' : 'var(--amb)',
            transition: 'width 180ms ease, background 180ms ease',
          }}
        />
      </div>
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <div
        className="uppercase font-semibold"
        style={{ color: 'var(--i2)', fontSize: 11, letterSpacing: '0.08em' }}
      >
        {title}
      </div>
      <span style={{ fontSize: 11, color: 'var(--i3)' }}>{subtitle}</span>
    </div>
  );
}

function EnrollGate({ ready, done, total }: { ready: boolean; done: number; total: number }) {
  const remaining = total - done;
  return (
    <div
      style={{
        marginTop: 18,
        padding: 14,
        borderRadius: 10,
        border: `1px solid ${ready ? 'var(--enroll)' : 'var(--amb)'}`,
        background: ready ? '#E9F5EE' : 'var(--at)',
      }}
    >
      <div className="flex items-center justify-between gap-3" style={{ flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div
            className="uppercase font-semibold"
            style={{
              color: ready ? 'var(--enroll)' : 'var(--amb)',
              fontSize: 10,
              letterSpacing: '0.08em',
            }}
          >
            SunFire Matrix enrollment gate
          </div>
          <div className="font-lora" style={{ fontSize: 15, marginTop: 4 }}>
            {ready
              ? 'All 16 items confirmed — Enroll Now is unlocked.'
              : `${remaining} item${remaining === 1 ? '' : 's'} left before Enroll Now unlocks.`}
          </div>
          <div style={{ fontSize: 12, color: 'var(--i2)', marginTop: 4 }}>
            {BROKER.name} · {BROKER.license} · NPN {BROKER.npn}
          </div>
        </div>

        <a
          href={ready ? BROKER.sunfire : undefined}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            if (!ready) e.preventDefault();
          }}
          aria-disabled={!ready}
          style={{
            padding: '12px 20px',
            borderRadius: 10,
            background: ready ? 'var(--enroll)' : 'var(--w2)',
            color: ready ? '#fff' : 'var(--i3)',
            fontSize: 14,
            fontWeight: 700,
            textDecoration: 'none',
            cursor: ready ? 'pointer' : 'not-allowed',
            border: `1px solid ${ready ? 'var(--enroll)' : 'var(--w2)'}`,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          Open SunFire Matrix →
        </a>
      </div>
    </div>
  );
}
