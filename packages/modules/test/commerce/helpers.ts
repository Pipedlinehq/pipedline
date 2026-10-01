import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { type DevicePrincipal, type Principal, AppError } from '@ros/core';
import { SIM_PAY_TOKENS } from '@ros/adapters';
import type { FixtureOrg } from '@ros/fixtures';
import type { TestEnv } from '@ros/testkit';
import { auth, menu, ordering } from '@ros/modules';

export const WORKER: Principal = { kind: 'worker', job: 'test' };
export const anon = (sessionId?: string): Principal => ({ kind: 'anon', sessionId });

/**
 * Thursday 1 October 2026, 6:00 pm in Sydney: mid dinner service, a day after the fixtures'
 * "now", so no seeded order occupies a slot and every venue is open.
 */
export const QUIET_EVENING = '2026-10-01T08:00:00.000Z';
/** The 6:30 pm slot that evening. */
export const SLOT_1830 = '2026-10-01T08:30:00.000Z';

export const okCard = (name: string = randomUUID()) => `${SIM_PAY_TOKENS.ok}:${name}`;

export interface MenuIndex {
  all: menu.PublicMenuItem[];
  byName(name: string): menu.PublicMenuItem;
  /** Any item with no required choices and no alcohol: the simplest thing to put in a cart. */
  plain(): menu.PublicMenuItem;
  modifier(item: menu.PublicMenuItem, group: string, name: string): string;
}

export async function menuOf(t: TestEnv, org: FixtureOrg, venueId: string, surface: menu.MenuSurface = 'online'): Promise<MenuIndex> {
  const m = await t.app.tenant(org.orgId, anon(), (ctx) => menu.getPublicMenu(ctx, venueId, { surface }));
  const all = m.menus.flatMap((x) => x.sections.flatMap((s) => s.items));
  const byName = (name: string) => {
    const item = all.find((i) => i.name.startsWith(name));
    if (!item) throw new Error(`No menu item starting "${name}"`);
    return item;
  };
  return {
    all,
    byName,
    plain: () => byName('Fries, aioli'),
    modifier(item, group, name) {
      const m2 = item.modifierGroups.find((g) => g.name === group)?.modifiers.find((x) => x.name === name);
      if (!m2) throw new Error(`No modifier ${group} / ${name} on ${item.name}`);
      return m2.id;
    },
  };
}

export interface Shopper {
  name?: string;
  email?: string;
  phone?: string;
}

export type OrderOverrides = Partial<Parameters<typeof ordering.createOrder>[1]>;

/** Create an order as an anonymous guest: fries by default, ASAP pickup. */
export async function placeOrder(t: TestEnv, org: FixtureOrg, venueId: string, over: OrderOverrides = {}, principal: Principal = anon()): Promise<ordering.OrderView> {
  const items = await menuOf(t, org, venueId, over.channel === 'dine-in-qr' ? 'in_venue' : 'online');
  return t.app.tenant(org.orgId, principal, (ctx) =>
    ordering.createOrder(ctx, {
      venueId,
      channel: 'pickup',
      lines: [{ menuItemId: items.plain().id, qty: 1 }],
      idempotencyKey: `test-${randomUUID()}`,
      customer: over.channel === 'dine-in-qr' ? {} : { name: 'Tess Tester', email: `tess.${randomUUID().slice(0, 8)}@example.com` },
      ...over,
    }),
  );
}

export async function pay(t: TestEnv, org: FixtureOrg, order: ordering.OrderView, sourceToken: string = okCard()): Promise<ordering.PayResult> {
  return ordering.payOrder(t.app, { orgId: org.orgId, principal: anon() }, { trackingToken: order.trackingToken!, sourceToken });
}

/** An order that has been paid: it is in the kitchen. */
export async function paidOrder(t: TestEnv, org: FixtureOrg, venueId: string, over: OrderOverrides = {}, card?: string): Promise<ordering.OrderView> {
  const order = await placeOrder(t, org, venueId, over);
  const r = await pay(t, org, order, card);
  if (r.status !== 'paid') throw new Error(`Expected the payment to succeed, got ${r.status}`);
  return r.order;
}

/** Pair a kitchen (or counter) screen the way a venue does: a manager starts it, the screen types the code. */
export async function pairScreen(t: TestEnv, org: FixtureOrg, venueId: string, purpose: 'kitchen' | 'counter' = 'kitchen'): Promise<DevicePrincipal> {
  const owner = await org.as('owner');
  const pairing = await t.app.tenant(org.orgId, owner, (ctx) => auth.createDevicePairing(ctx, { venueId, name: `${purpose} screen`, purpose }));
  const paired = await auth.pairDevice(t.app, pairing.code);
  const who = await auth.authenticateDevice(t.app, paired.token);
  if (!who) throw new Error('The screen did not authenticate');
  return who.principal;
}

/** What is on record for an order, read straight from the database. */
export async function footprint(t: TestEnv, orderId: string) {
  const order = await t.db.selectFrom('orders').selectAll().where('id', '=', orderId).executeTakeFirstOrThrow();
  const tickets = await t.db.selectFrom('kitchen_tickets').selectAll().where('order_id', '=', orderId).execute();
  const payments = await t.db.selectFrom('payments').selectAll().where('order_id', '=', orderId).orderBy('created_at').execute();
  const transactions = await t.db.selectFrom('transactions').selectAll().where('order_id', '=', orderId).execute();
  const messages = await t.db.selectFrom('messages').selectAll().where('idempotency_key', 'like', `order:${orderId}:%`).execute();
  const history = await t.db.selectFrom('order_status_history').selectAll().where('order_id', '=', orderId).orderBy('at').orderBy(sql`ctid`).execute();
  return { order, tickets, payments, transactions, messages, history };
}

export interface AdjusterLog {
  committed: Array<{ orderId: string; customerId: string | null; transactionId: string | null; code: string }>;
  released: Array<{ orderId: string; code: string }>;
}

/**
 * A checkout adjuster standing in for offers and loyalty, registered through the same contract
 * they use. TENOFF = $10 off. HUGE = more than any order. SPENT = a code that is ours but used.
 */
export function registerTestAdjuster(): AdjusterLog {
  const log: AdjusterLog = { committed: [], released: [] };
  ordering.registerCheckoutAdjuster({
    key: 'test-promo',
    async quote(_ctx, _draft, code) {
      const c = code.toUpperCase();
      if (c === 'TENOFF') return { adjuster: 'test-promo', code: c, label: 'Test promo: $10 off', amountCents: 1000, ref: { promo: 'tenoff' } };
      if (c === 'HUGE') return { adjuster: 'test-promo', code: c, label: 'Test promo: everything off', amountCents: 10_000_000, ref: { promo: 'huge' } };
      if (c === 'SPENT') throw new AppError('invalid', 'That code has already been used.');
      return null;
    },
    async commit(_ctx, args) {
      log.committed.push({ orderId: args.orderId, customerId: args.customerId, transactionId: args.transactionId, code: args.adjustment.code });
    },
    async release(_ctx, args) {
      log.released.push({ orderId: args.orderId, code: args.adjustment.code });
    },
  });
  return log;
}
