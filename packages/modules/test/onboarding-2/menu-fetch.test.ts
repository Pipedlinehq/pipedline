import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onboarding } from '@ros/modules';

/**
 * The menu page fetch: a server-side request to an address a person typed (THREAT_MODEL §6).
 * DNS and the transport are injected, so the rules are tested without a network: every name
 * is resolved and checked, redirects are checked again from scratch, and only small text pages
 * are read. The real node transport is exercised once against a local server.
 */
type Page = { status?: number; type?: string; body?: string | Buffer; location?: string };

function deps(dns: Record<string, string[]>, pages: Record<string, Page>) {
  const connected: Array<{ url: string; address: string }> = [];
  const d: onboarding.FetchDeps = {
    async resolve(host) {
      const list = dns[host];
      if (!list) throw new Error('ENOTFOUND');
      return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    async transport(url, address) {
      connected.push({ url: url.toString(), address: address.address });
      const p = pages[url.toString()] ?? { status: 404 };
      return { status: p.status ?? 200, headers: { 'content-type': p.type ?? 'text/html; charset=utf-8', ...(p.location ? { location: p.location } : {}) }, body: Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body ?? '') };
    },
  };
  return { d, connected };
}

const MENU_HTML = '<html><head><title>x</title><script>steal()</script><style>p{}</style></head><body><h1>Menu</h1><p>Wagyu rump &amp; chips &mdash; $48</p><!-- secret --></body></html>';

