import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  type App,
  type ConnectionRow,
  type CourierQuote,
  type CourierQuoteRequest,
  AppError,
  addMinutes,
  adapterFor,
  assertModule,
  conflict,
  getModule,
  invalid,
  json,
  rateLimit,
  resolveConnection,
  track,
} from '@ros/core';
import { type Actor } from '../ordering/payment';
import { orderingModule } from '../ordering/module';
import { registerDeliveryPricing } from '../ordering/contract';
import { orderAmounts } from '../ordering/fulfilment';
import { getVenue } from '../tenancy/venues';
import { type DeliveryConfig, deliveryModule, deliveryQuoted } from './module';
import { courierConnections, deliveryConfigAt } from './rows';
import { assertAddressPoint, guestFee, zoneFor } from './zones';

const notOffered = () => new AppError('module_disabled', 'That is not available at this venue.');

/** Delivery is on at the venue: the module, and the venue's own pause switch. */
export async function assertDelivery(ctx: Parameters<typeof assertModule>[0], venueId: string): Promise<DeliveryConfig> {
  const cfg = await assertModule(ctx, venueId, deliveryModule);
  if (!cfg.delivery_enabled) throw notOffered();
  return cfg;
}

export const addressInput = z.object({
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).nullish(),
  suburb: z.string().trim().min(2).max(100),
  state: z.string().trim().min(2).max(40),
  postcode: z.string().trim().regex(/^[0-9A-Za-z -]{3,10}$/),
  country: z.string().trim().length(2).default('AU'),
  /** From the address picker. Needed to check the address is in a delivery zone. */
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
});

export const quoteInput = z.object({
  venueId: z.string().uuid(),
  address: addressInput,
  /** Guest-written, for the courier: gate code, unit number. Text, never markup. */
  notes: z.string().trim().max(280).nullish(),
  /** The cart's subtotal as the checkout page last priced it. Used to show a fee now; the fee is worked out again from the server's own price when the order is made. */
  subtotalCents: z.number().int().min(0).max(100_000_000).default(0),
  containsAlcohol: z.boolean().default(false),
  /** The pickup slot chosen, if not as soon as possible. */
  readyAt: z.string().datetime().nullish(),
});

export interface DeliveryQuoteView {
  /** Pass to priceCart / createOrder as `deliveryId`. */
  deliveryId: string;
  /** What the guest will pay for delivery on the cart as priced. */
  feeCents: number;
  currency: string;
  expiresAt: Date;
  dropoffEta: Date | null;
  zoneName: string;
}

/**
 * Checkout: is this address delivered to, and for how much? Public, no role check; the org
 * comes from the host. A provider call, so not one transaction (CLAUDE.md rule 3): the address
 * and zone are checked, the preferred courier is asked (the next one if it has no courier or
 * cannot be reached), and the quote is saved as a delivery in status `quoted`. Rate-limited per
 * address and per venue. The quote expires when the provider's does; ordering refuses it after.
 */
