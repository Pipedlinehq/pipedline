import { afterAll, describe, expect, it } from 'vitest';
import { BASE, closeBrowser, closeDb, db, newVisitor, orgBySlug, signInStaff } from './helpers';

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

/** Buttons that only read or navigate. Anything else on a read-only person's screen would be a way to change something. */
const HARMLESS = /^(Apply|Ask|Show table|Show chart|Sign out|Close|✕|Cancel|Search|Look up|Find|Filter|Download as CSV|Previous|Next|Load more|Show|Print.*)$/i;

describe('console scope: people see only their venues, and read-only people change nothing', () => {
  it("the two-venue manager never sees the third venue's orders or numbers", async () => {
    const group = await orgBySlug('oak-group');
    const bondi = group.venues.find((x) => x.slug === 'bondi')!;
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-group.test');

    // The venue selector and the analytics filter offer only their own venues.
    expect(await v.page.$$eval('#venue-select option', (o) => o.map((x) => x.textContent))).toEqual(['Oak Group CBD', 'Oak Group Newtown']);
    await v.page.goto(`${BASE()}/console?venue=all`);
    const venueOptions = await v.page.$$eval('form[role=search] select[name=venue] option', (o) => o.map((x) => x.textContent ?? ''));
    expect(venueOptions.join('|')).not.toContain('Bondi');

    // "All venues" covers theirs, and the numbers say so.
    const prov = await v.page.locator('[data-testid=kpi-tiles] ~ [data-testid=provenance]').first().innerText();
    expect(prov).toContain('Oak Group CBD');
    expect(prov).not.toContain('Bondi');

    // Asking for the third venue by URL is ignored, and a cookie naming it cannot widen access.
    await v.page.goto(`${BASE()}/console?venue=${bondi.id}`);
    expect(await v.page.locator('[data-testid=kpi-tiles] ~ [data-testid=provenance]').first().innerText()).not.toContain('Bondi');
    await v.context.addCookies([{ name: 'ros_venue', value: bondi.id, url: `${BASE()}/console` }]);
    await v.page.goto(`${BASE()}/console`);
    expect(await v.page.locator('#venue-select').inputValue()).not.toBe(bondi.id);

    // A question naming the third venue by URL is not asked of it: the filter falls back to their own venue.
    await v.page.goto(`${BASE()}/console/analytics/views?m=net_sales&venue=${bondi.id}`);
    expect(await v.page.locator('[data-testid=explore-answer]').innerText()).not.toContain('Bondi');

    // Orders: none of the third venue's orders appear under either of their venues, and its order is not found by id.
    const bondiOrders = await db().selectFrom('orders').select(['id', 'reference']).where('venue_id', '=', bondi.id).where('status', 'not in', ['draft', 'pending_payment']).execute();
    for (const venue of group.venues.filter((x) => x.slug !== 'bondi')) {
      await v.page.goto(`${BASE()}/console`);
      await v.page.selectOption('#venue-select', venue.id);
      await v.page.waitForLoadState('networkidle');
      await v.page.goto(`${BASE()}/console/orders`);
      const text = await v.page.locator('main').innerText();
      for (const o of bondiOrders) expect(text).not.toContain(o.reference);
    }
    if (bondiOrders[0]) {
      await v.page.goto(`${BASE()}/console/orders/${bondiOrders[0].id}`);
      expect(await v.page.locator('main').innerText()).toMatch(/not here|not found/i);
    }
    await v.context.close();
  });

  it('the read-only role is shown no way to change anything, and a change sent anyway is refused', async () => {
    const group = await orgBySlug('oak-group');
    const pages = ['/console', '/console/orders', '/console/loyalty', '/console/offers', '/console/menu', '/console/qr', '/console/analytics', '/console/analytics/views', '/console/analytics/digest'];
    const auditBefore = await db().selectFrom('audit_log').select((eb) => eb.fn.max('occurred_at').as('at')).where('org_id', '=', group.orgId).executeTakeFirstOrThrow();

    const ro = await newVisitor();
    await signInStaff(ro.page, 'accounts@oak-group.test');
    for (const p of pages) {
      await ro.page.goto(`${BASE()}${p}`);
      const buttons = (await ro.page.locator('main button:visible').allInnerTexts()).map((t) => t.trim()).filter((t) => t && !HARMLESS.test(t));
      expect(buttons, p).toEqual([]);
      const writable = await ro.page.locator('main form:not([method=get]) :is(input[type=text], input:not([type]), input[type=number], textarea, select):visible').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).name));
      expect(writable, p).toEqual([]);
    }
    // The settings screens are not in their navigation.
    expect(await ro.page.locator('nav[aria-label=Console] a', { hasText: 'Team' }).count()).toBe(0);

    // A manager's real "pin this view" request, replayed with the read-only person's session.
    const mgr = await newVisitor();
    await signInStaff(mgr.page, 'manager@oak-group.test');
    await mgr.page.goto(`${BASE()}/console/analytics/views`);
    const view = await db().selectFrom('saved_views').select(['id', 'name', 'is_pinned']).where('org_id', '=', group.orgId).where('name', '=', 'Top items this month').executeTakeFirstOrThrow();
    const row = mgr.page.locator('[data-testid=saved-view]', { hasText: view.name });
    const captured = mgr.page.waitForRequest((r) => r.method() === 'POST' && !!r.headers()['next-action']);
    await row.getByRole('button', { name: view.is_pinned ? 'Unpin' : 'Pin' }).click();
    const request = await captured;
    // Put it back as it was.
    await row.getByRole('button', { name: view.is_pinned ? 'Pin' : 'Unpin' }).waitFor();
    await row.getByRole('button', { name: view.is_pinned ? 'Pin' : 'Unpin' }).click();
    await row.getByRole('button', { name: view.is_pinned ? 'Unpin' : 'Pin' }).waitFor();
    const settled = await db().selectFrom('saved_views').select('is_pinned').where('id', '=', view.id).executeTakeFirstOrThrow();
    expect(settled.is_pinned).toBe(view.is_pinned);

    const roCookie = (await ro.context.cookies()).find((c) => c.name === 'ros_staff')!;
    const replay = await fetch(request.url(), {
      method: 'POST',
      headers: { ...request.headers(), cookie: `ros_staff=${roCookie.value}` },
      body: new Uint8Array(request.postDataBuffer() ?? Buffer.alloc(0)),
    });
    const answer = await replay.text();
    expect(answer).toMatch(/does not allow|not allowed|Only /);
    const after = await db().selectFrom('saved_views').select('is_pinned').where('id', '=', view.id).executeTakeFirstOrThrow();
    expect(after.is_pinned).toBe(view.is_pinned);

    // Nothing the read-only person did left a change on the record.
    const roStaff = await db().selectFrom('staff').select('id').where('org_id', '=', group.orgId).where('email', '=', 'accounts@oak-group.test').executeTakeFirstOrThrow();
    const byThem = await db().selectFrom('audit_log').select('action').where('org_id', '=', group.orgId).where('actor_id', '=', roStaff.id).execute();
    expect(byThem).toEqual([]);
    const pins = await db().selectFrom('audit_log').select('action').where('entity_id', '=', view.id).where('occurred_at', '>', (auditBefore.at as Date | null) ?? new Date(0)).execute();
    expect(pins.map((p) => p.action)).toEqual(['analytics.view_pinned', 'analytics.view_pinned']);
    expect(ro.problems).toEqual([]);
    await ro.context.close();
    await mgr.context.close();
  });
});
