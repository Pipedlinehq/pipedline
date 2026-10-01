import { mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { auth } from '@ros/modules';
import { BASE, type Watched, closeBrowser, closeDb, db, eventually, newVisitor } from './helpers';
import { SHOTS, closeOpsApp, devPost, opsApp, realProblems, staffAs, venueOf } from './ops-helpers';

/**
 * The kitchen order screen, end to end: paired with a code a manager made, live tickets without
 * a refresh, taps recorded once each, taps made offline replayed once on reconnect, a revoked
 * screen sent back to pairing, and one venue's screen unable to read another venue's tickets.
 */

const TABLET = { width: 1280, height: 800 };

async function newTablet(): Promise<Watched> {
  const v = await newVisitor();
  await v.page.setViewportSize(TABLET);
  return v;
}

/** A manager makes the pairing code in the console (auth.createDevicePairing); the screen types it in. */
async function pairScreen(page: Page, orgSlug: string, manager: string, venueName?: string): Promise<{ deviceId: string; venueId: string; orgId: string }> {
  const venue = await venueOf(orgSlug, venueName);
  const m = await staffAs(manager, orgSlug);
  const app = await opsApp();
  const pairing = await app.tenant(m.orgId, m.principal, (ctx) => auth.createDevicePairing(ctx, { venueId: venue.venueId, name: 'Pass screen', purpose: 'kitchen' }));
  await page.goto(`${BASE()}/kitchen`);
  await page.waitForLoadState('networkidle');
  await page.fill('input[name=code]', pairing.code.toLowerCase());
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=kitchen-screen]');
  return { deviceId: pairing.deviceId, venueId: venue.venueId, orgId: m.orgId };
}

const ticketOf = async (orderId: string) => db().selectFrom('kitchen_tickets').select(['id', 'status', 'ticket_number']).where('order_id', '=', orderId).executeTakeFirst();
const screenEvents = async (ticketId: string) =>
  (await db().selectFrom('ticket_events').select(['event', 'idempotency_key', 'device_id']).where('ticket_id', '=', ticketId).where('idempotency_key', 'like', 'screen:%').where('event', '!=', 'viewed').orderBy('seq').execute());
const card = (page: Page, ticketId: string) => page.locator(`[data-testid=ticket][data-ticket-id="${ticketId}"]`);

