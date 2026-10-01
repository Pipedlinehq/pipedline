/**
 * Helpers for the venue-site scenarios (1x-site-*.e2e.ts). A guest is driven through the real
 * pages in a browser; set-up a venue's staff would do in the console (86 an item, publish a
 * page) goes through the same service functions, as that staff member, against the e2e database.
 */
import type { Page } from 'playwright';
import type { Ctx, Principal } from '@ros/core';
import { type Fixture, loadFixture } from '@ros/fixtures';
import { configFromEnv } from '@ros/runtime';
import { createTestApp, fakeClock, type TestApp } from '../../packages/testkit/src/app';
import { type Watched, codeIn, getBrowser, inbox, siteUrl } from './helpers';

export { siteUrl };

let n = 0;
/**
 * A fresh browser profile, like helpers.newVisitor, arriving from its own address: per-device
 * rate limits (orders, sign-ups, code guesses) then apply to one scenario, not the whole run.
 */
export async function visitor(opts: { mobile?: boolean; javaScript?: boolean } = {}): Promise<Watched> {
  const b = await getBrowser();
  const ip = `10.${(process.pid % 200) + 20}.${Math.floor(++n / 250)}.${n % 250}`;
  const base = opts.mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } };
  const context = await b.newContext({ ...base, javaScriptEnabled: opts.javaScript !== false });
  // Only our own hosts see the address; third parties (the font CDN) get the request untouched.
  await context.route(/^http:\/\/[^/]*localhost:\d+\//, (route) => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': ip } }));
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('/_next/webpack-hmr')) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText ?? '';
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(why)) problems.push(`failed: ${r.method()} ${r.url()} ${why}`);
  });
  return { context, page, problems };
}

let staffApp: TestApp | undefined;
let fixture: Fixture | undefined;

/** Run a service function as a fixture staff member (what they would do in the console). */
export async function asStaff<T>(org: 'diner' | 'group', who: 'owner' | 'manager', fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  staffApp ??= createTestApp(process.env.E2E_DATABASE_URL!, { clock: fakeClock(new Date()), config: configFromEnv() });
  fixture ??= await loadFixture(staffApp.app);
  const f = fixture[org];
  const principal: Principal = await f.as(who);
  return staffApp.app.tenant(f.orgId, principal, fn);
}

export async function closeStaff(): Promise<void> {
  await staffApp?.close();
  staffApp = undefined;
  fixture = undefined;
}

/** Wait for a new message to an address after `before` messages, and return its code. */
export async function nextCode(to: string, before: number): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    // Other messages (an order confirmation, a welcome) can land for the same address while the
    // code is on its way: take the newest one that carries a code, not simply the newest.
    const fresh = (await inbox(to)).slice(before).reverse().find((m) => /\b\d{6}\b/.test(m.body));
    if (fresh) return codeIn(fresh.body);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no sign-in code for ${to}`);
}

/** Sign a guest in on a venue's site through its own pages. */
export async function signInGuest(page: Page, org: string, destination: string, next = '/account'): Promise<void> {
  const before = (await inbox(destination)).length;
  await page.goto(siteUrl(org, `/account/login?next=${encodeURIComponent(next)}`));
  await page.fill('input[name=destination]', destination);
  await page.click('button[type=submit]');
  await page.waitForURL(/sent=1/);
  await page.fill('input[name=code]', await nextCode(destination, before));
  await page.click('button[type=submit]');
  await page.waitForURL((u) => u.pathname === next.split('?')[0]);
}

/** Add an item from the order page, choosing modifier options by their names. */
export async function addItem(page: Page, name: string, choose: string[] = []): Promise<void> {
  await page.click(`[data-order-item="${name}"] button`);
  await page.waitForSelector('dialog[open]');
  for (const option of choose) await page.check(`dialog label:has-text("${option}") input`);
  await page.click('dialog button:has-text("Add to order")');
  await page.waitForSelector('dialog[open]', { state: 'detached' });
  await page.waitForSelector(`[data-cart-line="${name}"]`, { state: 'attached' });
}

/** Open the checkout (the phone layout has a bottom bar, the desktop one a button in the cart). */
export async function openCheckout(page: Page): Promise<void> {
  const bar = page.locator('button:has-text("View order")');
  if (await bar.isVisible()) await bar.click();
  else await page.click('button:has-text("Go to checkout")');
  await page.waitForSelector('#checkout-h');
}

/** Wait until the server has priced the cart and the place-order button can be pressed. */
export async function waitPriced(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const b = document.querySelector<HTMLButtonElement>('form button[type=submit]');
    return !!b && !b.disabled && !!document.querySelector('[data-total]');
  });
}

export const unique = (prefix: string) => `${prefix}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com`;
