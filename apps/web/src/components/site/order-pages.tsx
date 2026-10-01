import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { delivery, identity, loyalty, menu, ordering, tenancy } from '@ros/modules';
import { app, sim } from '@/lib/runtime';
import { getVisitor, onSite } from '@/lib/site';
import { loadScope, optional, scopedHref, siteCall } from '@/lib/site-scope';
import { readTable } from '@/lib/site-table';
import { VenuePicker } from './blocks';
import { LiveRefresh } from './client-bits';
import { ORDER_STATUS_WORDS, cx, dateTimeIn, money, timeIn } from './format';
import { OrderApp, type OrderAppProps } from './order/order-app';
import { PayPanel } from './order/pay-panel';
import { TableBanner, pageMetadata } from './site-pages';
import type { SearchParams } from './site-pages';

// ── /order ──────────────────────────────────────────────────────────────────

export async function orderMetadata(host: string, venueSlug: string | null): Promise<Metadata> {
  const scope = await loadScope(host, venueSlug);
  return pageMetadata(scope, { title: `Order | ${scope.venue?.name ?? scope.view.org.name}`, path: '/order', noindex: true });
}

export async function OrderRoute({ host, venueSlug, searchParams }: { host: string; venueSlug: string | null; searchParams: SearchParams }) {
  const scope = await loadScope(host, venueSlug);
  const venue = scope.venue;
  if (!venue) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-12 sm:px-6">
        <h1 className="s-heading">Order</h1>
        <VenuePicker scope={scope} path="/order" verb="Order from" />
      </div>
    );
  }
  const table = await readTable(venue.id);
  const atTable = !!table?.canOrder;
  const { site } = scope;
  const { principal, customerId } = await getVisitor(site.orgId);
  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim();

  const checkout = await optional(ordering.getCheckoutOptions(app(), { orgId: site.orgId, principal, ip }, venue.id));
  const unavailable = (why: string) => (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-16 sm:px-6">
      <h1 className="s-heading">Order from {venue.name}</h1>
      <p>{why}</p>
      <p>
        <Link href={scopedHref(scope.basePath, '/menu')} className="s-btn-outline">
          See the menu
        </Link>
      </p>
    </div>
  );
  if (!checkout) return unavailable('Online ordering is not available here.');
  const delivers = !atTable && scope.view.enabledModules.includes('delivery') && (await optional(onSite(host, (ctx) => delivery.assertDelivery(ctx, venue.id)))) !== null;
  if (!atTable && !checkout.pickupEnabled && !delivers) return unavailable(table ? 'Ask our staff when you are ready to order.' : 'Ordering for pickup is not available here right now.');

  const data = await siteCall(host, async (ctx) => {
    const m = await menu.getPublicMenu(ctx, venue.id, { surface: atTable ? 'in_venue' : 'online' });
    const guest = customerId ? await optional(identity.getCustomer(ctx, customerId)) : null;
    let loyaltyProps: OrderAppProps['loyalty'] = null;
    if (scope.view.enabledModules.includes('loyalty')) {
      if (customerId) {
        const mine = await optional(loyalty.getMyLoyalty(ctx, { venueId: venue.id }));
        if (mine?.program) {
          loyaltyProps = {
            programName: mine.program.name,
            joinable: !mine.member,
            member: mine.member ? { available: mine.member.available } : null,
            rewards: mine.member ? mine.rewards.map((r) => ({ code: r.checkoutCode, name: r.name, description: r.description, costPoints: r.costPoints, canAfford: r.canAfford, blockedReason: r.blockedReason })) : [],
          };
        }
      } else {
        const program = await optional(loyalty.getProgram(ctx));
        if (program) loyaltyProps = { programName: program.name, joinable: true, member: null, rewards: [] };
      }
    }
    return { m, guest, loyaltyProps };
  });

  // With simulated providers there is no address autocomplete to supply a point, so the page
  // offers test addresses at known distances from the venue. Never in production.
  const offset = (northM: number, eastM: number) => ({ lat: (venue.lat ?? 0) + northM / 111_000, lng: (venue.lng ?? 0) + eastM / 92_000 });
  const testAddresses =
    delivers && sim() && venue.lat !== null && venue.lng !== null
      ? [
          { label: 'Nearby: 12 Test Lane (about 1 km)', line1: '12 Test Lane', line2: '', suburb: venue.suburb ?? 'Sydney', state: venue.state ?? 'NSW', postcode: venue.postcode ?? '2000', ...offset(900, 400) },
          { label: 'Further out: 80 Test Road (about 4.5 km)', line1: '80 Test Road', line2: 'Unit 3', suburb: venue.suburb ?? 'Sydney', state: venue.state ?? 'NSW', postcode: venue.postcode ?? '2000', ...offset(4200, 1500) },
          { label: 'Too far: 1 Far Away Street (about 30 km)', line1: '1 Far Away Street', line2: '', suburb: 'Penrith', state: 'NSW', postcode: '2750', ...offset(3000, -28_000) },
        ]
      : null;

  const code = typeof searchParams.code === 'string' ? searchParams.code.slice(0, 60) : null;
  const next = scopedHref(scope.basePath, '/order');
  return (
    <>
      {table ? <TableBanner table={table} scope={scope} /> : null}
      <div className="mx-auto max-w-6xl px-4 pt-8 sm:px-6">
        <h1 className="s-heading">{atTable ? `Order to ${table?.label ? `table ${table.label}` : 'your table'}` : delivers ? (checkout.pickupEnabled ? 'Order for pickup or delivery' : 'Order for delivery') : 'Order for pickup'}</h1>
        <p className="mt-1">
          {venue.name}
          {atTable ? '. Each order is its own round; order again any time.' : scope.openNow ? '. The kitchen is open.' : '. The kitchen is closed right now; you can order ahead for a later time.'}
        </p>
      </div>
      <OrderApp
        venue={{ id: venue.id, name: venue.name, timezone: venue.timezone }}
        channel={atTable ? 'dine-in-qr' : 'pickup'}
        delivery={delivers ? { testAddresses } : null}
        pickupEnabled={checkout.pickupEnabled}
        table={atTable ? { label: table!.label, area: table!.area } : null}
        menu={data.m}
        excludeAlcohol={atTable && table!.excludeAlcohol}
        showPrices={atTable ? table!.showPrices : true}
        payment={checkout.payment}
        promoCodesEnabled={checkout.promoCodesEnabled}
        consents={checkout.consentWordings}
        loyalty={data.loyaltyProps}
        guest={data.guest ? { name: [data.guest.firstName, data.guest.lastName].filter(Boolean).join(' '), email: data.guest.email ?? '', phone: data.guest.phone ?? '' } : null}
        signInHref={`/account/login?next=${encodeURIComponent(next)}`}
        initialCode={code}
        prompts={table?.prompts ?? { receiptEmail: true, loyalty: true }}
      />
    </>
  );
}

