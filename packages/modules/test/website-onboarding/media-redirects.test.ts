import { describe, expect, it } from 'vitest';
import { useTestEnv } from '@ros/testkit';
import { website } from '@ros/modules';

const ANON = { kind: 'anon' as const };

/** The smallest byte strings that are genuinely each format: signature plus the header that carries the size. */
function png(width: number, height: number, padTo = 64): Buffer {
  const b = Buffer.alloc(Math.max(padTo, 33));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
function jpeg(width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08]).copy(b, 0);
  b.writeUInt16BE(height, 13);
  b.writeUInt16BE(width, 15);
  return b;
}
function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(16);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}
function webp(width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

describe('media uploads', () => {
  const t = useTestEnv();

  it('recognises images by their bytes, not their name or declared type', () => {
    expect(website.sniffImage(png(1200, 800))).toEqual({ contentType: 'image/png', width: 1200, height: 800 });
    expect(website.sniffImage(jpeg(640, 480))).toEqual({ contentType: 'image/jpeg', width: 640, height: 480 });
    expect(website.sniffImage(gif(10, 20))).toEqual({ contentType: 'image/gif', width: 10, height: 20 });
    expect(website.sniffImage(webp(300, 200))).toEqual({ contentType: 'image/webp', width: 300, height: 200 });
    expect(website.sniffImage(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(website.sniffImage(Buffer.from('%PDF-1.7 ...'))).toBeNull();
    expect(website.sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'))).toBeNull();
    expect(website.sniffImage(Buffer.alloc(0))).toBeNull();
  });

  it('stores an image through the storage port and records it; the stored name and type are ours', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const body = png(1600, 900, 5000);
    // The browser claims it is a JPEG; the bytes say PNG. The bytes win.
    const media = await website.uploadMedia(t.app, diner.orgId, manager, { contentType: 'image/jpeg', body, alt: 'The dining room' });
    expect(media).toMatchObject({ alt: 'The dining room', width: 1600, height: 900, bytes: 5000, contentType: 'image/png' });

    const row = await t.db.selectFrom('media').selectAll().where('id', '=', media.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ org_id: diner.orgId, kind: 'image', content_type: 'image/png', bytes: 5000, width: 1600, height: 900 });
    expect(row.storage_key).toMatch(new RegExp(`^${diner.orgId}/media/[0-9a-f-]{36}\\.png$`));
    const stored = t.sim.storage.objects.get(row.storage_key);
    expect(stored?.contentType).toBe('image/png');
    expect(stored?.body.equals(body)).toBe(true);
    expect(media.url).toBe(`https://assets.sim.invalid/${row.storage_key}`);
    // The library URL is a valid image address for a block.
    expect(website.blockSchema.safeParse({ type: 'hero', heading: 'Hi', imageUrl: media.url }).success).toBe(true);

    const listed = await t.app.tenant(diner.orgId, manager, (ctx) => website.listMedia(ctx));
    expect(listed.map((m) => m.id)).toContain(media.id);
  });

  it('refuses a file that is not an image, whatever it is called, and one that is too large', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const objectsBefore = t.sim.storage.objects.size;
    const rowsBefore = await t.db.selectFrom('media').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    const upload = (contentType: string, body: Buffer) => website.uploadMedia(t.app, diner.orgId, manager, { contentType, body });

    await expect(upload('image/png', Buffer.from('<html><script>alert(document.cookie)</script></html>'))).rejects.toMatchObject({ code: 'invalid' });
    await expect(upload('image/jpeg', Buffer.from('%PDF-1.7\n1 0 obj'))).rejects.toMatchObject({ code: 'invalid' });
    await expect(upload('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).rejects.toMatchObject({ code: 'invalid' });
    await expect(upload('image/png', Buffer.from('MZ\x90\x00 this is a program'))).rejects.toMatchObject({ code: 'invalid' });
    // A real image declared as something that is not an image at all.
    await expect(upload('text/html', png(10, 10))).rejects.toMatchObject({ code: 'invalid' });
    await expect(upload('image/png', Buffer.alloc(0))).rejects.toMatchObject({ code: 'invalid' });
    // One byte over the cap, with a valid PNG header.
    await expect(upload('image/png', png(4000, 3000, website.MAX_IMAGE_BYTES + 1))).rejects.toMatchObject({ code: 'invalid', message: 'Images can be up to 8 MB.' });
    // Exactly at the cap is fine.
    const atCap = await upload('image/png', png(4000, 3000, website.MAX_IMAGE_BYTES));
    expect(atCap.bytes).toBe(website.MAX_IMAGE_BYTES);

    expect(t.sim.storage.objects.size).toBe(objectsBefore + 1);
    const rowsAfter = await t.db.selectFrom('media').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    expect(Number(rowsAfter.n)).toBe(Number(rowsBefore.n) + 1);
  });

  it('only a manager can upload or remove; another org\'s image is not found; removal takes the object out of storage', async () => {
    const { diner, group } = t.fixture;
    const manager = await diner.as('manager');
    const media = await website.uploadMedia(t.app, diner.orgId, manager, { contentType: 'image/gif', body: gif(1, 1) });
    const key = (await t.db.selectFrom('media').select('storage_key').where('id', '=', media.id).executeTakeFirstOrThrow()).storage_key;

    await expect(website.uploadMedia(t.app, diner.orgId, await diner.as('host'), { contentType: 'image/gif', body: gif(1, 1) })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(website.uploadMedia(t.app, diner.orgId, ANON, { contentType: 'image/gif', body: gif(1, 1) })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(website.removeMedia(t.app, diner.orgId, await diner.as('host'), { mediaId: media.id })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(website.removeMedia(t.app, group.orgId, await group.as('owner'), { mediaId: media.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(group.orgId, await group.as('owner'), (ctx) => website.setMediaAlt(ctx, { mediaId: media.id, alt: 'Mine' }))).rejects.toMatchObject({ code: 'not_found' });
    expect((await t.app.tenant(group.orgId, await group.as('owner'), (ctx) => website.listMedia(ctx))).map((m) => m.id)).not.toContain(media.id);
    expect(t.sim.storage.objects.has(key)).toBe(true);

    await website.removeMedia(t.app, diner.orgId, manager, { mediaId: media.id });
    expect(await t.db.selectFrom('media').select('id').where('id', '=', media.id).executeTakeFirst()).toBeUndefined();
    expect(t.sim.storage.objects.has(key)).toBe(false);
    await expect(website.removeMedia(t.app, diner.orgId, manager, { mediaId: media.id })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('redirects from the old site', () => {
  const t = useTestEnv();
  const rows = (orgId: string) => t.db.selectFrom('redirects').select(['from_path', 'to_path', 'status_code', 'hits']).where('org_id', '=', orgId).orderBy('from_path').execute();

  it('the seeded map resolves, counts hits, and accepts the old site\'s full URLs', async () => {
    const { diner } = t.fixture;
    expect(await rows(diner.orgId)).toEqual([
      { from_path: '/about-us', to_path: '/about', status_code: 301, hits: 0 },
      { from_path: '/bookings', to_path: '/contact', status_code: 301, hits: 0 },
      { from_path: '/contact-us.php', to_path: '/contact', status_code: 301, hits: 0 },
      { from_path: '/menu.html', to_path: '/menu', status_code: 301, hits: 0 },
    ]);
    const resolve = (path: string) => t.app.tenant(diner.orgId, ANON, (ctx) => website.resolveRedirect(ctx, { path }));
    expect(await resolve('/menu.html')).toEqual({ to: '/menu', statusCode: 301 });
    expect(await resolve('/menu.html?utm_source=google')).toEqual({ to: '/menu', statusCode: 301 });
    expect(await resolve('/bookings/')).toEqual({ to: '/contact', statusCode: 301 });
    expect(await resolve('/nothing-here')).toBeNull();
    expect(await resolve('//evil.example')).toBeNull();
    expect((await rows(diner.orgId)).map((r) => r.hits)).toEqual([0, 1, 0, 2]);
    // One org's map means nothing at another.
    expect(await t.app.tenant(t.fixture.group.orgId, ANON, (ctx) => website.resolveRedirect(ctx, { path: '/about-us' }))).toBeNull();
  });

  it('an open redirect is refused: a target must be a path on this site', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const before = await rows(diner.orgId);
    const bad = [
      'https://evil.example/',
      'http://evil.example/',
      '//evil.example/login',
      '/\\evil.example',
      'javascript:alert(1)',
      'evil.example',
      '/menu page',
      'data:text/html,hi',
      '',
    ];
    const result = await t.app.tenant(diner.orgId, manager, (ctx) => website.importRedirects(ctx, { entries: bad.map((to, i) => ({ from: `/old-${i}`, to })) }));
    expect(result.imported).toBe(0);
    expect(result.rejected).toHaveLength(bad.length);
    for (const r of result.rejected) expect(r.reason).toMatch(/only go to a page on this site/);
    expect(await rows(diner.orgId)).toEqual(before);
    for (let i = 0; i < bad.length; i++) expect(await t.app.tenant(diner.orgId, ANON, (ctx) => website.resolveRedirect(ctx, { path: `/old-${i}` }))).toBeNull();

    // Even a row written some other way cannot send a visitor off the site.
    await t.db.insertInto('redirects').values({ org_id: diner.orgId, from_path: '/planted', to_path: 'https://evil.example/' }).execute();
    expect(await t.app.tenant(diner.orgId, ANON, (ctx) => website.resolveRedirect(ctx, { path: '/planted' }))).toBeNull();
    await t.db.deleteFrom('redirects').where('from_path', '=', '/planted').execute();
  });

  it('loops and self-redirects are refused, one bad line does not lose the rest, and a chain is followed in one hop', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const result = await t.app.tenant(diner.orgId, manager, (ctx) =>
      website.importRedirects(ctx, {
        entries: [
          { from: '/a', to: '/b' },
          { from: '/b', to: '/c' },
          { from: '/c', to: '/a' }, // would close the loop a → b → c → a
          { from: '/same', to: '/same/' },
          { from: '/', to: '/menu' },
          { from: 'not a path', to: '/menu' },
          { from: '/specials', to: '/menu#specials', statusCode: 302 },
          { from: '/about', to: '/menu.html' }, // into the existing /menu.html → /menu
          { from: '/menu', to: '/about' }, // would close /about → /menu.html → /menu → /about
        ],
      }),
    );
    expect(result).toMatchObject({ imported: 4, updated: 0 });
    expect(result.rejected.map((r) => [r.from, r.reason])).toEqual([
      ['/c', 'This would create a loop with another redirect.'],
      ['/same', 'This redirect points at itself.'],
      ['/', 'The home page cannot be redirected.'],
      ['not a path', 'The old address is not a page address.'],
      ['/menu', 'This would create a loop with another redirect.'],
    ]);
    const resolve = (path: string) => t.app.tenant(diner.orgId, ANON, (ctx) => website.resolveRedirect(ctx, { path }));
    expect(await resolve('/a')).toEqual({ to: '/c', statusCode: 301 });
    expect(await resolve('/about')).toEqual({ to: '/menu', statusCode: 301 });
    expect(await resolve('/specials')).toEqual({ to: '/menu#specials', statusCode: 302 });

    // Importing again changes nothing; changing a target updates it.
    const again = await t.app.tenant(diner.orgId, manager, (ctx) => website.importRedirects(ctx, { entries: [{ from: '/a', to: '/b' }, { from: '/specials', to: '/menu' }] }));
    expect(again).toMatchObject({ imported: 0, updated: 1, unchanged: 1, rejected: [] });
    expect((await rows(diner.orgId)).find((r) => r.from_path === '/specials')).toMatchObject({ to_path: '/menu', status_code: 301 });

    // Front of house cannot change where the site sends people.
    await expect(t.app.tenant(diner.orgId, await diner.as('host'), (ctx) => website.importRedirects(ctx, { entries: [{ from: '/x', to: '/menu' }] }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(diner.orgId, ANON, (ctx) => website.importRedirects(ctx, { entries: [{ from: '/x', to: '/menu' }] }))).rejects.toMatchObject({ code: 'unauthenticated' });

    const listed = await t.app.tenant(diner.orgId, manager, (ctx) => website.listRedirects(ctx));
    const a = listed.find((r) => r.from === '/a')!;
    expect(a.hits).toBe(1);
    await t.app.tenant(diner.orgId, manager, (ctx) => website.removeRedirect(ctx, { redirectId: a.id }));
    expect(await resolve('/a')).toBeNull();
    await expect(t.app.tenant(t.fixture.group.orgId, await t.fixture.group.as('owner'), (ctx) => website.removeRedirect(ctx, { redirectId: listed[0]!.id }))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('drafts a redirect map from the old site\'s sitemap', () => {
    const urls = website.parseSitemapXml(`<?xml version="1.0"?><urlset>
      <url><loc>https://old.example/</loc></url>
      <url><loc> https://old.example/our-menu.html </loc></url>
      <url><loc>https://old.example/about-us/</loc></url>
      <url><loc>https://old.example/reservations?x=1&amp;y=2</loc></url>
      <url><loc>https://old.example/blog/2019/opening-night</loc></url>
      <url><loc>https://old.example/menu</loc></url>
    </urlset>`);
    expect(urls).toHaveLength(6);
    expect(urls[3]).toBe('https://old.example/reservations?x=1&y=2');
    const suggested = website.suggestRedirects({ oldUrls: urls, pageSlugs: ['home', 'menu', 'about', 'contact'] });
    expect(suggested).toEqual([
      { from: '/our-menu.html', to: '/menu', matched: true },
      { from: '/about-us', to: '/about', matched: true },
      { from: '/reservations', to: '/contact', matched: true },
      { from: '/blog/2019/opening-night', to: '/', matched: false },
    ]);
    // Everything it suggests passes the importer's own rules.
    for (const s of suggested) expect(website.isSitePath(s.to)).toBe(true);
  });
});
