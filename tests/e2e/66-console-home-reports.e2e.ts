import { afterAll, describe, expect, it } from 'vitest';
import { setModule } from '@ros/core';
import { hub } from '@ros/modules';
import { BASE, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff, waitForMessage } from './helpers';
import { closeOpsApp, devPost, opsApp, staffAs } from './ops-helpers';

/**
 * Wave 2, Home · Reports · Alerts · Plugs (docs/CONSOLE_IA.md section 9, patterns 8, 9, 13, 14):
 * needs-attention counts that open the view with the same rows and a card put away per person; a
 * report with a comparison, a download and "Save as"; an alert rule with a test send that reaches
 * the simulated inbox; a plugin's page with last-used from a real call. Every write is read back.
 */
afterAll(async () => {
  await closeOpsApp();
  await closeBrowser();
  await closeDb();
});

const run = Date.now().toString(36);
const placeOrder = (venueId: string, over: Record<string, unknown> = {}) => devPost<{ orderId: string; reference: string }>('order', { venueId, ...over });

describe('console: Home needs-attention, cards and suggestions', () => {
  it('the orders count opens "Needs accepting" with exactly as many rows; a card put away stays away for that person only', async () => {
    const diner = await orgBySlug('oak-diner');
    await placeOrder(diner.venueId, { guestName: `Home One ${run}`, guestEmail: `home1.${run}@example.com` });
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console`);
    const strip = v.page.getByTestId('home-attention');
    await strip.waitFor();
    const link = v.page.getByTestId('attention-orders_to_accept');
    await link.waitFor();
    const count = Number(await link.getAttribute('data-count'));
    expect(count).toBeGreaterThan(0);
    expect(await link.innerText()).toBe(`${count} ${count === 1 ? 'order to accept' : 'orders to accept'}`);
    // The owning module agrees, and so does the page behind the link.
    const waiting = await db().selectFrom('orders').select('id').where('venue_id', '=', diner.venueId).where('status', '=', 'placed').execute();
    expect(count).toBe(waiting.length);
    await link.click();
    await v.page.waitForURL((u) => u.pathname === '/console/orders' && u.searchParams.get('view') === 'accepting');
    await v.page.locator('[data-testid^=order-]').first().waitFor();
    expect(await v.page.locator('[data-testid^=order-]').count()).toBe(count);

    // A guidance card, put away: gone for the manager, read back as one row, still there for the owner.
    await v.page.goto(`${BASE()}/console`);
    const card = v.page.getByTestId('home-card-guide.reports');
    await card.waitFor();
    await v.page.getByTestId('dismiss-card-guide.reports').locator('button').click();
    await card.waitFor({ state: 'hidden' });
    const managerId = (await db().selectFrom('staff').select('id').where('email', '=', 'manager@oak-diner.test').executeTakeFirstOrThrow()).id;
    const rows = await eventually(async () => {
      const r = await db().selectFrom('home_dismissals').selectAll().where('org_id', '=', diner.orgId).where('card_key', '=', 'guide.reports').execute();
      return r.length ? r : null;
    }, 'the dismissal row');
    expect(rows.map((r) => r.staff_id)).toEqual([managerId]);
    await v.page.reload();
    await v.page.getByTestId('home-attention').waitFor();
    expect(await v.page.getByTestId('home-card-guide.reports').count()).toBe(0);
    const owner = await newVisitor();
    await signInStaff(owner.page, 'owner@oak-diner.test');
    await owner.page.goto(`${BASE()}/console`);
    await owner.page.getByTestId('home-card-guide.reports').waitFor();
    expect(v.problems).toEqual([]);
    expect(owner.problems).toEqual([]);
    await v.context.close();
    await owner.context.close();
  });

  it('a paid order left waiting becomes a suggestion; Approve accepts it once and it leaves the list', async () => {
    const diner = await orgBySlug('oak-diner');
    const manager = await staffAs('manager@oak-diner.test', 'oak-diner');
    const app = await opsApp();
    // The venue counts an order as waiting after one minute, so the suggestion appears inside the test's time.
    await app.tenant(manager.orgId, manager.principal, (ctx) => setModule(ctx, hub.hubModule, { venueId: diner.venueId, enabled: true, config: { ops_order_waiting_minutes: 1 } }));
    const order = await placeOrder(diner.venueId, { guestName: `Suggest ${run}`, guestEmail: `suggest.${run}@example.com` });
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    const key = `ops.accept_order:${order.reference}`;
    await eventually(async () => {
      await v.page.goto(`${BASE()}/console`);
      await v.page.getByTestId('home-suggestions').waitFor();
      return (await v.page.getByTestId(`suggestion-${key}`).count()) > 0 ? true : null;
    }, 'the suggestion to accept the order', 100_000);
    const row = v.page.getByTestId(`suggestion-${key}`);
    expect(await row.innerText()).toContain(`Accept order ${order.reference}`);
    await v.page.getByTestId(`approve-${key}`).click();
    const dialog = v.page.locator('dialog[open]');
    await dialog.waitFor();
    expect(await dialog.innerText()).toContain(`Accept order ${order.reference}?`);
    await dialog.getByRole('button', { name: 'Accept it', exact: true }).click();
    const accepted = await eventually(async () => {
      const o = await db().selectFrom('orders').select(['status', 'accepted_at']).where('id', '=', order.orderId).executeTakeFirstOrThrow();
      return o.status === 'accepted' ? o : null;
    }, 'the order accepted');
    expect(accepted.accepted_at).not.toBeNull();
    const decision = await db().selectFrom('home_suggestion_decisions').selectAll().where('suggestion_key', '=', key).executeTakeFirstOrThrow();
    expect(decision.decision).toBe('approved');
    expect((await db().selectFrom('order_status_history').select('id').where('order_id', '=', order.orderId).where('to_status', '=', 'accepted').execute()).length).toBe(1);
    await v.page.goto(`${BASE()}/console`);
    await v.page.getByTestId('home-suggestions').waitFor();
    expect(await v.page.getByTestId(`suggestion-${key}`).count()).toBe(0);
    await app.tenant(manager.orgId, manager.principal, (ctx) => setModule(ctx, hub.hubModule, { venueId: diner.venueId, enabled: true, config: { ops_order_waiting_minutes: 10 } }));
    expect(v.problems).toEqual([]);
    await v.context.close();
  }, 150_000);
});

describe('console: reports', () => {
  it('a report runs with a comparison, downloads as CSV with the table\'s rows, and "Save as" keeps it for the organisation', async () => {
    const diner = await orgBySlug('oak-diner');
    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    await v.page.goto(`${BASE()}/console/analytics/reports`);
    await v.page.getByTestId('reports-catalogue').waitFor();
    expect(await v.page.getByTestId('reports-sales').innerText()).toContain('Created by Pipedline');
    await v.page.getByTestId('report-sales.by_channel').locator('a').first().click();
    await v.page.waitForURL(/\/console\/analytics\/reports\/sales\.by_channel/);
    await v.page.goto(`${BASE()}/console/analytics/reports/sales.by_channel?period=last_28_days&compare=previous_period&venue=${diner.venueId}`);
    await v.page.getByTestId('report-figure').waitFor();
    const provenance = v.page.getByTestId('provenance').first();
    expect(await provenance.innerText()).toMatch(/compared with .* the 28 days immediately before/);
    const rows = await v.page.locator('[data-testid=report-table] tbody tr').count();
    // The table ends with its total row.
    expect(rows).toBeGreaterThan(1);
    expect(await v.page.locator('[data-testid=report-table] thead').innerText()).toMatch(/change/i);

    // Download: the same rows as the table, through the owner's own session.
    const href = await v.page.getByRole('link', { name: 'Download CSV' }).getAttribute('href');
    expect(href).toContain('/console/analytics/reports/sales.by_channel/export?');
    const res = await v.page.request.get(`${BASE()}${href}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition']).toMatch(/attachment; filename="sales\.by_channel_/);
    const lines = (await res.text()).trim().split('\n');
    expect(lines[0]).toContain('channel,net_sales,net_sales__compare,net_sales__change_pct');
    expect(lines.length).toBe(rows);
    const audited = await eventually(() => db().selectFrom('audit_log').select('id').where('org_id', '=', diner.orgId).where('action', '=', 'analytics.exported').executeTakeFirst(), 'the export on the record');
    expect(audited).toBeDefined();

    // Save as: a report of the venue's own, read back, listed under its category as "Yours".
    const name = `Channel mix ${run}`;
    await v.page.getByRole('button', { name: 'Save as…' }).click();
    await v.page.getByTestId('save-report-name').fill(name);
    await v.page.locator('dialog[open] select[name=category]').selectOption('sales');
    await v.page.locator('dialog[open]').getByRole('button', { name: 'Save report', exact: true }).click();
    const saved = await eventually(() => db().selectFrom('report_definitions').selectAll().where('org_id', '=', diner.orgId).where('name', '=', name).executeTakeFirst(), 'the saved report row');
    expect(saved).toMatchObject({ category: 'sales', chart: 'bars' });
    expect(saved.query).toEqual({ metrics: ['net_sales', 'orders', 'avg_order_value'], dimensions: ['channel'] });
    await v.page.goto(`${BASE()}/console/analytics/reports`);
    const mine = v.page.getByTestId(`report-saved:${saved.id}`);
    await mine.waitFor();
    expect(await mine.innerText()).toContain('Yours');
    expect(await mine.innerText()).toContain('Created by');
    // It runs as its own page, from the same question.
    await v.page.goto(`${BASE()}/console/analytics/reports/${saved.id}?period=last_7_days&compare=none`);
    await v.page.getByTestId('report-figure').waitFor();
    expect(await v.page.locator('h1').innerText()).toBe(name);
    // Mark a date: it comes back under the chart.
    await v.page.getByTestId('annotation-label').fill(`Menu change ${run}`);
    await v.page.getByRole('button', { name: 'Mark this date' }).click();
    const mark = await eventually(() => db().selectFrom('report_annotations').selectAll().where('org_id', '=', diner.orgId).where('label', '=', `Menu change ${run}`).executeTakeFirst(), 'the annotation row');
    expect(mark.venue_id).toBeNull();
    await v.page.getByTestId('annotation-list').getByText(`Menu change ${run}`).waitFor();
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});

describe('console: alerts to the team and plugin pages', () => {
  it('an alert rule is added for one person; "Send a test" delivers one email to them and nobody else', async () => {
    const diner = await orgBySlug('oak-diner');
    const managerId = (await db().selectFrom('staff').select('id').where('email', '=', 'manager@oak-diner.test').executeTakeFirstOrThrow()).id;
    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    await v.page.goto(`${BASE()}/console/settings/notifications`);
    const section = v.page.getByTestId('alert-event-digest.weekly');
    await section.waitFor();
    await v.page.getByTestId('alert-recipient-digest.weekly').selectOption(`staff:${managerId}`);
    await v.page.getByTestId('alert-channel-digest.weekly').selectOption('email');
    await section.getByRole('button', { name: 'Add', exact: true }).click();
    const rule = await eventually(() => db().selectFrom('alert_rules').selectAll().where('org_id', '=', diner.orgId).where('event', '=', 'digest.weekly').where('recipient', '=', managerId).executeTakeFirst(), 'the alert rule row');
    expect(rule).toMatchObject({ venue_id: diner.venueId, channel: 'email', recipient_kind: 'staff', enabled: true });
    await v.page.getByTestId(`alert-rule-${rule.id}`).waitFor();
    const before = (await db().selectFrom('messages').select('id').where('org_id', '=', diner.orgId).where('template_key', '=', 'alerts.team').execute()).length;
    await v.page.getByTestId(`alert-test-${rule.id}`).locator('button').click();
    const mail = await waitForMessage('manager@oak-diner.test', (m) => /^Test alert from Oak Diner: the weekly digest/.test(m.subject ?? ''));
    expect(mail.kind).toBe('transactional');
    expect(mail.body).toContain('This is a test of the "The weekly digest" alert for Oak Diner.');
    const after = await db().selectFrom('messages').select(['to_address', 'customer_id', 'kind']).where('org_id', '=', diner.orgId).where('template_key', '=', 'alerts.team').execute();
    expect(after.length).toBe(before + 1);
    expect(after.every((m) => m.customer_id === null && m.kind === 'transactional')).toBe(true);
    expect(after.map((m) => m.to_address)).toContain('manager@oak-diner.test');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a plugin\'s page lists what it reads and writes and its tools, with last-used from a real call; a service not connected says what would leave the venue', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    // A key, then one real call over the assistant connection, as the Timeline scenario does.
    await v.page.goto(`${BASE()}/console/assistant`);
    const keyName = `Plug page key ${run}`;
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
    const call = await eventually(() => db().selectFrom('agent_calls').select(['id', 'occurred_at']).where('key_id', '=', keyRow.id).where('tool', '=', 'venue_status').executeTakeFirst(), 'the call on the record');

    // The catalogue links to the page; the page shows the manifest words and the call.
    await v.page.goto(`${BASE()}/console/plugins`);
    await v.page.getByTestId('plugin-detail-tenancy').click();
    await v.page.waitForURL(/\/console\/plugins\/tenancy$/);
    await v.page.getByTestId('plugin-reads-writes').waitFor();
    expect(await v.page.getByTestId('plugin-reads-writes').innerText()).toMatch(/reads/i);
    const toolRow = v.page.getByTestId('plugin-tool-venue_status');
    await toolRow.waitFor();
    const lastUsed = await toolRow.getByTestId('tool-last-used').innerText();
    expect(lastUsed).not.toBe('Not yet');
    expect(lastUsed).toMatch(/\d{1,2}:\d{2}/);
    expect(await toolRow.innerText()).toContain('answered');
    expect(await v.page.getByTestId('plugin-idle-note').count()).toBe(0);

    // A service nobody has connected: what leaves the venue, in plain words, and a way to connect.
    await v.page.goto(`${BASE()}/console/plugins/criota-sim`);
    await v.page.getByTestId('plugin-data-leaves').waitFor();
    expect(await v.page.getByTestId('plugin-data-leaves').innerText()).toContain('never anything about one guest');
    expect(await v.page.getByTestId('plugin-detail-actions').innerText()).toContain('Not connected');
    expect(await v.page.getByRole('link', { name: 'Connect' }).count()).toBeGreaterThan(0);
    // One that does not exist is not found.
    const missing = await v.page.goto(`${BASE()}/console/plugins/not-a-plugin`);
    expect(missing?.status()).toBe(404);
    expect(v.problems.filter((p) => !/404/.test(p))).toEqual([]);
    await v.context.close();
    void call;
  });
});
