import Link from 'next/link';
import { comms, identity, ledger, loyalty } from '@ros/modules';
import { GUEST_FACING_ROLES } from '@ros/core';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { NotHere } from '@/components/console/not-here';
import { ConfirmAction } from '@/components/console/confirm';
import { Facts, NotForYourRole, ReadError } from '@/components/console/states';
import { ActionForm, Badge, Card, Field, GuestText, Input, LinkButton, PageHeader, SubmitButton, Table, Td, Textarea, Th, dateTime, money } from '@/ui';
import { erase, saveCustomer, withdrawConsent } from '../actions';

export const metadata = { title: 'Customer · Restaurant OS' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PURPOSE: Record<string, { label: string; withdrawn: string }> = {
  marketing_email: { label: 'Marketing email', withdrawn: 'They will get no more marketing email from you. Receipts and order updates still arrive.' },
  marketing_sms: { label: 'Marketing SMS', withdrawn: 'They will get no more marketing texts from you. Order updates by text still arrive.' },
  card_recognition: { label: 'Recognise their card', withdrawn: 'Their linked cards are deleted now, and future card payments are no longer tied to this record.' },
  ad_platform_sharing: { label: 'Share with ad platforms', withdrawn: 'Their details are no longer included in audiences sent to advertising platforms.' },
};

const SOURCE: Record<string, string> = {
  staff_on_request: 'staff, at their request',
  guest_account: 'their account',
  unsubscribe_link: 'an unsubscribe link',
  sms_stop: 'replying STOP',
  checkout: 'checkout',
  qr_checkout: 'table checkout',
  loyalty_signup: 'loyalty sign-up',
  import: 'an import',
};

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return <NotHere back="/console/customers" label="Back to customers" />;
  const c = await getConsole();
  if (!Object.values(c.session.principal.venueRoles).some((role) => atLeast(role, 'manager') || GUEST_FACING_ROLES.includes(role))) {
    return <NotForYourRole title="Customer">Guest details are shown to front-of-house staff and managers.</NotForYourRole>;
  }
  const r = await read((ctx) => identity.getCustomer(ctx, id));
  if (!r.ok) {
    if (r.code === 'not_found') return <NotHere back="/console/customers" label="Back to customers" />;
    return (
      <>
        <PageHeader title="Customer" />
        <ReadError message={r.error} />
      </>
    );
  }
  const g = r.data;
  const tz = c.venue.timezone;
  const loyaltyOn = await moduleOn('loyalty');
  const [consents, messages, sales, member] = await Promise.all([
    read((ctx) => identity.getConsents(ctx, g.id)),
    read((ctx) => comms.listMessagesForCustomer(ctx, g.id, 20)),
    read((ctx) => ledger.listTransactions(ctx, { customerId: g.id, limit: 20 })),
    loyaltyOn && (g.email || g.phone)
      ? read((ctx, cc) => loyalty.lookupMember(ctx, g.email ? { venueId: cc.venue.id, email: g.email } : { venueId: cc.venue.id, phone: g.phone! }))
      : Promise.resolve(null),
  ]);
  const name = [g.firstName, g.lastName].filter(Boolean).join(' ') || 'Guest';
  const venueName = (vid: string | null) => (vid ? (c.venues.find((v) => v.id === vid)?.name ?? 'A venue you do not work at') : '–');

  return (
    <>
      <PageHeader
        title={name}
        description={`Known since ${dateTime(g.createdAt, tz, { date: true, time: false })} · first came via ${g.acquisition.source.replace(/_/g, ' ')}`}
        actions={
          <>
            {c.isOwner ? (
              <form method="post" action={`/console/customers/${g.id}/export`}>
                <button type="submit" className="inline-flex h-10 items-center rounded-md border border-line-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-sunken">
                  Export their data
                </button>
              </form>
            ) : null}
            <LinkButton href="/console/customers">Search</LinkButton>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-6">
          <Card title="Details" description="Email and phone come from the guest when they order or sign in, so they are not edited here.">
            <Facts
              items={[
                ['Email', g.email ?? '–'],
                ['Phone', g.phone ?? '–'],
                ['First seen at', venueName(g.firstSeenVenueId)],
                ['Came from', [g.acquisition.source.replace(/_/g, ' '), g.acquisition.campaignId, g.acquisition.code].filter(Boolean).join(' · ')],
              ]}
            />
            <ActionForm action={saveCustomer} className="mt-5 space-y-4 border-t border-line pt-5">
              <input type="hidden" name="customerId" value={g.id} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="First name">
                  <Input name="firstName" defaultValue={g.firstName ?? ''} maxLength={100} />
                </Field>
                <Field label="Last name">
                  <Input name="lastName" defaultValue={g.lastName ?? ''} maxLength={100} />
                </Field>
                <Field label="Birthday">
                  <Input name="birthday" type="date" defaultValue={g.birthday ?? ''} />
                </Field>
              </div>
              <Field label="Allergies and dietary needs" hint="Shown to staff taking their orders.">
                <Textarea name="allergyNotes" defaultValue={g.allergyNotes ?? ''} maxLength={2000} />
              </Field>
              <Field label="Staff notes" hint="For staff only. Never shown to the guest or to an assistant.">
                <Textarea name="notes" defaultValue={g.notes ?? ''} maxLength={5000} />
              </Field>
              <SubmitButton>Save details</SubmitButton>
            </ActionForm>
          </Card>

          <Card title="Sales" description="From the ledger, at the venues you can see." padded={false}>
            {!sales.ok ? (
              <div className="p-5">
                <ReadError message={sales.error} />
              </div>
            ) : sales.data.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-3">No sales are tied to this guest at your venues.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Venue</Th>
                    <Th>Channel</Th>
                    <Th align="right">Total</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {sales.data.map((s) => (
                    <tr key={s.id}>
                      <Td className="whitespace-nowrap">{dateTime(s.occurredAt, tz)}</Td>
                      <Td>{venueName(s.venueId)}</Td>
                      <Td>{s.channel}</Td>
                      <Td numeric>
                        {money(s.totalCents)}
                        {s.refundedCents ? <span className="block text-xs text-bad">−{money(s.refundedCents)}</span> : null}
                      </Td>
                      <Td>{s.status.replace(/_/g, ' ')}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card title="Messages sent" description="What this guest was actually sent, for a question or a dispute." padded={false}>
            {!messages.ok ? (
              <div className="p-5">
                <ReadError message={messages.error} />
              </div>
            ) : messages.data.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-3">Nothing has been sent to this guest.</p>
            ) : (
              <ul className="divide-y divide-line">
                {messages.data.map((m) => (
                  <li key={m.id} className="px-5 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{m.subject ?? m.templateKey}</span>
                      <Badge tone={m.kind === 'marketing' ? 'accent' : 'neutral'}>{m.kind}</Badge>
                      <Badge tone={m.status === 'failed' || m.status === 'bounced' ? 'bad' : m.status === 'delivered' ? 'good' : 'neutral'}>{m.status.replace(/_/g, ' ')}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-3">
                      {m.channel === 'sms' ? 'SMS' : 'Email'} to {m.to} · {dateTime(m.sentAt ?? m.queuedAt, tz)}
                      {m.error ? ` · ${m.error}` : ''}
                    </p>
                    {m.renderedBody ? (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-accent">Show what was sent</summary>
                        <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-sunken p-2 font-sans text-xs text-ink-2">{m.renderedBody}</pre>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          <Card title="What they have agreed to" description="Only the guest can give consent. You can withdraw one when they ask you to.">
            {!consents.ok ? (
              <ReadError message={consents.error} />
            ) : (
              <ul className="space-y-3">
                {consents.data.map((k) => (
                  <li key={k.purpose} className="flex items-start justify-between gap-3 text-sm" data-testid={`consent-${k.purpose}`}>
                    <div>
                      <p className="font-medium">{PURPOSE[k.purpose]?.label ?? k.purpose}</p>
                      <p className="text-xs text-ink-3">
                        {k.granted ? 'Agreed' : k.at ? 'Withdrawn' : 'Never asked'}
                        {k.at ? ` ${dateTime(k.at, tz, { date: true, time: false })}` : ''}
                        {k.source ? ` via ${SOURCE[k.source] ?? k.source.replace(/_/g, ' ')}` : ''}
                        {k.wordingVersion ? ` · wording ${k.wordingVersion}` : ''}
                      </p>
                    </div>
                    {k.granted ? (
                      <ConfirmAction
                        trigger="Withdraw"
                        title={`Withdraw “${PURPOSE[k.purpose]?.label ?? k.purpose}”`}
                        action={withdrawConsent}
                        hidden={{ customerId: g.id, purpose: k.purpose }}
                        reason={{ label: 'How they asked (optional, kept on the record)', required: false, minLength: 0, placeholder: 'Asked at the counter on Friday night' }}
                        confirmLabel="Withdraw consent"
                        testId={`withdraw-${k.purpose}`}
                      >
                        Only do this because {name === 'Guest' ? 'the guest' : name} asked you to. {PURPOSE[k.purpose]?.withdrawn} It is recorded as withdrawn by staff at their request. Only the guest can agree again.
                      </ConfirmAction>
                    ) : (
                      <Badge>{k.at ? 'Withdrawn' : 'Not agreed'}</Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Allergies">
            {g.allergyNotes ? (
              <p className="text-sm">
                <GuestText>{g.allergyNotes}</GuestText>
              </p>
            ) : (
              <p className="text-sm text-ink-3">None recorded.</p>
            )}
          </Card>

          {loyaltyOn ? (
            <Card title="Loyalty">
              {!member ? (
                <p className="text-sm text-ink-3">No email or phone on the record to look the membership up by.</p>
              ) : !member.ok ? (
                <p className="text-sm text-ink-3">{member.error}</p>
              ) : !member.data.member ? (
                <p className="text-sm text-ink-3">Not a member. They can join at the counter or when they next order.</p>
              ) : (
                <>
                  <Facts
                    items={[
                      ['Member code', member.data.member.memberCode],
                      ['Status', member.data.member.status],
                      ['Points available', `${member.data.member.available.toLocaleString('en-AU')} (worth ${money(member.data.member.valueCents)})`],
                      ['Tier', member.data.member.tier?.name ?? 'No tier'],
                      ['Joined', dateTime(member.data.member.enrolledAt, tz, { date: true, time: false })],
                      ['Held for live codes', member.data.member.held.toLocaleString('en-AU')],
                    ]}
                  />
                  <p className="mt-3 text-sm">
                    <Link href="/console/loyalty" className="text-accent underline-offset-2 hover:underline">
                      Open in Loyalty
                    </Link>
                  </p>
                </>
              )}
            </Card>
          ) : null}

          {c.isOwner ? (
            <Card title="Erase this guest" description="For a guest who asks you to delete what you hold about them.">
              <ConfirmAction
                trigger="Erase…"
                triggerVariant="danger"
                triggerSize="md"
                title={`Erase ${name}`}
                action={erase}
                hidden={{ customerId: g.id }}
                confirmLabel="Erase permanently"
                testId="erase"
                fields={
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium text-ink">Type ERASE to confirm</span>
                    <input name="confirm" required autoComplete="off" className="block h-10 w-40 rounded-md border border-line-strong bg-surface px-3 text-sm" />
                  </label>
                }
              >
                <p>This cannot be undone. Their name, email, phone, birthday, allergies, staff notes, linked cards and every consent are deleted, and their loyalty membership and any unused offer codes are closed.</p>
                <p className="mt-2">Their past sales stay in the ledger with no one attached, so your sales figures do not change. The erasure is recorded in the audit log.</p>
              </ConfirmAction>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
