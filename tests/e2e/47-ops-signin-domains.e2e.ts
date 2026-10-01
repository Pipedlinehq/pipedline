import { createHash, randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { hub } from '@ros/modules';
import { configFromEnv } from '@ros/runtime';
import { createTestApp, fakeClock } from '../../packages/testkit/src/app';
import { E2E_CLOCK_START } from './global-setup';
import { BASE, closeBrowser, closeDb, codeIn, db, eventually, inbox, newVisitor } from './helpers';
import { closeOpsApp, devGet, devPost, signInPlatformOnce } from './ops-helpers';

/**
 * Two journeys that cross a wait: a person who follows an assistant's sign-in link before they
 * are signed in to the console, and a venue's own sending domain that cannot send until its DNS
 * records exist.
 */

afterAll(async () => {
  await closeBrowser();
  await closeOpsApp();
  await closeDb();
});

const run = Date.now().toString(36);

describe('an assistant\'s sign-in link, followed by someone who is signed out', () => {
  it('signs them in with an emailed code and lands them back on the same consent page, question intact', async () => {
    const REDIRECT = 'http://127.0.0.1:33419/callback';
    const name = `Signed-out Assistant ${run}`;
    const t = createTestApp(process.env.E2E_DATABASE_URL!, { clock: fakeClock(new Date(E2E_CLOCK_START)), config: configFromEnv() });
    let clientId: string;
    try {
      clientId = String((await hub.registerOAuthClient(t.app, { redirect_uris: [REDIRECT], client_name: name })).client_id);
    } finally {
      await t.close();
    }
    const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
    const state = `st-${run}`;
    const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state });
    const link = `${BASE()}/console/oauth/authorize?${query}`;
    const email = 'manager@oak-group.test';

    const v = await newVisitor();
    await v.context.route('http://127.0.0.1:33419/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Back at the assistant</title>' }));
    // No session: the link leads to sign-in, carrying where the person was going.
    await v.page.goto(link);
    await v.page.waitForURL(/\/login\?next=/);
    const next = new URL(v.page.url()).searchParams.get('next')!;
    expect(next.startsWith('/console/oauth/authorize?')).toBe(true);
    expect(new URLSearchParams(next.split('?')[1]).get('client_id')).toBe(clientId);
    // Nothing was decided or stored by merely arriving.
    expect((await db().selectFrom('agent_oauth_codes').select('code_hash').where('client_id', '=', clientId).execute()).length).toBe(0);

    const before = (await inbox(email)).length;
    await v.page.fill('input[name=email]', email);
    await v.page.click('button[type=submit]');
    await v.page.waitForURL(/sent=1/);
    // The destination survives the step in between.
    expect(new URL(v.page.url()).searchParams.get('next')).toBe(next);
    const mail = await eventually(async () => {
      const all = await inbox(email);
      return all.length > before ? all.at(-1)! : null;
    }, 'the sign-in code');
    await v.page.fill('input[name=code]', codeIn(mail.body));
    await v.page.click('button[type=submit]');

    // Signed in, and on the consent page for the same assistant, with the same question.
    await v.page.waitForURL((u) => u.pathname === '/console/oauth/authorize');
    const landed = new URL(v.page.url());
    for (const [k, value] of query) expect(landed.searchParams.get(k), k).toBe(value);
    expect(await v.page.locator('[data-testid=assistant-name]').innerText()).toBe(name);
    expect(await v.page.locator('main').innerText()).toContain('127.0.0.1');

    // And the page works from there: saying no goes back to the assistant with its state.
    await v.page.getByRole('button', { name: 'Do not connect' }).click();
    await v.page.waitForURL(/127\.0\.0\.1:33419\/callback/);
    const back = new URL(v.page.url());
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe(state);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a "next" that points off the console is ignored: sign-in lands on the console, never elsewhere', async () => {
    const email = 'host@oak-group.test';
    const v = await newVisitor();
    await v.page.goto(`${BASE()}/login?next=${encodeURIComponent('//evil.example/console')}`);
    const before = (await inbox(email)).length;
    await v.page.fill('input[name=email]', email);
    await v.page.click('button[type=submit]');
    await v.page.waitForURL(/sent=1/);
    expect(new URL(v.page.url()).searchParams.get('next')).toBeNull();
    const mail = await eventually(async () => {
      const all = await inbox(email);
      return all.length > before ? all.at(-1)! : null;
    }, 'the sign-in code');
    await v.page.fill('input[name=code]', codeIn(mail.body));
    await v.page.click('button[type=submit]');
    await v.page.waitForURL((u) => u.pathname === '/console');
    expect(new URL(v.page.url()).host).toBe(new URL(BASE()).host);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});

async function saveSection(page: Page, id: string, section: string, fill: (page: Page) => Promise<void>): Promise<void> {
  await page.goto(`${BASE()}/platform/onboarding/${id}/intake/${section}`);
  await fill(page);
  await page.click('button:has-text("Save section")');
  await page.locator('main form [role=status]').first().waitFor();
}

