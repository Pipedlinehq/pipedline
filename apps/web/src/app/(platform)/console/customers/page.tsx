import Link from 'next/link';
import { GUEST_FACING_ROLES } from '@ros/core';
import { identity } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { Card, EmptyState, FormMessage, PageHeader, Table, Td, Th, dateTime } from '@/ui';

export const metadata = { title: 'Customers · Pipedline' };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; erased?: string }> }) {
  const sp = await searchParams;
  const c = await getConsole();
  const roles = Object.values(c.session.principal.venueRoles);
  // Guest records are for staff who deal with guests; the service refuses kitchen and read-only roles.
  if (!roles.some((r) => atLeast(r, 'manager') || GUEST_FACING_ROLES.includes(r))) {
    return <NotForYourRole title="Customers">Guest details are shown to front-of-house staff and managers. The numbers about customers are in Analytics.</NotForYourRole>;
  }
  const q = (sp.q ?? '').trim().slice(0, 100);
  const r = q.length >= 2 ? await read((ctx) => identity.searchCustomers(ctx, { q, limit: 50 })) : null;

  return (
    <>
      <PageHeader title="Customers" description="Find a guest by name, email or phone to see their orders, messages, loyalty and what they have agreed to." />
      {sp.erased ? (
        <div className="mb-4">
          <FormMessage tone="success">The guest was erased. Their sales stay in the ledger with no one attached.</FormMessage>
        </div>
      ) : null}
      <form method="get" role="search" className="mb-6 flex flex-wrap items-end gap-3">
        <label className="block min-w-64 flex-1">
          <span className="mb-1 block text-sm font-medium text-ink">Search</span>
          <input
            name="q"
            type="search"
            defaultValue={q}
            minLength={2}
            maxLength={100}
            placeholder="Name, email or phone"
            autoComplete="off"
            className="block h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-3"
          />
        </label>
        <button type="submit" className="h-10 rounded-md bg-ink px-4 text-sm font-medium text-white hover:bg-ink/85">
          Search
        </button>
      </form>
      {!r ? (
        <EmptyState title="Search for a guest">Type at least two letters of a name, or an email address or phone number. Guests are only listed when you look for them.</EmptyState>
      ) : !r.ok ? (
        <ReadError message={r.error} />
      ) : r.data.length === 0 ? (
        <EmptyState title="No one matches that">Try part of the name, the full email address, or the phone number with its area code.</EmptyState>
      ) : (
        <Card padded={false}>
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Phone</Th>
                <Th>Allergies</Th>
                <Th>First seen</Th>
              </tr>
            </thead>
            <tbody>
              {r.data.map((g) => (
                <tr key={g.id}>
                  <Td>
                    <Link href={`/console/customers/${g.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                      {g.name}
                    </Link>
                  </Td>
                  <Td className="max-w-64 truncate">{g.email ?? '–'}</Td>
                  <Td className="whitespace-nowrap">{g.phone ?? '–'}</Td>
                  <Td className="max-w-48 truncate">{g.allergyNotes ?? '–'}</Td>
                  <Td className="whitespace-nowrap">{dateTime(g.createdAt, c.venue.timezone, { date: true, time: false })}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {r.data.length >= 50 ? <p className="px-5 py-3 text-xs text-ink-3">Showing the first 50. Narrow the search to find someone specific.</p> : null}
        </Card>
      )}
    </>
  );
}
