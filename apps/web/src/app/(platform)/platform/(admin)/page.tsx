import Link from 'next/link';
import { onboarding } from '@ros/modules';
import { app } from '@/lib/runtime';
import { platformActor } from '@/lib/ops-platform';
import { Card, PageHeader } from '@/ui';
import { OnboardingBadge, Stat, hours } from '@/components/platform/status';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Platform · Pipedline' };

/** The two numbers that decide whether the business works, what is in flight, and what is broken. */
export default async function PlatformHome() {
  const actor = await platformActor();
  const [metrics, board, health] = await Promise.all([onboarding.onboardingMetrics(app(), actor), onboarding.listOnboardings(app(), actor), onboarding.listTenantHealth(app(), actor)]);
  const unhealthy = health.filter((h) => !h.healthy);
  return (
    <>
      <PageHeader title="Platform" description="Onboarding and tenant health across every organisation." />
      <div className="mb-6 grid gap-4 sm:grid-cols-4">
        <Stat label="Median time to live" value={hours(metrics.medianTimeToLiveHours)} />
        <Stat label="Mean hands-on minutes" value={metrics.meanManualTouchMinutes === null ? '–' : `${metrics.meanManualTouchMinutes} min`} />
        <Stat label="Onboardings in flight" value={String(metrics.inFlight)} />
        <Stat label="Tenants needing attention" value={`${unhealthy.length} of ${health.length}`} tone={unhealthy.length ? 'bad' : 'good'} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="In flight" actions={<Link className="text-sm text-accent underline" href="/platform/onboarding">Status board</Link>}>
          {board.length === 0 ? (
            <p className="text-sm text-ink-2">Nothing in flight.</p>
          ) : (
            <ul className="divide-y divide-line">
              {board.map((o) => (
                <li key={o.onboardingId} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <Link href={`/platform/onboarding/${o.onboardingId}`} className="font-medium text-accent underline-offset-2 hover:underline">
                      {o.name}
                    </Link>
                    {o.blockedOn.length ? <p className="truncate text-xs text-ink-2">{o.blockedOn[0]}</p> : null}
                  </div>
                  <OnboardingBadge status={o.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Needs attention" actions={<Link className="text-sm text-accent underline" href="/platform/tenants">All tenants</Link>}>
          {unhealthy.length === 0 ? (
            <p className="text-sm text-good">Every tenant is healthy.</p>
          ) : (
            <ul className="divide-y divide-line">
              {unhealthy.map((h) => (
                <li key={h.orgId} className="py-2">
                  <Link href={`/platform/tenants/${h.orgId}`} className="font-medium text-accent underline-offset-2 hover:underline">
                    {h.name}
                  </Link>
                  <p className="text-xs text-bad">{h.problems.join(' ')}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
