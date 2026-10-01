import Link from 'next/link';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { digestsFor } from '@/lib/console-analytics';
import { ActionForm, EmptyState, PageHeader, SubmitButton } from '@/ui';
import { DigestFindings } from '@/components/console/analytics/digest';
import { AnalyticsTabs } from '@/components/console/analytics/tabs';
import { ReadError } from '@/components/console/states';
import { buildDigestAction } from '../actions';

export const metadata = { title: 'Digests · Analytics · Restaurant OS' };

type SP = Record<string, string | string[] | undefined>;
const KINDS = [
  { value: 'week', label: 'Weekly' },
  { value: 'day', label: 'Daily' },
  { value: 'month', label: 'Monthly' },
] as const;

/** What moved, in plain words, against a like-for-like baseline. Written by the platform after each period. */
export default async function DigestPage({ searchParams }: { searchParams: Promise<SP> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const raw = Array.isArray(sp.period) ? sp.period[0] : sp.period;
  const kind = KINDS.find((k) => k.value === raw)?.value ?? 'week';
  const tz = c.venue.timezone;
  const venueId = c.venues.length > 1 ? c.venue.id : undefined;
  const digests = await read((ctx) => digestsFor(ctx, c.venue.id, c.venues.length, { period: kind, limit: 8 }));
  const manager = atLeast(c.role, 'manager');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Digests"
        description={`${c.venue.name}. Each digest compares a period with the same weekdays over the weeks before it, and says only what moved beyond normal variation.`}
        actions={
          manager ? (
            <ActionForm action={buildDigestAction} className="flex items-center gap-2">
              <input type="hidden" name="period" value={kind} />
              <input type="hidden" name="scope" value={venueId ? 'venue' : 'org'} />
              <SubmitButton variant="secondary" size="sm" pendingLabel="Writing…">
                Write the latest {kind === 'day' ? 'daily' : kind === 'month' ? 'monthly' : 'weekly'} digest now
              </SubmitButton>
            </ActionForm>
          ) : undefined
        }
      />
      <AnalyticsTabs current="/console/analytics/digest" manager={manager} />
      <nav aria-label="Digest period" className="flex gap-4 text-sm">
        {KINDS.map((k) => (
          <Link key={k.value} href={`?period=${k.value}`} aria-current={k.value === kind ? 'true' : undefined} className={k.value === kind ? 'font-medium text-ink underline' : 'text-accent hover:underline'}>
            {k.label}
          </Link>
        ))}
      </nav>
      {!digests.ok ? (
        <ReadError message={digests.error} />
      ) : digests.data.length === 0 ? (
        <EmptyState title="No digests yet">They are written after each complete period. The first weekly digest appears the Monday after a full week of sales.</EmptyState>
      ) : (
        <div className="space-y-6">
          {digests.data.map((d, i) => (
            <DigestFindings key={d.id} digest={d} timeZone={tz} compact={i > 0} />
          ))}
        </div>
      )}
    </div>
  );
}
