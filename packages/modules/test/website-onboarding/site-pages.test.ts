import { afterAll, describe, expect, it } from 'vitest';
import { getTool, setModule, type WriteTool } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { tenancy, website } from '@ros/modules';

const ANON = { kind: 'anon' as const };
const WORKER = { kind: 'worker' as const, job: 'test' };

describe('the site read model, pages and publishing', () => {
  const t = useTestEnv();
  const revalidated: string[][] = [];
  const stop = website.onRevalidate((tags) => void revalidated.push(tags));
  afterAll(stop);

  const pageRow = (id: string) => t.db.selectFrom('pages').select(['title', 'blocks', 'status', 'draft', 'published_at']).where('id', '=', id).executeTakeFirstOrThrow();

  it('getSite gives the layout everything it renders from, to an anonymous visitor', async () => {
    const { diner } = t.fixture;
    const site = await t.app.tenant(diner.orgId, ANON, (ctx) => website.getSite(ctx));
    expect(site.org).toMatchObject({ slug: 'oak-diner', name: 'Oak Diner', status: 'live' });
    // A single-venue org's site is about its one venue.
    expect(site.scope).toBe('org');
    expect(site.venue).toMatchObject({ id: diner.venueId, suburb: 'Surry Hills' });
    expect(site.hours).toHaveLength(11);
    expect(site.hourExceptions).toEqual([{ date: '2026-10-05', closed: true, opensAt: null, closesAt: null, reason: 'Public holiday' }]);
    expect(site.skeleton.key).toBe('hero-photo');
    expect(site.nav).toEqual([
      { label: 'Menu', href: '/menu' },
      { label: 'About', href: '/about' },
      { label: 'Visit', href: '/contact' },
    ]);
    expect(site.pages.map((p) => p.slug).sort()).toEqual(['about', 'contact', 'home', 'menu']);
    expect(site.brand.cssVariables['--brand-color-primary']).toBe('#8B2F2F');
    expect(site.brand.css.startsWith(':root{--brand-font-heading:')).toBe(true);
    expect(site.config.orderCtaTarget).toBe('/order');
    expect(site.config.integrations.googleAnalyticsId).toBe('G-FIXTUREDIN1');
    expect(site.enabledModules).toContain('website');
    expect(site.canonicalBase).toBe('http://oak-diner.tables.test');
    expect(site.cacheTags).toEqual([`org:${diner.orgId}`]);
    expect(site.structuredData).toMatchObject({ '@type': 'Restaurant', name: 'Oak Diner', url: 'http://oak-diner.tables.test/', hasMenu: 'http://oak-diner.tables.test/menu', priceRange: '$$$' });
    // Nothing personal is in a cacheable read model.
    expect(JSON.stringify(site)).not.toContain('@oak-diner.test');
  });

  it('a group has an org-level site listing its venues, and each venue its own site and brand', async () => {
    const { group } = t.fixture;
    const orgSite = await t.app.tenant(group.orgId, ANON, (ctx) => website.getSite(ctx));
    expect(orgSite.venue).toBeNull();
    expect(orgSite.structuredData).toBeNull();
    expect(orgSite.venues.map((v) => v.slug).sort()).toEqual(['bondi', 'cbd', 'newtown']);
    expect(orgSite.skeleton.key).toBe('split-panel');

    const newtown = await t.app.tenant(group.orgId, ANON, (ctx) => website.getSite(ctx, { venueId: group.venues.newtown!.id }));
    expect(newtown.scope).toBe('venue');
    expect(newtown.venue?.slug).toBe('newtown');
    expect(newtown.brand.tokens.colour.primary).toBe('#7A1E48');
    expect(orgSite.brand.tokens.colour.primary).toBe('#1F3A5F');
    expect(newtown.structuredData).toMatchObject({ name: 'Oak Group Newtown' });

    // A venue may choose its own skeleton in its config; the org's brand keeps its own.
    const manager = await group.as('manager');
    await t.app.tenant(group.orgId, manager, (ctx) => setModule(ctx, website.websiteModule, { venueId: group.venues.newtown!.id, config: { skeleton: 'minimal' } }));
    const again = await t.app.tenant(group.orgId, ANON, (ctx) => website.getSite(ctx, { venueId: group.venues.newtown!.id }));
    expect(again.skeleton.key).toBe('minimal');
    expect((await t.app.tenant(group.orgId, ANON, (ctx) => website.getSite(ctx, { venueId: group.venues.cbd!.id }))).skeleton.key).toBe('split-panel');

    // A venue's own page wins over the org-level page at the same address.
    const venueHome = await t.app.tenant(group.orgId, ANON, (ctx) => website.getPage(ctx, { venueId: group.venues.newtown!.id, slug: 'home' }));
    const orgHome = await t.app.tenant(group.orgId, ANON, (ctx) => website.getPage(ctx, { slug: '/' }));
    expect(venueHome.venueId).toBe(group.venues.newtown!.id);
    expect(orgHome.venueId).toBeNull();
    expect(venueHome.blocks[0]).toMatchObject({ type: 'hero', heading: 'Oak Group Newtown' });
    expect(orgHome.blocks[0]).toMatchObject({ type: 'hero', heading: 'Oak Group' });
  });

  it('a draft is invisible to the public until it is published, and edits to a published page stay private until the next publish', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const asManager = <T>(fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(diner.orgId, manager, fn);
    const asAnon = <T>(fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(diner.orgId, ANON, fn);

    const created = await asManager((ctx) =>
      website.createPage(ctx, { slug: 'Private-Dining', title: 'Private dining', blocks: [{ type: 'rich-text', id: 'intro', paragraphs: [{ kind: 'paragraph', text: 'The back room seats twelve.' }] }] }),
    );
    expect(created).toMatchObject({ slug: 'private-dining', status: 'draft', hasUnpublishedChanges: true, published: null });
    expect(await pageRow(created.id)).toMatchObject({ status: 'draft', blocks: [], published_at: null });

    await expect(asAnon((ctx) => website.getPage(ctx, { slug: 'private-dining' }))).rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect((await asAnon((ctx) => website.getSite(ctx))).pages.map((p) => p.slug)).not.toContain('private-dining');
    expect((await asAnon((ctx) => website.getSitemap(ctx))).map((e) => e.path)).not.toContain('/private-dining');
    // The console's own reads are not open to the public either.
    await expect(asAnon((ctx) => website.getPageForEdit(ctx, { pageId: created.id }))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(asAnon((ctx) => website.getPagePreview(ctx, { slug: 'private-dining' }))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(asAnon((ctx) => website.listPages(ctx))).rejects.toMatchObject({ code: 'unauthenticated' });
    // Staff can preview the draft.
    expect((await asManager((ctx) => website.getPagePreview(ctx, { slug: 'private-dining' }))).blocks).toHaveLength(1);

    revalidated.length = 0;
    const published = await asManager((ctx) => website.publishPage(ctx, { pageId: created.id }));
    expect(published.revalidateTags).toEqual([`org:${diner.orgId}`, `page:${created.id}`]);
    expect(revalidated).toEqual([[`org:${diner.orgId}`, `page:${created.id}`]]);
    const live = await asAnon((ctx) => website.getPage(ctx, { slug: 'private-dining' }));
    expect(live.blocks).toEqual([{ type: 'rich-text', id: 'intro', heading: null, paragraphs: [{ kind: 'paragraph', text: 'The back room seats twelve.' }] }]);
    expect(await pageRow(created.id)).toMatchObject({ status: 'published', draft: null, title: 'Private dining' });
    expect((await asAnon((ctx) => website.getSitemap(ctx))).find((e) => e.path === '/private-dining')).toMatchObject({ loc: 'http://oak-diner.tables.test/private-dining' });

    // Edit the published page: the public still sees the old wording.
    await asManager((ctx) => website.savePageDraft(ctx, { pageId: created.id, title: 'Private rooms', blocks: [{ type: 'rich-text', id: 'intro', paragraphs: [{ kind: 'paragraph', text: 'The back room now seats sixteen.' }] }] }));
    const still = await asAnon((ctx) => website.getPage(ctx, { slug: 'private-dining' }));
    expect(still.title).toBe('Private dining');
    expect(JSON.stringify(still.blocks)).toContain('seats twelve');
    const forEdit = await asManager((ctx) => website.getPageForEdit(ctx, { pageId: created.id }));
    expect(forEdit.hasUnpublishedChanges).toBe(true);
    expect(forEdit.draft?.title).toBe('Private rooms');
    expect(forEdit.published?.title).toBe('Private dining');

    await asManager((ctx) => website.publishPage(ctx, { pageId: created.id }));
    expect((await asAnon((ctx) => website.getPage(ctx, { slug: 'private-dining' }))).title).toBe('Private rooms');

    // Unpublishing takes it off the site and keeps the content.
    await asManager((ctx) => website.unpublishPage(ctx, { pageId: created.id }));
    await expect(asAnon((ctx) => website.getPage(ctx, { slug: 'private-dining' }))).rejects.toMatchObject({ code: 'not_found' });
    expect((await asManager((ctx) => website.getPageForEdit(ctx, { pageId: created.id }))).draft?.title).toBe('Private rooms');

    const events = await t.db.selectFrom('events').select(['name', 'properties']).where('org_id', '=', diner.orgId).where('name', 'in', ['page.published', 'page.unpublished']).orderBy('occurred_at').orderBy('id').execute();
    expect(events.filter((e) => (e.properties as { page_id: string }).page_id === created.id).map((e) => e.name).sort()).toEqual(['page.published', 'page.published', 'page.unpublished']);
    const audited = await t.db.selectFrom('audit_log').select('action').where('entity_id', '=', created.id).orderBy('occurred_at').execute();
    expect(audited.map((a) => a.action)).toEqual(expect.arrayContaining(['page.created', 'page.published', 'page.draft_saved', 'page.unpublished']));
  });

  it('publishing a page that shows the menu also revalidates that venue\'s menu; a rolled-back publish revalidates nothing', async () => {
    const { diner, group } = t.fixture;
    const manager = await diner.as('manager');
    const menuPage = await t.db.selectFrom('pages').select('id').where('org_id', '=', diner.orgId).where('slug', '=', 'menu').executeTakeFirstOrThrow();
    const r = await t.app.tenant(diner.orgId, manager, (ctx) => website.publishPage(ctx, { pageId: menuPage.id }));
    expect(r.revalidateTags).toEqual([`org:${diner.orgId}`, `page:${menuPage.id}`, `menu:${diner.venueId}`]);

    // A venue page names only its own venue's menu.
    const groupManager = await group.as('manager');
    const venueMenu = await t.db.selectFrom('pages').select('id').where('venue_id', '=', group.venues.cbd!.id).where('slug', '=', 'menu').executeTakeFirstOrThrow();
    const v = await t.app.tenant(group.orgId, groupManager, (ctx) => website.publishPage(ctx, { pageId: venueMenu.id }));
    expect(v.revalidateTags).toEqual([`org:${group.orgId}`, `page:${venueMenu.id}`, `menu:${group.venues.cbd!.id}`]);

    revalidated.length = 0;
    await expect(
      t.app.tenant(diner.orgId, manager, async (ctx) => {
        await website.publishPage(ctx, { pageId: menuPage.id });
        throw new Error('something later in the request failed');
      }),
    ).rejects.toThrow('something later');
    expect(revalidated).toEqual([]);
  });

  it('another org\'s page does not exist, a venue the caller has no role at is not found, and the wrong role is forbidden', async () => {
    const { diner, group } = t.fixture;
    const dinerHome = await t.db.selectFrom('pages').select('id').where('org_id', '=', diner.orgId).where('slug', '=', 'home').executeTakeFirstOrThrow();
    const groupOwner = await group.as('owner');
    const inGroup = <T>(fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(group.orgId, groupOwner, fn);

    await expect(inGroup((ctx) => website.getPageForEdit(ctx, { pageId: dinerHome.id }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(inGroup((ctx) => website.savePageDraft(ctx, { pageId: dinerHome.id, title: 'Taken over' }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(inGroup((ctx) => website.publishPage(ctx, { pageId: dinerHome.id }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(inGroup((ctx) => website.deletePage(ctx, { pageId: dinerHome.id }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(inGroup((ctx) => website.updateBlockCopy(ctx, { pageId: dinerHome.id, blockId: 'home-hero', changes: { heading: 'Taken over' } }))).rejects.toMatchObject({ code: 'not_found' });
    // Nor can the other org's venue be named to reach its site.
    await expect(t.app.tenant(group.orgId, ANON, (ctx) => website.getSite(ctx, { venueId: diner.venueId }))).rejects.toMatchObject({ status: 404 });
    await expect(t.app.tenant(group.orgId, ANON, (ctx) => website.getPage(ctx, { venueId: diner.venueId, slug: 'home' }))).rejects.toMatchObject({ status: 404 });
    expect((await pageRow(dinerHome.id)).title).toBe('Home');

    // The group manager holds CBD and Newtown, not Bondi.
    const manager = await group.as('manager');
    const bondiHome = await t.db.selectFrom('pages').select('id').where('venue_id', '=', group.venues.bondi!.id).where('slug', '=', 'home').executeTakeFirstOrThrow();
    await expect(t.app.tenant(group.orgId, manager, (ctx) => website.savePageDraft(ctx, { pageId: bondiHome.id, title: 'Mine' }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(group.orgId, manager, (ctx) => website.listPages(ctx, { venueId: group.venues.bondi!.id }))).rejects.toMatchObject({ code: 'not_found' });

    // Front of house can read the page list but not change a page.
    const host = await group.as('host');
    const newtownHome = await t.db.selectFrom('pages').select('id').where('venue_id', '=', group.venues.newtown!.id).where('slug', '=', 'home').executeTakeFirstOrThrow();
    expect((await t.app.tenant(group.orgId, host, (ctx) => website.listPages(ctx, { venueId: group.venues.newtown!.id }))).length).toBeGreaterThan(0);
    await expect(t.app.tenant(group.orgId, host, (ctx) => website.savePageDraft(ctx, { pageId: newtownHome.id, title: 'Mine' }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(group.orgId, host, (ctx) => website.publishPage(ctx, { pageId: newtownHome.id }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(group.orgId, host, (ctx) => website.createPage(ctx, { venueId: group.venues.newtown!.id, slug: 'events', title: 'Events' }))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('page addresses: duplicates and reserved words are refused, the home page cannot be removed', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const run = <T>(fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(diner.orgId, manager, fn);
    await expect(run((ctx) => website.createPage(ctx, { slug: 'menu', title: 'Another menu' }))).rejects.toMatchObject({ code: 'conflict' });
    await expect(run((ctx) => website.createPage(ctx, { slug: 'api', title: 'Api' }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(run((ctx) => website.createPage(ctx, { slug: '../etc', title: 'Nope' }))).rejects.toMatchObject({ code: 'invalid' });
    const home = await t.db.selectFrom('pages').select('id').where('org_id', '=', diner.orgId).where('slug', '=', 'home').executeTakeFirstOrThrow();
    await expect(run((ctx) => website.deletePage(ctx, { pageId: home.id }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(run((ctx) => website.unpublishPage(ctx, { pageId: home.id }))).rejects.toMatchObject({ code: 'invalid' });
    // An empty page cannot be published.
    const empty = await run((ctx) => website.createPage(ctx, { slug: 'empty', title: 'Empty' }));
    await expect(run((ctx) => website.publishPage(ctx, { pageId: empty.id }))).rejects.toMatchObject({ code: 'invalid' });
    await run((ctx) => website.deletePage(ctx, { pageId: empty.id }));
    expect(await t.db.selectFrom('pages').select('id').where('id', '=', empty.id).executeTakeFirst()).toBeUndefined();
  });

  it('a block type switched off in config is hidden, not deleted', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const before = await t.app.tenant(diner.orgId, ANON, (ctx) => website.getPage(ctx, { slug: 'home' }));
    expect(before.blocks.map((b) => b.type)).toContain('testimonials');
    const enabled = website.BLOCK_TYPES.filter((b) => b !== 'testimonials');
    await t.app.tenant(diner.orgId, manager, (ctx) => setModule(ctx, website.websiteModule, { venueId: diner.venueId, config: { enabledBlocks: [...enabled] } }));
    const after = await t.app.tenant(diner.orgId, ANON, (ctx) => website.getPage(ctx, { slug: 'home' }));
    expect(after.blocks.map((b) => b.type)).not.toContain('testimonials');
    const stored = await pageRow(before.id);
    expect((stored.blocks as Array<{ type: string }>).map((b) => b.type)).toContain('testimonials');
    await t.app.tenant(diner.orgId, manager, (ctx) => setModule(ctx, website.websiteModule, { venueId: diner.venueId, config: { enabledBlocks: [...website.BLOCK_TYPES] } }));
  });

  it('page_update_copy shows before and after, changes nothing until committed, then publishes only that change', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const tool = getTool('page_update_copy') as WriteTool<{ page: string; section_id: string; changes: Record<string, string | null> }, { page: string; section_id: string; changed: Array<{ field: string; before: string | null; after: string | null }>; published_at: string }>;
    expect(tool).toMatchObject({ effect: 'write', module: 'website', minRole: 'manager', venueScoped: true });

    const home = await t.db.selectFrom('pages').select('id').where('org_id', '=', diner.orgId).where('slug', '=', 'home').executeTakeFirstOrThrow();
    // Other edits are waiting in the working copy; the tool must not publish them.
    await t.app.tenant(diner.orgId, manager, async (ctx) => {
      const page = await website.getPageForEdit(ctx, { pageId: home.id });
      const blocks = page.published!.blocks.map((b) => (b.type === 'about' ? { ...b, body: 'A draft rewrite that is not ready.' } : b));
      await website.savePageDraft(ctx, { pageId: home.id, blocks });
    });
    const before = await pageRow(home.id);

    // The read tool tells an assistant what is there and what each section is called.
    const read = getTool('page_copy')!;
    expect(read.effect).toBe('read');
    const listed = await t.app.tenant(diner.orgId, manager, (ctx) => (read as { run: (tc: unknown, i: unknown) => Promise<{ pages: Array<{ page: string; sections: Array<{ section_id: string; kind: string; text: Record<string, string | null> }> }> }> }).run({ ctx, venueId: diner.venueId }, { page: 'home' }));
    expect(listed.pages[0]!.sections.find((s) => s.section_id === 'home-hero')).toMatchObject({ kind: 'hero', text: { heading: 'Oak Diner', subheading: 'Dry-aged beef, cooked over ironbark.' } });

    revalidated.length = 0;
    const input = { page: 'home', section_id: 'home-hero', changes: { heading: 'Oak Diner, Surry Hills', subheading: 'Open for lunch from Tuesday.' } };
    await t.app.tenant(diner.orgId, manager, async (ctx) => {
      const proposal = await tool.propose({ ctx, venueId: diner.venueId }, input);
      expect(proposal.question).toBe(
        'On the "Home" page, in the hero section, change the heading: from "Oak Diner" to "Oak Diner, Surry Hills"; and the subheading: from "Dry-aged beef, cooked over ironbark." to "Open for lunch from Tuesday."? This goes live on the website straight away.',
      );
    });
    // Proposing changed nothing.
    expect(await pageRow(home.id)).toEqual(before);
    expect(revalidated).toEqual([]);

    t.clock.advanceMinutes(3);
    const result = await t.app.tenant(diner.orgId, manager, async (ctx) => (await tool.propose({ ctx, venueId: diner.venueId }, input)).commit());
    const out = tool.output.parse(result);
    expect(out).toMatchObject({ page: 'home', section_id: 'home-hero' });
    expect(out.changed).toEqual([
      { field: 'heading', before: 'Oak Diner', after: 'Oak Diner, Surry Hills' },
      { field: 'subheading', before: 'Dry-aged beef, cooked over ironbark.', after: 'Open for lunch from Tuesday.' },
    ]);

    const after = await pageRow(home.id);
    const hero = (after.blocks as Array<Record<string, unknown>>).find((b) => b.id === 'home-hero')!;
    expect(hero).toMatchObject({ heading: 'Oak Diner, Surry Hills', subheading: 'Open for lunch from Tuesday.' });
    expect(after.published_at).toEqual(t.clock());
    // The public sees the new heading and still the old about text; the unfinished rewrite stays a draft with the new heading carried into it.
    const live = await t.app.tenant(diner.orgId, ANON, (ctx) => website.getPage(ctx, { slug: 'home' }));
    expect(live.blocks.find((b) => b.type === 'hero')).toMatchObject({ heading: 'Oak Diner, Surry Hills' });
    expect(JSON.stringify(live.blocks)).not.toContain('A draft rewrite');
    const draft = (after.draft as { blocks: Array<Record<string, unknown>> }).blocks;
    expect(draft.find((b) => b.type === 'about')).toMatchObject({ body: 'A draft rewrite that is not ready.' });
    expect(draft.find((b) => b.id === 'home-hero')).toMatchObject({ heading: 'Oak Diner, Surry Hills' });

    expect(revalidated).toEqual([[`org:${diner.orgId}`, `page:${home.id}`, `menu:${diner.venueId}`]]);
    const event = await t.db.selectFrom('events').select(['properties', 'source']).where('org_id', '=', diner.orgId).where('name', '=', 'page.published').orderBy('occurred_at', 'desc').limit(1).executeTakeFirstOrThrow();
    expect(event).toMatchObject({ source: 'agent', properties: { page_id: home.id, via: 'assistant' } });
    const audit = await t.db.selectFrom('audit_log').select(['before', 'after']).where('entity_id', '=', home.id).where('action', '=', 'page.copy_updated').executeTakeFirstOrThrow();
    expect(audit).toEqual({
      before: { 'home-hero.heading': 'Oak Diner', 'home-hero.subheading': 'Dry-aged beef, cooked over ironbark.' },
      after: { 'home-hero.heading': 'Oak Diner, Surry Hills', 'home-hero.subheading': 'Open for lunch from Tuesday.' },
    });

    // What it refuses: markup, a field that is not text, a link, another role, an unknown section.
    const propose = (changes: Record<string, string | null>, who = manager, section = 'home-hero') =>
      t.app.tenant(diner.orgId, who, (ctx) => tool.propose({ ctx, venueId: diner.venueId }, { page: 'home', section_id: section, changes }));
    await expect(propose({ heading: '<script>alert(1)</script>' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(propose({ ctaHref: 'https://evil.example/' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(propose({ type: 'about' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(propose({ heading: 'x' }, manager, 'no-such-section')).rejects.toMatchObject({ code: 'not_found' });
    await expect(propose({ heading: 'Host was here' }, await diner.as('host'))).rejects.toMatchObject({ code: 'forbidden' });
    expect((await pageRow(home.id)).blocks).toEqual(after.blocks);
  });

  it('with the website switched off, every surface answers not-found and nothing is deleted', async () => {
    const { diner, group } = t.fixture;
    const manager = await diner.as('manager');
    const home = await t.db.selectFrom('pages').select('id').where('org_id', '=', diner.orgId).where('slug', '=', 'home').executeTakeFirstOrThrow();
    const pagesBefore = await t.db.selectFrom('pages').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', diner.orgId).executeTakeFirstOrThrow();
    await t.app.tenant(diner.orgId, manager, (ctx) => setModule(ctx, website.websiteModule, { venueId: diner.venueId, enabled: false }));

    const off = { code: 'module_disabled', status: 404 };
    const tool = getTool('page_update_copy') as WriteTool<unknown, unknown>;
    await expect(t.app.tenant(diner.orgId, ANON, (ctx) => website.getSite(ctx))).rejects.toMatchObject(off);
    await expect(t.app.tenant(diner.orgId, ANON, (ctx) => website.getPage(ctx, { slug: 'home' }))).rejects.toMatchObject(off);
    await expect(t.app.tenant(diner.orgId, ANON, (ctx) => website.getPage(ctx, { venueId: diner.venueId, slug: 'home' }))).rejects.toMatchObject(off);
    await expect(t.app.tenant(diner.orgId, ANON, (ctx) => website.getSitemap(ctx))).rejects.toMatchObject(off);
    await expect(t.app.tenant(diner.orgId, ANON, (ctx) => website.getRobots(ctx, { host: 'oak-diner.tables.test' }))).rejects.toMatchObject(off);
    expect(await t.app.tenant(diner.orgId, ANON, (ctx) => website.resolveRedirect(ctx, { path: '/menu.html' }))).toBeNull();
    await expect(t.app.tenant(diner.orgId, manager, (ctx) => website.listPages(ctx))).rejects.toMatchObject(off);
    await expect(t.app.tenant(diner.orgId, manager, (ctx) => website.publishPage(ctx, { pageId: home.id }))).rejects.toMatchObject(off);
    await expect(t.app.tenant(diner.orgId, manager, (ctx) => website.listRedirects(ctx))).rejects.toMatchObject(off);
    await expect(t.app.tenant(diner.orgId, manager, (ctx) => website.listMedia(ctx))).rejects.toMatchObject(off);
    await expect(t.app.tenant(diner.orgId, manager, (ctx) => tool.propose({ ctx, venueId: diner.venueId }, { page: 'home', section_id: 'home-hero', changes: { heading: 'x' } }))).rejects.toMatchObject(off);

    // Hidden, not deleted: switch it back on and the site is as it was.
    expect(await t.db.selectFrom('pages').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', diner.orgId).executeTakeFirstOrThrow()).toEqual(pagesBefore);
    await t.app.tenant(diner.orgId, manager, (ctx) => setModule(ctx, website.websiteModule, { venueId: diner.venueId, enabled: true }));
    expect((await t.app.tenant(diner.orgId, ANON, (ctx) => website.getPage(ctx, { slug: 'home' }))).id).toBe(home.id);

    // In a group, one venue's site can be off while the others and the org-level site stay up.
    const groupManager = await group.as('manager');
    const cbd = group.venues.cbd!.id;
    await t.app.tenant(group.orgId, groupManager, (ctx) => setModule(ctx, website.websiteModule, { venueId: cbd, enabled: false }));
    await expect(t.app.tenant(group.orgId, ANON, (ctx) => website.getSite(ctx, { venueId: cbd }))).rejects.toMatchObject(off);
    await expect(t.app.tenant(group.orgId, ANON, (ctx) => website.getPage(ctx, { venueId: cbd, slug: 'home' }))).rejects.toMatchObject(off);
    const orgSite = await t.app.tenant(group.orgId, ANON, (ctx) => website.getSite(ctx));
    expect(orgSite.venues.map((v) => v.slug).sort()).toEqual(['bondi', 'newtown']);
    expect((await t.app.tenant(group.orgId, ANON, (ctx) => website.getSite(ctx, { venueId: group.venues.newtown!.id }))).venue?.slug).toBe('newtown');
    await t.app.tenant(group.orgId, groupManager, (ctx) => setModule(ctx, website.websiteModule, { venueId: cbd, enabled: true }));
  });

  it('robots: only a live org\'s primary host is indexable', async () => {
    const { diner } = t.fixture;
    const robots = (host: string) => t.app.tenant(diner.orgId, ANON, (ctx) => website.getRobots(ctx, { host }));
    expect((await robots('oak-diner.tables.test')).sitemap).toBe('http://oak-diner.tables.test/sitemap.xml');
    // Once a custom domain is verified it is the canonical host, and the subdomain stops being indexed.
    const owner = await diner.as('owner');
    const d = await t.app.tenant(diner.orgId, owner, (ctx) => tenancy.addCustomDomain(ctx, { host: 'oakdiner.example.com.au' }));
    await t.app.tenant(diner.orgId, WORKER, (ctx) => tenancy.markDomainVerified(ctx, d.id));
    expect((await robots('oak-diner.tables.test')).rules).toEqual([{ userAgent: '*', allow: [], disallow: ['/'] }]);
    expect((await robots('oakdiner.example.com.au')).sitemap).toBe('http://oakdiner.example.com.au/sitemap.xml');
    expect((await t.app.tenant(diner.orgId, ANON, (ctx) => website.getSitemap(ctx))).find((e) => e.path === '/')!.loc).toBe('http://oakdiner.example.com.au/');
  });
});
