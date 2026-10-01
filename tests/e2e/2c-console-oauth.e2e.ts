import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '@ros/core';
import { hub } from '@ros/modules';
import { configFromEnv } from '@ros/runtime';
import { createTestApp, fakeClock } from '../../packages/testkit/src/app';
import { E2E_CLOCK_START } from './global-setup';
import { BASE, closeBrowser, closeDb, db, newVisitor, orgBySlug, signInStaff, type Watched } from './helpers';

/**
 * An assistant connects by sign-in: it registers, sends the person to the consent page, and the
 * person answers there. The assistant's half (registration, exchanging the code) is done from
 * this process through the hub's own functions, as its HTTP endpoints would; the person's half
 * is the real page in a real browser.
 */
const REDIRECT = 'http://127.0.0.1:33418/callback';
let t: ReturnType<typeof createTestApp>;
let clientId: string;
const name = `Test Assistant ${Date.now()}`;

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const authorizeUrl = (challenge: string, extra: Record<string, string> = {}) =>
  `${BASE()}/console/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', ...extra })}`;

/** The assistant's own callback address is a program on the person's computer; stand in for it. */
async function listenForCallback(v: Watched): Promise<void> {
  await v.context.route('http://127.0.0.1:33418/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Back at the assistant</title>' }));
}

beforeAll(async () => {
  // The running app's clock moves on from the e2e start, so this one is never ahead of it: a
  // code the page has just made is always still in date when the assistant exchanges it.
  t = createTestApp(process.env.E2E_DATABASE_URL!, { clock: fakeClock(new Date(E2E_CLOCK_START)), config: configFromEnv() });
  const reg = await hub.registerOAuthClient(t.app, { redirect_uris: [REDIRECT], client_name: name });
  clientId = String(reg.client_id);
});

afterAll(async () => {
  await t.close();
  await closeBrowser();
  await closeDb();
});

describe('console: connecting an assistant by sign-in', () => {
  it('a manager sees who is asking and what it could see, cannot allow changes, and can say no', async () => {
    const diner = await orgBySlug('oak-diner');
    const v = await newVisitor();
    await listenForCallback(v);
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(authorizeUrl(pkce().challenge));
    expect(await v.page.locator('[data-testid=assistant-name]').innerText()).toBe(name);
    expect(await v.page.locator('main').innerText()).toContain('127.0.0.1');
    const box = v.page.locator('input[type=checkbox][name=allowChanges]');
    expect(await box.isChecked()).toBe(false);
    expect(await box.isDisabled()).toBe(true);

    const codesBefore = await db().selectFrom('agent_oauth_codes').select('code_hash').where('client_id', '=', clientId).execute();
    await v.page.getByRole('button', { name: 'Do not connect' }).click();
    await v.page.waitForURL(/127\.0\.0\.1:33418\/callback/);
    const back = new URL(v.page.url());
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('code')).toBeNull();
    expect((await db().selectFrom('agent_oauth_codes').select('code_hash').where('client_id', '=', clientId).execute()).length).toBe(codesBefore.length);
    const declined = await db().selectFrom('audit_log').select('after').where('org_id', '=', diner.orgId).where('action', '=', 'agent_oauth.declined').orderBy('occurred_at', 'desc').executeTakeFirstOrThrow();
    expect(JSON.stringify(declined.after)).toContain(name);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('an owner connects it for 7 days with changes allowed; only the code\'s hash is stored, and the code becomes a working sign-in', async () => {
    const diner = await orgBySlug('oak-diner');
    const { verifier, challenge } = pkce();
    const v = await newVisitor();
    await listenForCallback(v);
    await signInStaff(v.page, 'owner@oak-diner.test');
    await v.page.goto(authorizeUrl(challenge));
    const box = v.page.locator('input[type=checkbox][name=allowChanges]');
    expect(await box.isChecked()).toBe(false);
    if (process.env.E2E_SHOTS) {
      await v.page.screenshot({ path: `${process.env.E2E_SHOTS}/oauth-authorize-desktop.png`, fullPage: true });
      await v.page.setViewportSize({ width: 820, height: 1180 });
      await v.page.screenshot({ path: `${process.env.E2E_SHOTS}/oauth-authorize-tablet.png`, fullPage: true });
    }
    await box.check();
    await v.page.selectOption('select[name=lastsDays]', '7');
    await v.page.getByRole('button', { name: /^Connect / }).click();
    await v.page.waitForURL(/127\.0\.0\.1:33418\/callback\?/);
    const back = new URL(v.page.url());
    const code = back.searchParams.get('code')!;
    expect(code).toBeTruthy();
    expect(back.searchParams.get('state')).toBe('xyz');

    const row = await db().selectFrom('agent_oauth_codes').selectAll().where('client_id', '=', clientId).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect(row.org_id).toBe(diner.orgId);
    expect(row.can_write).toBe(true);
    expect(row.lasts_days).toBe(7);
    expect(row.venue_ids).toBeNull();
    expect(Buffer.from(row.code_hash).equals(Buffer.from(hashToken(code)))).toBe(true);
    expect(JSON.stringify(row)).not.toContain(code);
    const agreed = await db().selectFrom('audit_log').select(['after', 'actor_kind']).where('org_id', '=', diner.orgId).where('action', '=', 'agent_oauth.agreed').orderBy('occurred_at', 'desc').executeTakeFirstOrThrow();
    expect(agreed.actor_kind).toBe('staff');
    expect(JSON.stringify(agreed.after)).not.toContain(code);

    // The assistant exchanges the code, and what it holds is the owner, no more.
    const token = await hub.oauthToken(t.app, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
    const caller = (await hub.resolveAgentKey(t.app, token.access_token))!;
    expect(caller.kind).toBe('oauth');
    expect(caller.orgId).toBe(diner.orgId);
    expect(caller.principal.canWrite).toBe(true);

    // It is listed, by name, where the owner can end it.
    await v.page.goto(`${BASE()}/console/settings/assistants`);
    expect(await v.page.locator('main').innerText()).toContain(name);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a link naming an address the assistant never registered connects nothing and sends the person nowhere', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    await v.page.goto(authorizeUrl(pkce().challenge, { redirect_uri: 'https://evil.example/cb' }));
    expect(new URL(v.page.url()).pathname).toBe('/console/oauth/authorize');
    expect(await v.page.locator('main').innerText()).toMatch(/Nothing was connected/);
    expect(await v.page.getByRole('button', { name: /^Connect / }).count()).toBe(0);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
