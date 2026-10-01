import Link from 'next/link';
import { onboarding } from '@ros/modules';
import { app } from '@/lib/runtime';
import { platformActor } from '@/lib/ops-platform';
import { ActionForm, Card, EmptyState, Field, Input, PageHeader, SubmitButton, Table, Td, Th } from '@/ui';
import { OnboardingBadge, Stat, StepBadge, hours } from '@/components/platform/status';
import { startOnboardingAction } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Onboarding · Platform' };

/** The status board: every in-flight onboarding, each step's state and what it is blocked on (docs/ONBOARDING.md section 3). */
export default async function OnboardingBoardPage({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const { all } = await searchParams;
  const actor = await platformActor();
  const [board, metrics] = await Promise.all([onboarding.listOnboardings(app(), actor, { includeFinished: all === '1' }), onboarding.onboardingMetrics(app(), actor)]);
  return (
    <>
      <PageHeader
        title="Onboarding"
        description="Sold to live. Live on the subdomain first, always; a custom domain lands whenever its DNS does."
        actions={
          <Link className="text-sm text-accent underline" href={all === '1' ? '/platform/onboarding' : '/platform/onboarding?all=1'}>
            {all === '1' ? 'In flight only' : 'Include finished'}
          </Link>
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-4">
        <Stat label="In flight" value={String(metrics.inFlight)} />
        <Stat label="Live" value={String(metrics.live)} />
        <Stat label="Median time to live" value={hours(metrics.medianTimeToLiveHours)} />
        <Stat label="Mean hands-on minutes" value={metrics.meanManualTouchMinutes === null ? '–' : `${metrics.meanManualTouchMinutes} min`} />
      </div>

      <Card title="Start an onboarding" description="At the moment of sale. The organisation is created later, by provisioning, from the finished intake." className="mb-6">
        <ActionForm action={startOnboardingAction} className="grid items-end gap-3 sm:grid-cols-[2fr_2fr_1fr_auto]">
          <Field label="Trading name">
            <Input name="tradingName" required />
          </Field>
          <Field label="Contact email">
            <Input name="contactEmail" type="email" />
          </Field>
          <Field label="Contact first name">
            <Input name="contactFirstName" />
          </Field>
          <SubmitButton pendingLabel="Starting…">Start</SubmitButton>
        </ActionForm>
      </Card>

      {board.length === 0 ? (
        <EmptyState title="Nothing in flight">Start an onboarding above when a venue is sold.</EmptyState>
      ) : (
        <Card padded={false}>
          <Table>
            <thead>
              <tr>
                <Th>Venue</Th>
                <Th>Status</Th>
                <Th>Intake</Th>
                <Th>Steps</Th>
                <Th>Blocked on</Th>
                <Th align="right">In flight</Th>
              </tr>
            </thead>
            <tbody>
              {board.map((o) => (
                <tr key={o.onboardingId} data-testid="onboarding-row">
                  <Td>
                    <Link className="font-medium text-accent underline-offset-2 hover:underline" href={`/platform/onboarding/${o.onboardingId}`}>
                      {o.name}
                    </Link>
                    <span className="block text-xs text-ink-3">{o.manualTouchMinutes} hands-on min</span>
                  </Td>
                  <Td>
                    <OnboardingBadge status={o.status} />
                  </Td>
                  <Td numeric>{o.intake.percentComplete}%</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {o.steps.length ? o.steps.map((s) => (
                        <span key={s.key} title={s.label} className="inline-flex items-center gap-1 text-xs">
                          <StepBadge status={s.status} />
                          <span className="text-ink-3">{s.key.replace(/_/g, ' ')}</span>
                        </span>
                      )) : <span className="text-xs text-ink-3">Not started</span>}
                    </div>
                  </Td>
                  <Td className="max-w-xs text-sm text-ink-2">{o.blockedOn.length ? o.blockedOn.join(' · ') : '—'}</Td>
                  <Td numeric>{o.liveAt ? `live after ${hours(o.timeToLiveHours)}` : hours(o.hoursInFlight)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}