export async function quoteDelivery(app: App, actor: Actor, raw: z.input<typeof quoteInput>): Promise<DeliveryQuoteView> {
  const input = quoteInput.parse(raw);
  const internal = actor.principal.kind === 'worker' || actor.principal.kind === 'platform';
  if (!internal && actor.ip) await rateLimit(app, `delivery-quote:ip:${actor.ip}`, { limit: 30, windowSeconds: 600 }, 'Too many address checks from this device. Try again shortly.');

  const prep = await app.tenant(
    actor.orgId,
    actor.principal,
    async (ctx) => {
      const cfg = await assertDelivery(ctx, input.venueId);
      if (!internal) await rateLimit(ctx.app, `delivery-quote:venue:${input.venueId}`, { limit: 900, windowSeconds: 600 }, 'Delivery is busy right now. Try again shortly.');
      const point = assertAddressPoint(input.address.lat, input.address.lng);
      const venue = await getVenue(ctx, input.venueId);
      const zone = await zoneFor(ctx, venue, cfg, point);
      if (!zone) throw invalid('Sorry, that address is outside our delivery area.');
      if (input.containsAlcohol && !cfg.alcohol_enabled) throw invalid('Alcohol cannot be delivered from here. Remove it, or choose pickup.');
      const ordering = await getModule(ctx, input.venueId, orderingModule);
      const now = ctx.now();
      const wanted = input.readyAt ? new Date(input.readyAt) : null;
      const readyAt = wanted && wanted > now ? wanted : addMinutes(now, ordering.config.lead_time_minutes);
      const conns = await courierConnections(ctx, input.venueId, cfg.failover_to_next_provider ? cfg.providers : cfg.providers.slice(0, 1));
      if (!conns.length) throw new AppError('unavailable', 'Delivery is not set up at this venue yet.');
      return { cfg, point, venue, zone, readyAt, conns };
    },
    { ip: actor.ip, requestId: actor.requestId },
  );

  const { venue, cfg, zone } = prep;
  const request: CourierQuoteRequest = {
    pickup: {
      name: venue.name,
      phone: venue.phone,
      address: { line1: venue.addressLine1 ?? venue.name, line2: venue.addressLine2, suburb: venue.suburb ?? '', state: venue.state ?? '', postcode: venue.postcode ?? '', country: 'AU', lat: venue.lat, lng: venue.lng },
    },
    dropoff: {
      name: 'Guest',
      address: { ...input.address, line2: input.address.line2 ?? null, lat: prep.point.lat, lng: prep.point.lng },
      notes: input.notes ?? null,
    },
    readyAt: prep.readyAt,
    orderValueCents: input.subtotalCents,
    containsAlcohol: input.containsAlcohol,
  };

  let chosen: { provider: string; conn: ConnectionRow; quote: CourierQuote } | null = null;
  for (const { provider, conn } of prep.conns) {
    try {
      const adapter = adapterFor(app, 'courier', conn);
      if (input.containsAlcohol && !adapter.supportsAlcohol) continue;
      const quote = await adapter.quote(await resolveConnection(app, conn), request);
      if (quote) {
        chosen = { provider, conn, quote };
        break;
      }
    } catch (e) {
      // One provider down is not the guest's problem while another can quote.
      app.log.warn('delivery: quote failed', { orgId: actor.orgId, provider, error: (e as Error).message?.slice(0, 300) });
    }
  }
  if (!chosen) throw new AppError('unavailable', 'No courier can take a delivery to that address right now. You can order for pickup instead.');
  const c = chosen;

  return app.tenant(
    actor.orgId,
    actor.principal,
    async (ctx) => {
      const rule = zone.feeRule ?? cfg.fee_rule;
      const fee = guestFee(rule, c.quote.feeCents, input.subtotalCents);
      const row = await ctx.db
        .insertInto('deliveries')
        .values({
          org_id: ctx.orgId,
          venue_id: input.venueId,
          provider: c.provider,
          connection_id: c.conn.id,
          quote_id: c.quote.quoteId,
          quote_expires_at: c.quote.expiresAt,
          courier_fee_cents: c.quote.feeCents,
          customer_fee_cents: fee,
          status: 'quoted',
          pickup_eta: c.quote.pickupEta,
          dropoff_eta: c.quote.dropoffEta,
          dropoff_address: json({ line1: input.address.line1, line2: input.address.line2 ?? null, suburb: input.address.suburb, state: input.address.state, postcode: input.address.postcode, country: input.address.country }),
          dropoff_lat: prep.point.lat,
          dropoff_lng: prep.point.lng,
          dropoff_notes: input.notes?.length ? input.notes : null,
          contains_alcohol: input.containsAlcohol,
          order_value_cents: input.subtotalCents,
          attempted_providers: [c.provider],
          idempotency_key: `quote:${randomUUID()}`,
          created_at: ctx.now(),
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      await ctx.db.insertInto('delivery_status_history').values({ org_id: ctx.orgId, delivery_id: row.id, from_status: null, to_status: 'quoted', at: ctx.now(), source: 'quote', raw: null }).execute();
      await track(ctx, deliveryQuoted, { delivery_id: row.id, provider: c.provider, courier_fee_cents: c.quote.feeCents, customer_fee_cents: fee }, { venueId: input.venueId });
      return { deliveryId: row.id, feeCents: fee, currency: c.quote.currency.toUpperCase(), expiresAt: c.quote.expiresAt, dropoffEta: c.quote.dropoffEta, zoneName: zone.name };
    },
    { ip: actor.ip, requestId: actor.requestId },
  );
}

/**
 * Ordering's side of checkout (ordering/contract.ts). The fee is worked out here from the cart
 * the server priced, never from what the browser was shown. A quote is used by one order only.
 */
registerDeliveryPricing({
  async getQuote(ctx, { deliveryId, venueId, subtotalCents, containsAlcohol }) {
    const cfg = await assertDelivery(ctx, venueId);
    const d = await ctx.db.selectFrom('deliveries').selectAll().where('id', '=', deliveryId).where('venue_id', '=', venueId).executeTakeFirst();
    // Unknown, another org's (row-level security), another venue's, or already used by an order.
    if (!d || d.status !== 'quoted' || d.order_id || !d.quote_expires_at) return null;
    const venue = await getVenue(ctx, venueId);
    const zone = d.dropoff_lat !== null && d.dropoff_lng !== null ? await zoneFor(ctx, venue, cfg, { lat: d.dropoff_lat, lng: d.dropoff_lng }) : null;
    const subtotal = subtotalCents ?? d.order_value_cents;
    const min = zone?.minOrderCents || cfg.min_order_cents;
    let issue: string | null = null;
    if (!zone) issue = 'Sorry, that address is no longer in our delivery area.';
    else if (containsAlcohol && !cfg.alcohol_enabled) issue = 'Alcohol cannot be delivered from here. Remove it, or choose pickup.';
    else if (containsAlcohol && !d.contains_alcohol) issue = 'Your order has alcohol in it now. Check the address again so the courier knows.';
    else if (subtotal < min) issue = `The smallest order we deliver is $${(min / 100).toFixed(2)}.`;
    const fee = guestFee(zone?.feeRule ?? cfg.fee_rule, d.courier_fee_cents, subtotal);
    return { customerFeeCents: fee, expiresAt: d.quote_expires_at, dropoffEta: d.dropoff_eta, issue };
  },

  async attachToOrder(ctx, { deliveryId, orderId }) {
    const d = await ctx.db.selectFrom('deliveries').select(['id', 'venue_id', 'status', 'order_id']).where('id', '=', deliveryId).forUpdate().executeTakeFirst();
    if (!d || d.status !== 'quoted' || (d.order_id && d.order_id !== orderId)) throw conflict('That delivery quote has already been used. Check the address again.');
    // What the order was priced at, from ordering: the fee the guest pays is the server's, not the quote page's.
    const o = await orderAmounts(ctx, orderId);
    if (o.venueId !== d.venue_id) throw conflict('That delivery quote is for another venue.');
    await ctx.db
      .updateTable('deliveries')
      .set({ order_id: orderId, customer_fee_cents: o.deliveryFeeCents, order_value_cents: o.goodsCents, customer_id: o.customerId })
      .where('id', '=', d.id)
      .execute();
  },
});

export { deliveryConfigAt };
