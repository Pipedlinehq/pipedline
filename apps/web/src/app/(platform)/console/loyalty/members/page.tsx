import Link from 'next/link';
import { loyalty } from '@ros/modules';
import { getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { Badge, Card, EmptyState, Input, LinkButton, Table, Td, Th, dateTime } from '@/ui';
import { LoyaltyFrame, loyaltyRoles } from '../shared';

export const metadata = { title: 'Members · Restaurant OS' };

const PAGE = 50;

export default async function MembersPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const c = await getConsole();
  if (!loyaltyRoles(c).manager) return <NotForYourRole title="Members">The member list is for managers. Front of house can look a guest up on the Counter screen.</NotForYourRole>;
  const sp = await searchParams;
  const q = (sp.q ?? '').trim().slice(0, 120);
  const page = Math.max(0, Number(sp.page) || 0);
  const r = await read((ctx) => loyalty.listMembers(ctx, { q: q || undefined, limit: PAGE + 1, offset: page * PAGE }));
  const rows = r.ok ? r.data.slice(0, PAGE) : [];
  const more = r.ok && r.data.length > PAGE;
  const link = (p: number) => `/console/loyalty/members?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`;
  const tz = c.venue.timezone;
  return (
    <LoyaltyFrame c={c} current="/console/loyalty/members" title="Members" description="Every member of the programme, newest first. Open one to see their points or adjust them.">
      <form method="get" role="search" className="mb-4 flex max-w-lg gap-2">
        <label htmlFor="member-q" className="sr-only">
          Search members
        </label>
        <Input id="member-q" name="q" defaultValue={q} placeholder="Name, email, phone or member code" />
        <button type="submit" className="h-10 rounded-md border border-line-strong bg-surface px-4 text-sm font-medium hover:bg-sunken">
          Search
        </button>
      </form>
      {!r.ok ? (
        <ReadError message={r.error} />
      ) : rows.length === 0 ? (
        <EmptyState title={q ? 'No member matches that' : 'No members yet'}>{q ? 'Try part of a name, or the full phone number.' : 'Guests join online, at checkout or at the counter.'}</EmptyState>
      ) : (
        <Card padded={false}>
          <Table>
            <thead>
              <tr>
                <Th>Member</Th>
                <Th>Tier</Th>
                <Th align="right">Balance</Th>
                <Th>Joined</Th>
                <Th>Last activity</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.accountId}>
                  <Td>
                    <Link href={`/console/loyalty/members/${m.accountId}`} className="font-medium text-accent hover:underline">
                      {m.name}
                    </Link>
                    <span className="block text-xs text-ink-3">{m.email ?? m.phone ?? ''}</span>
                  </Td>
                  <Td>{m.tier ?? '–'}</Td>
                  <Td numeric>{m.balance.toLocaleString('en-AU')}</Td>
                  <Td>{dateTime(m.enrolledAt, tz, { date: true, time: false })}</Td>
                  <Td>{dateTime(m.lastActivityAt, tz, { date: true, time: false })}</Td>
                  <Td>{m.status === 'active' ? <Badge tone="good">Active</Badge> : <Badge tone="warn">Suspended</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {page > 0 || more ? (
        <div className="mt-4 flex gap-2">
          {page > 0 ? <LinkButton href={link(page - 1)} size="sm">Newer</LinkButton> : null}
          {more ? <LinkButton href={link(page + 1)} size="sm">Older</LinkButton> : null}
        </div>
      ) : null}
    </LoyaltyFrame>
  );
}
