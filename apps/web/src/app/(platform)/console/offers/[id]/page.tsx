import Link from 'next/link';
import { notFound } from 'next/navigation';
import { campaigns, offers } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { ConfirmAction } from '@/components/console/confirm';
import { Facts, ModuleOff, ReadError } from '@/components/console/states';
import { ActionForm, Badge, Card, Dialog, EmptyState, FormMessage, LinkButton, PageHeader, SubmitButton, Table, Td, Th, dateTime, money } from '@/ui';
import { issueCodeAction, switchOfferAction, voidCodeAction } from '../actions';
import { APPLIES_TO, AUDIENCES, METHODS, OFFER_KINDS, OfferForm, STATUS_WORDS } from '../offer-form';

export const metadata = { title: 'Offer · Pipedline' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['issued', 'claimed', 'redeemed', 'expired', 'voided'] as const;
const CHANNEL_LABEL: Record<string, string> = { pickup: 'Pickup', delivery: 'Delivery', 'dine-in-qr': 'Table ordering' };
const TONE = { issued: 'accent', claimed: 'accent', redeemed: 'good', expired: 'neutral', voided: 'warn' } as const;
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default async function OfferPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ status?: string; created?: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sp = await searchParams;
  const c = await getConsole();
  const manager = atLeast(c.role, 'manager');
  if (!(await moduleOn('offers'))) return <ModuleOff title="Offer" what="Offers" canManage={manager} />;
  const status = STATUSES.find((s) => s === sp.status);
  const [offer, codes, summary, lists] = await Promise.all([
    read((ctx) => offers.getOffer(ctx, id)),
    manager ? read((ctx) => offers.listCodes(ctx, { offerId: id, status, limit: 100 })) : null,
    read((ctx) => offers.getOffersSummary(ctx)),
    manager && (await moduleOn('campaigns')) ? read((ctx) => campaigns.listSegments(ctx)) : null,
  ]);
  if (!offer.ok) {
    if (offer.code === 'not_found') notFound();
    return (
      <>
        <PageHeader title="Offer" />
        <ReadError message={offer.error} />
      </>
    );
  }
  const o = offer.data;
  const st = STATUS_WORDS[o.status];
  const stats = summary.ok ? summary.data.offers.find((s) => s.offerId === o.id) : undefined;
  const tz = c.venue.timezone;
  const cur = c.org.currency;
  const when = [
    o.days?.length ? o.days.map((d) => DAY[d]).join(', ') : null,
    o.services?.length ? o.services.join(', ') : null,
    o.timeFrom && o.timeTo ? `${o.timeFrom} to ${o.timeTo}` : null,
    o.startsAt ? `from ${dateTime(o.startsAt, tz)}` : null,
    o.endsAt ? `until ${dateTime(o.endsAt, tz)}` : null,
  ].filter(Boolean);
  const combines = [o.combineItem ? 'dish and category offers' : null, o.combineBill ? 'whole-bill offers' : null, o.combineDelivery ? 'delivery offers' : null].filter(Boolean);
  return (
    <>
      <PageHeader
        title={o.name}
        description={<span data-testid="offer-summary">{o.summary}</span>}
        actions={
          <>
            <LinkButton href="/console/offers" size="sm">Back</LinkButton>
            {manager ? (
              <ActionForm action={switchOfferAction}>
                <input type="hidden" name="offerId" value={o.id} />
                <input type="hidden" name="on" value={o.isActive ? '0' : '1'} />
                <SubmitButton variant="secondary" size="sm" pendingLabel="Switching…">
                  {o.isActive ? 'Switch off' : 'Switch on'}
                </SubmitButton>
              </ActionForm>
            ) : null}
            {manager ? (
              <Dialog trigger="Edit offer" title={`Edit ${o.name}`}>
                <OfferForm offer={o} c={c} lists={lists?.ok ? lists.data.map((s) => ({ id: s.id, name: s.name })) : []} />
              </Dialog>
            ) : null}
          </>
        }
      />
      {sp.created === '1' ? (
        <div className="mb-4">
          <FormMessage tone="success">Offer created. {o.method === 'code' ? 'Issue codes below, or let a flow or campaign issue them.' : 'It applies by itself at checkout, and a till discount with its name counts as a use.'}</FormMessage>
        </div>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-6">
          <Card title="Details">
            <Facts
              items={[
                ['Status', <Badge tone={st.tone}>{st.label}</Badge>],
                ['How it is used', METHODS[o.method]],
                ['Kind', OFFER_KINDS[o.kind] ?? o.kind],
                ['Comes off', `${APPLIES_TO[o.appliesTo]}${o.category ? `: ${o.category}` : ''}`],
                ['For', o.audience === 'list' ? (o.segmentName ? <Link href={`/console/customers/lists/${o.segmentId}`} className="text-accent hover:underline">{o.segmentName}</Link> : 'A guest list') : AUDIENCES[o.audience]],
                ['When', when.length ? when.join(' · ') : 'Any time'],
                ['Limits', [o.perGuestLimit ? `${o.perGuestLimit} per guest` : null, o.totalLimit ? `${o.totalLimit} in total` : null].filter(Boolean).join(' · ') || 'None'],
                ['Combines with', combines.length ? combines.join(', ') : 'Not with other offers'],
                ['Uses', `${(stats?.uses ?? 0).toLocaleString('en-AU')} · ${money(stats?.discountCents ?? 0, cur)} given away · ${money(stats?.revenueCents ?? 0, cur)} in sales they sat on`],
                ['Code lasts', o.method === 'code' ? `${o.validityDays} days` : 'No codes'],
                ['Code prefix', o.method === 'code' ? <span className="font-mono">{o.codePrefix}</span> : '–'],
                ['Online orders', o.channels.map((ch) => CHANNEL_LABEL[ch] ?? ch).join(', ') || 'None (till only)'],
                ['Venues', o.validVenueIds ? o.validVenueIds.map((v) => c.venues.find((x) => x.id === v)?.name ?? 'another venue').join(', ') : 'Every venue'],
                ['Guest pays', o.priceCents ? money(o.priceCents, cur) : 'Free'],
                ['Most codes', o.maxCodes?.toLocaleString('en-AU') ?? 'No limit'],
                ['Claim first', o.requiresClaim ? 'Yes' : 'No: ready on issue'],
                ['Creator / campaign', [o.creatorId, o.campaignId].filter(Boolean).join(' / ') || '–'],
              ]}
            />
            {o.description ? <p className="mt-4 text-sm text-ink-2">{o.description}</p> : null}
          </Card>
          {manager && o.method === 'code' ? (
            <Card title="Issue a code" description="A single-use code not yet tied to a guest: print it or hand it over. It binds to whoever claims or uses it.">
              {o.status === 'active' || o.status === 'scheduled' ? (
                <ActionForm action={issueCodeAction}>
                  <input type="hidden" name="offerId" value={o.id} />
                  <SubmitButton pendingLabel="Issuing…">Issue a code</SubmitButton>
                </ActionForm>
              ) : (
                <p className="text-sm text-ink-2">{o.status === 'off' ? 'Switch the offer on to issue codes.' : 'This offer has ended.'}</p>
              )}
            </Card>
          ) : null}
        </div>
        {manager && codes && o.method === 'code' ? (
          <Card title="Codes" padded={false}>
            <nav aria-label="Code status" className="flex flex-wrap gap-1 border-b border-line px-4 py-2 text-sm">
              {[undefined, ...STATUSES].map((s) => (
                <Link key={s ?? 'all'} href={`/console/offers/${o.id}${s ? `?status=${s}` : ''}`} aria-current={s === status ? 'page' : undefined} className={`rounded-md px-2 py-1 ${s === status ? 'bg-sunken font-medium text-ink' : 'text-ink-2 hover:bg-sunken'}`}>
                  {s ? s[0]!.toUpperCase() + s.slice(1) : 'All'}
                </Link>
              ))}
            </nav>
            {!codes.ok ? (
              <div className="p-5"><ReadError message={codes.error} /></div>
            ) : codes.data.length === 0 ? (
              <div className="p-5"><EmptyState title={status ? `No ${status} codes` : 'No codes yet'} /></div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Code</Th>
                    <Th>Status</Th>
                    <Th>Issued</Th>
                    <Th>Expires</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody data-testid="codes">
                  {codes.data.map((k) => (
                    <tr key={k.id}>
                      <Td className="whitespace-nowrap font-mono">{k.code}</Td>
                      <Td>
                        <Badge tone={TONE[k.status]}>{k.status}</Badge>
                        <span className="block text-xs text-ink-3">{k.customerId ? 'a known guest' : 'not tied to a guest'}{k.source ? ` · via ${k.source}` : ''}</span>
                      </Td>
                      <Td>{dateTime(k.issuedAt, tz, { date: true, time: false })}</Td>
                      <Td>{dateTime(k.expiresAt, tz, { date: true, time: false })}</Td>
                      <Td align="right">
                        {k.status === 'issued' || k.status === 'claimed' ? (
                          <ConfirmAction trigger="Cancel" title={`Cancel ${k.code}`} action={voidCodeAction} hidden={{ codeId: k.id, offerId: o.id }} confirmLabel="Cancel code" reason={{ label: 'Reason', minLength: 3, hint: 'Kept on the audit log.' }}>
                            {k.code} stops working now, for anyone holding it. This cannot be undone.
                          </ConfirmAction>
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        ) : manager && o.method === 'automatic' ? (
          <Card title="How it is applied" description="No codes: this offer comes off by itself.">
            <p className="text-sm text-ink-2">
              Online, it is added to the bill at checkout when the order qualifies (who it is for, the day, the service, the limits). At the till, a discount carrying this offer&apos;s name on a sale counts as a use once the sale reaches the record. Each use is in the numbers above and on the guest&apos;s timeline.
            </p>
          </Card>
        ) : null}
      </div>
    </>
  );
}
