import Link from 'next/link';
import { GUEST_FACING_ROLES, localDate, zonedTimeToUtc } from '@ros/core';
import { events, identity } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { resolveView, type ViewSpec } from '@/lib/console-views';
import { app } from '@/lib/runtime';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { IndexViews } from '@/components/console/views';
import { Card, EmptyState, FormMessage, PageHeader, Table, Td, Th, dateTime } from '@/ui';
import { deleteView, renameView, saveView } from '../views-actions';

export const metadata = { title: 'Customers · Pipedline' };

const SPEC: ViewSpec = {
  page: 'customers',
  path: '/console/customers',
  // Lands on All: finding one guest is the commonest reason to open the page, and a search
  // typed on a narrower view is combined with that view's filters, as it says.
  landing: 'all',
  defaults: [
    { key: 'all', label: 'All', filters: {} },
    { key: 'regulars', label: 'Regulars', filters: { visits: 'regular' } },
    { key: 'new', label: 'New this month', filters: { since: 'month' } },
    { key: 'email', label: 'Said yes to email', filters: { consent: 'marketing_email' } },
    { key: 'lapsed', label: 'Lapsed 60+ days', filters: { visits: 'lapsed60' } },
  ],
  fields: [
    { key: 'q', label: 'Name, email or phone', kind: 'text', placeholder: 'Sam, sam@…, 0412…' },
    {
      key: 'visits',
      label: 'Visits',
      kind: 'select',
      options: [
        { value: 'regular', label: 'Regulars (3+ in 90 days)' },
        { value: 'lapsed60', label: 'Not in for 60+ days' },
        { value: 'lapsed90', label: 'Not in for 90+ days' },
      ],
    },
    {
      key: 'since',
      label: 'First known',
      kind: 'select',
      options: [
        { value: 'month', label: 'This month' },
        { value: '30d', label: 'Last 30 days' },
        { value: '90d', label: 'Last 90 days' },
      ],
    },
    {
      key: 'consent',
      label: 'Said yes to',
      kind: 'select',
      options: [
        { value: 'marketing_email', label: 'Marketing email' },
        { value: 'marketing_sms', label: 'Marketing texts' },
        { value: 'card_recognition', label: 'Card recognition' },
      ],
    },
  ],
};

/**
 * Customers (docs/CONSOLE_IA.md section 9, wave 1): guests as a list with saved views (regulars,
 * new this month, said yes to email, lapsed) and a search. Guest records are for staff who deal
 * with guests; the service refuses kitchen and read-only roles. Visits are counted at the venue
 * the console is looking at.
 */
export default async function CustomersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const c = await getConsole();
  const roles = Object.values(c.session.principal.venueRoles);
  if (!roles.some((r) => atLeast(r, 'manager') || GUEST_FACING_ROLES.includes(r))) {
    return <NotForYourRole title="Customers">Guest details are shown to front-of-house staff and managers. The numbers about customers are in Analytics.</NotForYourRole>;
  }
  // A plain ?q= (the old search box, a link from elsewhere) is a search over everyone.
  const sp = raw.q && raw.f !== '1' ? { ...raw, f: '1', view: 'all' } : raw;
  const saved = await read((ctx) => events.listConsoleViews(ctx, { venueId: c.venue.id, page: 'customers' }));
  const resolved = resolveView(SPEC, sp, saved.ok ? saved.data : []);
  const f = resolved.filters;
  const tz = c.venue.timezone;
  const now = app().clock();
  const since = f.since === 'month' ? zonedTimeToUtc(`${localDate(now, tz).slice(0, 7)}-01`, '00:00', tz) : f.since === '30d' ? new Date(now.getTime() - 30 * 86_400_000) : f.since === '90d' ? new Date(now.getTime() - 90 * 86_400_000) : undefined;
  const r = await read((ctx) =>
    identity.listCustomers(ctx, {
      venueId: c.venue.id,
      q: f.q || undefined,
      createdSince: since,
      consent: (f.consent as 'marketing_email') || undefined,
      regular: f.visits === 'regular' ? { minVisits: 3, withinDays: 90 } : undefined,
      lapsedDays: f.visits === 'lapsed60' ? 60 : f.visits === 'lapsed90' ? 90 : undefined,
      limit: 100,
    }),
  );

  return (
    <>
      <PageHeader title="Customers" description={`Guests of ${c.venue.name}: who comes back, who is new, who said yes to hearing from you, and who has not been in for a while.`} />
      {raw.erased ? (
        <div className="mb-4">
          <FormMessage tone="success">The guest was erased. Their sales stay in the ledger with no one attached.</FormMessage>
        </div>
      ) : null}
      <IndexViews page="customers" path="/console/customers" resolved={resolved} fields={SPEC.fields} canSave saveAction={saveView} renameAction={renameView} deleteAction={deleteView} />
      {!r.ok ? (
        <ReadError message={r.error} />
      ) : r.data.length === 0 ? (
        <EmptyState title="No guests match this view">{f.q ? 'Try part of the name, the full email address, or the phone number with its area code.' : 'Try another view, or clear a filter.'}</EmptyState>
      ) : (
        <Card padded={false}>
          <Table label="Guests">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Phone</Th>
                <Th align="right">Visits</Th>
                <Th>Last visit</Th>
                <Th>First seen</Th>
              </tr>
            </thead>
            <tbody>
              {r.data.map((g) => (
                <tr key={g.id} data-testid={`guest-${g.id}`}>
                  <Td>
                    <Link href={`/console/customers/${g.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                      {g.name}
                    </Link>
                    {g.allergyNotes ? <span className="block max-w-56 truncate text-xs text-warn">Allergies noted</span> : null}
                  </Td>
                  <Td className="max-w-64 truncate">{g.email ?? '–'}</Td>
                  <Td className="whitespace-nowrap">{g.phone ?? '–'}</Td>
                  <Td numeric>{g.visits}</Td>
                  <Td className="whitespace-nowrap">{g.lastVisitAt ? dateTime(g.lastVisitAt, tz, { date: true, time: false }) : <span className="text-ink-3">None recorded</span>}</Td>
                  <Td className="whitespace-nowrap">{dateTime(g.createdAt, tz, { date: true, time: false })}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {r.data.length >= 100 ? <p className="px-5 py-3 text-xs text-ink-3">Showing the first 100. Narrow the view to find someone specific.</p> : null}
        </Card>
      )}
    </>
  );
}
