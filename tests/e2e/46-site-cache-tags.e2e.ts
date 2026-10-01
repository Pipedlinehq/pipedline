import { mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { setModule } from '@ros/core';
import { website } from '@ros/modules';
import { BASE, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff } from './helpers';
import { SHOTS, devPost } from './ops-helpers';
import { asStaff, closeStaff, siteUrl, visitor } from './site-helpers';

/**
 * The venue site's cache and its third-party tags.
 *
 * Cache: a published page's content is cached per tenant and expired by the website module's
 * own tags. A change made from outside the web process cannot reach the cache (proving it is
 * one); a publish in the console expires that organisation's pages at once, and nobody else's.
 *
 * Tags: a venue's Google Analytics and Meta pixel ids load nothing until the visitor says yes.
 */

beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

afterAll(async () => {
  await closeBrowser();
  await closeStaff();
  await closeDb();
});

const run = Date.now().toString(36);

async function publishFromOutside(org: 'diner' | 'group', slug: string, body: string): Promise<string> {
  return asStaff(org, 'manager', async (ctx) => {
    const blocks = [{ type: 'about', id: 'cachebody', heading: 'Cache proof', body }];
    const existing = (await website.listPages(ctx, {})).find((p) => p.slug === slug);
    const page = existing ?? (await website.createPage(ctx, { slug, title: 'Cache proof', blocks }));
    if (existing) await website.savePageDraft(ctx, { pageId: existing.id, blocks });
    await website.publishPage(ctx, { pageId: page.id });
    return page.id;
  });
}

const bodyOf = async (page: Page, url: string) => {
  const res = await page.goto(url);
  expect(res!.status()).toBe(200);
  return page.locator('[data-block=about]').first().innerText();
};

describe('venue site: page cache, expired by tenant', () => {
  it('a published page is served from the cache until that organisation publishes; another organisation publishing does not touch it', async () => {
    const diner = await orgBySlug('oak-diner');
    const group = await orgBySlug('oak-group');
    const slug = `cache-${run}`;
    const dinerUrl = siteUrl('oak-diner', `/${slug}`);
    const groupUrl = siteUrl('oak-group', `/${slug}`);
    const dinerPage = await publishFromOutside('diner', slug, 'Version A at the diner.');
    const groupPage = await publishFromOutside('group', slug, 'Version A at the group.');

    const guest = await visitor();
    try {
      // First read: fresh from the database, and now cached.
      expect(await bodyOf(guest.page, dinerUrl)).toContain('Version A at the diner.');
      expect(await bodyOf(guest.page, groupUrl)).toContain('Version A at the group.');

      // Both pages change in the database, from a process the site's cache cannot hear.
      await publishFromOutside('diner', slug, 'Version B at the diner.');
      await publishFromOutside('group', slug, 'Version B at the group.');
      expect(JSON.stringify((await db().selectFrom('pages').select('blocks').where('id', '=', dinerPage).executeTakeFirstOrThrow()).blocks)).toContain('Version B at the diner.');
      // The site still answers from its cache: that is what a cache is.
      expect(await bodyOf(guest.page, dinerUrl)).toContain('Version A at the diner.');
      expect(await bodyOf(guest.page, groupUrl)).toContain('Version A at the group.');

      // The diner's manager publishes in the console. The website module revalidates the diner's tag in the web process.
      const staff = await newVisitor();
      await signInStaff(staff.page, 'manager@oak-diner.test');
      await staff.page.goto(`${BASE()}/console/website/pages/${dinerPage}`);
      await staff.page.getByTestId('publish-page').click();
      const confirm = staff.page.locator('dialog[open]');
      await confirm.getByRole('button', { name: 'Publish now' }).click();
      await confirm.getByText('Published. The page is live on the site.').waitFor();

      // The very next read of the diner's page is fresh…
      expect(await bodyOf(guest.page, dinerUrl)).toContain('Version B at the diner.');
      // …and the group's cache was not touched: exactly one tenant was expired.
      expect(await bodyOf(guest.page, groupUrl)).toContain('Version A at the group.');
      // The diner's other pages still render (their cached copies were expired too, and re-read).
      expect((await guest.page.goto(siteUrl('oak-diner', '/')))!.status()).toBe(200);
      expect(staff.problems).toEqual([]);
      await staff.context.close();

      // The group publishes in its own console: now its page is fresh as well.
      const owner = await newVisitor();
      await signInStaff(owner.page, 'owner@oak-group.test');
      await owner.page.goto(`${BASE()}/console/website/pages/${groupPage}`);
      await owner.page.getByTestId('publish-page').click();
      await owner.page.locator('dialog[open]').getByRole('button', { name: 'Publish now' }).click();
      await owner.page.locator('dialog[open]').getByText('Published. The page is live on the site.').waitFor();
      expect(await bodyOf(guest.page, groupUrl)).toContain('Version B at the group.');
      expect(owner.problems).toEqual([]);
      await owner.context.close();

      // Unpublishing is a change like any other: the page is gone at once, not when the cache runs out.
      const again = await newVisitor();
      await signInStaff(again.page, 'manager@oak-diner.test');
      await again.page.goto(`${BASE()}/console/website/pages/${dinerPage}`);
      await again.page.getByRole('button', { name: 'Take off the site' }).click();
      await again.page.locator('dialog[open]').getByRole('button', { name: 'Take it down' }).click();
      await eventually(async () => (await db().selectFrom('pages').select('status').where('id', '=', dinerPage).executeTakeFirstOrThrow()).status !== 'published', 'the page unpublished');
      const gone = await fetch(dinerUrl);
      expect(gone.status).toBe(404);
      await again.context.close();
    } finally {
      await asStaff('diner', 'manager', (ctx) => website.deletePage(ctx, { pageId: dinerPage })).catch(() => undefined);
      await asStaff('group', 'manager', (ctx) => website.deletePage(ctx, { pageId: groupPage })).catch(() => undefined);
      // The deletions were made from outside: tell the site, as a publish inside it would have.
      await devPost('site-bust', { orgId: diner.orgId });
      await devPost('site-bust', { orgId: group.orgId });
    }
    expect((await fetch(groupUrl)).status).toBe(404);
    await guest.context.close();
  });
});

const THIRD_PARTY = /googletagmanager\.com|google-analytics\.com|connect\.facebook\.net|facebook\.com\/tr/;

/** A guest whose requests to the tag providers are answered locally and written down. */
async function taggedVisitor(opts: { gpc?: boolean } = {}): Promise<{ page: Page; context: BrowserContext; problems: string[]; thirdParty: string[] }> {
  const v = await visitor();
  const thirdParty: string[] = [];
  await v.context.route(THIRD_PARTY, (route) => {
    thirdParty.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* stand-in for the provider */' });
  });
  if (opts.gpc) {
    // What a browser with Global Privacy Control switched on sends, and reports to script.
    await v.context.setExtraHTTPHeaders({ 'Sec-GPC': '1' });
    await v.context.addInitScript(() => Object.defineProperty(navigator, 'globalPrivacyControl', { value: true }));
  }
  return { ...v, thirdParty };
}

describe('venue site: analytics and pixel tags, only with the visitor\'s yes', () => {
  it('ids saved in the console load nothing until a visitor allows it; no, and Global Privacy Control, load nothing at all', async () => {
    const diner = await orgBySlug('oak-diner');
    const GA = 'G-E2ETEST123';
    const PIXEL = '123456789012345';
    const before = (await db().selectFrom('venue_modules').select('config').where('venue_id', '=', diner.venueId).where('module_key', '=', 'website').executeTakeFirstOrThrow()).config as { integrations: Record<string, string | null> };

    // As deployed by default, third-party tags are switched off: an id saved for a venue (the
    // fixture has one) does nothing at all. No question, no choice in the footer, no request.
    const off = await taggedVisitor();
    await off.page.goto(siteUrl('oak-diner', '/'));
    await off.page.waitForLoadState('networkidle');
    expect(before.integrations.googleAnalyticsId).toBeTruthy();
    expect(await off.page.getByTestId('tag-consent').count()).toBe(0);
    expect(await off.page.getByRole('button', { name: 'Measurement choices' }).count()).toBe(0);
    expect(off.thirdParty).toEqual([]);
    await off.context.close();

    const staff = await newVisitor();
    await signInStaff(staff.page, 'manager@oak-diner.test');
    await staff.page.goto(`${BASE()}/console/website/settings`);
    // This deployment switches tags on. From here, the visitor's own answer is the gate.
    await devPost('site-tags', { on: true });
    try {
      // An id is an id: anything else is refused, in words, and not stored.
      await staff.page.locator('input[name=googleAnalyticsId]').fill('G-X"><script>alert(1)</script>');
      await staff.page.getByRole('button', { name: 'Save settings' }).click();
      await staff.page.getByText('A Google Analytics id looks like G-AB12CD34EF.').waitFor();
      await staff.page.locator('input[name=googleAnalyticsId]').fill(GA);
      await staff.page.locator('input[name=metaPixelId]').fill(PIXEL);
      await staff.page.getByRole('button', { name: 'Save settings' }).click();
      await staff.page.getByText('Website settings saved.').waitFor();
      const saved = (await db().selectFrom('venue_modules').select('config').where('venue_id', '=', diner.venueId).where('module_key', '=', 'website').executeTakeFirstOrThrow()).config as { integrations: Record<string, string | null> };
      expect(saved.integrations).toMatchObject({ googleAnalyticsId: GA, metaPixelId: PIXEL });

      // A visitor who has not answered: asked, and nothing sent anywhere while they decide or browse.
      const undecided = await taggedVisitor();
      await undecided.page.goto(siteUrl('oak-diner', '/'));
      const ask = undecided.page.getByTestId('tag-consent');
      await ask.waitFor();
      await undecided.page.screenshot({ path: `${SHOTS}/site-tag-consent-desktop.png` });
      const phone = await visitor({ mobile: true });
      await phone.page.goto(siteUrl('oak-diner', '/order'));
      await phone.page.getByTestId('tag-consent').waitFor();
      await phone.page.screenshot({ path: `${SHOTS}/site-tag-consent-phone.png` });
      await phone.context.close();
      expect(await ask.innerText()).toContain('Google Analytics and the Meta pixel');
      await undecided.page.goto(siteUrl('oak-diner', '/menu'));
      await undecided.page.getByTestId('tag-consent').waitFor();
      await undecided.page.waitForLoadState('networkidle');
      expect(undecided.thirdParty).toEqual([]);
      expect(await undecided.page.locator('script[src*="googletagmanager"], script[src*="facebook"]').count()).toBe(0);
      expect(await undecided.page.evaluate(() => 'dataLayer' in window || 'fbq' in window)).toBe(false);

      // No: remembered, never asked again, nothing loaded.
      await undecided.page.getByTestId('tag-consent').getByRole('button', { name: 'No thanks' }).click();
      await undecided.page.getByTestId('tag-consent').waitFor({ state: 'detached' });
      expect((await undecided.context.cookies()).find((c) => c.name === 'ros_tags')).toMatchObject({ value: 'no', domain: 'oak-diner.tables.localhost' });
      await undecided.page.reload();
      await undecided.page.waitForLoadState('networkidle');
      expect(await undecided.page.getByTestId('tag-consent').count()).toBe(0);
      expect(undecided.thirdParty).toEqual([]);
      expect(undecided.problems).toEqual([]);
      await undecided.context.close();

      // Yes: both tags load, each with the venue's own id and nothing else of ours.
      const willing = await taggedVisitor();
      await willing.page.goto(siteUrl('oak-diner', '/'));
      await willing.page.getByTestId('tag-consent').getByRole('button', { name: 'Allow' }).click();
      await eventually(async () => willing.thirdParty.some((u) => u.includes('googletagmanager.com/gtag/js')) && willing.thirdParty.some((u) => u.includes('connect.facebook.net')), 'both tags requested');
      expect(willing.thirdParty.find((u) => u.includes('gtag/js'))).toBe(`https://www.googletagmanager.com/gtag/js?id=${GA}`);
      expect(willing.thirdParty.find((u) => u.includes('facebook'))).toBe('https://connect.facebook.net/en_US/fbevents.js');
      const queued = await willing.page.evaluate(() => ({
        ga: ((window as unknown as { dataLayer?: unknown[] }).dataLayer ?? []).map((a) => Array.from(a as ArrayLike<unknown>).map(String)),
        pixel: ((window as unknown as { fbq?: { queue?: unknown[][] } }).fbq?.queue ?? []).map((a) => Array.from(a).map(String)),
      }));
      expect(queued.ga.some((a) => a[0] === 'config' && a[1] === GA)).toBe(true);
      expect(queued.pixel.some((a) => a[0] === 'init' && a[1] === PIXEL)).toBe(true);
      expect(queued.pixel.some((a) => a[0] === 'track' && a[1] === 'PageView')).toBe(true);
      // Remembered on this host; the next page loads them without asking.
      const count = willing.thirdParty.length;
      await willing.page.goto(siteUrl('oak-diner', '/menu'));
      await eventually(async () => willing.thirdParty.length > count, 'tags on the next page');
      expect(await willing.page.getByTestId('tag-consent').count()).toBe(0);
      // A change of mind, from the footer: asked again, and a no stops them from the next load on.
      await willing.page.getByRole('button', { name: 'Measurement choices' }).click();
      await willing.page.getByTestId('tag-consent').getByRole('button', { name: 'No thanks' }).click();
      await willing.page.waitForLoadState('load');
      await eventually(async () => (await willing.context.cookies()).find((c) => c.name === 'ros_tags')?.value === 'no', 'the choice changed to no');
      await willing.page.waitForLoadState('networkidle');
      willing.thirdParty.length = 0;
      await willing.page.goto(siteUrl('oak-diner', '/'));
      await willing.page.waitForLoadState('networkidle');
      expect(willing.thirdParty).toEqual([]);
      expect(willing.problems).toEqual([]);
      await willing.context.close();

      // A browser that sends Global Privacy Control has already said no: it is not asked and nothing loads.
      const gpc = await taggedVisitor({ gpc: true });
      await gpc.page.goto(siteUrl('oak-diner', '/'));
      await gpc.page.waitForLoadState('networkidle');
      expect(await gpc.page.getByTestId('tag-consent').count()).toBe(0);
      expect(await gpc.page.getByRole('button', { name: 'Measurement choices' }).count()).toBe(0);
      expect(gpc.thirdParty).toEqual([]);
      await gpc.context.close();

      // Another organisation's site asks about its own tags only: it has an analytics id and no pixel.
      const elsewhere = await taggedVisitor();
      await elsewhere.page.goto(siteUrl('oak-group', '/'));
      const other = elsewhere.page.getByTestId('tag-consent');
      await other.waitFor();
      expect(await other.innerText()).toContain('Google Analytics');
      expect(await other.innerText()).not.toContain('Meta');
      // The question is in the page's flow, above the header: it covers nothing.
      const box = await other.boundingBox();
      const header = await elsewhere.page.locator('header').first().boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(header!.y + 1);
      await elsewhere.page.waitForLoadState('networkidle');
      expect(elsewhere.thirdParty).toEqual([]);
      await elsewhere.context.close();
    } finally {
      await devPost('site-tags', { on: false });
      await asStaff('diner', 'manager', (ctx) => setModule(ctx, website.websiteModule, { venueId: diner.venueId, config: { integrations: before.integrations } as never }));
    }
    expect(staff.problems).toEqual([]);
    await staff.context.close();
  });
});

describe('venue site: rough edges', () => {
  it('the footer does not repeat the hours on a page that already shows them, and does show them elsewhere', async () => {
    const v = await visitor();
    const seen: Array<{ path: string; block: boolean; footer: boolean }> = [];
    for (const path of ['/', '/menu', '/about', '/contact', '/story']) {
      const res = await v.page.goto(siteUrl('oak-diner', path));
      if (res!.status() !== 200) continue;
      seen.push({
        path,
        block: (await v.page.locator('[data-block=hours-location]').count()) > 0,
        footer: await v.page.locator('footer .s-footer-hours').isVisible(),
      });
    }
    expect(seen.some((s) => s.block), JSON.stringify(seen)).toBe(true);
    expect(seen.some((s) => !s.block), JSON.stringify(seen)).toBe(true);
    for (const s of seen) expect(s.footer, `footer hours on ${s.path}`).toBe(!s.block);
    // On the page with the block, the hours are said once: one table of opening hours.
    const withBlock = seen.find((s) => s.block)!;
    await v.page.goto(siteUrl('oak-diner', withBlock.path));
    expect(await v.page.locator('table').evaluateAll((tables) => tables.filter((t) => t.querySelector('caption')?.textContent === 'Opening hours' && (t as HTMLElement).offsetParent !== null).length)).toBe(1);
    // The address and the way to get there are still in the footer.
    await v.page.locator('footer').getByText('Get directions').waitFor();
    expect(v.problems.filter((p) => !p.includes(' 404 '))).toEqual([]);
    await v.context.close();
  });

  it('a guest at a table is not offered "order ahead": the table banner is how they order', async () => {
    const group = await orgBySlug('oak-group');
    const newtown = group.venues.find((x) => x.slug === 'newtown')!;
    // The venue's menu page carries an "Order ahead" section (added here if the fixture's layout has none).
    // Newtown's own menu page if it has one, else the organisation's: the one /at/newtown/menu draws.
    const menuPage = await asStaff('group', 'manager', async (ctx) => {
      const own = (await website.listPages(ctx, { venueId: newtown.id })).find((p) => p.slug === 'menu' && p.status === 'published');
      return own ?? (await website.listPages(ctx, {})).find((p) => p.slug === 'menu') ?? null;
    });
    expect(menuPage).not.toBeNull();
    const row = await db().selectFrom('pages').select(['id', 'blocks']).where('id', '=', menuPage!.id).executeTakeFirstOrThrow();
    const original = row.blocks as Array<{ type: string }>;
    const added = !original.some((b) => b.type === 'order-cta');
    if (added) {
      await asStaff('group', 'manager', async (ctx) => {
        await website.savePageDraft(ctx, { pageId: row.id, blocks: [...original, { type: 'order-cta', id: 'e2eorder', heading: 'Order ahead', label: 'Order now' }] });
        await website.publishPage(ctx, { pageId: row.id });
      });
      await devPost('site-bust', { orgId: group.orgId });
    }
    try {
      const code = await db().selectFrom('qr_codes').select(['code', 'label']).where('venue_id', '=', newtown.id).where('kind', '=', 'table').where('is_active', '=', true).orderBy('label').executeTakeFirstOrThrow();
      const v = await visitor({ mobile: true });
      // Arriving from the street: the menu page invites an order for pickup.
      await v.page.goto(siteUrl('oak-group', '/at/newtown/menu'));
      await v.page.locator('[data-block=order-cta]').getByText('Order ahead').waitFor();
      expect(await v.page.locator('[aria-label="Your table"]').count()).toBe(0);

      // Scanning the code on the table: the same page, without "order ahead", with the table's own way to order.
      await v.page.goto(siteUrl('oak-group', `/q/${code.code}`));
      await v.page.waitForURL(/\/at\/newtown\/menu$/);
      await v.page.locator('[aria-label="Your table"]').waitFor();
      expect(await v.page.locator('[data-block=order-cta]').count()).toBe(0);
      expect(await v.page.getByText('Order ahead').count()).toBe(0);
      await v.page.getByRole('link', { name: `Order from Table ${code.label}` }).waitFor();
      expect(v.problems).toEqual([]);
      await v.context.close();
    } finally {
      if (added) {
        await asStaff('group', 'manager', async (ctx) => {
          await website.savePageDraft(ctx, { pageId: row.id, blocks: original });
          await website.publishPage(ctx, { pageId: row.id });
        });
        await devPost('site-bust', { orgId: group.orgId });
      }
    }
  });
});
