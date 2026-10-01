import { afterAll, describe, expect, it } from 'vitest';
import { BASE, PORT, closeBrowser, closeDb, db, inbox, newVisitor, signInStaff, siteUrl } from './helpers';

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

describe('access: sign-in, host separation, tenant boundaries', () => {
  it('a manager signs in with an emailed code and sees only the venues they work at', async () => {
    const v = await newVisitor();
    await v.page.goto(`${BASE()}/console`);
    expect(new URL(v.page.url()).pathname).toBe('/login');

    await signInStaff(v.page, 'manager@oak-group.test', { fresh: true });
    const venues = await v.page.$$eval('#venue-select option', (o) => o.map((x) => x.textContent));
    expect(venues).toEqual(['Oak Group CBD', 'Oak Group Newtown']);

    const cookie = (await v.context.cookies()).find((c) => c.name === 'ros_staff')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.domain).toBe('localhost');

    const session = await db().selectFrom('sessions').select(['kind', 'org_id']).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect(session.kind).toBe('staff');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a wrong code is refused and says so', async () => {
    const v = await newVisitor();
    await v.page.goto(`${BASE()}/login`);
    await v.page.fill('input[name=email]', 'owner@oak-diner.test');
    await v.page.click('button[type=submit]');
    await v.page.waitForURL(/sent=1/);
    await v.page.fill('input[name=code]', '000000');
    await v.page.click('button[type=submit]');
    // p[role=alert] is the form's message; Next's route announcer is also role=alert.
    await v.page.waitForSelector('p[role=alert]');
    expect(await v.page.textContent('p[role=alert]')).toMatch(/not right|expired/);
    expect(new URL(v.page.url()).pathname).toBe('/login');
    await v.context.close();
  });

  it('an address with no account gets the same answer and no email', async () => {
    const v = await newVisitor();
    await v.page.goto(`${BASE()}/login`);
    await v.page.fill('input[name=email]', 'stranger@example.com');
    await v.page.click('button[type=submit]');
    await v.page.waitForURL(/sent=1/);
    expect(await inbox('stranger@example.com')).toEqual([]);
    await v.context.close();
  });

  it('the console is not reachable on a venue\'s host, and venue pages are not reachable by path', async () => {
    const status = async (url: string) => (await fetch(url, { redirect: 'manual' })).status;
    expect(await status(siteUrl('oak-diner', '/console'))).toBe(404);
    expect(await status(siteUrl('oak-diner', '/dev/inbox'))).toBe(404);
    expect(await status(`${BASE()}/sites/oak-diner.tables.localhost`)).toBe(404);
    expect(await status(`http://nobody.tables.localhost:${PORT()}/`)).toBe(404);
  });

  it('a staff session cookie set on the platform host is not sent to a venue\'s host', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test', { fresh: true });
    // What the browser really sends: context.cookies(url) matches a host-only "localhost" cookie
    // against subdomains too, so it cannot answer this. The request's own Cookie header can.
    const [request] = await Promise.all([v.page.waitForRequest((r) => r.url() === siteUrl('oak-diner', '/')), v.page.goto(siteUrl('oak-diner', '/'))]);
    const sent = (await request.allHeaders()).cookie ?? '';
    expect(sent).not.toContain('ros_staff');
    const toConsole = await v.page.request.get(`${BASE()}/console`, { maxRedirects: 0 });
    expect(toConsole.status()).toBe(200);
    await v.context.close();
  });

  it('security headers are present and a cross-site POST is refused', async () => {
    const r = await fetch(`${BASE()}/login`);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    const cross = await fetch(siteUrl('oak-diner', '/api/session'), { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(cross.status).toBe(403);
  });
});