describe('onboarding-2: fetching a menu page', () => {
  it('reads a public page, reduced to its visible text', async () => {
    const { d, connected } = deps({ 'bella.example': ['93.184.216.34'] }, { 'https://bella.example/menu': { body: MENU_HTML } });
    const page = await onboarding.fetchMenuPage('https://bella.example/menu', d);
    expect(page.text).toBe('Menu\nWagyu rump & chips — $48');
    expect(page.text).not.toMatch(/steal|secret|<|p\{\}/);
    // It connected to exactly the address that was checked.
    expect(connected).toEqual([{ url: 'https://bella.example/menu', address: '93.184.216.34' }]);
  });

  it('refuses private, loopback, link-local, metadata and mixed answers, before connecting', async () => {
    const cases: Record<string, string[]> = {
      'private.example': ['10.0.0.8'],
      'loop.example': ['127.0.0.1'],
      'meta.example': ['169.254.169.254'],
      'cgnat.example': ['100.64.1.1'],
      'v6loop.example': ['::1'],
      'v6ula.example': ['fd00::1'],
      'v6mapped.example': ['::ffff:192.168.1.1'],
      'mixed.example': ['93.184.216.34', '192.168.0.10'],
    };
    const { d, connected } = deps(cases, {});
    for (const host of Object.keys(cases)) {
      await expect(onboarding.fetchMenuPage(`http://${host}/menu`, d), host).rejects.toMatchObject({ code: 'invalid', message: `${host} is not on the public internet, so it cannot be read.` });
    }
    for (const literal of ['http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://0.0.0.0/']) {
      await expect(onboarding.fetchMenuPage(literal, d), literal).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(connected).toEqual([]);
    expect(onboarding.isPublicAddress('93.184.216.34')).toBe(true);
    expect(onboarding.isPublicAddress('2606:4700::1111')).toBe(true);
    expect(onboarding.isPublicAddress('not an address')).toBe(false);
  });

  it('checks every redirect again: one that lands on a private address is refused; too many are refused', async () => {
    const { d, connected } = deps(
      { 'bella.example': ['93.184.216.34'], 'internal.example': ['10.1.2.3'] },
      {
        'https://bella.example/menu': { status: 302, location: 'http://internal.example/admin' },
        'https://bella.example/meta': { status: 301, location: 'http://169.254.169.254/latest/meta-data/' },
        'https://bella.example/a': { status: 302, location: '/b' },
        'https://bella.example/b': { status: 302, location: '/c' },
        'https://bella.example/c': { status: 302, location: '/d' },
        'https://bella.example/d': { status: 302, location: '/e' },
        'https://bella.example/ftp': { status: 302, location: 'ftp://bella.example/menu.txt' },
        'https://bella.example/moved': { status: 301, location: '/menu-2026' },
        'https://bella.example/menu-2026': { body: MENU_HTML },
      },
    );
    await expect(onboarding.fetchMenuPage('https://bella.example/menu', d)).rejects.toMatchObject({ message: 'internal.example is not on the public internet, so it cannot be read.' });
    await expect(onboarding.fetchMenuPage('https://bella.example/meta', d)).rejects.toMatchObject({ code: 'invalid' });
    await expect(onboarding.fetchMenuPage('https://bella.example/a', d)).rejects.toMatchObject({ message: 'The page redirected too many times.' });
    await expect(onboarding.fetchMenuPage('https://bella.example/ftp', d)).rejects.toMatchObject({ message: 'Only http and https addresses can be read.' });
    // Nothing internal was ever connected to.
    expect(connected.some((c) => c.address.startsWith('10.') || c.address.startsWith('169.254'))).toBe(false);
    // A redirect that stays public is followed.
    expect((await onboarding.fetchMenuPage('https://bella.example/moved', d)).finalUrl).toBe('https://bella.example/menu-2026');
  });

  it('refuses what is not a text page, what is too large, other schemes, ports and credentials', async () => {
    const big = Buffer.alloc(onboarding.FETCH_LIMITS.maxBytes + 10, 'a');
    const { d } = deps({ 'bella.example': ['93.184.216.34'] }, {
      'https://bella.example/menu.pdf': { type: 'application/pdf', body: '%PDF-1.7' },
      'https://bella.example/pic': { type: 'image/png', body: 'x' },
      'https://bella.example/huge': { body: big },
      'https://bella.example/empty': { body: '<html><script>x()</script></html>' },
      'https://bella.example/gone': { status: 500 },
    });
    await expect(onboarding.fetchMenuPage('https://bella.example/menu.pdf', d)).rejects.toMatchObject({ message: 'That address is not a web page or text. Paste the menu text instead.' });
    await expect(onboarding.fetchMenuPage('https://bella.example/pic', d)).rejects.toMatchObject({ code: 'invalid' });
    await expect(onboarding.fetchMenuPage('https://bella.example/huge', d)).rejects.toMatchObject({ message: 'That page is too large to read.' });
    await expect(onboarding.fetchMenuPage('https://bella.example/empty', d)).rejects.toMatchObject({ message: 'There is no text on that page. Paste the menu text instead.' });
    await expect(onboarding.fetchMenuPage('https://bella.example/gone', d)).rejects.toMatchObject({ message: 'The page answered with an error (500).' });
    for (const bad of ['file:///etc/passwd', 'gopher://bella.example/', 'https://bella.example:8443/menu', 'https://user:pw@bella.example/menu', 'not a url']) {
      await expect(onboarding.fetchMenuPage(bad, d), bad).rejects.toMatchObject({ code: 'invalid' });
    }
  });

  describe('the real transport', () => {
    let server: http.Server;
    let port = 0;
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url === '/menu') return void res.writeHead(200, { 'content-type': 'text/html' }).end(MENU_HTML);
        if (req.url === '/big') {
          res.writeHead(200, { 'content-type': 'text/html' });
          const chunk = Buffer.alloc(64 * 1024, 'b');
          let sent = 0;
          const pump = () => {
            while (sent < 3 * 1024 * 1024) {
              sent += chunk.length;
              if (!res.write(chunk)) return void res.once('drain', pump);
            }
            res.end();
          };
          return pump();
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it('connects to the checked address, reads a page, and stops reading past the size cap', async () => {
      // Only this test's own server is allowed, and only by overriding the address rule for it.
      const allowLocal: onboarding.FetchDeps = {
        resolve: async () => [{ address: '127.0.0.1', family: 4 }],
        transport: (url, address, limits) => onboarding.nodeFetchDeps.transport(new URL(url.toString().replace('menu.test', `menu.test:${port}`)), address, limits),
        allowAddress: (a) => a === '127.0.0.1',
      };
      const page = await onboarding.fetchMenuPage('http://menu.test/menu', allowLocal);
      expect(page.text).toBe('Menu\nWagyu rump & chips — $48');
      await expect(onboarding.fetchMenuPage('http://menu.test/big', allowLocal)).rejects.toMatchObject({ message: 'That page is too large to read.' });
      // Without the override the same server is refused: it is this machine.
      await expect(onboarding.fetchMenuPage('http://menu.test/menu', { ...allowLocal, allowAddress: undefined })).rejects.toMatchObject({ message: 'menu.test is not on the public internet, so it cannot be read.' });
    });
  });
});
