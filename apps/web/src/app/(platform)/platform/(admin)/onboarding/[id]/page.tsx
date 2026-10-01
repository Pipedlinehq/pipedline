import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@ros/core';
import { onboarding } from '@ros/modules';
import { app } from '@/lib/runtime';
import { platformActor } from '@/lib/ops-platform';
import { ActionForm, Card, Field, Input, LinkButton, PageHeader, SubmitButton, Table, Td, Th, dateTime } from '@/ui';
import { AutoRefresh } from '@/components/platform/auto-refresh';
import { CheckBadge, OnboardingBadge, StepBadge, hours } from '@/components/platform/status';
import { goLiveAction, manualTouchAction, retryStepAction, startProvisioningAction } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Onboarding · Platform' };

const TZ = 'Australia/Sydney';

interface DnsRecord {
  type: string;
  name: string;
  value: string;
  priority?: number;
}

export default async function OnboardingDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ checks?: string }> }) {
  const { id } = await params;
  const { checks } = await searchParams;
  const actor = await platformActor();
  let detail: onboarding.OnboardingDetail;
  let intake: onboarding.IntakeView;
  try {
    [detail, intake] = await Promise.all([onboarding.getOnboarding(app(), actor, { onboardingId: id }), onboarding.getIntake(app(), actor, { onboardingId: id })]);
  } catch (e) {
    if (isAppError(e) && e.code === 'not_found') notFound();
    throw e;
  }
  const checklist = checks === '1' && detail.orgId ? await onboarding.runGoLiveChecks(app(), actor, { onboardingId: id }) : null;
  const running = detail.steps.some((s) => s.status === 'running' || s.status === 'pending') && detail.status === 'provisioning';
  const canProvision = intake.complete && detail.status !== 'live';

  return (
    <>
      <PageHeader
        title={detail.name}
        description={
          <>
            <OnboardingBadge status={detail.status} /> Sold {dateTime(detail.soldAt, TZ)}
            {detail.liveAt ? ` · live ${dateTime(detail.liveAt, TZ)} (${hours(detail.timeToLiveHours)} from sold)` : ` · ${hours(detail.hoursInFlight)} in flight`} · {detail.manualTouchMinutes} hands-on minutes
          </>
        }
        actions={detail.orgId ? <LinkButton href={`/platform/tenants/${detail.orgId}`}>Tenant health</LinkButton> : null}
      />
      <AutoRefresh active={running} />

      {detail.blockedOn.length ? (
        <div className="mb-6 rounded-lg border border-warn bg-warn-soft px-4 py-3 text-sm text-warn" data-testid="blocked-on">
          <p className="font-semibold">Waiting on</p>
          <ul className="mt-1 list-disc pl-5">
            {detail.blockedOn.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Intake" description={`${intake.percentComplete}% of the required sections complete. Resumable: save a section half-done and come back.`}>
          <ul className="divide-y divide-line">
            {intake.sections.map((s) => (
              <li key={s.key} className="flex items-start justify-between gap-3 py-2" data-testid={`section-${s.key}`}>
                <div className="min-w-0">
                  <Link href={`/platform/onboarding/${id}/intake/${s.key}`} className="font-medium text-accent underline-offset-2 hover:underline">
                    {s.label}
                  </Link>
                  {s.required ? <span className="ml-2 text-xs text-ink-3">required</span> : null}
                  {s.missing.length ? <p className="mt-0.5 break-words text-xs text-ink-2">Missing: {s.missing.join(', ')}</p> : null}
                </div>
                <span className="shrink-0">
                  <StepBadge status={s.status === 'complete' ? 'done' : s.status === 'in_progress' ? 'blocked' : 'pending'} />
                </span>
              </li>
            ))}
          </ul>
          <ActionForm action={startProvisioningAction} className="mt-4">
            <input type="hidden" name="onboardingId" value={id} />
            {canProvision ? (
              <SubmitButton pendingLabel="Starting…">{detail.steps.length ? 'Run provisioning again' : 'Start provisioning'}</SubmitButton>
            ) : (
              <p className="text-sm text-ink-2">{detail.status === 'live' ? 'This organisation is live.' : 'Provisioning can start once every required section is complete.'}</p>
            )}
          </ActionForm>
        </Card>

        <Card title="Provisioning" description="Every step is idempotent and retried on its own. A blocked step is waiting on the venue, not failing.">
          {detail.steps.length === 0 ? (
            <p className="text-sm text-ink-2">Not started.</p>
          ) : (
            <ol className="divide-y divide-line">
              {detail.steps.map((s) => {
                const records = (Array.isArray(s.result?.records) ? s.result.records : []) as DnsRecord[];
                return (
                  <li key={s.key} className="py-3" data-testid={`step-${s.key}`} data-status={s.status}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">{s.label}</p>
                        <p className="text-xs text-ink-3">
                          {s.attempts} attempt{s.attempts === 1 ? '' : 's'}
                          {s.finishedAt ? ` · finished ${dateTime(s.finishedAt, TZ, { date: false })}` : ''}
                        </p>
                        {s.blockedOn ? <p className="mt-1 text-sm text-warn">{s.blockedOn}</p> : null}
                        {s.error ? <p className="mt-1 text-sm text-bad">{s.error}</p> : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <StepBadge status={s.status} />
                        {s.status === 'failed' || s.status === 'blocked' ? (
                          <ActionForm action={retryStepAction}>
                            <input type="hidden" name="onboardingId" value={id} />
                            <input type="hidden" name="step" value={s.key} />
                            <SubmitButton size="sm" variant="secondary" pendingLabel="…">
                              {s.status === 'blocked' ? 'Check again' : 'Retry'}
                            </SubmitButton>
                          </ActionForm>
                        ) : null}
                      </div>
                    </div>
                    {s.status === 'blocked' && records.length ? (
                      <Table className="mt-2 rounded border border-line">
                        <thead>
                          <tr>
                            <Th>Type</Th>
                            <Th>Name</Th>
                            <Th>Value</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {records.map((r, i) => (
                            <tr key={i}>
                              <Td className="font-mono text-xs">{r.type}</Td>
                              <Td className="break-all font-mono text-xs">{r.name}</Td>
                              <Td className="break-all font-mono text-xs">{r.value}</Td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </Card>

        <Card title="Go-live checks" description="Gated, not advisory: the organisation cannot go live while any check fails.">
          {!detail.orgId ? (
            <p className="text-sm text-ink-2">The organisation does not exist yet. Provisioning creates it.</p>
          ) : checklist ? (
            <>
              <ul className="divide-y divide-line" data-testid="checklist">
                {checklist.items.map((i) => (
                  <li key={i.key} className="flex items-start justify-between gap-3 py-2" data-check={i.key} data-status={i.status}>
                    <div>
                      <p className="font-medium">{i.label}</p>
                      <p className="text-sm text-ink-2">{i.reason}</p>
                    </div>
                    <CheckBadge status={i.status} />
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <LinkButton href={`/platform/onboarding/${id}?checks=1`} variant="secondary">
                  Run the checks again
                </LinkButton>
                {detail.status !== 'live' ? (
                  <ActionForm action={goLiveAction}>
                    <input type="hidden" name="onboardingId" value={id} />
                    <SubmitButton pendingLabel="Going live…">Go live</SubmitButton>
                  </ActionForm>
                ) : null}
              </div>
              {!checklist.ready && detail.status !== 'live' ? <p className="mt-2 text-sm text-bad">Not ready: going live will be refused until every failing check passes.</p> : null}
            </>
          ) : (
            <LinkButton href={`/platform/onboarding/${id}?checks=1`}>Run go-live checks</LinkButton>
          )}
        </Card>

        <Card title="Hands-on time" description="Every manual minute is recorded; the trend is what tells us which step to automate next.">
          <ActionForm action={manualTouchAction} resetOnSuccess className="grid items-end gap-3 sm:grid-cols-[6rem_1fr_auto]">
            <input type="hidden" name="onboardingId" value={id} />
            <Field label="Minutes">
              <Input name="minutes" type="number" min={1} max={480} required />
            </Field>
            <Field label="What it went on">
              <Input name="note" required maxLength={500} />
            </Field>
            <SubmitButton pendingLabel="Saving…">Record</SubmitButton>
          </ActionForm>
          {detail.touches.length ? (
            <ul className="mt-4 divide-y divide-line text-sm">
              {detail.touches.map((t, i) => (
                <li key={i} className="flex justify-between gap-3 py-2">
                  <span>{t.note}</span>
                  <span className="shrink-0 tabular-nums text-ink-2">
                    {t.minutes} min · {dateTime(t.recordedAt, TZ)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      </div>
    </>
  );
}
