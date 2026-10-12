import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { type Principal, listModuleDefs, listPlugs } from '@ros/core';
import { bookings, campaigns, guestPlugin, tenancy } from '@ros/modules';
import { BASE, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff } from './helpers';
import { closeOpsApp, devGet, opsApp, staffAs } from './ops-helpers';

/**
 * The console's information architecture (docs/CONSOLE_IA.md): the sections and who sees them,
 * Home, the book, Channels, Plugins, Assistant, the moved routes, and the phone layout. Every
 * write is read back from the database; the Channels scenario also calls the guest plugin's own
 * directory function to prove a venue switched off there is gone from guests' assistants.
 */

afterAll(async () => {
  await closeOpsApp();
  await closeBrowser();
  await closeDb();
});

const run = Date.now().toString(36);
const ANON: Principal = { kind: 'anon' };

/** Every section label in the sidebar, in order. */
const sidebarSections = (page: Page) => page.locator('nav[aria-label=Console] > div > a').allInnerTexts();

const ALL_SECTIONS = ['Home', 'Orders', 'Bookings', 'Menu', 'Customers', 'Marketing', 'Offers', 'Website', 'Analytics', 'Channels', 'Plugins', 'Assistant', 'Settings'];

/** Tomorrow at the fixture venues (all in Sydney), by the web process's clock. */
async function tomorrowInSydney(): Promise<string> {
  const { now } = await devGet<{ now: string }>('clock');
  const d = new Date(new Date(now).getTime() + 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

async function confirmDialog(page: Page, button: string, expectText: RegExp): Promise<void> {
  const dialog = page.locator('dialog[open]');
  await dialog.getByRole('button', { name: button }).click();
  await page.waitForFunction(
    (re) => {
      const d = document.querySelector('dialog[open]');
      return !d || new RegExp(re, 'i').test(d.textContent ?? '');
    },
    expectText.source,
  );
  expect(await page.locator('dialog[open] [role=alert]').count()).toBe(0);
}

describe('console: sections, home, bookings, channels, plugins, assistant, moves, phone', () => {
  it('an owner sees every section in order; front of house sees the book but none of the restricted sections', async () => {
    const owner = await newVisitor();
    await signInStaff(owner.page, 'owner@oak-diner.test');
    await owner.page.goto(`${BASE()}/console`);
    expect(await sidebarSections(owner.page)).toEqual(ALL_SECTIONS);
    // The organisation's name sits above the venue, as a store switcher would.
    expect(await owner.page.locator('aside').innerText()).toContain('Oak Diner');
    // Keyboard: Tab from the skip link reaches the navigation.
    await owner.page.keyboard.press('Tab');
    expect(await owner.page.evaluate(() => document.activeElement?.textContent?.trim())).toBe('Skip to content');
    expect(owner.problems).toEqual([]);
    await owner.context.close();

    const host = await newVisitor();
    await signInStaff(host.page, 'host@oak-diner.test');
    await host.page.goto(`${BASE()}/console`);
    const seen = await sidebarSections(host.page);
    expect(seen).toContain('Bookings');
    expect(seen).toContain('Customers');
    for (const restricted of ['Marketing', 'Channels', 'Plugins', 'Assistant', 'Settings']) expect(seen, restricted).not.toContain(restricted);
    // The order is the owner's order with the missing ones taken out.
    expect(ALL_SECTIONS.filter((s) => seen.includes(s))).toEqual(seen);
    // Typing a restricted address gets the same refusal the server gives, not the page.
    for (const path of ['/console/plugins', '/console/channels', '/console/assistant']) {
      await host.page.goto(`${BASE()}${path}`);
      expect(await host.page.locator('main').innerText(), path).toMatch(/Your role does not include this/);
    }
    expect(host.problems).toEqual([]);
    await host.context.close();
  });

  it('home shows today\'s service and an approval waiting for a yes; the owner says no from there and the record agrees', async () => {
    const diner = await orgBySlug('oak-diner');
    // A manager's campaign, submitted through the service the console's own button calls: it waits for a yes.
    const manager = await staffAs('manager@oak-diner.test', 'oak-diner');
    const app = await opsApp();
    const name = `Home approval ${run}`;
    const { approvalId, campaignId } = await app.tenant(manager.orgId, manager.principal, async (ctx) => {
      const regulars = (await campaigns.listSegments(ctx)).find((s) => s.name === 'Regulars')!;
      const c = await campaigns.draftCampaign(ctx, { venueId: diner.venueId, name, channel: 'email', segmentId: regulars.id, subject: `Subject ${run}`, body: `Hi {{first_name}}, ${name}.` });
      const s = await campaigns.submitCampaign(ctx, { campaignId: c.id });
      return { approvalId: s.approval.id, campaignId: c.id };
    });
    expect((await db().selectFrom('approvals').select('status').where('id', '=', approvalId).executeTakeFirstOrThrow()).status).toBe('pending');

    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    await v.page.goto(`${BASE()}/console`);
    const main = await v.page.locator('main').innerText();
    expect(main).toContain("Today's service");
    expect(main).toContain('Covers booked today');
    expect(main).toContain('This week against last');
    expect(await v.page.locator('[data-testid=week-tiles] > *').count()).toBe(3);
    const row = v.page.getByTestId(`home-approval-${approvalId}`);
    await row.waitFor();
    expect(await row.innerText()).toContain('Regulars');
    // Live: the diner is live, so there is no setup card.
    expect(await v.page.getByTestId('setup-progress').count()).toBe(0);

    await row.getByTestId(`reject-${approvalId}`).click();
    await confirmDialog(v.page, 'Reject', /Rejected\. Nothing will happen/);
    await eventually(async () => (await db().selectFrom('approvals').select('status').where('id', '=', approvalId).executeTakeFirstOrThrow()).status === 'rejected', 'approval rejected');
    const campaign = await db().selectFrom('campaigns').select('status').where('id', '=', campaignId).executeTakeFirstOrThrow();
    expect(campaign.status).not.toBe('pending_approval');
    expect(await db().selectFrom('messages').select('id').where('campaign_id', '=', campaignId).execute()).toEqual([]);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('bookings: a guest\'s request appears in the book and front of house confirms it; the row, the record and the audit agree', async () => {
    const diner = await orgBySlug('oak-diner');
    const manager = await staffAs('manager@oak-diner.test', 'oak-diner');
    const app = await opsApp();
    const date = await tomorrowInSydney();
    const configured = () => db().selectFrom('venue_modules').select('config').where('venue_id', '=', diner.venueId).where('module_key', '=', 'bookings').executeTakeFirstOrThrow();
    const before = (await configured()).config as { auto_confirm: boolean };
    expect(before.auto_confirm).toBe(true);

    // The venue decides to confirm each booking itself; a guest then books through the public function.
    await app.tenant(manager.orgId, manager.principal, (ctx) => tenancy.configurePlugin(ctx, { venueId: diner.venueId, plugin: 'bookings', config: { auto_confirm: false } }));
    let reference = '';
    try {
      const requested = await app.tenant(diner.orgId, ANON, (ctx) =>
        bookings.requestBooking(ctx, { venueId: diner.venueId, date, time: '19:30', partySize: 3, name: `Robin Request ${run}`, email: `robin-${run}@example.com`, note: 'Window seat if you can', requestKey: `e2e-request-${run}-${Date.now()}` }),
      );
      reference = requested.reference;
      expect(requested.status).toBe('requested');

      const v = await newVisitor();
      await signInStaff(v.page, 'host@oak-diner.test');
      await v.page.goto(`${BASE()}/console/bookings?date=${date}`);
      const row = v.page.getByTestId(`booking-${reference}`);
      await row.waitFor();
      expect(await row.getAttribute('data-status')).toBe('requested');
      expect(await row.innerText()).toContain('Waiting for a yes');
      // Guest-written words are shown as quoted text, never as markup.
      expect(await row.locator('q').count()).toBeGreaterThan(0);
      expect(await v.page.getByTestId('booking-services').innerText()).toMatch(/Dinner/);

      await row.getByTestId(`confirm-${reference}`).getByRole('button', { name: 'Confirm' }).click();
      const stored = await eventually(async () => {
        const r = await db().selectFrom('bookings').select(['id', 'status', 'decided_at']).where('venue_id', '=', diner.venueId).where('reference', '=', reference).executeTakeFirstOrThrow();
        return r.status === 'confirmed' ? r : null;
      }, 'booking confirmed');
      expect(stored.decided_at).not.toBeNull();
      await v.page.waitForFunction((ref) => document.querySelector(`[data-testid="booking-${ref}"]`)?.getAttribute('data-status') === 'confirmed', reference);
      const history = await db().selectFrom('booking_status_history').select(['from_status', 'to_status', 'by_kind']).where('booking_id', '=', stored.id).orderBy('at').execute();
      expect(history.map((h) => `${h.from_status ?? '-'}>${h.to_status}`)).toEqual(['->requested', 'requested>confirmed']);
      expect(history[1]!.by_kind).toBe('staff');
      const audited = await db().selectFrom('audit_log').select('action').where('entity_id', '=', stored.id).execute();
      expect(audited.map((a) => a.action)).toContain('bookings.confirmed');
      // The guest is told: a confirmation is queued to the address they gave.
      await eventually(() => db().selectFrom('messages').select('id').where('org_id', '=', diner.orgId).where('to_address', '=', `robin-${run}@example.com`).executeTakeFirst(), 'confirmation message');
      expect(v.problems).toEqual([]);
      await v.context.close();
    } finally {
      await app.tenant(manager.orgId, manager.principal, (ctx) => tenancy.configurePlugin(ctx, { venueId: diner.venueId, plugin: 'bookings', config: { auto_confirm: true } }));
    }
    expect(((await configured()).config as { auto_confirm: boolean }).auto_confirm).toBe(true);
  });

  it('booking rules: a time that is not a time is refused with the reason and nothing is saved; a real change is saved and read back', async () => {
    const diner = await orgBySlug('oak-diner');
    const config = async () => (await db().selectFrom('venue_modules').select('config').where('venue_id', '=', diner.venueId).where('module_key', '=', 'bookings').executeTakeFirstOrThrow()).config as Record<string, unknown>;
    const start = await config();
    expect(start.max_party_size_online).toBe(8);

    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    await v.page.goto(`${BASE()}/console/bookings/settings`);
    const form = v.page.getByTestId('settings-bookings');
    // The form is the schema's own words.
    expect(await form.innerText()).toContain('Kitchen pacing: the most guests (covers) whose bookings may start in one slot.');
    expect(await form.locator('[data-testid="rows-cfg.service_periods"] tbody tr').count()).toBeGreaterThanOrEqual(4);
    expect(await form.locator('input[name="cfg.service_periods.0.name"]').inputValue()).toBe('Lunch');

    await form.locator('input[name="cfg.service_periods.0.starts_at"]').fill('9pm');
    await form.getByRole('button', { name: 'Save booking rules' }).click();
    await form.locator('[role=alert]').waitFor();
    expect(await form.locator('[role=alert]').innerText()).toMatch(/not valid.*24-hour time/i);
    expect(await config()).toEqual(start);

    await v.page.reload();
    await v.page.getByTestId('settings-bookings').locator('input[name="cfg.max_party_size_online"]').fill('10');
    await v.page.getByTestId('settings-bookings').getByRole('button', { name: 'Save booking rules' }).click();
    await v.page.getByTestId('settings-bookings').getByText('Table bookings settings saved.').waitFor();
    const after = await config();
    expect(after.max_party_size_online).toBe(10);
    expect(after.service_periods).toEqual(start.service_periods);
    const audited = await db().selectFrom('audit_log').select('after').where('entity_id', '=', `${diner.venueId}:bookings`).where('action', '=', 'module.set').orderBy('occurred_at', 'desc').limit(1).executeTakeFirstOrThrow();
    expect((audited.after as { config: { max_party_size_online: number } }).config.max_party_size_online).toBe(10);
    expect(v.problems).toEqual([]);

    // Back as it was, through the same form.
    await v.page.reload();
    await v.page.getByTestId('settings-bookings').locator('input[name="cfg.max_party_size_online"]').fill('8');
    await v.page.getByTestId('settings-bookings').getByRole('button', { name: 'Save booking rules' }).click();
    await v.page.getByTestId('settings-bookings').getByText('Table bookings settings saved.').waitFor();
    expect(await config()).toEqual(start);
    await v.context.close();
  });

  it('channels: "Inside assistants" shows the guest endpoint; switched off, the guest plugin no longer lists the venue; switched on, it does', async () => {
    const diner = await orgBySlug('oak-diner');
    const app = await opsApp();
    const listed = async () => (await guestPlugin.findListedVenues(app, 'Oak Diner')).map((x) => x.venueId);
    expect(await listed()).toContain(diner.venueId);
    const state = () => db().selectFrom('venue_modules').select('enabled').where('venue_id', '=', diner.venueId).where('module_key', '=', 'guest-plugin').executeTakeFirstOrThrow();

    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    await v.page.goto(`${BASE()}/console/channels`);
    const card = v.page.locator('#channel-guest-plugin');
    expect(await card.innerText()).toContain('Inside assistants');
    expect(await card.innerText()).toMatch(/no payment is taken inside the chat/);
    expect(await v.page.getByTestId('channel-address-guest-plugin').innerText()).toBe(`${BASE()}/api/guest/mcp`);
    // The other channels are there too, each from its manifest.
    for (const key of ['website', 'qr', 'ordering', 'bookings']) expect(await v.page.locator(`#channel-${key}`).count(), key).toBe(1);

    try {
      await v.page.getByTestId('channel-off-guest-plugin').click();
      await confirmDialog(v.page, 'Switch it off', /is now off/);
      await eventually(async () => (await state()).enabled === false, 'guest plugin off');
      expect(await listed()).not.toContain(diner.venueId);
      await v.page.goto(`${BASE()}/console/channels`);
      expect(await v.page.getByTestId('channel-guest-plugin').innerText()).toContain('Off');
    } finally {
      await v.page.goto(`${BASE()}/console/channels`);
      if (await v.page.getByTestId('channel-on-guest-plugin').count()) await v.page.getByTestId('channel-on-guest-plugin').locator('button').click();
      await eventually(async () => (await state()).enabled === true, 'guest plugin back on');
    }
    expect(await listed()).toContain(diner.venueId);
    const audited = await db().selectFrom('audit_log').select('after').where('entity_id', '=', `${diner.venueId}:guest-plugin`).where('action', '=', 'module.set').orderBy('occurred_at', 'desc').limit(2).execute();
    expect(audited.map((a) => (a.after as { enabled: boolean }).enabled)).toEqual([true, false]);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('plugins: every module and plug is listed with its state, and a configure form refuses a value the schema refuses', async () => {
    const diner = await orgBySlug('oak-diner');
    const expected = listModuleDefs().filter((d) => !d.key.startsWith('test_')).length + listPlugs().length;
    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    await v.page.goto(`${BASE()}/console/plugins`);
    expect(await v.page.locator('section[id^=plugin-]').count()).toBe(expected);
    // Every toggleable module has a switch; every plug a Connect or Manage; the spine says always on.
    for (const def of listModuleDefs().filter((d) => !d.key.startsWith('test_'))) {
      const actions = await v.page.getByTestId(`plugin-${def.key}`).innerText();
      expect(actions, def.key).toMatch(def.spine ? /Always on/ : /^(On|Off)/m);
    }
    for (const plug of listPlugs()) expect(await v.page.getByTestId(`plugin-${plug.key}`).innerText(), plug.key).toMatch(/Connect|Manage/);
    // The card says what it needs, reads and writes, from the manifest.
    const card = v.page.locator('#plugin-bookings');
    expect(await card.innerText()).toMatch(/Reads opening hours and closed days/);
    expect(await card.innerText()).toMatch(/A booking never adds a guest to a marketing list/);

    const config = async () => (await db().selectFrom('venue_modules').select('config').where('venue_id', '=', diner.venueId).where('module_key', '=', 'bookings').executeTakeFirstOrThrow()).config;
    const before = await config();
    await card.getByTestId('plugin-configure-bookings').click();
    const form = card.getByTestId('settings-bookings');
    await form.locator('input[name="cfg.booking_note"]').fill('x'.repeat(301));
    await form.getByRole('button', { name: 'Save settings' }).click();
    await form.locator('[role=alert]').waitFor();
    expect(await form.locator('[role=alert]').innerText()).toMatch(/not valid.*booking_note/i);
    expect(await config()).toEqual(before);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('assistant: the connection address, a key, and a call the assistant made are on the page; the old address redirects', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');

    // The old path still lands, on the new section.
    const res = await v.page.request.get(`${BASE()}/console/settings/assistants`, { maxRedirects: 0 });
    expect(res.status()).toBe(308);
    expect(res.headers().location).toMatch(/\/console\/assistant$/);
    await v.page.goto(`${BASE()}/console/settings/assistants`);
    expect(new URL(v.page.url()).pathname).toBe('/console/assistant');
    expect(await v.page.getByTestId('mcp-endpoint').innerText()).toBe(`${BASE()}/api/mcp`);
    expect(await v.page.locator('main').innerText()).toMatch(/Sign in from the assistant/);
    expect(await v.page.locator('main').innerText()).toMatch(/Paste a key/);
    expect(await v.page.getByTestId('hosted-agents').innerText()).toMatch(/Shadow|Supervised|Autonomous|Off/);

    const name = `IA key ${run}`;
    await v.page.fill('input[name=name]', name);
    await v.page.click('button:has-text("Create key")');
    const shown = v.page.getByTestId('new-agent-key');
    await shown.waitFor();
    const key = (await shown.textContent())!.trim();

    // The assistant calls a tool with the key, as it would.
    const mcp = await fetch(`${BASE()}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${key}`, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'venue_status' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'venue_status', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'e2e-assistant', version: '1.0.0' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
    });
    expect(mcp.status).toBe(200);
    const text = await mcp.text();
    expect(text).toContain('open_now');
    const keyRow = await eventually(() => db().selectFrom('agent_keys').select('id').where('name', '=', name).executeTakeFirst(), 'key row');
    const call = await eventually(() => db().selectFrom('agent_calls').select(['tool', 'outcome', 'effect']).where('key_id', '=', keyRow.id).executeTakeFirst(), 'the call on the record');
    expect(call).toMatchObject({ tool: 'venue_status', outcome: 'answered', effect: 'read' });

    await v.page.reload();
    const row = v.page.locator('[data-testid=agent-call][data-tool=venue_status]').first();
    await row.waitFor();
    expect(await row.innerText()).toContain(name);
    expect(await row.getAttribute('data-outcome')).toBe('answered');
    expect(await v.page.content()).not.toContain(key.slice(20));

    await v.page.getByTestId(`revoke-key-${name}`).click();
    await confirmDialog(v.page, 'Revoke key', /Key revoked/);
    await eventually(async () => (await db().selectFrom('agent_keys').select('revoked_at').where('id', '=', keyRow.id).executeTakeFirstOrThrow()).revoked_at, 'key revoked');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('on a phone the sidebar becomes a bottom bar (Home, Orders, Bookings, Menu, More) and no page scrolls sideways', async () => {
    const v = await newVisitor({ mobile: true });
    await signInStaff(v.page, 'owner@oak-diner.test');
    await v.page.goto(`${BASE()}/console`);
    const bar = v.page.locator('nav[aria-label="Main sections"]');
    await bar.waitFor();
    // Each item is an icon (hidden from assistive tech) over a word; the word is the name.
    expect((await bar.locator('a, button').allInnerTexts()).map((t) => t.split('\n').pop()!.trim())).toEqual(['Home', 'Orders', 'Bookings', 'Menu', 'More']);
    expect(await bar.getByRole('link', { name: 'Bookings', exact: true }).count()).toBe(1);
    expect(await v.page.locator('aside').isVisible()).toBe(false);
    for (const path of ['/console', '/console/orders', '/console/bookings', '/console/menu', '/console/plugins', '/console/channels', '/console/assistant', '/console/analytics']) {
      await v.page.goto(`${BASE()}${path}`);
      await v.page.waitForLoadState('networkidle');
      const widths = await v.page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(widths.scroll, path).toBeLessThanOrEqual(widths.inner);
      expect(await bar.isVisible(), path).toBe(true);
    }
    // More opens every section as a sheet, which the keyboard can close.
    await bar.getByRole('button', { name: 'More' }).click();
    const sheet = v.page.locator('dialog[open]');
    await sheet.waitFor();
    expect(await sheet.locator('nav[aria-label="All sections"] a').allInnerTexts()).toEqual(ALL_SECTIONS);
    await v.page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });
    await bar.getByRole('button', { name: 'More' }).click();
    await v.page.locator('dialog[open] a', { hasText: 'Plugins' }).click();
    await v.page.waitForURL(/\/console\/plugins$/);
    expect(await v.page.locator('h1').innerText()).toBe('Plugins');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
