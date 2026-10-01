import Link from 'next/link';
import { loyalty, offers } from '@ros/modules';
import { getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { ActionForm, Badge, Card, EmptyState, Field, FormMessage, Input, LinkButton, Select, SubmitButton, Table, Td, Th, money, timeOnly } from '@/ui';
import { enrolAction, forceConfirmAction, issueRedemptionAction, lookupAction, redeemCodeAction, voidRedemptionAction } from '../actions';
import { LoyaltyFrame, loyaltyRoles, points } from '../shared';

export const metadata = { title: 'Counter · Pipedline' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The counter: find the guest in front of you, give them a reward code, join them up, check an
 * offer code. For front of house and managers at the selected venue.
 */
export default async function CounterPage({ searchParams }: { searchParams: Promise<{ member?: string; name?: string; code?: string; joined?: string; already?: string }> }) {
  const c = await getConsole();
  const roles = loyaltyRoles(c);
  if (!roles.counter) return <NotForYourRole title="Counter">The counter screen is for front of house and managers.</NotForYourRole>;
  const sp = await searchParams;
  const memberId = sp.member && UUID.test(sp.member) ? sp.member : null;
  const name = (sp.name ?? '').trim().slice(0, 120);
  const code = (sp.code ?? '').trim().slice(0, 40);
  const offersOn = await moduleOn('offers');
  const tz = c.venue.timezone;

  const [card, found, queue, check] = await Promise.all([
    memberId ? read((ctx, cc) => loyalty.getMemberCard(ctx, { venueId: cc.venue.id, accountId: memberId })) : null,
    name.length >= 2 ? read((ctx, cc) => loyalty.searchMembers(ctx, { venueId: cc.venue.id, q: name })) : null,
    read((ctx, cc) => loyalty.listCounterRedemptions(ctx, { venueId: cc.venue.id })),
    offersOn && code.length >= 4 ? read((ctx, cc) => offers.checkCode(ctx, { venueId: cc.venue.id, code })) : null,
  ]);

  return (
    <LoyaltyFrame c={c} current="/console/loyalty/counter" title="Counter" description={`Serving guests at ${c.venue.name}.`}>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-6">
          <Card title="Find a member">
            <ActionForm action={lookupAction} className="flex flex-wrap items-end gap-3">
              <Field label="By" className="w-40">
                <Select name="by" defaultValue="phone">
                  <option value="phone">Phone</option>
                  <option value="email">Email</option>
                  <option value="code">Member code</option>
                </Select>
              </Field>
              <Field label="What the guest gave you" className="min-w-48 flex-1">
                <Input name="value" required autoComplete="off" data-testid="lookup-value" />
              </Field>
              <SubmitButton pendingLabel="Looking…">Look up</SubmitButton>
            </ActionForm>
            <form method="get" role="search" className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
              <Field label="Or search by name" className="min-w-48 flex-1">
                <Input name="name" defaultValue={name} minLength={2} autoComplete="off" />
              </Field>
              <button type="submit" className="h-10 rounded-md border border-line-strong bg-surface px-4 text-sm font-medium hover:bg-sunken">
                Search
              </button>
            </form>
            {found ? (
              !found.ok ? (
                <div className="mt-3"><ReadError message={found.error} /></div>
              ) : found.data.length === 0 ? (
                <p className="mt-3 text-sm text-ink-2">No member by that name.</p>
              ) : (
                <ul className="mt-3 divide-y divide-line rounded-md border border-line">
                  {found.data.map((m) => (
                    <li key={m.accountId}>
                      <Link href={`/console/loyalty/counter?member=${m.accountId}`} className="flex justify-between gap-3 px-3 py-2 text-sm hover:bg-sunken">
                        <span className="font-medium text-ink">{m.name}</span>
                        <span className="text-ink-3">{points(m.balance)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </Card>

          {card ? !card.ok ? <ReadError message={card.error} /> : <MemberPanel m={card.data} joined={sp.joined === '1'} already={sp.already === '1'} currency={c.org.currency} tz={tz} manager={roles.manager} /> : null}

          <Card title="Codes waiting for their sale" description="Issued here in the last day. Each is used once when the matching sale reaches the till." padded={false}>
            {!queue.ok ? (
              <div className="p-5"><ReadError message={queue.error} /></div>
            ) : queue.data.length === 0 ? (
              <p className="px-5 py-6 text-sm text-ink-2">Nothing waiting.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Code</Th>
                    <Th>Guest</Th>
                    <Th>Reward</Th>
                    <Th>Until</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {queue.data.map((r) => (
                    <tr key={r.id}>
                      <Td className="font-mono">{r.code}</Td>
                      <Td>{r.memberName}</Td>
                      <Td>
                        {r.rewardSummary}
                        <span className="block text-xs text-ink-3">{points(r.points)}</span>
                      </Td>
                      <Td>{r.status === 'expired' ? <Badge tone="warn">Lapsed</Badge> : timeOnly(r.expiresAt, tz)}</Td>
                      <Td align="right">
                        <div className="flex flex-wrap justify-end gap-2">
                          {r.status === 'issued' ? (
                            <ConfirmAction trigger="Cancel" title={`Cancel code ${r.code}`} action={voidRedemptionAction} hidden={{ redemptionId: r.id }} confirmLabel="Cancel code" reason={{ label: 'Why (optional)', required: false, minLength: 0 }}>
                              The code stops working and the {points(r.points)} held for it are free for {r.memberName} to spend again.
                            </ConfirmAction>
                          ) : null}
                          {roles.manager ? (
                            <ConfirmAction trigger="Confirm by hand" title={`Confirm ${r.code} by hand`} action={forceConfirmAction} hidden={{ redemptionId: r.id }} confirmLabel="Spend the points" reason={{ label: 'Why is this being confirmed by hand?', minLength: 3, hint: 'e.g. the till was offline. Kept on the audit log.' }}>
                              Use this only when {r.memberName} received {r.rewardSummary} but the sale never matched. {points(r.points)} are spent from their balance now and the code is closed.
                            </ConfirmAction>
                          ) : null}
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          {offersOn ? (
            <Card title="Check an offer code">
              <form method="get" className="flex flex-wrap items-end gap-3">
                {memberId ? <input type="hidden" name="member" value={memberId} /> : null}
                <Field label="Code" className="min-w-40 flex-1">
                  <Input name="code" defaultValue={code} minLength={4} maxLength={40} autoComplete="off" className="font-mono uppercase" />
                </Field>
                <button type="submit" className="h-10 rounded-md border border-line-strong bg-surface px-4 text-sm font-medium hover:bg-sunken">
                  Check
                </button>
              </form>
              {check ? (
                <div className="mt-4">
                  {!check.ok ? (
                    <ReadError message={check.error} />
                  ) : (
                    <div className="space-y-3">
                      <FormMessage tone={check.data.usable ? 'success' : 'error'}>{check.data.usable ? 'Good to use here.' : check.data.reason}</FormMessage>
                      <p className="text-sm">
                        <span className="font-mono">{check.data.code.code}</span>: {check.data.code.summary}
                        <span className="block text-xs text-ink-3">
                          {check.data.code.offerName}
                          {check.data.guestName ? <> · for {check.data.guestName}</> : null} · {check.data.code.status}
                        </span>
                      </p>
                      {check.data.usable ? (
                        <ConfirmAction trigger="Mark as used" triggerVariant="primary" title={`Use ${check.data.code.code}`} action={redeemCodeAction} hidden={{ code: check.data.code.code }} confirmLabel="Mark as used" variant="primary">
                          Apply {check.data.code.summary} at the till, then mark it here. The code can never be used again.
                        </ConfirmAction>
                      ) : null}
                    </div>
                  )}
                </div>
              ) : null}
            </Card>
          ) : null}

          <Card title="Join a guest up" description="Ask for their phone number or email. Marketing consent is theirs to give later; this records none.">
            <ActionForm action={enrolAction} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="First name">
                  <Input name="firstName" maxLength={100} autoComplete="off" />
                </Field>
                <Field label="Last name">
                  <Input name="lastName" maxLength={100} autoComplete="off" />
                </Field>
              </div>
              <Field label="Phone">
                <Input name="phone" type="tel" autoComplete="off" />
              </Field>
              <Field label="Email">
                <Input name="email" type="email" autoComplete="off" />
              </Field>
              <SubmitButton pendingLabel="Joining…">Join</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </LoyaltyFrame>
  );
}

function MemberPanel({ m, joined, already, currency, tz, manager }: { m: loyalty.MemberCard; joined: boolean; already: boolean; currency: string; tz: string; manager: boolean }) {
  return (
    <Card
      title={m.name}
      description={`Member ${m.memberCode}${m.tier ? ` · ${m.tier.name}` : ''}`}
      actions={<LinkButton href={`/console/loyalty/members/${m.accountId}`} size="sm">{manager ? 'Full record' : 'History'}</LinkButton>}
    >
      {joined ? <div className="mb-3"><FormMessage tone="success">Welcome aboard: {m.name} is now a member.</FormMessage></div> : null}
      {already ? <div className="mb-3"><FormMessage tone="info">{m.name} was already a member. Nothing was changed.</FormMessage></div> : null}
      {m.status !== 'active' ? <div className="mb-3"><FormMessage tone="error">This membership is {m.status}: it cannot earn or redeem.</FormMessage></div> : null}
      <p className="text-3xl font-semibold tabular-nums" data-testid="counter-balance">
        {m.available.toLocaleString('en-AU')} <span className="text-base font-normal text-ink-2">points to spend</span>
      </p>
      <p className="text-sm text-ink-2">
        Worth {money(m.valueCents, currency)}
        {m.held ? `. ${points(m.held)} are held for a code below.` : '.'}
        {m.nextTier ? ` ${points(m.nextTier.pointsToGo)} to ${m.nextTier.name}.` : ''}
      </p>

      <h3 className="mt-5 text-sm font-semibold">Rewards</h3>
      {m.rewards.length === 0 ? (
        <EmptyState title="No rewards offered" />
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {m.rewards.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <span className="text-sm">
                <span className="font-medium">{r.name}</span> <span className="text-ink-3">· {points(r.costPoints)}</span>
                {r.blockedReason ? <span className="block text-xs text-ink-3">{r.blockedReason}</span> : !r.canAfford ? <span className="block text-xs text-ink-3">{points(r.pointsShort)} short</span> : null}
              </span>
              {r.canAfford && !r.blockedReason && m.status === 'active' ? (
                <InlineAction action={issueRedemptionAction} hidden={{ accountId: m.accountId, rewardId: r.id }} label="Give code" pendingLabel="Issuing…" />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {m.liveRedemptions.length ? (
        <>
          <h3 className="mt-5 text-sm font-semibold">Live codes</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {m.liveRedemptions.map((r) => (
              <li key={r.id}>
                <span className="font-mono font-semibold">{r.code}</span> · {r.rewardSummary} · until {timeOnly(r.expiresAt, tz)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
