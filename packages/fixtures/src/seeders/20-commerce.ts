import { type App, type Principal, addDays, addMinutes, connect, drainJobs, localDate, setModule, zonedTimeToUtc } from '@ros/core';
import { SIM_PAY_TOKENS } from '@ros/adapters';
import { events, menu, ordering, qr } from '@ros/modules';
import { FIXTURE_ORGS, type SeedOptions } from '../base';
import { CAMPAIGNS, CREATORS, FIRST_NAMES, LAST_NAMES } from '../data';
import type { ModuleSeeder } from '../index';
import type { Fixture, FixtureOrg } from '../load';
import { createRng, type Rng } from '../rng';

/**
 * Menu, ordering, payments and QR for the fixture venues (docs/MODULES.md contract item 5).
 *
 *   - ordering on everywhere; QR on (order and pay) at the dine-in venues, off at the pickup-only one
 *   - a simulated card processor connected per venue
 *   - a code per table, a general menu code, a counter code and a creator's campaign code
 *   - about 80 orders over the last two weeks, placed and paid through the real flow, most
 *     completed, a few rejected or refunded, one card declined, and a handful live "now"
 */

const TZ = 'Australia/Sydney';
const WORKER: Principal = { kind: 'worker', job: 'fixtures' };
const MY_JOBS = ['comms.send', 'ordering.refund', 'ordering.pos_push', 'ordering.expire_unpaid'];
const ORDERS_AT_SCALE_ONE = 80;

interface Planned {
  at: Date;
  venueSlug: string;
  venueId: string;
  dineIn: boolean;
  live: boolean;
  n: number;
}

type PublicItem = menu.PublicMenuItem;

function pickLines(rng: Rng, items: PublicItem[], count: number): Array<{ menuItemId: string; qty: number; modifierIds: string[] }> {
  const lines: Array<{ menuItemId: string; qty: number; modifierIds: string[] }> = [];
  const used = new Set<string>();
  for (let i = 0; i < count; i++) {
    const item = rng.pick(items);
    if (used.has(item.id)) continue;
    used.add(item.id);
    const modifierIds: string[] = [];
    for (const g of item.modifierGroups) {
      const options = g.modifiers.filter((m) => m.isAvailable);
      const need = g.minSelections > 0 ? g.minSelections : rng.chance(0.3) ? 1 : 0;
      for (let k = 0; k < need && k < options.length; k++) modifierIds.push(options[(rng.int(0, options.length - 1) + k) % options.length]!.id);
    }
    lines.push({ menuItemId: item.id, qty: rng.chance(0.2) ? 2 : 1, modifierIds: [...new Set(modifierIds)] });
  }
  return lines;
}

/** A time inside a trading period on a date, early enough that an ASAP order can still be made. */
function serviceMoment(rng: Rng, date: string): Date {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const dinner = weekday !== 0 && rng.chance(0.6);
  const [start, span] = dinner ? [17 * 60 + 30, 215] : [12 * 60, 125];
  const minute = start + rng.int(0, span);
  return zonedTimeToUtc(date, `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`, TZ);
}

async function setUpVenue(app: App, org: FixtureOrg, venueSlug: string, venueId: string, dineIn: boolean): Promise<string[]> {
  return app.tenant(org.orgId, WORKER, async (ctx) => {
    await setModule(ctx, ordering.orderingModule, { venueId, enabled: true, config: { max_orders_per_slot: 8, tipping_enabled: true } });
    await connect(ctx, {
      plugKey: 'sim-pay',
      venueId,
      externalAccountId: `simpay-${org.slug}-${venueSlug}`,
      credentials: { accessToken: `sim-pay-${org.slug}-${venueSlug}` },
      config: { locationRef: `simloc-${venueSlug}` },
    });
    if (!dineIn) {
      // Pickup only: no tables, so no QR. The row exists and is off.
      await setModule(ctx, qr.qrModule, { venueId, enabled: false });
      return [];
    }
    // One venue keeps alcohol out of table ordering, so both settings are exercised.
    await setModule(ctx, qr.qrModule, { venueId, enabled: true, config: { stage: 'order', exclude_alcohol: venueSlug === 'newtown', tipping_enabled: true } });
    const tables = await qr.createTableCodes(ctx, { venueId, labels: Array.from({ length: 12 }, (_, i) => String(i + 1)), area: 'Main room', printBatch: 'fixture-2026-09' });
    await qr.createQrCode(ctx, { venueId, kind: 'menu', targetPath: '/menu', printBatch: 'fixture-2026-09' });
    await qr.createQrCode(ctx, { venueId, kind: 'counter', label: 'Bar', area: 'Bar', printBatch: 'fixture-2026-09' });
    await qr.createQrCode(ctx, { venueId, kind: 'campaign', targetPath: '/offer', creatorId: CREATORS[0], campaignId: CAMPAIGNS[1], printBatch: 'fixture-flyer' });
    return tables.map((t) => t.code);
  });
}

