import Link from 'next/link';
import { GUEST_FACING_ROLES, localDate } from '@ros/core';
import { analytics, approvals, bookings, hub, onboarding, ordering } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { app } from '@/lib/runtime';
import { moduleStates } from '@/lib/console-modules';
import { digestsFor, show } from '@/lib/console-analytics';
import { read } from '@/lib/console-read';
import { Badge, Card, EmptyState, LinkButton, PageHeader, StatTile, dateTime } from '@/ui';
import { DecideButtons, REQUESTER } from '@/components/console/approval-bits';
import { ReadError } from '@/components/console/states';
import { decideFromHome } from './home-actions';

export const metadata = { title: 'Home · Pipedline' };

/**
 * Home (docs/CONSOLE_IA.md section 2): today's service at a glance, what is waiting for the
 * person's yes, the week against last week, setup progress while the venue is not live, and
 * what the assistant did this week. Each block reads through the function that owns the fact
 * and shows nothing the person's role could not open on the fuller screen behind it.
 */
export default async function ConsoleHome() {
  const c = await getConsole();
  const manager = atLeast(c.role, 'manager');
  const guestFacing = manager || GUEST_FACING_ROLES.includes(c.role);
  const on = await moduleStates();
  const tz = c.venue.timezone;
  const venueId = c.venue.id;

  const [sales, book, bookNumbers, live, flagged, ops, waiting, week, digests, setup, calls, runs] = await Promise.all([
    read((ctx) => analytics.salesSummary(ctx, { venueId })),
    on.bookings && guestFacing ? read((ctx) => bookings.listBookings(ctx, { venueId })) : null,
    on.bookings && !guestFacing
      ? read((ctx) => {
          const today = localDate(ctx.now(), tz);
          return bookings.bookingSummary(ctx, { venueId, from: today, to: today });
        })
      : null,
    on.ordering ? read((ctx) => ordering.listOrders(ctx, { venueId, live: true, limit: 200 })) : null,
    on.ordering ? read((ctx) => ordering.listOrders(ctx, { venueId, needsAttention: true, limit: 100 })) : null,
    manager && on.hub ? read((ctx) => hub.opsStatus(ctx, { venueId })) : null,
    manager ? read((ctx) => approvals.listApprovals(ctx, { status: 'pending' })) : null,
    read((ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales', 'orders', 'avg_order_value'], period: 'this_week', compareTo: 'previous_period', filters: { venue: venueId } })),
    read((ctx) => digestsFor(ctx, venueId, c.venues.length, { period: 'week', limit: 1 })),
    c.isOwner ? read((ctx) => onboarding.getSetupStatus(ctx, venueId)) : null,
    manager && on.hub ? read((ctx) => hub.listAgentCalls(ctx, { limit: 200 })) : null,
    manager && on.hub ? read((ctx) => hub.listAgentRuns(ctx, { venueId, limit: 100 })) : null,
  ]);

  const today = sales.ok ? sales.data.windows.find((w) => w.window === 'today_so_far') : undefined;
  const covers = book?.ok ? book.data.totals.covers : bookNumbers?.ok ? bookNumbers.data.covers : null;
  const requests = book?.ok ? book.data.totals.requests : null;
  const liveOrders = live?.ok ? live.data.length : null;
  const attention = [
    ...(flagged?.ok && flagged.data.length ? [`${flagged.data.length} ${flagged.data.length === 1 ? 'order needs' : 'orders need'} a look.`] : []),
    ...(ops?.ok ? ops.data.findings : []),
  ];
  const pending = waiting?.ok ? waiting.data : [];
  const venueName = (id: string | null) => (id ? (c.venues.find((v) => v.id === id)?.name ?? 'Another venue') : 'Whole organisation');

  // Shown only while the organisation is not live; once it is, there is nothing left to set up.
  const setupShown = setup?.ok && !setup.data.complete ? setup.data : null;
  // The app's clock, as every service reads it (tests and fixtures move it).
  const now = app().clock();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
  const weekCalls = calls?.ok ? calls.data.filter((a) => a.occurredAt >= sevenDaysAgo) : [];
  const weekChanges = weekCalls.filter((a) => a.effect === 'write' && a.outcome === 'confirmed').length;
  const weekRuns = runs?.ok ? runs.data.filter((r) => r.startedAt >= sevenDaysAgo) : [];

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={dateTime(now, tz, { date: true, time: false })}
        title={c.venue.name}
        description="Today's service, what is waiting for your yes, and the week so far. Your assistant does the work; this is where you see it."
        actions={on.bookings && guestFacing ? <LinkButton href="/console/bookings">Today's bookings</LinkButton> : undefined}
      />

      {/* Today's service */}
      <section aria-labelledby="today-heading" data-testid="home-today">
        <h2 id="today-heading" className="mb-3 text-lg font-semibold text-ink">
          Today's service
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {covers !== null ? (
            <StatTile label="Covers booked today" value={String(covers)} hint={requests ? `${requests} ${requests === 1 ? 'request waits' : 'requests wait'} for a yes` : book?.ok && book.data.services.length ? book.data.services.map((s) => `${s.name} ${s.covers}/${s.maxCovers}`).join(' · ') : undefined} />
          ) : null}
          {liveOrders !== null ? <StatTile label="Orders in progress" value={String(liveOrders)} hint={flagged?.ok && flagged.data.length ? `${flagged.data.length} need a look` : 'Paid, in the kitchen\'s hands'} /> : null}
          {today ? (
            <StatTile
              label="Sales so far today"
              value={show(today.net_sales_cents, 'cents', sales.ok ? sales.data.currency : 'AUD')}
              delta={today.change_pct}
              comparedTo={today.usual_net_sales_cents === null ? undefined : `usual ${show(today.usual_net_sales_cents, 'cents', sales.ok ? sales.data.currency : 'AUD')}`}
              hint={today.usual_net_sales_cents === null ? 'No usual yet: too little history' : undefined}
            />
          ) : sales.ok ? null : (
            <ReadError message={sales.error} />
          )}
          <div className="rounded-card border border-line bg-surface p-4" data-testid="home-attention">
            <p className="text-sm text-ink-2">Needs attention</p>
            {attention.length ? (
              <ul className="mt-1.5 space-y-1 text-sm text-ink">
                {attention.slice(0, 3).map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 font-display text-[1.75rem] font-medium text-ink">Nothing</p>
            )}
            {attention.length && on.ordering ? (
              <Link href="/console/orders?view=attention" className="mt-2 inline-block text-sm text-accent">
                Open orders needing attention
              </Link>
            ) : null}
          </div>
        </div>
        {sales.ok ? <p className="mt-3 text-sm text-ink-2">{sales.data.summary}</p> : null}
      </section>

      {/* Waiting for your yes */}
      {manager ? (
        <section aria-labelledby="yes-heading" data-testid="home-approvals">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <h2 id="yes-heading" className="text-lg font-semibold text-ink">
              Waiting for your yes
            </h2>
            <Link href="/console/approvals" className="text-sm text-accent">
              All approvals
            </Link>
          </div>
          {!waiting?.ok ? (
            <ReadError message={waiting?.error ?? 'Could not read approvals.'} />
          ) : pending.length === 0 ? (
            <EmptyState title="Nothing is waiting for you">When a campaign, a batch of messages or your assistant needs a yes, it appears here with exactly what will happen.</EmptyState>
          ) : (
            <Card padded={false}>
              <ul className="divide-y divide-line">
                {pending.slice(0, 5).map((a) => (
                  <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4" data-testid={`home-approval-${a.id}`}>
                    <div className="min-w-0 flex-1 basis-72">
                      <Link href={`/console/approvals/${a.id}`} className="font-medium text-accent">
                        {a.summary}
                      </Link>
                      <p className="mt-0.5 text-xs text-ink-3">
                        {REQUESTER[a.requestedByKind] ?? a.requestedByKind} · {venueName(a.venueId)} · asked {dateTime(a.createdAt, tz)}
                      </p>
                    </div>
                    {!a.venueId || atLeast(c.session.principal.venueRoles[a.venueId] ?? 'read_only', 'manager') ? <DecideButtons id={a.id} summary={a.summary} action={decideFromHome} /> : null}
                  </li>
                ))}
              </ul>
              {pending.length > 5 ? <p className="border-t border-line px-5 py-3 text-xs text-ink-3">{pending.length - 5} more under Approvals.</p> : null}
            </Card>
          )}
        </section>
      ) : null}

      {/* This week against last */}
      <section aria-labelledby="week-heading" data-testid="home-week">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <h2 id="week-heading" className="text-lg font-semibold text-ink">
            This week against last
          </h2>
          <Link href="/console/analytics/overview?period=this_week&compare=previous_period" className="text-sm text-accent">
            The full picture
          </Link>
        </div>
        {week.ok ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="week-tiles">
            {['net_sales', 'orders', 'avg_order_value'].map((k) => {
              const m = week.data.metrics.find((x) => x.key === k);
              const v = week.data.totals.values[k];
              const prev = week.data.totals.compare?.[k];
              const unit = (m?.unit ?? 'number') as 'cents' | 'count' | 'ratio' | 'days' | 'number';
              return (
                <StatTile
                  key={k}
                  label={m?.name ?? k}
                  value={show(v, unit, week.data.currency)}
                  delta={week.data.totals.change?.[k]?.pct ?? null}
                  goodWhen={m?.good_direction === 'down_is_good' ? 'down' : m?.good_direction === 'up_is_good' ? 'up' : 'neither'}
                  comparedTo={`last week (${show(prev, unit, week.data.currency)})`}
                />
              );
            })}
          </div>
        ) : (
          <ReadError message={week.error} />
        )}
        {digests.ok && digests.data[0] ? (
          <p className="mt-3 text-sm text-ink-2">
            <span className="font-medium text-ink">Monday's digest:</span> {digests.data[0].summary}{' '}
            <Link href="/console/analytics/digest" className="text-accent">
              Read it
            </Link>
          </p>
        ) : null}
      </section>

      {/* Setup progress, until live */}
      {setupShown ? (
        <section aria-labelledby="setup-heading" data-testid="setup-progress">
          <h2 id="setup-heading" className="mb-3 text-lg font-semibold text-ink">
            Until you are live
          </h2>
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1 basis-72">
                <p className="text-sm text-ink-2">
                  {setupShown.steps.filter((s) => s.status === 'done').length} of {setupShown.steps.length} steps done. {setupShown.summary}
                </p>
                {setupShown.next ? (
                  <p className="mt-3 text-base text-ink" data-testid="setup-next">
                    <span className="font-medium">Next:</span> {setupShown.next.whatToDo}
                  </p>
                ) : null}
                {setupShown.askTheOwner.length ? (
                  <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-2">
                    {setupShown.askTheOwner.slice(0, 3).map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <ol className="basis-64 space-y-1 text-sm">
                {setupShown.steps.map((s) => (
                  <li key={s.key} className="flex items-center gap-2">
                    <Badge tone={s.status === 'done' ? 'good' : s.status === 'to_do' ? 'warn' : 'neutral'}>{s.status === 'done' ? 'Done' : s.status === 'to_do' ? 'To do' : s.status === 'waiting' ? 'Waiting' : 'Optional'}</Badge>
                    <span className={s.status === 'done' ? 'text-ink-3' : 'text-ink'}>{s.title}</span>
                  </li>
                ))}
              </ol>
            </div>
            <p className="mt-4 text-xs text-ink-3">Your assistant can do every step from <span className="font-mono">setup_status</span>; the Plugins and Channels pages do the same by hand.</p>
          </Card>
        </section>
      ) : null}

      {/* What your assistant did this week */}
      {manager && on.hub ? (
        <section aria-labelledby="assistant-heading" data-testid="assistant-week">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <h2 id="assistant-heading" className="text-lg font-semibold text-ink">
              What your assistant did this week
            </h2>
            <Link href="/console/assistant" className="text-sm text-accent">
              Assistant
            </Link>
          </div>
          {calls?.ok ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatTile label="Questions answered" value={String(weekCalls.filter((a) => a.effect === 'read').length)} hint="Reads through the connection" />
              <StatTile label="Changes made after a yes" value={String(weekChanges)} hint={`${weekCalls.filter((a) => a.outcome === 'asked').length} proposed`} />
              <StatTile label="Hosted agent runs" value={String(weekRuns.length)} hint={weekRuns[0] ? `Last: ${weekRuns[0].agentName}` : 'None listed here yet'} />
            </div>
          ) : (
            <ReadError message={calls?.error ?? 'Could not read assistant activity.'} />
          )}
        </section>
      ) : null}
    </div>
  );
}
