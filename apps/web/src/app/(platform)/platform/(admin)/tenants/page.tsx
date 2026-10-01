import Link from 'next/link';
import { onboarding } from '@ros/modules';
import { app } from '@/lib/runtime';
import { platformActor } from '@/lib/ops-platform';
import { Card, EmptyState, PageHeader, Table, Td, Th } from '@/ui';
import { HealthBadge } from '@/components/platform/status';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Tenants · Platform' };

/** Every org's health: connections, the message queue, dead jobs, failed provisioning steps (docs/DEPLOYMENT.md section 10). */
export default async function TenantsPage({ searchParams }: { searchParams: Promise<{ closed?: string; unhealthy?: string }> }) {
  const q = await searchParams;
  const health = await onboarding.listTenantHealth(app(), await platformActor(), { includeClosed: q.closed === '1', onlyUnhealthy: q.unhealthy === '1' });
  const link = (k: 'closed' | 'unhealthy', label: string) => {
    const on = q[k] === '1';
    const next = new URLSearchParams({ ...(q.closed ? { closed: q.closed } : {}), ...(q.unhealthy ? { unhealthy: q.unhealthy } : {}) });
    if (on) next.delete(k);
    else next.set(k, '1');
    return (
      <Link className="text-sm text-accent underline" href={`/platform/tenants${next.size ? `?${next}` : ''}`}>
        {on ? `Hide ${label}` : `Show ${label}`}
      </Link>
    );
  };
  return (
    <>
      <PageHeader title="Tenants" description="Is anything wrong at any venue? Each row says so in words." actions={<>{link('unhealthy', 'only unhealthy')}{link('closed', 'closed')}</>} />
      {health.length === 0 ? (
        <EmptyState title="Nothing to show">No organisation matches.</EmptyState>
      ) : (
        <Card padded={false}>
          <Table>
            <thead>
              <tr>
                <Th>Organisation</Th>
                <Th>Health</Th>
                <Th align="right">Connections</Th>
                <Th align="right">Queue</Th>
                <Th align="right">Dead jobs</Th>
                <Th align="right">Failed steps</Th>
                <Th>Problems</Th>
              </tr>
            </thead>
            <tbody>
              {health.map((h) => (
                <tr key={h.orgId} data-testid="tenant-row" data-org={h.slug}>
                  <Td>
                    <Link href={`/platform/tenants/${h.orgId}`} className="font-medium text-accent underline-offset-2 hover:underline">
                      {h.name}
                    </Link>
                    <span className="block text-xs text-ink-3">
                      {h.slug} · {h.status}
                    </span>
                  </Td>
                  <Td>
                    <HealthBadge healthy={h.healthy} />
                  </Td>
                  <Td numeric>
                    {h.connections.filter((c) => c.status === 'connected').length}/{h.connections.length}
                  </Td>
                  <Td numeric>{h.queue.depth}</Td>
                  <Td numeric>{h.deadJobs.count}</Td>
                  <Td numeric>{h.failedProvisioningSteps.length}</Td>
                  <Td className="max-w-sm text-sm text-ink-2">{h.problems.length ? h.problems.join(' ') : '—'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
