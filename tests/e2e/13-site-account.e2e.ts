import { afterAll, describe, expect, it } from 'vitest';
import { closeBrowser, closeDb, db, eventually, orgBySlug, waitForMessage } from './helpers';
import { addItem, closeStaff, openCheckout, signInGuest, siteUrl, unique, visitor, waitPriced } from './site-helpers';

afterAll(async () => {
  await closeBrowser();
  await closeDb();
  await closeStaff();
});

const customerByEmail = async (orgId: string, email: string) => db().selectFrom('customers').selectAll().where('org_id', '=', orgId).where('primary_email', '=', email).executeTakeFirstOrThrow();

describe('venue site: the guest account, loyalty, offers and consent', () => {
  it('a guest joins loyalty at checkout, then sees the points on their account page with a membership QR', async () => {
    const { orgId } = await orgBySlug('oak-diner');
    const email = unique('lou');
    const v = await visitor({ mobile: true });
    await v.page.goto(siteUrl('oak-diner', '/order'));
    await addItem(v.page, 'Scotch fillet 300g', ['Medium']);
    await openCheckout(v.page);
    await v.page.fill('input[name=name]', 'Lou Loyal');
    await v.page.fill('input[name=email]', email);
    await v.page.check('input[name=loyalty_join]');
    await v.page.check('[data-consent=marketing_email] input');
    await v.page.click('label:has-text("Test card A")');
    await waitPriced(v.page);
    await v.page.click('form button[type=submit]');
    await v.page.waitForURL(/\/order\/t\//);

    const customer = await customerByEmail(orgId, email);
    const account = await eventually(() => db().selectFrom('loyalty_accounts').select(['id', 'member_code']).where('customer_id', '=', customer.id).executeTakeFirst(), 'the loyalty account');
    const earned = await eventually(async () => {
      const rows = await db().selectFrom('loyalty_transactions').select(['kind', 'points']).where('account_id', '=', account.id).execute();
      return rows.some((r) => r.kind === 'earn') ? rows : null;
    }, 'points earned on the paid order');
    const balance = earned.reduce((s, r) => s + r.points, 0);
    expect(balance).toBeGreaterThan(0);

    await signInGuest(v.page, 'oak-diner', email);
    expect(Number(await v.page.getAttribute('[data-points-balance]', 'data-points-balance'))).toBe(balance);
    expect((await v.page.textContent('[data-member-code]'))!.trim()).toBe(account.member_code);
    expect(await v.page.getAttribute('svg[data-member-qr]', 'data-member-qr')).toBe(account.member_code);
    expect(await v.page.locator('svg[data-member-qr] path').getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
    // The order is in their history.
    const order = await db().selectFrom('orders').select('reference').where('customer_id', '=', customer.id).executeTakeFirstOrThrow();
    expect(await v.page.locator(`[data-order-ref="${order.reference}"]`).count()).toBe(1);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a guest withdraws one consent in one step, and turns another on, on their account page', async () => {
    const { orgId } = await orgBySlug('oak-diner');
    const email = unique('cora');
    const v = await visitor();
    await signInGuest(v.page, 'oak-diner', email);
    const customer = await customerByEmail(orgId, email);
    // Turn on email offers (with the words shown), then withdraw them; each is one press.
    await v.page.click('[data-consent-row=marketing_email] button:has-text("Turn on")');
    await v.page.waitForSelector('[data-consent-row=marketing_email][data-granted=yes]');
    let row = await db().selectFrom('consents').selectAll().where('customer_id', '=', customer.id).where('purpose', '=', 'marketing_email').executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'granted', wording_version: 'v1', source: 'guest_account' });
    await v.page.click('[data-consent-row=marketing_email] button:has-text("Withdraw")');
    await v.page.waitForSelector('[data-consent-row=marketing_email][data-granted=no]');
    row = await db().selectFrom('consents').selectAll().where('customer_id', '=', customer.id).where('purpose', '=', 'marketing_email').executeTakeFirstOrThrow();
    expect(row.status).toBe('revoked');
    const events = await db().selectFrom('consent_events').select(['action', 'source']).where('customer_id', '=', customer.id).orderBy('occurred_at').execute();
    expect(events).toEqual([
      { action: 'granted', source: 'guest_account' },
      { action: 'revoked', source: 'guest_account' },
    ]);
    // The others were never touched.
    expect(await db().selectFrom('consents').select('purpose').where('customer_id', '=', customer.id).execute()).toHaveLength(1);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a guest signs up for the welcome offer, then redeems the code at checkout', async () => {
    const { orgId } = await orgBySlug('oak-diner');
    const offer = await db().selectFrom('offers').select(['id', 'name']).where('org_id', '=', orgId).where('kind', '=', 'welcome').where('is_active', '=', true).executeTakeFirstOrThrow();
    const email = unique('wes');
    const v = await visitor({ mobile: true });
    await v.page.goto(siteUrl('oak-diner', `/offer/${offer.id}`));
    expect(await v.page.textContent('h1')).toBe(offer.name);
    await v.page.fill('input[name=firstName]', 'Wes');
    await v.page.fill('input[name=contact]', email);
    await v.page.click('button:has-text("Get my code")');
    const code = (await (await v.page.waitForSelector('[data-issued-code]')).getAttribute('data-issued-code'))!;
    const customer = await customerByEmail(orgId, email);
    expect(customer.acquisition_source).toBe('offer');
    expect(customer.acquisition_code).toBe(code);

    await v.page.click('a:has-text("Use it on an order")');
    await v.page.waitForURL(/\/order\?code=/);
    await addItem(v.page, 'Wagyu rump 250g');
    await openCheckout(v.page);
    await v.page.fill('input[name=name]', 'Wes Welcome');
    await v.page.fill('input[name=email]', email);
    await v.page.waitForSelector('dt:has-text("Welcome")');
    await v.page.click('label:has-text("Test card A")');
    await waitPriced(v.page);
    await v.page.click('form button[type=submit]');
    await v.page.waitForURL(/\/order\/t\//);
    const order = await db().selectFrom('orders').select(['id', 'discount_cents', 'promo_code', 'customer_id']).where('customer_email', '=', email).executeTakeFirstOrThrow();
    expect(order).toMatchObject({ discount_cents: 1000, promo_code: code, customer_id: customer.id });
    const row = await db().selectFrom('offer_codes').select(['status', 'redeemed_order_id']).where('code', '=', code).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'redeemed', redeemed_order_id: order.id });
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a claim link previews without claiming, then claims with one tap; a creator offer carries the creator into the visit', async () => {
    const { orgId } = await orgBySlug('oak-diner');
    const issued = await db()
      .selectFrom('offer_codes as c')
      .innerJoin('offers as o', 'o.id', 'c.offer_id')
      .select(['c.code', 'c.id'])
      .where('c.org_id', '=', orgId)
      .where('c.status', '=', 'issued')
      .where('c.expires_at', '>', new Date('2026-10-03T00:00:00Z'))
      .where('o.creator_id', 'is', null)
      .executeTakeFirstOrThrow();
    let v = await visitor({ mobile: true });
    await v.page.goto(siteUrl('oak-diner', `/claim/${issued.code}`));
    expect(await v.page.getAttribute('[data-code-status]', 'data-code-status')).toBe('issued');
    expect((await db().selectFrom('offer_codes').select('status').where('id', '=', issued.id).executeTakeFirstOrThrow()).status).toBe('issued');
    await v.page.click('button:has-text("Claim this offer")');
    await v.page.waitForSelector(`[data-issued-code="${issued.code}"]`);
    expect((await db().selectFrom('offer_codes').select('status').where('id', '=', issued.id).executeTakeFirstOrThrow()).status).toBe('claimed');

    const creator = await db().selectFrom('offers').select(['id', 'creator_id', 'campaign_id']).where('org_id', '=', orgId).where('kind', '=', 'creator').executeTakeFirstOrThrow();
    expect(v.problems).toEqual([]);
    await v.context.close();
    // Attribution is first-touch, so this is a new visitor arriving from the creator's link.
    v = await visitor({ mobile: true });
    await v.page.goto(siteUrl('oak-diner', `/offer/${creator.id}`));
    await v.page.waitForURL(/creator=/);
    const url = new URL(v.page.url());
    expect(url.searchParams.get('creator')).toBe(creator.creator_id);
    await v.page.waitForLoadState('networkidle');
    const vs = (await eventually(async () => (await v.context.cookies()).find((c) => c.name === 'ros_vs'), 'the visitor cookie')).value;
    const session = await eventually(() => db().selectFrom('visitor_sessions').select(['creator_id', 'campaign_id']).where('id', '=', vs).executeTakeFirst(), 'the visitor session');
    expect(session).toEqual({ creator_id: creator.creator_id, campaign_id: creator.campaign_id });
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it("one venue's guest session is not a session on another venue's site", async () => {
    const email = unique('host');
    const v = await visitor();
    await signInGuest(v.page, 'oak-diner', email);
    const cookie = (await v.context.cookies(siteUrl('oak-diner', '/'))).find((c) => c.name === 'ros_guest')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.domain).toBe('oak-diner.tables.localhost');
    expect((await v.context.cookies(siteUrl('oak-group', '/'))).find((c) => c.name === 'ros_guest')).toBeUndefined();

    await v.page.goto(siteUrl('oak-group', '/account'));
    await v.page.waitForURL(/\/account\/login/);
    // Even carried across by hand, the diner's session means nothing at the group.
    await v.context.addCookies([{ name: 'ros_guest', value: cookie.value, domain: 'oak-group.tables.localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
    await v.page.goto(siteUrl('oak-group', '/account'));
    await v.page.waitForURL(/\/account\/login/);
    expect(await v.page.locator('header').textContent()).toContain('Sign in');
    const { orgId } = await orgBySlug('oak-group');
    expect(await db().selectFrom('customers').select('id').where('org_id', '=', orgId).where('primary_email', '=', email).execute()).toHaveLength(0);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a guest downloads their data, then deletes their account with a clear confirmation', async () => {
    const { orgId } = await orgBySlug('oak-diner');
    const email = unique('del');
    const v = await visitor();
    await signInGuest(v.page, 'oak-diner', email);
    const download = v.page.waitForEvent('download');
    await v.page.click('button:has-text("Download my data")');
    const file = await (await download).path();
    const data = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'));
    expect(data.customer.email).toBe(email);
    expect(Object.keys(data)).toEqual(expect.arrayContaining(['customer', 'identities', 'consents', 'transactions', 'orders']));

    await v.page.click('summary:has-text("Delete my account")');
    await v.page.click('button:has-text("Delete my account")');
    // Nothing happens without the confirmation typed.
    await v.page.waitForSelector('input[name=confirm]:invalid');
    await v.page.fill('input[name=confirm]', 'nope');
    await v.page.click('button:has-text("Delete my account")');
    await v.page.waitForSelector('[role=alert]:has-text("Type DELETE")');
    expect((await customerByEmail(orgId, email)).status).toBe('active');
    await v.page.fill('input[name=confirm]', 'DELETE');
    await v.page.click('button:has-text("Delete my account")');
    await v.page.waitForURL(/\/account\/deleted$/);
    const gone = await db().selectFrom('customers').select(['status', 'primary_email', 'first_name']).where('org_id', '=', orgId).where('status', '=', 'deleted').orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect(gone).toEqual({ status: 'deleted', primary_email: null, first_name: null });
    expect(await db().selectFrom('customer_identities').select('id').where('value', '=', email).execute()).toHaveLength(0);
    expect((await v.context.cookies()).find((c) => c.name === 'ros_guest')).toBeUndefined();
    await v.page.goto(siteUrl('oak-diner', '/account'));
    await v.page.waitForURL(/\/account\/login/);
    expect(v.problems).toEqual([]);
    await v.context.close();
    void waitForMessage;
  });
});
