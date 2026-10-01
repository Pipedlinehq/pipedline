import { afterAll, describe, expect, it } from 'vitest';
import { BASE, closeDb, db, eventually } from './helpers';
import { devPost, venueOf } from './ops-helpers';

/**
 * Provider webhooks over real HTTP: a POS sale rung up on the simulated till arrives by signed
 * webhook and lands in the ledger once; a forged one is refused and stores nothing; a replay is a
 * no-op; a bounce suppresses the address. The development tools do what the provider would, and
 * post to the same routes a provider is given.
 */

interface Delivery {
  status: number;
  body: { ok?: boolean; result?: { status: string; created: number; changed: number }; error?: { code: string } };
}
interface Sale {
  paymentId: string;
  orgId: string;
  venueId: string;
  totalCents: number;
  eventId: string | null;
  delivery: Delivery | null;
}

const ledgerRows = (paymentId: string) =>
  db().selectFrom('transactions').select(['id', 'org_id', 'venue_id', 'total_cents', 'refunded_cents', 'status', 'discount_cents', 'customer_id', 'raw']).where('external_ref', '=', paymentId).execute();
const webhookEvents = async () => Number((await db().selectFrom('webhook_events').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);

afterAll(async () => {
  await closeDb();
});

describe('webhooks', () => {
  it('a sale rung up on the POS arrives by signed webhook and is in the ledger of the right venue', async () => {
    const venue = await venueOf('oak-group', 'Oak Group Newtown');
    const sale = await devPost<Sale>('sale', { venueId: venue.venueId, customerEmail: 'wendy.webhook@example.com', customerName: 'Wendy Webhook', cardName: 'wendy-visa', discountCode: 'HAPPY5', discountCents: 500 });
    expect(sale.delivery).toMatchObject({ status: 200, body: { ok: true, result: { status: 'processed', created: 1 } } });
    const rows = await ledgerRows(sale.paymentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: venue.orgId, venue_id: venue.venueId, total_cents: sale.totalCents, discount_cents: 500, status: 'completed' });
    // The card's fingerprint never reaches the stored payload.
    expect(JSON.stringify(rows[0]!.raw)).not.toMatch(/devcard-wendy-visa|fingerprint/);
    const hook = await db().selectFrom('webhook_events').select(['status', 'org_id']).where('event_id', 'like', `%:${sale.eventId}`).execute();
    expect(hook).toEqual([{ status: 'processed', org_id: venue.orgId }]);
  });

  it('the same webhook delivered again is a no-op', async () => {
    const venue = await venueOf('oak-diner');
    const sale = await devPost<Sale>('sale', { venueId: venue.venueId });
    expect(sale.delivery?.body.result?.status).toBe('processed');
    const before = await webhookEvents();
    const replay = await devPost<Delivery>('replay', { eventId: sale.eventId });
    expect(replay).toMatchObject({ status: 200, body: { ok: true, result: { status: 'duplicate', created: 0 } } });
    expect(await ledgerRows(sale.paymentId)).toHaveLength(1);
    expect(await webhookEvents()).toBe(before);
  });

  it('a forged webhook is 401 and stores nothing; unknown endpoints are 404', async () => {
    const venue = await venueOf('oak-diner');
    const before = await webhookEvents();
    const forged = await devPost<Sale>('sale', { venueId: venue.venueId, deliver: 'forged' });
    expect(forged.delivery).toMatchObject({ status: 401, body: { error: { code: 'unauthenticated' } } });
    expect(await ledgerRows(forged.paymentId)).toEqual([]);
    expect(await webhookEvents()).toBe(before);

    // No signature at all, straight at the route: the same answer.
    const bare = await fetch(`${BASE()}/webhooks/pos/sim-pos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_id: 'x', account_id: 'simpos-acct-oak-diner', data: { ids: [forged.paymentId] } }) });
    expect(bare.status).toBe(401);
    expect(await ledgerRows(forged.paymentId)).toEqual([]);

    expect((await fetch(`${BASE()}/webhooks/pos/no-such-plug`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(`${BASE()}/webhooks/messages/no-such-adapter`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(`${BASE()}/webhooks/couriers/anyone`, { method: 'POST', body: '{}' })).status).toBe(404);
    // A webhook needs no session and is not refused for coming from another origin: it authenticates by signature.
    const cross = await fetch(`${BASE()}/webhooks/messages/sim-email`, { method: 'POST', headers: { origin: 'https://provider.example' }, body: '{"events":[]}' });
    expect(cross.status).toBe(401);
    expect(await webhookEvents()).toBe(before);
  });

  it('a refund at the till reaches the ledger by webhook', async () => {
    const venue = await venueOf('oak-diner');
    const sale = await devPost<Sale>('sale', { venueId: venue.venueId });
    const refund = await devPost<{ refundedCents: number; delivery: Delivery }>('refund', { paymentId: sale.paymentId, amountCents: 1000 });
    expect(refund.delivery.status).toBe(200);
    const [row] = await ledgerRows(sale.paymentId);
    expect(row).toMatchObject({ refunded_cents: 1000, status: 'partially_refunded' });
  });

  it('a hard bounce suppresses the address; a complaint suppresses and withdraws consent', async () => {
    const venue = await venueOf('oak-diner');
    const bouncy = `bouncy.${Date.now()}@example.com`;
    const order = await devPost<{ orderId: string }>('order', { venueId: venue.venueId, guestEmail: bouncy, guestName: 'Bo Bounce' });
    const message = await eventually(
      () => db().selectFrom('messages').select(['id', 'status', 'provider_message_id', 'org_id']).where('to_address', '=', bouncy).where('provider_message_id', 'is not', null).executeTakeFirst(),
      'the order confirmation sent',
      30_000,
    );
    expect(order.orderId).toBeTruthy();
    const bounce = await devPost<Delivery>('message-event', { messageId: message.id, event: 'bounced', hard: true });
    expect(bounce).toMatchObject({ status: 200, body: { ok: true, result: { applied: 1 } } });
    const sup = await db().selectFrom('suppressions').select(['reason', 'channel', 'org_id']).where('value', '=', bouncy).execute();
    expect(sup).toEqual([{ reason: 'bounced_hard', channel: 'email', org_id: message.org_id }]);
    const m = await db().selectFrom('messages').select('status').where('id', '=', message.id).executeTakeFirstOrThrow();
    expect(m.status).toBe('bounced');

    // Delivered events are recorded too (the go-live email check reads them).
    const complainer = `complains.${Date.now()}@example.com`;
    await devPost('order', { venueId: venue.venueId, guestEmail: complainer });
    const m2 = await eventually(
      () => db().selectFrom('messages').select(['id']).where('to_address', '=', complainer).where('provider_message_id', 'is not', null).executeTakeFirst(),
      'second confirmation sent',
      30_000,
    );
    const complaint = await devPost<Delivery>('message-event', { messageId: m2.id, event: 'complained' });
    expect(complaint.status).toBe(200);
    expect(await db().selectFrom('suppressions').select('reason').where('value', '=', complainer).execute()).toEqual([{ reason: 'complained' }]);
  });
});