describe('a venue\'s own sending domain', () => {
  it('is registered during provisioning, waits on DNS with the records shown, and is verified only once the provider finds them', async () => {
    const slug = `mailco-${run}`;
    const domain = `mail.${slug}.example.com.au`;
    const ownerEmail = `olive@${slug}.test`;
    const steps = async (id: string) => Object.fromEntries((await db().selectFrom('provisioning_steps').select(['step', 'status', 'blocked_on']).where('onboarding_id', '=', id).execute()).map((s) => [s.step, s]));

    const admin = await newVisitor();
    await signInPlatformOnce(admin.page);
    const page = admin.page;
    await page.goto(`${BASE()}/platform/onboarding`);
    await page.fill('input[name=tradingName]', `Mail Co ${run}`);
    await page.fill('input[name=contactEmail]', ownerEmail);
    await page.fill('input[name=contactFirstName]', 'Olive');
    await page.click('button:has-text("Start")');
    await page.waitForURL(/\/platform\/onboarding\/[0-9a-f-]{36}$/);
    const id = page.url().split('/').pop()!;

    await saveSection(page, id, 'identity', async (p) => {
      await p.fill('input[name=legalName]', `Mail Co ${run} Pty Ltd`);
      await p.fill('input[name=slug]', slug);
      await p.fill('input[name=pcLast]', 'Owner');
      await p.fill('input[name=pcMobile]', '0412 000 222');
    });
    await saveSection(page, id, 'brand', async (p) => {
      await p.selectOption('select[name=skeleton]', 'minimal');
      await p.fill('input[name=primary]', '#1F2937');
      await p.fill('textarea[name=toneOfVoice]', 'Plain and friendly.');
    });
    await saveSection(page, id, 'venues', async (p) => {
      await p.fill('input[name=name]', `Mail Co ${run}`);
      await p.fill('input[name=addressLine1]', '1 Test Street');
      await p.fill('input[name=suburb]', 'Fitzroy');
      await p.fill('input[name=state]', 'VIC');
      await p.fill('input[name=postcode]', '3065');
      await p.fill('input[name=phone]', '03 5550 4321');
      await p.fill('input[name=email]', `hello@${slug}.example`);
      await p.selectOption('select[name=timezone]', 'Australia/Melbourne');
      for (const d of ['2', '3', '4', '5', '6']) await p.check(`input[name=hours_day][value="${d}"]`);
      await p.fill('input[name=hours_opens]', '17:00');
      await p.fill('input[name=hours_closes]', '22:00');
      await p.fill('input[name=hours_service]', 'dinner');
    });
    await saveSection(page, id, 'services', async (p) => p.check('input[name=services][value="dine-in"]'));
    await saveSection(page, id, 'content', async (p) => {
      await p.fill('input[name=tagline]', 'Letters, mostly.');
      await p.fill('textarea[name=about]', 'A small room that writes to its regulars.');
    });
    // The sending domain is asked for on day one: DNS has lead time.
    await saveSection(page, id, 'comms', async (p) => {
      await p.fill('input[name=sendingDomain]', domain);
      await p.fill('input[name=fromName]', `Mail Co ${run}`);
    });

    await page.goto(`${BASE()}/platform/onboarding/${id}`);
    await page.click('button:has-text("Start provisioning")');
    await eventually(async () => (await steps(id)).sending_domain?.status === 'blocked', 'the sending domain waiting on DNS', 60_000);
    const s = await steps(id);
    expect(s.sending_domain!.blocked_on).toMatch(/Waiting for DNS: the sending records for .* have not been added yet/);
    const row = await db().selectFrom('onboardings').select('org_id').where('id', '=', id).executeTakeFirstOrThrow();
    const orgId = row.org_id!;

    // The identity exists, pending, with the provider's records for the venue to add. It cannot send yet.
    const identity = async () => db().selectFrom('sending_identities').select(['id', 'status', 'domain', 'from_email', 'provider', 'provider_domain_id', 'dns_records', 'verified_at']).where('org_id', '=', orgId).where('channel', '=', 'email').executeTakeFirstOrThrow();
    const pending = await identity();
    expect(pending).toMatchObject({ status: 'pending', domain, from_email: `hello@${domain}`, verified_at: null });
    expect(pending.provider_domain_id).toBeTruthy();
    expect(JSON.stringify(pending.dns_records)).toContain('_domainkey');
    const registered = await devGet<Array<{ kind: string; name: string; verified: boolean }>>('domains');
    expect(registered).toContainEqual({ kind: 'sending', name: domain, verified: false });

    // The platform page shows the step blocked, in words, with the records.
    await page.reload();
    const step = page.locator('[data-testid=step-sending_domain]');
    expect(await step.getAttribute('data-status')).toBe('blocked');
    expect(await step.textContent()).toContain('_domainkey');

    // Checking again before the records exist changes nothing: nobody can declare a domain verified.
    await step.locator('button:has-text("Check again")').click();
    await new Promise((r) => setTimeout(r, 3500));
    expect((await steps(id)).sending_domain!.status).toBe('blocked');
    expect((await identity()).status).toBe('pending');

    // The venue adds its DNS records (the simulated provider is told so); the same button now finishes the step.
    await devPost('verify-domain', { kind: 'sending', name: domain });
    await page.reload();
    await page.locator('[data-testid=step-sending_domain] button:has-text("Check again")').click();
    await eventually(async () => (await steps(id)).sending_domain?.status === 'done', 'the sending domain verified', 30_000);
    const verified = await identity();
    expect(verified.status).toBe('verified');
    expect(verified.verified_at).not.toBeNull();
    // Verified by the provisioner on the provider's word, and on the record as that.
    const audit = await db().selectFrom('audit_log').select(['actor_kind', 'after']).where('org_id', '=', orgId).where('action', '=', 'sending_identity.status').where('entity_id', '=', verified.id).orderBy('occurred_at', 'desc').executeTakeFirstOrThrow();
    expect(audit.actor_kind).not.toBe('staff');
    expect(audit.after).toMatchObject({ status: 'verified' });
    await page.reload();
    expect(await page.locator('[data-testid=step-sending_domain]').getAttribute('data-status')).toBe('done');
    expect(admin.problems).toEqual([]);
    await admin.context.close();
  });
});
