import { afterAll, describe, expect, it } from 'vitest';
import { website } from '@ros/modules';
import { closeBrowser, closeDb, db, orgBySlug } from './helpers';
import { asStaff, closeStaff, siteUrl, visitor } from './site-helpers';

afterAll(async () => {
  await closeBrowser();
  await closeDb();
  await closeStaff();
});

const jsonLd = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);

describe('venue site: pages, skeletons, blocks and search', () => {
  it('a guest on a phone reads the home page: brand, navigation, hours, and structured data a search engine can use', async () => {
    const v = await visitor({ mobile: true });
    const res = await v.page.goto(siteUrl('oak-diner', '/'));
    expect(res!.status()).toBe(200);
    await v.page.waitForLoadState('networkidle');
    expect(await v.page.locator('h1').allTextContents()).toEqual(['Oak Diner']);
    // Brand variables sit on the site's root element; no per-tenant stylesheet exists.
    const primary = await v.page.$eval('.site', (el) => getComputedStyle(el).getPropertyValue('--brand-color-primary').trim());
    expect(primary).toBe('#8B2F2F');
    expect(await v.page.locator('link[href*="fonts.googleapis.com/css2"]').count()).toBeGreaterThan(0);
    // Footer: the venue's hours and address, and whether it is open (the e2e clock is Friday dinner).
    const footer = v.page.locator('footer');
    await expect.poll(() => footer.textContent()).toContain('Open now');
    expect(await footer.textContent()).toContain('1 Fixture Street');
    // No page scrolls sideways on a phone.
    expect(await v.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    const html = await v.page.content();
    const restaurant = jsonLd(html).find((d) => d['@type'] === 'Restaurant')!;
    expect(restaurant).toMatchObject({ name: 'Oak Diner' });
    expect((restaurant.openingHoursSpecification as unknown[]).length).toBeGreaterThan(0);
    expect(await v.page.getAttribute('link[rel=canonical]', 'href')).toBe('http://oak-diner.tables.localhost/');
    expect(await v.page.getAttribute('meta[property="og:title"]', 'content')).toBe('Oak Diner');

    // The visit was recorded first-party: a session and a page view.
    const vs = (await v.context.cookies()).find((c) => c.name === 'ros_vs')!.value;
    const views = await db().selectFrom('events').select('name').where('session_id', '=', vs).where('name', '=', 'page.viewed').execute();
    expect(views.length).toBeGreaterThan(0);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('each of the six skeletons draws the same content as a different page composition', async () => {
    const { orgId } = await orgBySlug('oak-diner');
    const signatures = new Map<string, string>();
    const v = await visitor();
    try {
      for (const key of website.SKELETON_KEYS) {
        await asStaff('diner', 'manager', (ctx) => website.setBrand(ctx, { skeleton: key }));
        await v.page.goto(siteUrl('oak-diner', '/'));
        await v.page.waitForLoadState('networkidle');
        expect(await v.page.getAttribute('.site', 'data-skeleton')).toBe(key);
        const shape = await v.page.evaluate(() => {
          const root = document.querySelector('[data-page]')!;
          const describe = (el: Element, depth: number): string =>
            `${el.tagName.toLowerCase()}${el.getAttribute('data-region') ? `@${el.getAttribute('data-region')}` : ''}.${[...el.classList].filter((c) => /^(grid|lg:|max-w|s-alt|s-card|sticky|text-center|mx-auto)/.test(c)).sort().join('.')}` +
            (depth > 0 ? `(${[...el.children].map((c) => describe(c, depth - 1)).join(',')})` : '');
          const hero = document.querySelector('[data-block=hero]')!.getBoundingClientRect();
          return { outline: describe(root, 3), heroWidth: Math.round(hero.width), asides: document.querySelectorAll('[data-page] aside').length };
        });
        signatures.set(key, shape.outline);
        if (key === 'hero-photo') expect(shape.heroWidth).toBe(1280);
        if (key === 'minimal') expect(shape.asides).toBe(0);
        if (key === 'split-panel') {
          const aside = await v.page.locator('[data-page] aside').boundingBox();
          expect(aside!.x).toBeGreaterThan(640);
        }
        if (key === 'single-scroll') {
          expect(await v.page.locator('section#menu').count()).toBe(1);
          expect(await v.page.locator('nav[aria-label=Main] a[href="/#menu"]').count()).toBe(1);
        }
      }
      expect(new Set(signatures.values()).size).toBe(6);
      const brand = await db().selectFrom('brands').select('layout_skeleton').where('org_id', '=', orgId).where('venue_id', 'is', null).executeTakeFirstOrThrow();
      expect(brand.layout_skeleton).toBe('single-scroll');
      expect(v.problems).toEqual([]);
    } finally {
      await asStaff('diner', 'manager', (ctx) => website.setBrand(ctx, { skeleton: 'hero-photo' }));
      await v.context.close();
    }
  });

  it('every block type renders as data; a draft stays hidden; an old address redirects; an unknown one is 404', async () => {
    const blocks = [
      { type: 'hero', heading: 'Every block', subheading: 'Drawn from data', ctaLabel: 'Order now' },
      { type: 'rich-text', heading: 'Our story', paragraphs: [{ kind: 'paragraph', text: 'Under <$20 and 2 < 3 stay plain text.' }, { kind: 'subheading', text: 'The butcher' }, { kind: 'quote', text: 'Waste nothing.', attribution: 'Chef' }, { kind: 'list', items: ['Dry-aged', 'Ironbark'] }] },
      { type: 'about', heading: 'About us', body: 'A neighbourhood steakhouse.' },
      { type: 'menu', heading: 'From the menu', display: 'highlights', itemLimit: 3 },
      { type: 'testimonials', heading: 'Guests', items: [{ quote: 'Great steak.', author: 'Sam' }] },
      { type: 'order-cta', heading: 'Order ahead', label: 'Order now' },
      { type: 'booking-cta', heading: 'Book', label: 'Book a table', href: 'https://example.com/book' },
      { type: 'hours-location', heading: 'Find us', note: 'Street parking after 6pm.' },
      { type: 'faq', heading: 'Good to know', items: [{ question: 'Walk-ins?', answer: 'Yes, at the bar.' }] },
      { type: 'contact', heading: 'Get in touch' },
      { type: 'instagram-feed', heading: 'On Instagram', handle: 'oakdiner' },
      { type: 'criota-reel', heading: 'From creators', limit: 4 },
    ];
    const page = await asStaff('diner', 'manager', async (ctx) => {
      const p = await website.createPage(ctx, { slug: 'every-block', title: 'Every block', blocks });
      await website.publishPage(ctx, { pageId: p.id });
      return p;
    });
    const draft = await asStaff('diner', 'manager', (ctx) => website.createPage(ctx, { slug: 'not-yet', title: 'Not yet', blocks: [{ type: 'about', body: 'Secret' }] }));
    expect((await db().selectFrom('pages').select('status').where('id', '=', draft.id).executeTakeFirstOrThrow()).status).toBe('draft');

    const v = await visitor();
    expect((await v.page.goto(siteUrl('oak-diner', '/every-block')))!.status()).toBe(200);
    const types = await v.page.$$eval('[data-block]', (els) => els.map((e) => e.getAttribute('data-block')));
    expect(new Set(types)).toEqual(new Set(blocks.map((b) => b.type)));
    const text = (await v.page.textContent('main'))!;
    expect(text).toContain('Under <$20 and 2 < 3 stay plain text.');
    expect(text).toContain('Creator videos appear here once Criota is connected.');
    expect(await v.page.locator('[data-block=criota-reel] li').count()).toBe(4);
    expect(await v.page.locator('[data-block=menu] [data-highlight]').count()).toBe(3);
    expect(await v.page.getAttribute('link[rel=canonical]', 'href')).toBe('http://oak-diner.tables.localhost/every-block');
    expect(v.problems).toEqual([]);

    expect((await v.page.goto(siteUrl('oak-diner', '/not-yet')))!.status()).toBe(404);
    expect(await v.page.textContent('h1')).toContain('could not find');
    expect((await v.page.goto(siteUrl('oak-diner', '/no-such-page')))!.status()).toBe(404);
    // The old site's /menu.html is in the redirect map.
    const moved = await fetch(siteUrl('oak-diner', '/menu.html'), { redirect: 'manual' });
    expect([301, 308]).toContain(moved.status);
    expect(moved.headers.get('location')).toBe('/menu');
    await v.context.close();
    void page;
  });

  it('the menu: sections, prices, allergens on every dish, dietary filters that work with JavaScript off', async () => {
    const v = await visitor({ javaScript: false });
    await v.page.goto(siteUrl('oak-diner', '/menu'));
    const dishes = await v.page.locator('[data-item]').count();
    expect(dishes).toBeGreaterThan(20);
    expect(await v.page.locator('[data-item] :text("Allergens:")').count()).toBe(dishes);
    expect(await v.page.locator('[data-item="' + (await v.page.getAttribute('[data-item]', 'data-item')) + '"]').textContent()).toMatch(/\$\d+\.\d\d/);
    await v.page.check('input[name=diet][value=vg]');
    await v.page.click('button:has-text("Apply filters")');
    await v.page.waitForURL(/diet=vg/);
    const vegan = await v.page.locator('[data-item]').count();
    expect(vegan).toBeGreaterThan(0);
    expect(vegan).toBeLessThan(dishes);
    for (const tags of await v.page.locator('[data-item] ul[aria-label=Dietary]').allTextContents()) expect(tags).toContain('Vegan');
    const doc = jsonLd(await v.page.content()).find((d) => d['@type'] === 'Menu')!;
    expect((doc.hasMenuSection as unknown[]).length).toBeGreaterThan(2);
    // With JavaScript off the browser refuses the page's scripts; that is the point of this check.
    expect(v.problems.filter((p) => !/\/_next\/static\/.* csp$/.test(p))).toEqual([]);
    await v.context.close();
  });

  it('a group: the org site picks a location; Newtown shows its own brand override on the same host', async () => {
    const v = await visitor({ mobile: true });
    await v.page.goto(siteUrl('oak-group', '/'));
    const group = await v.page.$eval('.site', (el) => getComputedStyle(el).getPropertyValue('--brand-color-primary').trim());
    expect(group).toBe('#1F3A5F');
    await v.page.goto(siteUrl('oak-group', '/menu'));
    expect(await v.page.locator('a[href="/at/newtown/menu"]').count()).toBeGreaterThan(0);
    await v.page.click('a[href="/at/newtown/menu"] >> nth=0');
    await v.page.waitForURL(/\/at\/newtown\/menu$/);
    const site = v.page.locator('.site');
    expect(await site.getAttribute('data-brand')).toBe('venue');
    expect(await v.page.$eval('.site', (el) => getComputedStyle(el).getPropertyValue('--brand-color-primary').trim())).toBe('#7A1E48');
    expect(await v.page.$eval('h1', (el) => getComputedStyle(el).fontFamily)).toContain('Oswald');
    expect(await v.page.textContent('header')).toContain('Oak Group Newtown');
    // Another org's venue slug is simply not here.
    expect((await v.page.goto(siteUrl('oak-group', '/at/main')))!.status()).toBe(404);
    v.problems.splice(0, v.problems.length, ...v.problems.filter((p) => !p.includes('/at/main') && !p.includes('status of 404')));
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('sitemap.xml and robots.txt per host; an unknown host is 404', async () => {
    const sitemap = await (await fetch(siteUrl('oak-group', '/sitemap.xml'))).text();
    expect(sitemap).toContain('<loc>http://oak-group.tables.localhost/menu</loc>');
    expect(sitemap).toContain('<loc>http://oak-group.tables.localhost/at/newtown/menu</loc>');
    const robots = await (await fetch(siteUrl('oak-diner', '/robots.txt'))).text();
    expect(robots).toContain('Disallow: /account');
    expect(robots).toContain('Sitemap: http://oak-diner.tables.localhost/sitemap.xml');
    for (const path of ['/', '/menu', '/sitemap.xml', '/api/cart']) {
      expect((await fetch(`http://nobody.tables.localhost:${process.env.E2E_PORT}${path}`, { method: path === '/api/cart' ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: path === '/api/cart' ? '{}' : undefined })).status).toBe(404);
    }
  });
});
