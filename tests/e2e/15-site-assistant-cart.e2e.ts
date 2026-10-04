import { afterAll, describe, expect, it } from 'vitest';
import { BASE, closeBrowser, closeDb, db, orgBySlug } from './helpers';
import { siteUrl, visitor } from './site-helpers';

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

let rpcId = 1;

/** One tool call to the public assistant connection, as a guest's assistant makes it: no sign-in. */
async function guestCall(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await fetch(`${BASE()}/api/guest/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': name },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'e2e-guest-assistant', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  const message = JSON.parse(line ? line.slice(5) : text) as { result?: { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> } };
  if (!message.result || message.result.isError) throw new Error(`${name} failed (${res.status}): ${message.result?.content?.[0]?.text ?? text.slice(0, 300)}`);
  return message.result.structuredContent as Record<string, any>;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

describe('venue site: a cart from a guest\'s assistant', () => {
  it('an assistant builds a pickup order through the public connection; its link opens the venue\'s order page with the cart filled in at the server\'s prices, and a tampered link opens an empty cart', async () => {
    const { orgId } = await orgBySlug('oak-diner');
    const venue = await db().selectFrom('venues').select('id').where('org_id', '=', orgId).executeTakeFirstOrThrow();
    const item = async (name: string) => (await db().selectFrom('menu_items').select('id').where('venue_id', '=', venue.id).where('name', '=', name).executeTakeFirstOrThrow()).id;
    const option = async (name: string) => (await db().selectFrom('modifiers').select('id').where('venue_id', '=', venue.id).where('name', '=', name).executeTakeFirstOrThrow()).id;
    const ordersBefore = (await db().selectFrom('orders').select('id').where('venue_id', '=', venue.id).execute()).length;

    // The assistant finds the venue, picks a time and builds the order; the caller's prices are ignored.
    const found = await guestCall('find_venue', { query: 'Oak Diner Surry Hills' });
    expect(found.venues.map((v: { venue_id: string }) => v.venue_id)).toEqual([venue.id]);
    const times = await guestCall('pickup_times', { venue_id: venue.id });
    const slot = times.asap.available ? 'asap' : times.slots[0].start;
    const args = {
      venue_id: venue.id,
      items: [
        { item_id: await item('Wagyu rump 250g'), quantity: 1, option_ids: [await option('Medium rare'), await option('Truffle fries')], price_cents: 100 },
        { item_id: await item('Fries, aioli'), quantity: 2 },
      ],
      pickup_slot: slot,
    };
    const ask = await guestCall('order_start', args);
    expect(ask).toMatchObject({ status: 'confirm_with_guest', checkout_url: null, total_cents: 5100 + 2200 });
    const yes = await guestCall('order_start', { ...args, proposal: ask.proposal });
    expect(yes.status).toBe('ready_to_pay');
    const link = new URL(yes.checkout_url);
    expect(`${link.hostname}${link.pathname}`).toBe('oak-diner.tables.localhost/order');

    // The guest opens it: the venue's own order page, the cart filled in, priced by the server.
    const v = await visitor();
    await v.page.goto(siteUrl('oak-diner', `${link.pathname}${link.search}`));
    await v.page.waitForSelector('[data-assistant-cart=info]');
    await v.page.waitForSelector('[data-total]');
    expect(await v.page.textContent('[data-assistant-cart=info]')).toContain('Your order from your assistant is below, priced by us.');
    const rump = v.page.locator('[data-cart-line="Wagyu rump 250g"]');
    expect(await rump.textContent()).toContain('Medium rare, Truffle fries');
    expect(await rump.textContent()).toContain(money(5100));
    const fries = v.page.locator('[data-cart-line="Fries, aioli"]');
    expect(await fries.textContent()).toContain(money(2200));
    expect(await v.page.textContent('[data-total]')).toBe(money(yes.total_cents));
    // The address no longer carries the link; nothing has been ordered until the guest pays.
    await v.page.waitForFunction(() => !window.location.search.includes('cart='));
    expect((await db().selectFrom('orders').select('id').where('venue_id', '=', venue.id).execute()).length).toBe(ordersBefore);

    // An altered link: said plainly, and the cart is empty.
    const token = link.searchParams.get('cart')!;
    const [, body, sig] = token.split('.') as [string, string, string];
    const tampered = `c1.${body.slice(0, -2)}${body.endsWith('A') ? 'B' : 'A'}${body.slice(-1)}.${sig}`;
    await v.page.goto(siteUrl('oak-diner', `/order?cart=${tampered}`));
    await v.page.waitForSelector('[data-assistant-cart=error]');
    expect(await v.page.textContent('[data-assistant-cart=error]')).toBe('This order link is not valid. You can start your order below.');
    expect(await v.page.locator('[data-cart-line]').count()).toBe(0);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
