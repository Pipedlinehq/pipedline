import Link from 'next/link';
import { notFound } from 'next/navigation';
import { offers } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { ConfirmAction } from '@/components/console/confirm';
import { Facts, ModuleOff, ReadError } from '@/components/console/states';
import { ActionForm, Badge, Card, Dialog, EmptyState, FormMessage, LinkButton, PageHeader, SubmitButton, Table, Td, Th, dateTime, money } from '@/ui';
import { issueCodeAction, voidCodeAction } from '../actions';
import { OFFER_KINDS, OfferForm } from '../offer-form';

export const metadata = { title: 'Offer · Pipedline' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['issued', 'claimed', 'redeemed', 'expired', 'voided'] as const;
const CHANNEL_LABEL: Record<string, string> = { pickup: 'Pickup', delivery: 'Delivery', 'dine-in-qr': 'Table ordering' };
const TONE = { issued: 'accent', claimed: 'accent', redeemed: 'good', expired: 'neutral', voided: 'warn' } as const;

export default async function OfferPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ status?: string; created?: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sp = await searchParams;
  const c = await getConsole();
  const manager = atLeast(c.role, 'manager');
  if (!(await moduleOn('offers'))) return <ModuleOff title="Offer" what="Offers" canManage={manager} />;
  const status = STATUSES.find((s) => s === sp.status);
  const [offer, codes] = await Promise.all([
    read((ctx) => offers.getOffer(ctx, id)),
    manager ? read((ctx) => offers.listCodes(ctx, { offerId: id, status, limit: 100 })) : null,
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
  const tz = c.venue.timezone;
  return (
    <>
      <PageHeader
        title={o.name}
        description={o.summary}
        actions={
          <>
            <LinkButton href="/console/offers" size="sm">Back</LinkButton>
            {manager ? (
              <Dialog trigger="Edit offer" title={`Edit ${o.name}`}>
                <OfferForm offer={o} c={c} />
              </Dialog>
            ) : null}
          </>
        }
      />
      {sp.created === '1' ? (
        <div className="mb-4">
          <FormMessage tone="success">Offer created. Issue codes below, or let a flow or campaign issue them.</FormMessage>
        </div>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-6">
          <Card title="Details">
            <Facts
              items={[
                ['Status', o.isActive ? <Badge tone="good">On</Badge> : <Badge>Off</Badge>],
                ['Kind', OFFER_KINDS[o.kind] ?? o.kind],
                ['Code lasts', `${o.validityDays} days`],
                ['Code prefix', <span className="font-mono">{o.codePrefix}</span>],
                ['Online orders', o.channels.map((ch) => CHANNEL_LABEL[ch] ?? ch).join(', ') || 'None (till only)'],
                ['Venues', o.validVenueIds ? o.validVenueIds.map((v) => c.venues.find((x) => x.id === v)?.name ?? 'another venue').join(', ') : 'Every venue'],
                ['Guest pays', o.priceCents ? money(o.priceCents, c.org.currency) : 'Free'],
                ['Most codes', o.maxCodes?.toLocaleString('en-AU') ?? 'No limit'],
                ['Claim first', o.requiresClaim ? 'Yes' : 'No: ready on issue'],
                ['Creator / campaign', [o.creatorId, o.campaignId].filter(Boolean).join(' / ') || '–'],
              ]}
            />
            {o.description ? <p className="mt-4 text-sm text-ink-2">{o.description}</p> : null}
          </Card>
          {manager ? (
            <Card title="Issue a code" description="A single-use code not yet tied to a guest: print it or hand it over. It binds to whoever claims or uses it.">
              {o.isActive ? (
                <ActionForm action={issueCodeAction}>
                  <input type="hidden" name="offerId" value={o.id} />
                  <SubmitButton pendingLabel="Issuing…">Issue a code</SubmitButton>
                </ActionForm>
              ) : (
                <p className="text-sm text-ink-2">Switch the offer on to issue codes.</p>
              )}
            </Card>
          ) : null}
        </div>
        {manager && codes ? (
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
        ) : null}
      </div>
    </>
  );
}
