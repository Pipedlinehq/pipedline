import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createDb, createPool, type Database } from '@ros/core';

export const BASE = () => process.env.E2E_BASE_URL!;
export const PORT = () => process.env.E2E_PORT!;

/** A venue's site, on its own host, as a guest's browser would reach it. */
export const siteUrl = (orgSlug: string, path = '/') => `http://${orgSlug}.tables.localhost:${PORT()}${path}`;
export const siteHost = (orgSlug: string) => `${orgSlug}.tables.localhost`;

let browser: Browser | undefined;
export async function getBrowser(): Promise<Browser> {
  return (browser ??= await chromium.launch());
}
export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = undefined;
}

export interface Watched {
  context: BrowserContext;
  page: Page;
  /** Console errors, page errors and failed requests seen so far. A clean run leaves this empty. */
  problems: string[];
}

/** A fresh browser profile whose page records every console error, page error and failed request. */
export async function newVisitor(opts: { mobile?: boolean } = {}): Promise<Watched> {
  const b = await getBrowser();
  const context = await b.newContext(opts.mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText ?? '';
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(why)) problems.push(`failed: ${r.method()} ${r.url()} ${why}`);
  });
  return { context, page, problems };
}

export interface SimMessage {
  to: string;
  channel: 'email' | 'sms';
  kind: string;
  subject: string | null;
  body: string;
  unsubscribeUrl: string | null;
  at: string;
}

/** Messages the simulated providers accepted for an address. Nothing here left the machine. */
export async function inbox(to: string): Promise<SimMessage[]> {
  const r = await fetch(`${BASE()}/api/dev/sim?to=${encodeURIComponent(to)}`);
  const j = (await r.json()) as { email: SimMessage[]; sms: SimMessage[] };
  return [...j.email, ...j.sms].sort((a, b) => a.at.localeCompare(b.at));
}

export async function waitForMessage(to: string, match: (m: SimMessage) => boolean, timeoutMs = 20_000): Promise<SimMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = (await inbox(to)).reverse().find(match);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no matching message for ${to} within ${timeoutMs}ms`);
}

export const codeIn = (body: string) => body.match(/\b(\d{6})\b/)![1]!;

/**
 * Sessions already made in this run, per address. Sign-in codes are rate-limited (5 per address
 * and 30 per IP address in 15 minutes, as in production), and a full run signs the same people
 * in many times, so after the first real sign-in a person's session cookie is reused. The cache
 * lives beside the run's own database, so a new run starts with none.
 */
function sessionCacheFile(email: string): string {
  const run = createHash('sha256').update(process.env.E2E_DATABASE_URL ?? BASE()).digest('hex').slice(0, 12);
  return path.join(tmpdir(), `ros-e2e-${run}-${email.replace(/\W+/g, '_')}.json`);
}

/**
 * Sign a staff member in through the real pages: email, then the code from the simulated inbox.
 * Pass `fresh: true` to always go through the code (tests of sign-in itself).
 */
export async function signInStaff(page: Page, email: string, opts: { fresh?: boolean } = {}): Promise<void> {
  const cache = sessionCacheFile(email);
  if (!opts.fresh && existsSync(cache)) {
    // Restored for the platform host's url. A restored cookie is not guaranteed host-only the way
    // a real sign-in's is, so a test about where the cookie is sent signs in with { fresh: true }.
    const saved = JSON.parse(readFileSync(cache, 'utf8')) as Array<{ name: string; value: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Lax' | 'Strict' | 'None' }>;
    await page.context().addCookies(saved.map((c) => ({ name: c.name, value: c.value, url: BASE(), expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite })));
    await page.goto(`${BASE()}/console`);
    if (/\/console(\/|$|\?)/.test(new URL(page.url()).pathname)) return;
    await page.context().clearCookies();
  }
  await signInWithCode(page, email);
  const cookies = (await page.context().cookies()).filter((c) => c.name === 'ros_staff');
  writeFileSync(cache, JSON.stringify(cookies));
}

async function signInWithCode(page: Page, email: string): Promise<void> {
  const before = (await inbox(email)).length;
  await page.goto(`${BASE()}/login`);
  await page.fill('input[name=email]', email);
  await page.click('button[type=submit]');
  await page.waitForURL(/sent=1/);
  const deadline = Date.now() + 15_000;
  let messages = await inbox(email);
  while (messages.length <= before && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    messages = await inbox(email);
  }
  await page.fill('input[name=code]', codeIn(messages.at(-1)!.body));
  await page.click('button[type=submit]');
  await page.waitForURL(/\/console(\/|$|\?)/);
}

let database: Database | undefined;
/** Unscoped read access to the e2e database, for reading side-effects back. Never written through. */
export function db(): Database {
  return (database ??= createDb(createPool(process.env.E2E_DATABASE_URL!, { max: 2 })));
}
export async function closeDb(): Promise<void> {
  await database?.destroy();
  database = undefined;
}

/** Poll until a condition holds: the worker runs in the app process, so effects land a moment later. */
export async function eventually<T>(fn: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

export async function orgBySlug(slug: string) {
  const org = await db().selectFrom('orgs').select(['id', 'slug', 'trading_name']).where('slug', '=', slug).executeTakeFirstOrThrow();
  const venues = await db().selectFrom('venues').select(['id', 'slug', 'name']).where('org_id', '=', org.id).orderBy('created_at').execute();
  return { orgId: org.id, name: org.trading_name, venues, venueId: venues[0]!.id };
}

/** Switch the console to one of the person's venues with the venue picker, as they would. */
export async function chooseVenue(page: Page, label: string): Promise<void> {
  if ((await page.locator('#venue-select').count()) === 0) return;
  const current = (await page.locator('#venue-select option:checked').innerText()).trim();
  if (current === label) return;
  // Choosing submits the picker's form. The choice is saved once that request has answered:
  // navigating away before then would cancel it.
  await Promise.all([page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.startsWith('/console')), page.selectOption('#venue-select', { label })]);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction((name) => document.querySelector('#venue-select option:checked')?.textContent?.trim() === name, label);
}