const seeder: ModuleSeeder = {
  module: 'commerce',
  async seed(app: App, fixture: Fixture, opts: SeedOptions): Promise<void> {
    const rng = createRng(2020);
    const scale = opts.scale ?? 1;
    const today = localDate(opts.now, TZ);
    const total = Math.max(12, Math.round(ORDERS_AT_SCALE_ONE * scale));
    const tableCodes = new Map<string, string[]>();
    const plan: Planned[] = [];
    let n = 0;

    for (const spec of FIXTURE_ORGS) {
      const org = spec.slug === fixture.diner.slug ? fixture.diner : fixture.group;
      const orgShare = spec.slug === fixture.diner.slug ? 0.5 : 0.5;
      for (const v of spec.venues) {
        const venueId = org.venues[v.slug]!.id;
        tableCodes.set(venueId, await setUpVenue(app, org, v.slug, venueId, v.dineIn));
        const count = Math.max(3, Math.round(total * orgShare * v.share));
        // A few orders are in the kitchen right now; the rest are history.
        const live = Math.min(3, Math.max(1, Math.round(count * 0.12)));
        for (let i = 0; i < count; i++) {
          n++;
          if (i < live) {
            plan.push({ at: opts.now, venueSlug: v.slug, venueId, dineIn: v.dineIn, live: true, n });
            continue;
          }
          let date = addDays(today, -rng.int(1, 13));
          while (new Date(`${date}T12:00:00Z`).getUTCDay() === 1) date = addDays(date, -1);
          plan.push({ at: serviceMoment(rng, date), venueSlug: v.slug, venueId, dineIn: v.dineIn, live: false, n });
        }
      }
    }
    plan.sort((a, b) => a.at.getTime() - b.at.getTime() || a.n - b.n);

    const menus = new Map<string, PublicItem[]>();
    let placed = 0;
    let history = 0;
    for (const p of plan) {
      const org = Object.values(fixture.diner.venues).some((v) => v.id === p.venueId) ? fixture.diner : fixture.group;
      opts.setNow(p.at);
      const codes = tableCodes.get(p.venueId) ?? [];
      const atTable = p.dineIn && codes.length > 0 && rng.chance(0.45);
      const sessionId = rng.uuid();
      const anon: Principal = { kind: 'anon', sessionId };

      const menuKey = `${p.venueId}:${atTable}`;
      if (!menus.has(menuKey)) {
        const m = await app.tenant(org.orgId, anon, (ctx) => menu.getPublicMenu(ctx, p.venueId, { surface: atTable ? 'in_venue' : 'online' }));
        menus.set(menuKey, m.menus.flatMap((x) => x.sections.flatMap((s) => s.items)).filter((i) => i.isAvailable && !(atTable && p.venueSlug === 'newtown' && i.isAlcohol)));
      }
      const lines = pickLines(rng, menus.get(menuKey)!, rng.int(1, 4));

      const known = atTable ? rng.chance(0.55) : true;
      const first = rng.pick(FIRST_NAMES);
      const last = rng.pick(LAST_NAMES);
      const email = known ? `${first}.${last}.o${p.n}@orders.${org.slug}.example`.toLowerCase() : null;
      const cardBox = known && rng.chance(0.2);
      const consents = [...(known && rng.chance(0.35) ? [{ purpose: 'marketing_email' as const }] : []), ...(cardBox ? [{ purpose: 'card_recognition' as const }] : [])];
      const qrCode = atTable ? rng.pick(codes) : null;

      // Some visits arrive from a creator's post, so orders carry attribution.
      const fromCreator = !atTable && rng.chance(0.2);
      const order = await app.tenant(org.orgId, anon, async (ctx) => {
        if (qrCode) await qr.resolveQrCode(ctx, { code: qrCode, sessionId, deviceClass: 'mobile' });
        else {
          await events.touchSession(ctx, {
            sessionId,
            venueId: p.venueId,
            landingPath: '/menu',
            deviceClass: 'mobile',
            ...(fromCreator ? { utmSource: 'criota', utmMedium: 'social', creatorId: rng.pick(CREATORS), campaignId: rng.pick(CAMPAIGNS) } : {}),
          });
        }
        return ordering.createOrder(ctx, {
          venueId: p.venueId,
          channel: atTable ? 'dine-in-qr' : 'pickup',
          qrCode,
          lines,
          tipCents: rng.chance(0.15) ? 300 : 0,
          idempotencyKey: `fixture-order-${org.slug}-${String(p.n).padStart(4, '0')}`,
          customer: known ? { name: `${first} ${last}`, email } : {},
          note: rng.chance(0.12) ? rng.pick(['No onion please', 'Sauce on the side', 'Running 5 minutes late', 'Allergic to sesame']) : null,
          sessionId,
          consents,
          flags: known && rng.chance(0.25) ? ['loyalty_join'] : [],
        });
      });

      // What becomes of each past order is decided by its position, so every outcome is always
      // present: most are completed, and a few are declined, rejected, or refunded in full or in part.
      const k = p.live ? -1 : history++;
      const declined = k % 23 === 3;
      const paid = await ordering.payOrder(
        app,
        { orgId: org.orgId, principal: anon },
        { trackingToken: order.trackingToken!, sourceToken: declined ? SIM_PAY_TOKENS.decline : `${SIM_PAY_TOKENS.ok}:fixture-${org.slug}-${p.n}` },
      );
      // The worker catches up every few orders: confirmations, POS pushes, refunds, lapsed checkouts.
      if (++placed % 4 === 0) await drainJobs(app, { kinds: MY_JOBS });
      if (paid.status !== 'paid') continue;

      const staff = <T>(fn: Parameters<typeof app.tenant<T>>[2]) => app.tenant(org.orgId, WORKER, fn);
      // Read outside a tenant: the seeder only needs the id of the ticket the payment just made.
      const ticket = await app.db.selectFrom('kitchen_tickets').select('id').where('order_id', '=', order.id).executeTakeFirstOrThrow();
      const tap = (event: (typeof ordering.SCREEN_EVENTS)[number]) => staff((ctx) => ordering.recordTicketEvent(ctx, { ticketId: ticket.id, event, key: `fixture-${order.id}-${event}` }));

      if (p.live) {
        // Left where a kitchen would have them at noon: one new and unacknowledged, the rest under way.
        const stage = p.n % 3;
        if (stage >= 1) await tap('acknowledged');
        if (stage === 2) await tap('ready');
        continue;
      }

      if (k % 17 === 5) {
        await staff((ctx) => ordering.rejectOrder(ctx, order.id, rng.pick(['We have sold out of the main you ordered.', 'The kitchen is closing early tonight.'])));
      } else {
        opts.setNow(addMinutes(p.at, 2));
        await tap('viewed');
        await tap('acknowledged');
        opts.setNow(addMinutes(p.at, rng.int(14, 26)));
        await tap('ready');
        opts.setNow(addMinutes(p.at, rng.int(27, 38)));
        await tap('bumped');
        const full = k % 13 === 7;
        if (full || k % 19 === 11) {
          // A complaint afterwards: refunded in full, or a few dollars back for a missing item.
          await ordering.refundOrder(
            app,
            { orgId: org.orgId, principal: WORKER },
            {
              orderId: order.id,
              reason: full ? 'Guest reported the order was wrong.' : 'One item was missing.',
              idempotencyKey: `fixture-refund-${p.n}`,
              ...(full ? {} : { amountCents: Math.max(100, Math.round(order.totalCents / 4)) }),
            },
          );
        }
      }
    }

    opts.setNow(opts.now);
    await drainJobs(app, { kinds: MY_JOBS });
  },
};

export default seeder;