/** Pages through the screen, the way a cook would, until the ticket is in view. It arrives by polling, so keep looking for a while. */
async function showTicket(page: Page, ticketId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const prev = page.locator('button[aria-label="Previous page"]');
  const next = page.locator('button[aria-label="Next page"]');
  while (Date.now() < deadline) {
    if (await card(page, ticketId).isVisible()) return;
    while (await prev.isEnabled()) await prev.click();
    for (let i = 0; i < 10; i++) {
      if (await card(page, ticketId).isVisible()) return;
      if (!(await next.isEnabled())) break;
      await next.click();
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`ticket ${ticketId} never appeared on the screen`);
}

async function tap(page: Page, ticketId: string, action: string): Promise<void> {
  await showTicket(page, ticketId);
  await card(page, ticketId).locator(`[data-action=${action}]`).click();
}

beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

afterAll(async () => {
  await closeBrowser();
  await closeOpsApp();
  await closeDb();
});

describe('kitchen screen', () => {
  let screen: Watched;
  let paired: { deviceId: string; venueId: string; orgId: string };

  it('pairs with a code a manager made, and keeps the token out of reach of page script', async () => {
    screen = await newTablet();
    await screen.page.goto(`${BASE()}/kitchen`);
    await screen.page.waitForLoadState('networkidle');
    await screen.page.screenshot({ path: `${SHOTS}/kitchen-pairing.png`, caret: 'initial' });

    // A wrong code is refused in words.
    await screen.page.fill('input[name=code]', 'ZZZZZZZZ');
    await screen.page.click('button[type=submit]');
    await screen.page.waitForSelector('main [role=alert]');
    expect(await screen.page.textContent('main [role=alert]')).toMatch(/not right|expired/);

    paired = await pairScreen(screen.page, 'oak-diner', 'manager@oak-diner.test');
    const cookie = (await screen.context.cookies()).find((c) => c.name === 'ros_device')!;
    expect(cookie.httpOnly).toBe(true);
    expect(await screen.page.evaluate(() => document.cookie)).not.toContain('ros_d_');
    const device = await db().selectFrom('devices').select(['paired_at', 'token_hash', 'venue_id', 'purpose']).where('id', '=', paired.deviceId).executeTakeFirstOrThrow();
    expect(device).toMatchObject({ venue_id: paired.venueId, purpose: 'kitchen' });
    expect(device.paired_at).not.toBeNull();
    expect(device.token_hash).not.toBeNull();
    // The fixture's live tickets for this venue are on screen.
    await eventually(async () => (await screen.page.locator('[data-testid=ticket]').count()) > 0, 'tickets on screen');
  });

  it('shows a new paid order without a refresh, with its allergens, and alerts until acknowledged', async () => {
    const page = screen.page;
    await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
    const order = await devPost<{ orderId: string; reference: string }>('order', { venueId: paired.venueId, guestName: 'Ari Allergen', note: 'Severe peanut allergy, please check everything' });
    const ticket = await eventually(() => ticketOf(order.orderId), 'the ticket row');
    await showTicket(page, ticket.id);
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
    await expect.poll(() => page.locator('[data-testid=new-alert]').isVisible()).toBe(true);

    const c = card(page, ticket.id);
    expect(await c.getAttribute('data-status')).toBe('new');
    expect(await c.locator('[data-testid=ticket-allergens]').textContent()).toMatch(/ALLERGENS/i);
    expect(await c.locator('[data-testid=ticket-note]').textContent()).toContain('Severe peanut allergy');
    expect(await c.locator('[data-testid=ticket-who]').textContent()).toContain('Ari');
    // The level is in words, never colour alone.
    expect(await c.locator('[data-testid=ticket-level]').textContent()).toMatch(/ON TRACK|DUE SOON|DUE NOW|OVERDUE/);
  });

  it('acknowledge, ready, bump: each tap stored once, the order follows, and a bump can be recalled', async () => {
    const page = screen.page;
    const order = await devPost<{ orderId: string }>('order', { venueId: paired.venueId, guestName: 'Bea Bumper' });
    const ticket = await eventually(() => ticketOf(order.orderId), 'ticket row');
    await showTicket(page, ticket.id);

    await tap(page, ticket.id, 'acknowledged');
    await eventually(async () => (await screenEvents(ticket.id)).some((e) => e.event === 'acknowledged'), 'acknowledged stored');
    await tap(page, ticket.id, 'ready');
    await eventually(async () => (await screenEvents(ticket.id)).some((e) => e.event === 'ready'), 'ready stored');
    await tap(page, ticket.id, 'bumped');
    await eventually(async () => (await ticketOf(order.orderId))?.status === 'bumped', 'ticket bumped');

    const events = await screenEvents(ticket.id);
    const counts = events.reduce<Record<string, number>>((m, e) => ({ ...m, [e.event]: (m[e.event] ?? 0) + 1 }), {});
    expect(counts).toMatchObject({ acknowledged: 1, ready: 1, bumped: 1 });
    expect(events.every((e) => e.device_id === paired.deviceId)).toBe(true);
    const o = await db().selectFrom('orders').select(['status']).where('id', '=', order.orderId).executeTakeFirstOrThrow();
    expect(o.status).toBe('completed');

    // Mis-tapped: recall puts it back to ready, and the order with it.
    await tap(page, ticket.id, 'recalled');
    await eventually(async () => (await ticketOf(order.orderId))?.status === 'ready', 'ticket recalled');
    await eventually(async () => (await db().selectFrom('orders').select('status').where('id', '=', order.orderId).executeTakeFirstOrThrow()).status === 'ready', 'order back to ready');
    expect((await screenEvents(ticket.id)).filter((e) => e.event === 'recalled')).toHaveLength(1);
  });

  it('keeps working offline: taps queue on the screen and replay exactly once when the connection is back', async () => {
    const page = screen.page;
    const order = await devPost<{ orderId: string }>('order', { venueId: paired.venueId, guestName: 'Olly Offline' });
    const ticket = await eventually(() => ticketOf(order.orderId), 'ticket row');
    await showTicket(page, ticket.id);

    // The screen has been opened before (as it is every service): the service worker holds the page and its scripts.
    await page.reload();
    await page.waitForSelector('[data-testid=kitchen-screen]');
    await eventually(() => page.evaluate(() => !!navigator.serviceWorker.controller), 'service worker in control');
    await page.waitForLoadState('networkidle');

    await screen.context.setOffline(true);
    try {
    await page.waitForSelector('[data-testid=offline-banner]', { timeout: 15_000 });
    await tap(page, ticket.id, 'acknowledged');
    await tap(page, ticket.id, 'ready');
    // The screen shows what was tapped even though the server has not heard. (A ready ticket moves behind the ones still cooking.)
    await showTicket(page, ticket.id);
    expect(await card(page, ticket.id).getAttribute('data-status')).toBe('ready');
    expect(await page.textContent('[data-testid=offline-banner]')).toContain('2 taps waiting');
    await page.screenshot({ path: `${SHOTS}/kitchen-offline.png`, caret: 'initial' });
    await new Promise((r) => setTimeout(r, 5000));
    expect(await screenEvents(ticket.id)).toEqual([]);

    // Reopened while still offline: the service worker serves the page and its scripts, and the queued taps are
    // still there. Only in a production build: the development server's client will not start without its
    // hot-reload socket, which has nothing to do with the screen.
    if (process.env.E2E_MODE === 'build') {
      await page.reload();
      await page.waitForSelector('[data-testid=kitchen-screen]');
      await page.waitForSelector('[data-testid=offline-banner]', { timeout: 15_000 });
      await showTicket(page, ticket.id);
      expect(await card(page, ticket.id).getAttribute('data-status')).toBe('ready');
      expect(await screenEvents(ticket.id)).toEqual([]);
    }
    } finally {
      await screen.context.setOffline(false);
    }
    await eventually(async () => (await screenEvents(ticket.id)).length >= 2, 'queued taps replayed', 30_000);
    await eventually(async () => !(await page.locator('[data-testid=offline-banner]').isVisible()), 'banner gone');
    await new Promise((r) => setTimeout(r, 5000));
    const events = await screenEvents(ticket.id);
    expect(events.map((e) => e.event)).toEqual(['acknowledged', 'ready']);
    expect(new Set(events.map((e) => e.idempotency_key)).size).toBe(2);
    expect((await ticketOf(order.orderId))?.status).toBe('ready');
    expect(await page.evaluate(() => localStorage.length && Object.keys(localStorage).filter((k) => k.endsWith('.queue')).map((k) => JSON.parse(localStorage.getItem(k)!).length))).toEqual([0]);
  });

  it('replaying the same batch again records nothing new', async () => {
    const order = await devPost<{ orderId: string }>('order', { venueId: paired.venueId, guestName: 'Rey Replay' });
    const ticket = await eventually(() => ticketOf(order.orderId), 'ticket row');
    const batch = { events: [{ ticketId: ticket.id, event: 'acknowledged', key: `e2e-replay-${ticket.id}`, occurredAt: new Date().toISOString() }] };
    const send = () => screen.page.evaluate(async (b) => (await fetch('/kitchen/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json(), batch);
    expect(await send()).toEqual({ results: [{ key: batch.events[0]!.key, ok: true }] });
    expect(await send()).toEqual({ results: [{ key: batch.events[0]!.key, ok: true }] });
    expect((await screenEvents(ticket.id)).filter((e) => e.event === 'acknowledged')).toHaveLength(1);
  });

  it('the 86 button takes a dish off the menu and puts it back', async () => {
    const page = screen.page;
    await page.click('button:text-is("86")');
    const item = page.locator('[data-item]').first();
    await item.waitFor();
    const name = (await item.getAttribute('data-item'))!;
    const row = () => db().selectFrom('menu_items').select(['is_available', 'unavailable_until']).where('venue_id', '=', paired.venueId).where('name', '=', name).executeTakeFirstOrThrow();
    expect((await row()).is_available).toBe(true);
    await item.click();
    await eventually(async () => (await row()).is_available === false, 'item 86d');
    expect((await row()).unavailable_until).not.toBeNull();
    await expect.poll(() => item.getAttribute('aria-pressed')).toBe('true');
    await page.screenshot({ path: `${SHOTS}/kitchen-86.png`, caret: 'initial' });
    await item.click();
    await eventually(async () => (await row()).is_available === true, 'item restored');
    await page.click('button:text-is("Close")');
  });

  it('looks right on a landscape tablet with several tickets and allergens', async () => {
    const page = screen.page;
    await devPost('order', { venueId: paired.venueId, table: true, note: 'Birthday: candle on the dessert' });
    await devPost('order', { venueId: paired.venueId, guestName: 'Sam Shellfish', items: ['Salt and pepper squid', 'Kingfish crudo'] }).catch(() => devPost('order', { venueId: paired.venueId, guestName: 'Sam Shellfish' }));
    await new Promise((r) => setTimeout(r, 5000));
    await page.click('button[aria-label="Previous page"]').catch(() => undefined);
    for (let i = 0; i < 5; i++) if (await page.locator('button[aria-label="Previous page"]').isEnabled()) await page.click('button[aria-label="Previous page"]');
    await page.screenshot({ path: `${SHOTS}/kitchen-board.png`, caret: 'initial' });
    // Nothing on the screen scrolls the page: every ticket is on a page, not below the fold.
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
    expect(await page.locator('[data-testid=ticket-allergens]').count()).toBeGreaterThan(0);
    // Overdue tickets always sort to the first page.
    const levels = await page.locator('[data-testid=ticket]').evaluateAll((els) => els.map((e) => e.getAttribute('data-level')));
    const firstNotOver = levels.indexOf(levels.find((l) => l !== 'over') ?? 'none');
    if (firstNotOver >= 0) expect(levels.slice(firstNotOver).includes('over')).toBe(false);
  });

  it('a screen for one venue cannot read another venue\'s tickets', async () => {
    // Probed with the screen's own cookie, from outside the page (a deliberate 404 in the page would be logged as an error).
    const get = (ctx: Watched, path: string) => ctx.context.request.get(`${BASE()}${path}`);
    expect((await get(screen, '/kitchen/api/tickets')).status()).toBe(200);
    const other = await venueOf('oak-group');
    const r = await get(screen, `/kitchen/api/tickets?venueId=${other.venueId}`);
    expect(r.status()).toBe(404);
    expect(await r.text()).not.toContain('ticketNumber');

    // Two venues of one org: CBD's screen cannot read Newtown's either.
    const cbd = await newTablet();
    const cbdPaired = await pairScreen(cbd.page, 'oak-group', 'manager@oak-group.test', 'Oak Group CBD');
    const newtown = await venueOf('oak-group', 'Oak Group Newtown');
    expect((await get(cbd, `/kitchen/api/tickets?venueId=${newtown.venueId}`)).status()).toBe(404);
    const ownBoard = (await (await get(cbd, '/kitchen/api/tickets')).json()) as { venueId: string };
    expect(ownBoard.venueId).toBe(cbdPaired.venueId);
    // Taps on another venue's ticket are not found either.
    const foreign = await db().selectFrom('kitchen_tickets').select('id').where('venue_id', '=', newtown.venueId).executeTakeFirst();
    if (foreign) {
      const res = (await (await cbd.context.request.post(`${BASE()}/kitchen/api/events`, { data: { events: [{ ticketId: foreign.id, event: 'acknowledged', key: `e2e-foreign-${foreign.id}` }] } })).json()) as { results: Array<{ ok: boolean }> };
      expect(res.results[0]!.ok).toBe(false);
      expect(await db().selectFrom('ticket_events').select('id').where('idempotency_key', '=', `screen:e2e-foreign-${foreign.id}`).execute()).toEqual([]);
    }
    expect(realProblems(cbd.problems), JSON.stringify(cbd.problems)).toEqual([]);
    await cbd.context.close();
  });

  it('a revoked screen is sent back to pairing', async () => {
    const m = await staffAs('manager@oak-diner.test', 'oak-diner');
    const app = await opsApp();
    await app.tenant(m.orgId, m.principal, (ctx) => auth.revokeDevice(ctx, paired.deviceId));
    await screen.page.waitForSelector('input[name=code]', { timeout: 20_000 });
    expect(new URL(screen.page.url()).pathname).toBe('/kitchen');
    const d = await db().selectFrom('devices').select(['revoked_at', 'token_hash']).where('id', '=', paired.deviceId).executeTakeFirstOrThrow();
    expect(d.revoked_at).not.toBeNull();
    expect(d.token_hash).toBeNull();
    expect((await screen.context.request.get(`${BASE()}/kitchen/api/tickets`)).status()).toBe(401);
    // Nothing went wrong in the browser apart from what switching the network off causes, and the 401 the revoked screen's poll got (that is how it learned).
    expect(realProblems(screen.problems).filter((p) => !/status of 401/.test(p)), JSON.stringify(realProblems(screen.problems))).toEqual([]);
    await screen.context.close();
  });

  it('the service worker is scoped to the kitchen and does not control the console', async () => {
    const r = await fetch(`${BASE()}/kitchen/sw.js`);
    expect(r.headers.get('service-worker-allowed')).toBe('/kitchen');
    // The script itself parses (a syntax error would silently leave the screen with no offline cache).
    const script = await r.text();
    expect(() => new Function(script)).not.toThrow();
    const v = await newVisitor();
    await v.page.goto(`${BASE()}/login`);
    expect(await v.page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    const manifest = await (await fetch(`${BASE()}/kitchen/manifest.webmanifest`)).json();
    expect(manifest).toMatchObject({ scope: '/kitchen', start_url: '/kitchen' });
    await v.context.close();
  });
});