// ── /order/t/<token> ────────────────────────────────────────────────────────

const STEPS: Array<{ key: string; label: string }> = [
  { key: 'placed', label: 'Paid and sent' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'preparing', label: 'Being prepared' },
  { key: 'ready', label: 'Ready' },
  { key: 'completed', label: 'Collected' },
];
const DELIVERY_STEP: Record<string, string> = {
  quoted: 'Order placed',
  requested: 'Looking for a courier',
  courier_assigned: 'Courier on the way to the venue',
  picked_up: 'Picked up',
  delivered: 'Delivered',
  failed: 'Could not be delivered',
  returned: 'Returned to the venue',
  cancelled: 'Delivery cancelled',
};
const RANK: Record<string, number> = { placed: 0, accepted: 1, preparing: 2, ready: 3, completed: 4 };

export function trackMetadata(): Metadata {
  return { title: 'Your order', robots: { index: false, follow: false } };
}

export async function TrackRoute({ host, token }: { host: string; token: string }) {
  const scope = await loadScope(host);
  const { order, venue, payment, drop } = await siteCall(host, async (ctx, site) => {
    const o = await ordering.trackOrder(ctx, decodeURIComponent(token));
    const v = await tenancy.getVenue(ctx, o.venueId);
    const { principal } = await getVisitor(site.orgId);
    const p = o.awaitingPayment ? (await optional(ordering.getCheckoutOptions(app(), { orgId: site.orgId, principal }, o.venueId)))?.payment ?? null : null;
    const d = o.channel === 'delivery' ? await optional(delivery.getDeliveryTracking(ctx, decodeURIComponent(token))) : null;
    return { order: o, venue: v, payment: p, drop: d };
  });
  const tz = venue.timezone;
  const terminal = ['rejected', 'cancelled', 'refunded', 'completed'].includes(order.status);
  const rank = RANK[order.status] ?? -1;
  const table = order.channel === 'dine-in-qr';
  const venueBase = scope.view.venues.length > 1 && !scope.site.venueId ? `/at/${venue.slug}` : '';
  const headline = order.awaitingPayment
    ? 'Waiting for payment'
    : order.status === 'ready'
      ? table
        ? 'Your order is on its way to the table'
        : order.channel === 'delivery'
          ? 'Your order is ready for the courier'
          : 'Your order is ready to collect'
      : (ORDER_STATUS_WORDS[order.status] ?? order.status);

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-4 py-10 sm:px-6">
      {/* Tracking is rate-limited per device; this pace stays well inside it. */}
      <LiveRefresh active={!terminal || (!!drop && !['delivered', 'failed', 'returned', 'cancelled'].includes(drop.status))} seconds={drop ? 15 : 10} />
      <div className="space-y-2">
        <p className="text-sm">
          Order <span className="s-tabular font-semibold" data-reference>{order.reference}</span> at {venue.name}
          {order.tableLabel ? `, table ${order.tableLabel}` : ''}
        </p>
        <h1 className="s-heading" aria-live="polite" data-status={order.status}>
          {order.firstName && !order.awaitingPayment && !terminal ? `Thanks, ${order.firstName}. ` : ''}
          {headline}
        </h1>
        {!terminal && !order.awaitingPayment && order.promisedAt ? (
          <p className="text-lg">
            {table ? 'Expected about' : order.channel === 'delivery' ? 'Leaving the kitchen at about' : order.requestedAsap ? 'Ready at about' : 'Ready for pickup at'} <strong>{timeIn(order.promisedAt, tz)}</strong>
            {order.requestedAsap ? '' : ` (${dateTimeIn(order.promisedAt, tz)})`}.
          </p>
        ) : null}
        {order.rejectedReason ? <p className="s-notice">{order.rejectedReason}</p> : null}
        {!terminal ? <p className="text-sm">This page updates by itself.</p> : null}
      </div>

      {order.awaitingPayment ? (
        <PayPanel trackingToken={decodeURIComponent(token)} totalLabel={money(order.totalCents, order.currency)} payment={payment} />
      ) : !['rejected', 'cancelled', 'refunded'].includes(order.status) ? (
        <ol className="grid gap-2 sm:grid-cols-5" aria-label="Progress">
          {STEPS.filter((s) => !(table && s.key === 'completed')).map((s) => (s.key === 'completed' && order.channel === 'delivery' ? { ...s, label: 'Delivered' } : s)).map((s) => {
            const done = rank >= (RANK[s.key] ?? 99);
            const current = RANK[s.key] === rank;
            return (
              <li key={s.key} className={cx('rounded-[var(--brand-radius-md)] border-2 px-3 py-2 text-sm', done ? 'font-semibold' : 's-rule')} style={done ? { borderColor: 'var(--brand-color-text)' } : undefined} aria-current={current ? 'step' : undefined}>
                <span aria-hidden="true">{done ? '✓ ' : '○ '}</span>
                {s.label}
                <span className="sr-only">{done ? ' (done)' : ' (not yet)'}</span>
              </li>
            );
          })}
        </ol>
      ) : null}

      {drop && !order.awaitingPayment ? (
        <section aria-labelledby="delivery-h" className="s-card space-y-2 p-5" data-delivery-status={drop.status}>
          <h2 id="delivery-h" className="s-heading text-xl">
            Delivery: <span aria-live="polite">{drop.label}</span>
          </h2>
          {drop.deliveredAt ? (
            <p>Delivered at {timeIn(drop.deliveredAt, tz)}.</p>
          ) : drop.dropoffEta ? (
            <p>
              Expected at about <strong>{timeIn(drop.dropoffEta, tz)}</strong>.
            </p>
          ) : null}
          {drop.courierFirstName ? <p>Your courier is {drop.courierFirstName}.</p> : null}
          {drop.trackingUrl && /^https:\/\//.test(drop.trackingUrl) ? (
            <p>
              <a href={drop.trackingUrl} className="s-link" target="_blank" rel="noopener noreferrer">
                Follow the courier on a map
              </a>
            </p>
          ) : null}
          {drop.steps.length > 1 ? (
            <ol className="space-y-1 text-sm">
              {drop.steps.map((st, i) => (
                <li key={i}>
                  {timeIn(st.at, tz)}: {DELIVERY_STEP[st.status] ?? st.status}
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="items-h" className="s-card space-y-3 p-5">
        <h2 id="items-h" className="s-heading text-xl">
          What you ordered
        </h2>
        <ul className="divide-y divide-[var(--brand-color-border)]">
          {order.items.map((i, n) => (
            <li key={n} className="flex justify-between gap-4 py-2">
              <span>
                {i.qty} × {i.name}
                {i.modifiers.length ? <span className="block text-sm">{i.modifiers.map((m) => m.name).join(', ')}</span> : null}
                {i.note ? <span className="block text-sm">Note: {i.note}</span> : null}
              </span>
              <span className="s-tabular">{money(i.lineTotalCents, order.currency)}</span>
            </li>
          ))}
        </ul>
        <dl className="space-y-1 border-t pt-3 s-rule s-tabular">
          {order.adjustments.map((a) => (
            <div key={a.label} className="flex justify-between gap-3">
              <dt>{a.label}</dt>
              <dd>−{money(a.amountCents, order.currency)}</dd>
            </div>
          ))}
          {order.channel === 'delivery' ? (
            <div className="flex justify-between">
              <dt>Delivery</dt>
              <dd>{order.deliveryFeeCents ? money(order.deliveryFeeCents, order.currency) : 'Free'}</dd>
            </div>
          ) : null}
          {order.tipCents ? (
            <div className="flex justify-between">
              <dt>Tip</dt>
              <dd>{money(order.tipCents, order.currency)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between font-semibold">
            <dt>Total</dt>
            <dd>{money(order.totalCents, order.currency)}</dd>
          </div>
          {order.refundedCents ? (
            <div className="flex justify-between">
              <dt>Refunded</dt>
              <dd>{money(order.refundedCents, order.currency)}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      <div className="flex flex-wrap gap-3">
        {table && !order.awaitingPayment ? (
          <Link href={`${venueBase}/order`} className="s-btn">
            Order another round
          </Link>
        ) : null}
        <Link href={venueBase || '/'} className="s-btn-outline">
          Back to {venue.name}
        </Link>
      </div>
    </div>
  );
}
