import { notFound } from 'next/navigation';
import { loyalty } from '@ros/modules';
import { getConsole } from '@/lib/console';
import { idempotencyKey } from '@/lib/console-actions';
import { read } from '@/lib/console-read';
import { ConfirmAction } from '@/components/console/confirm';
import { Facts, NotForYourRole, ReadError } from '@/components/console/states';
import { Badge, Card, EmptyState, LinkButton, Table, Td, Th, dateTime, money } from '@/ui';
import { adjustPointsAction, setMemberStatusAction } from '../../actions';
import { LoyaltyFrame, loyaltyRoles, points } from '../../shared';
import { AdjustFields } from './adjust-fields';

export const metadata = { title: 'Member · Restaurant OS' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function MemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const c = await getConsole();
  const roles = loyaltyRoles(c);
  if (!roles.counter) return <NotForYourRole title="Member" />;
  const [card, acct] = await Promise.all([
    read((ctx, cc) => loyalty.getMemberCard(ctx, { venueId: cc.venue.id, accountId: id })),
    read((ctx) => loyalty.getAccount(ctx, { accountId: id })),
  ]);
  if (!card.ok && card.code === 'not_found') notFound();
  const tz = c.venue.timezone;
  const m = card.ok ? card.data : null;

  return (
    <LoyaltyFrame
      c={c}
      current={roles.manager ? '/console/loyalty/members' : '/console/loyalty/counter'}
      title={m ? m.name : 'Member'}
      description={m ? `Member ${m.memberCode} since ${dateTime(m.enrolledAt, tz, { date: true, time: false })}` : undefined}
      actions={<LinkButton href={roles.manager ? '/console/loyalty/members' : '/console/loyalty/counter'} size="sm">Back</LinkButton>}
    >
      {!card.ok ? <ReadError message={card.error} /> : null}
      {m ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="space-y-6">
            <Card title="Points">
              <p className="text-3xl font-semibold tabular-nums" data-testid="member-balance">
                {m.balance.toLocaleString('en-AU')}
              </p>
              <p className="text-sm text-ink-2">
                {points(m.available)} free to spend, worth {money(m.valueCents, c.org.currency)}
                {m.held ? `; ${points(m.held)} held for a code at the counter` : ''}.
              </p>
              <div className="mt-4">
                <Facts
                  items={[
                    ['Status', m.status === 'active' ? <Badge tone="good">Active</Badge> : <Badge tone="warn">{m.status === 'suspended' ? 'Suspended' : 'Closed'}</Badge>],
                    ['Tier', m.tier?.name ?? 'None'],
                    ['Next tier', m.nextTier ? `${m.nextTier.name}: ${points(m.nextTier.pointsToGo)} to go` : '–'],
                    ['Phone', m.phone],
                    ['Email', m.email],
                  ]}
                />
              </div>
              {roles.manager && m.status !== 'closed' ? (
                <div className="mt-5 flex flex-wrap gap-2">
                  <ConfirmAction
                    trigger="Adjust points"
                    title={`Adjust ${m.name}'s points`}
                    action={adjustPointsAction}
                    hidden={{ accountId: m.accountId, requestKey: idempotencyKey() }}
                    fields={<AdjustFields balance={m.balance} available={m.available} />}
                    reason={{ label: 'Reason', hint: 'Kept on the audit log with your name. Not shown to the guest.', minLength: 3 }}
                    confirmLabel="Make the adjustment"
                    variant="primary"
                    testId="adjust-points"
                  >
                    Points are money the venue owes. The change is recorded against {c.venue.name} and on the audit log. The guest is not messaged. Changes above the venue&apos;s limit need the owner.
                  </ConfirmAction>
                  <ConfirmAction
                    trigger={m.status === 'active' ? 'Suspend' : 'Lift suspension'}
                    title={m.status === 'active' ? `Suspend ${m.name}` : `Lift ${m.name}'s suspension`}
                    action={setMemberStatusAction}
                    hidden={{ accountId: m.accountId, status: m.status === 'active' ? 'suspended' : 'active' }}
                    reason={{ label: 'Reason', minLength: 3 }}
                    confirmLabel={m.status === 'active' ? 'Suspend membership' : 'Lift suspension'}
                  >
                    {m.status === 'active'
                      ? `While suspended, ${m.name} cannot earn or redeem anywhere. Their ${points(m.balance)} are kept.`
                      : `${m.name} will earn and redeem again, with their ${points(m.balance)}.`}
                  </ConfirmAction>
                </div>
              ) : null}
            </Card>
            <Card title="Codes" padded={false}>
              {!acct.ok ? (
                <div className="p-5"><ReadError message={acct.error} /></div>
              ) : acct.data.redemptions.length === 0 ? (
                <p className="px-5 py-6 text-sm text-ink-2">No rewards redeemed yet.</p>
              ) : (
                <Table>
                  <tbody>
                    {acct.data.redemptions.map((r) => (
                      <tr key={r.id}>
                        <Td>
                          {r.rewardName}
                          <span className="block text-xs text-ink-3">{dateTime(r.issuedAt, tz)}</span>
                        </Td>
                        <Td numeric>{r.points.toLocaleString('en-AU')}</Td>
                        <Td>
                          <Badge tone={r.status === 'redeemed' ? 'good' : r.status === 'issued' ? 'accent' : 'neutral'}>{r.forced ? 'confirmed by hand' : r.status}</Badge>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>
          <Card title="Points history" padded={false}>
            {!acct.ok ? (
              <div className="p-5"><ReadError message={acct.error} /></div>
            ) : acct.data.history.length === 0 ? (
              <div className="p-5"><EmptyState title="No points yet" /></div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>What</Th>
                    <Th>Where</Th>
                    <Th align="right">Points</Th>
                  </tr>
                </thead>
                <tbody>
                  {acct.data.history.map((h) => (
                    <tr key={h.id}>
                      <Td>{dateTime(h.occurredAt, tz)}</Td>
                      <Td>{h.description}</Td>
                      <Td>{h.venueId ? (c.venues.find((v) => v.id === h.venueId)?.name ?? 'Another venue') : '–'}</Td>
                      <Td numeric className={h.points < 0 ? 'text-bad' : undefined}>
                        {h.points > 0 ? '+' : ''}
                        {h.points.toLocaleString('en-AU')}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      ) : null}
    </LoyaltyFrame>
  );
}
