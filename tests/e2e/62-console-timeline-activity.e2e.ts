import { afterAll, describe, expect, it } from 'vitest';
import { events } from '@ros/modules';
import { BASE, chooseVenue, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff } from './helpers';
import { closeOpsApp, devPost, opsApp, staffAs } from './ops-helpers';

/**
 * The console's shared pieces, wave 1, second half (docs/CONSOLE_IA.md section 9): the Timeline
 * with staff notes and @mentions on a record, the Activity log with the assistant badged, and
 * search from anywhere. Every write is read back from the database; the negative cases are the
 * venue next door and the organisation next door.
 */

afterAll(async () => {
  await closeOpsApp();
  await closeBrowser();
  await closeDb();
});

const run = Date.now().toString(36);

interface DevOrder {
  orderId: string;
  reference: string;
}
const placeOrder = (venueId: string, over: Record<string, unknown> = {}) => devPost<DevOrder>('order', { venueId, ...over });

describe('console: timeline and notes', () => {
  it('a host leaves a note with an @mention on an order: it is on the timeline with the author, in the database with the mention, and the kitchen can read it', async () => {
    const diner = await orgBySlug('oak-diner');
    const order = await placeOrder(diner.venueId, { guestName: `Nora Noted ${run}`, guestEmail: `noted.${run}@example.com` });
    const manager = await db().selectFrom('staff').select('id').where('org_id', '=', diner.orgId).where('email', '=', 'manager@oak-diner.test').executeTakeFirstOrThrow();

    const v = await newVisitor();
    await signInStaff(v.page, 'host@oak-diner.test');
    await v.page.goto(`${BASE()}/console/orders/${order.orderId}`);
    const timeline = v.page.getByTestId('order-timeline');
    await timeline.waitFor();
    // The order's own steps are there, newest first, with the audit's words beside them.
    expect(await timeline.innerText()).toMatch(/Placed and paid/);

    const body = `Extra sauce on the side, they asked twice. @Morgan can you check? <b>not markup</b> ${run}`;
    const form = v.page.getByTestId('note-form');
    await form.locator('textarea[name=body]').fill(body);
    await form.getByRole('button', { name: 'Leave note' }).click();
    const note = await eventually(() => db().selectFrom('staff_notes').selectAll().where('entity_id', '=', order.orderId).where('entity_type', '=', 'order').executeTakeFirst(), 'the note row');
    expect(note).toMatchObject({ org_id: diner.orgId, venue_id: diner.venueId, body, author_kind: 'staff', deleted_at: null });
    expect(note.mentions).toEqual([manager.id]);
    const shown = timeline.locator('[data-kind=note]');
    await shown.first().waitFor();
    expect(await shown.count()).toBe(1);
    expect(await shown.first().innerText()).toContain('Harper Host');
    expect(await shown.first().innerText()).toContain('Note');
    expect(await shown.first().innerText()).toContain(body);
    // Text, never markup.
    expect(await shown.first().locator('b').count()).toBe(0);
    expect(await form.innerText()).toContain('One person was mentioned');
    // Typing @ offers the team's names.
    await form.locator('textarea[name=body]').fill('Thanks @Mo');
    const options = form.locator('[role=listbox] [role=option]');
    await options.first().waitFor();
    expect(await options.allInnerTexts()).toEqual(expect.arrayContaining(['@Morgan Manager']));
    await v.page.keyboard.press('Escape');
    expect(v.problems).toEqual([]);
    await v.context.close();

    // The kitchen reads the same timeline (no guest contact on it) and sees the note.
    const k = await newVisitor();
    await signInStaff(k.page, 'kitchen@oak-diner.test');
    await k.page.goto(`${BASE()}/console/orders/${order.orderId}`);
    await k.page.getByTestId('order-timeline').waitFor();
    expect(await k.page.getByTestId('order-timeline').locator('[data-kind=note]').count()).toBe(1);
    expect(await k.page.content()).not.toContain(`noted.${run}@example.com`);
    expect(k.problems).toEqual([]);
    await k.context.close();
  });

  it('a note on a guest at one venue is not shown at the other venue of the same organisation, and the record has one row with that venue on it', async () => {
    const group = await orgBySlug('oak-group');
    const cbd = group.venues.find((v) => v.slug === 'cbd')!;
    const newtown = group.venues.find((v) => v.slug === 'newtown')!;
    const guest = await db().selectFrom('customers').select('id').where('org_id', '=', group.orgId).where('status', '=', 'active').where('first_name', 'is not', null).orderBy('created_at').executeTakeFirstOrThrow();
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-group.test');
    await v.page.goto(`${BASE()}/console/customers/${guest.id}`);
    await chooseVenue(v.page, 'Oak Group CBD');
    await v.page.goto(`${BASE()}/console/customers/${guest.id}`);
    const body = `Comes in with the Tuesday crowd ${run}`;
    await v.page.getByTestId('note-form').locator('textarea[name=body]').fill(body);
    await v.page.getByTestId('note-form').getByRole('button', { name: 'Leave note' }).click();
    const rows = await eventually(async () => {
      const r = await db().selectFrom('staff_notes').select(['venue_id', 'body']).where('entity_id', '=', guest.id).where('body', '=', body).execute();
      return r.length ? r : null;
    }, 'the guest note');
    expect(rows).toEqual([{ venue_id: cbd.id, body }]);
    await v.page.getByTestId('guest-timeline').locator('[data-kind=note]', { hasText: body }).waitFor();

    await chooseVenue(v.page, 'Oak Group Newtown');
    await v.page.goto(`${BASE()}/console/customers/${guest.id}`);
    await v.page.getByRole('heading', { level: 1 }).waitFor();
    expect(await v.page.locator(`[data-kind=note]`, { hasText: body }).count()).toBe(0);
    expect(await db().selectFrom('staff_notes').select('id').where('entity_id', '=', guest.id).where('venue_id', '=', newtown.id).where('body', '=', body).execute()).toEqual([]);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});

describe('console: activity log', () => {
  it('a call the assistant made and a change a person made are both on the log, each badged for who did it; the log is linked from Settings and from Assistant', async () => {
    const diner = await orgBySlug('oak-diner');
    // A change by a person, through the service the console's own button calls.
    const manager = await staffAs('manager@oak-diner.test', 'oak-diner');
    const app = await opsApp();
    const viewName = `Activity check ${run}`;
    const saved = await app.tenant(manager.orgId, manager.principal, (ctx) => events.saveConsoleView(ctx, { venueId: diner.venueId, page: 'menu', name: viewName, filters: { availability: 'off' } }));

    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    // A key the assistant uses, made as a person would, then one call over MCP.
    await v.page.goto(`${BASE()}/console/assistant`);
    expect(await v.page.locator('main a[href="/console/activity?view=assistant"]').count()).toBe(1);
    const keyName = `Activity key ${run}`;
    await v.page.fill('input[name=name]', keyName);
    await v.page.click('button:has-text("Create key")');
    const shown = v.page.getByTestId('new-agent-key');
    await shown.waitFor();
    const key = (await shown.textContent())!.trim();
    const mcp = await fetch(`${BASE()}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${key}`, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'venue_status' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'venue_status', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'e2e-assistant', version: '1.0.0' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
    });
    expect(mcp.status).toBe(200);
    const keyRow = await eventually(() => db().selectFrom('agent_keys').select('id').where('name', '=', keyName).executeTakeFirst(), 'key row');
    await eventually(() => db().selectFrom('agent_calls').select('id').where('key_id', '=', keyRow.id).where('tool', '=', 'venue_status').executeTakeFirst(), 'the call on the record');

    // Settings links to Activity.
    await v.page.goto(`${BASE()}/console/settings/team`);
    expect(await v.page.locator('nav[aria-label=Console] a[href="/console/activity"]').count()).toBe(1);

    await v.page.goto(`${BASE()}/console/activity?view=assistant`);
    const lines = v.page.getByTestId('activity-line');
    await lines.first().waitFor();
    const assistant = lines.filter({ hasText: 'checked whether the venue is open' }).filter({ hasText: keyName });
    await assistant.first().waitFor();
    expect(await assistant.first().getAttribute('data-who')).toBe('Assistant');
    expect(await assistant.first().innerText()).toContain('Assistant');
    // In this view, only assistants.
    const who = await lines.evaluateAll((els) => els.map((e) => e.getAttribute('data-who')));
    expect(who.every((w) => w === 'Assistant')).toBe(true);

    await v.page.goto(`${BASE()}/console/activity?view=staff`);
    const staffLine = v.page.getByTestId('activity-line').filter({ hasText: `saved the view “${viewName}”` });
    await staffLine.first().waitFor();
    expect(await staffLine.first().innerText()).toContain('Morgan Manager');
    expect(await staffLine.first().getAttribute('data-who')).toBe('Team');
    // The words filter narrows it to that one line.
    await v.page.goto(`${BASE()}/console/activity?view=all&f=1&when=today&q=${encodeURIComponent(viewName)}`);
    await v.page.getByTestId('activity-line').first().waitFor();
    expect(await v.page.getByTestId('activity-line').count()).toBe(1);
    expect(v.problems).toEqual([]);
    await v.context.close();

    // A host has no activity log.
    const h = await newVisitor();
    await signInStaff(h.page, 'host@oak-diner.test');
    await h.page.goto(`${BASE()}/console/activity`);
    expect(await h.page.locator('main').innerText()).toMatch(/for managers and owners/);
    await h.context.close();
    await app.tenant(manager.orgId, manager.principal, (ctx) => events.deleteConsoleView(ctx, saved.id));
  });
});

describe('console: search', () => {
  it('Ctrl+K finds an order by reference and a guest by name as links; another organisation never finds the guest', async () => {
    const diner = await orgBySlug('oak-diner');
    const guestName = `Searchy Seeker ${run}`;
    const order = await placeOrder(diner.venueId, { guestName, guestEmail: `searchy.${run}@example.com` });
    const guest = await eventually(() => db().selectFrom('customers').select('id').where('org_id', '=', diner.orgId).where('primary_email', '=', `searchy.${run}@example.com`).executeTakeFirst(), 'the guest record');

    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console`);
    await v.page.keyboard.press('Control+k');
    const dialog = v.page.getByTestId('search-dialog');
    await dialog.waitFor();
    await v.page.getByTestId('search-input').fill(order.reference);
    const hit = dialog.getByTestId('search-hit-orders').filter({ hasText: `Order ${order.reference}` });
    await hit.first().waitFor();
    expect(await hit.first().getAttribute('href')).toBe(`/console/orders/${order.orderId}`);

    await v.page.getByTestId('search-input').fill('Searchy Seeker');
    const guestHit = dialog.getByTestId('search-hit-guests').filter({ hasText: guestName });
    await guestHit.first().waitFor();
    expect(await guestHit.first().getAttribute('href')).toBe(`/console/customers/${guest.id}`);
    // Narrowed to orders, the guest is not offered.
    await v.page.getByTestId('search-category').selectOption('orders');
    await v.page.getByTestId('search-empty').waitFor();
    // Following a result closes the dialog and lands on the record.
    await v.page.getByTestId('search-category').selectOption('guests');
    await guestHit.first().waitFor();
    await guestHit.first().click();
    await v.page.waitForURL(`${BASE()}/console/customers/${guest.id}`);
    await v.page.waitForFunction(() => !document.querySelector('[data-testid=search-dialog][open]'));
    expect(v.problems).toEqual([]);
    await v.context.close();

    // The group's manager searches the same name: nothing, because the guest is the diner's.
    const g = await newVisitor();
    await signInStaff(g.page, 'manager@oak-group.test');
    await g.page.goto(`${BASE()}/console`);
    await g.page.getByTestId('search-open').first().click();
    await g.page.getByTestId('search-dialog').waitFor();
    await g.page.getByTestId('search-input').fill('Searchy Seeker');
    await g.page.getByTestId('search-empty').waitFor();
    expect(await g.page.getByTestId('search-dialog').innerText()).not.toContain(guestName);
    await g.page.getByTestId('search-input').fill(order.reference);
    await g.page.waitForFunction(() => document.querySelector('[data-testid=search-dialog] [aria-live]')?.textContent?.match(/Nothing matches|Looking/));
    await g.page.waitForTimeout(600);
    expect(await g.page.getByTestId('search-dialog').locator(`a[href="/console/orders/${order.orderId}"]`).count()).toBe(0);
    expect(g.problems).toEqual([]);
    await g.context.close();
  });
});
