import { notFound } from 'next/navigation';
import { isAppError } from '@ros/core';
import { onboarding, tenancy } from '@ros/modules';
import { app } from '@/lib/runtime';
import { asSupport, openSupportAccesses, platformActor } from '@/lib/ops-platform';
import { ActionForm, Badge, Card, Field, Input, PageHeader, SubmitButton, Table, Td, Th, Textarea, dateTime } from '@/ui';
import { HealthBadge, Stat } from '@/components/platform/status';
import { closeSupportAction, openSupportAction } from '../../support-actions';
import { closeOrgAction } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Tenant · Platform' };

const TZ = 'Australia/Sydney';

/** One org: its health in detail, support access on the record, and closing it. */
export default async function TenantPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const actor = await platformActor();
  let h: onboarding.TenantHealth;
  try {
    h = await onboarding.getTenantHealth(app(), actor, { orgId });
  } catch (e) {
    if (isAppError(e) && e.code === 'not_found') notFound();
    throw e;
  }

  // Inside the tenant only through open support access; supportPrincipal refuses otherwise.
  let inside: { venues: tenancy.VenueView[]; log: onboarding.SupportAccessView[] } | null = null;
  try {
    inside = await asSupport(orgId, async (ctx) => ({ venues: await tenancy.listVenues(ctx), log: await onboarding.listSupportAccess(ctx) }));
  } catch (e) {
    if (!isAppError(e) || e.code !== 'forbidden') throw e;
  }
  const mine = (await openSupportAccesses()).find((s) => s.orgId === orgId);
  const openAccessId = mine?.accessId ?? inside?.log.find((l) => !l.endedAt)?.id ?? null;

  return (
    <>
      <PageHeader title={h.name} description={<>{h.slug} · {h.status} · <HealthBadge healthy={h.healthy} /></>} />

      {h.problems.length ? (
        <div role="alert" className="mb-6 rounded-lg border border-bad bg-bad-soft px-4 py-3 text-sm text-bad" data-testid="problems">
          <ul className="list-disc pl-5">
            {h.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-4">
        <Stat label="Connections healthy" value={`${h.connections.filter((c) => c.status === 'connected').length}/${h.connections.length}`} tone={h.connections.some((c) => c.status === 'unhealthy') ? 'bad' : undefined} />
        <Stat label="Messages waiting" value={String(h.queue.depth)} tone={h.queue.oldestAgeMinutes !== null && h.queue.oldestAgeMinutes >= 15 ? 'bad' : undefined} />
        <Stat label="Dead jobs" value={String(h.deadJobs.count)} tone={h.deadJobs.count ? 'bad' : undefined} />
        <Stat label="Failed provisioning steps" value={String(h.failedProvisioningSteps.length)} tone={h.failedProvisioningSteps.length ? 'bad' : undefined} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Connections" padded={false}>
          <Table>
            <thead>
              <tr>
                <Th>Service</Th>
                <Th>Status</Th>
                <Th>Last good</Th>
              </tr>
            </thead>
            <tbody>
              {h.connections.map((c) => (
                <tr key={c.id} data-testid="connection" data-plug={c.plugKey} data-status={c.status}>
                  <Td>{c.plugKey}</Td>
                  <Td>
                    <Badge tone={c.status === 'connected' ? 'good' : c.status === 'unhealthy' ? 'bad' : 'warn'}>{c.status}</Badge>
                    {c.lastError ? <span className="mt-1 block text-xs text-bad">{c.lastError}</span> : null}
                  </Td>
                  <Td className="text-sm text-ink-2">{dateTime(c.lastOkAt, TZ)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {h.deadJobs.count ? <p className="px-5 py-3 text-sm text-bad">Dead jobs: {h.deadJobs.kinds.join(', ')} (last {dateTime(h.deadJobs.lastAt, TZ)})</p> : null}
        </Card>

        <Card title="Support access" description="To act inside this organisation you open access with a reason. The owner sees it in their audit log.">
          {inside ? (
            <div className="space-y-4">
              <p className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad" data-testid="support-open">
                Support access is open. Everything you do inside is recorded against it.
              </p>
              {openAccessId ? (
                <form action={closeSupportAction}>
                  <input type="hidden" name="accessId" value={openAccessId} />
                  <SubmitButton variant="danger">Close support access</SubmitButton>
                </form>
              ) : null}
              <div>
                <h3 className="text-sm font-semibold">Inside: venues</h3>
                <ul className="mt-1 text-sm">
                  {inside.venues.map((v) => (
                    <li key={v.id}>
                      {v.name} <span className="text-ink-3">({v.status})</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-sm font-semibold">Their record of our access</h3>
                <ul className="mt-1 divide-y divide-line text-sm">
                  {inside.log.map((l) => (
                    <li key={l.id} className="py-1">
                      {dateTime(l.startedAt, TZ)} {l.by}: “{l.reason}” {l.endedAt ? `(closed ${dateTime(l.endedAt, TZ, { date: false })})` : '(open)'}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <ActionForm action={openSupportAction} className="space-y-3">
              <input type="hidden" name="orgId" value={h.orgId} />
              <input type="hidden" name="orgName" value={h.name} />
              <Field label="Reason (the owner reads this)">
                <Textarea name="reason" required minLength={10} maxLength={500} placeholder="e.g. The owner asked us to fix the trading hours on the phone, ticket 1234." />
              </Field>
              <SubmitButton variant="secondary" pendingLabel="Opening…">
                Open support access
              </SubmitButton>
            </ActionForm>
          )}
        </Card>

        {h.status !== 'closed' ? (
          <Card className="border-bad lg:col-span-2" title="Close this organisation" description="Custom domains are detached, connections revoked and marketing identities suspended; the org and its venues are closed. Nothing is deleted.">
            <ActionForm action={closeOrgAction} className="space-y-3">
              <input type="hidden" name="orgId" value={h.orgId} />
              <input type="hidden" name="slug" value={h.slug} />
              <Field label="Reason (goes on their audit log)">
                <Input name="reason" required minLength={5} maxLength={500} />
              </Field>
              <Field label={`Type ${h.slug} to confirm`}>
                <Input name="confirm" required autoComplete="off" />
              </Field>
              <SubmitButton variant="danger" pendingLabel="Closing…">
                Close organisation
              </SubmitButton>
            </ActionForm>
          </Card>
        ) : (
          <Card title="Closed" className="lg:col-span-2">
            <p className="text-sm text-ink-2" data-testid="org-closed">
              This organisation has left the platform. Its custom domains are detached and its connections revoked; its data is kept, hidden, until it is exported and deleted.
            </p>
          </Card>
        )}
      </div>
    </>
  );
}
