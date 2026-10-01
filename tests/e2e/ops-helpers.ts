import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import type { App, Principal } from '@ros/core';
import { auth } from '@ros/modules';
import { configFromEnv } from '@ros/runtime';
import { type FakeClock, createTestApp } from '../../packages/testkit/src/app';
import { BASE, codeIn, db, inbox } from './helpers';

/**
 * Helpers for the operations scenarios (kitchen screen, webhooks, platform admin, dev tools).
 *
 * Provider-side effects go through the running app's development tools (/api/dev/ops/*), because
 * the simulated providers live in the web process. Console functions a person would use (make a
 * pairing code, revoke a screen, confirm hours) are called from here through an App on the same
 * database, as that person, with the web process's own clock.
 */

export async function devGet<T = unknown>(action: string): Promise<T> {
  const r = await fetch(`${BASE()}/api/dev/ops/${action}`);
  const j = (await r.json()) as { data?: T; error?: { message: string } };
  if (!r.ok) throw new Error(`dev ${action}: HTTP ${r.status} ${JSON.stringify(j)}`);
  return j.data as T;
}

export async function devPost<T = unknown>(action: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE()}/api/dev/ops/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json()) as { data?: T; error?: { message: string } };
  if (!r.ok) throw new Error(`dev ${action}: HTTP ${r.status} ${JSON.stringify(j)}`);
  return j.data as T;
}

let testApp: { app: App; close(): Promise<void> } | undefined;

/** An App on the e2e database whose clock reads what the web process's clock reads. */
export async function opsApp(): Promise<App> {
  if (testApp) return testApp.app;
  const { now } = await devGet<{ now: string }>('clock');
  const offset = Date.parse(now) - Date.now();
  const clock = (() => new Date(Date.now() + offset)) as FakeClock;
  clock.set = () => undefined;
  clock.advance = () => undefined;
  clock.advanceMinutes = () => undefined;
  clock.advanceDays = () => undefined;
  testApp = createTestApp(process.env.E2E_DATABASE_URL!, { clock, config: configFromEnv() });
  return testApp.app;
}

export async function closeOpsApp(): Promise<void> {
  await testApp?.close();
  testApp = undefined;
}

/** A staff member as the console would act for them, built from the database. */
export async function staffAs(email: string, orgSlug: string): Promise<{ orgId: string; principal: Principal }> {
  const org = await db().selectFrom('orgs').select('id').where('slug', '=', orgSlug).executeTakeFirstOrThrow();
  const user = await db().selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow();
  const principal = await auth.staffPrincipal(await opsApp(), user.id, org.id);
  if (!principal) throw new Error(`${email} is not staff at ${orgSlug}`);
  return { orgId: org.id, principal };
}

export async function venueOf(orgSlug: string, venueName?: string) {
  const org = await db().selectFrom('orgs').select(['id']).where('slug', '=', orgSlug).executeTakeFirstOrThrow();
  let q = db().selectFrom('venues').select(['id', 'name']).where('org_id', '=', org.id).orderBy('created_at');
  if (venueName) q = q.where('name', '=', venueName);
  const v = await q.executeTakeFirstOrThrow();
  return { orgId: org.id, venueId: v.id, name: v.name };
}

/** Sign a platform admin in through the platform's own sign-in page. */
export async function signInPlatform(page: Page, email = 'admin@rosplatform.test'): Promise<void> {
  const before = (await inbox(email)).length;
  await page.goto(`${BASE()}/platform/login`);
  await page.fill('input[name=email]', email);
  await page.click('button[type=submit]');
  await page.waitForURL(/sent=1/);
  const deadline = Date.now() + 15_000;
  let messages = await inbox(email);
  while (messages.length <= before && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    messages = await inbox(email);
  }
  if (messages.length <= before) throw new Error(`no platform sign-in code for ${email}`);
  await page.fill('input[name=code]', codeIn(messages.at(-1)!.body));
  await page.click('button[type=submit]');
  await page.waitForURL(`${BASE()}/platform`);
}

export const SHOTS = process.env.E2E_SHOTS_DIR ?? 'tests/e2e/.shots';

/**
 * Requests that fail because the test turned the network off are expected, as is the development
 * server's hot-reload client failing to load while offline (it does not exist in a production
 * build). Everything else is a problem.
 */
export const realProblems = (problems: string[]) => problems.filter((p) => !/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|Failed to fetch|hmr|webpack-hmr/i.test(p));

/** Pair a browser as a venue's kitchen screen, with a code made the way a manager would in the console. */
export async function pairKitchenScreen(page: Page, venueId: string, name = 'E2E pass screen'): Promise<{ deviceId: string }> {
  const pairing = await devPost<{ code: string; deviceId: string }>('pairing-code', { venueId, name });
  await page.goto(`${BASE()}/kitchen`);
  await page.waitForLoadState('networkidle');
  await page.fill('input[name=code]', pairing.code.toLowerCase());
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=kitchen-screen]');
  return { deviceId: pairing.deviceId };
}

/** Page through the kitchen screen, as a cook would, until a ticket is in view. It arrives by polling. */
export async function showKitchenTicket(page: Page, ticketId: string, timeoutMs = 25_000): Promise<void> {
  const card = page.locator(`[data-testid=ticket][data-ticket-id="${ticketId}"]`);
  const prev = page.locator('button[aria-label="Previous page"]');
  const next = page.locator('button[aria-label="Next page"]');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await card.isVisible()) return;
    while (await prev.isEnabled()) await prev.click();
    for (let i = 0; i < 12; i++) {
      if (await card.isVisible()) return;
      if (!(await next.isEnabled())) break;
      await next.click();
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`ticket ${ticketId} never appeared on the kitchen screen`);
}

/**
 * As signInPlatform, but a platform session made earlier in this run is reused. Sign-in codes are
 * limited per address (as in production), and several scenario files need a platform admin.
 * Scenarios about platform sign-in itself use signInPlatform.
 */
export async function signInPlatformOnce(page: Page, email = 'admin@rosplatform.test'): Promise<void> {
  const runKey = createHash('sha256').update(process.env.E2E_DATABASE_URL ?? BASE()).digest('hex').slice(0, 12);
  const cache = path.join(tmpdir(), `ros-e2e-${runKey}-platform-${email.replace(/\W+/g, '_')}.json`);
  if (existsSync(cache)) {
    const saved = JSON.parse(readFileSync(cache, 'utf8')) as Array<{ name: string; value: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Lax' | 'Strict' | 'None' }>;
    await page.context().addCookies(saved.map((c) => ({ name: c.name, value: c.value, url: BASE(), expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite })));
    await page.goto(`${BASE()}/platform`);
    if (new URL(page.url()).pathname === '/platform') return;
    await page.context().clearCookies();
  }
  await signInPlatform(page, email);
  writeFileSync(cache, JSON.stringify((await page.context().cookies()).filter((c) => c.name === 'ros_platform')));
}
