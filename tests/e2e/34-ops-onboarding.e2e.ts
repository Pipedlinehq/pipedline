import { mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { menu, onboarding } from '@ros/modules';
import { BASE, PORT, type Watched, closeBrowser, closeDb, db, eventually, newVisitor, signInStaff } from './helpers';
import { SHOTS, closeOpsApp, devPost, opsApp, signInPlatform, staffAs } from './ops-helpers';

/**
 * A whole onboarding through the platform pages: sold, the intake filled in over several sittings,
 * provisioning, a custom domain blocked on DNS until the venue "adds its records", hands-on time
 * recorded, the gated go-live checklist, live on its subdomain, and finally closed.
 */

/** A fresh address per run, so the scenario can be repeated against a database that has seen it before. */
const SLUG = `bella-${Date.now().toString(36)}`;
const CUSTOM = `${SLUG}.example.com.au`;
const OWNER = `bella@${SLUG}.test`;

beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

afterAll(async () => {
  await closeBrowser();
  await closeOpsApp();
  await closeDb();
});

const onboardingRow = (id: string) => db().selectFrom('onboardings').select(['id', 'org_id', 'status', 'intake', 'manual_touch_minutes', 'live_at']).where('id', '=', id).executeTakeFirstOrThrow();
const steps = async (id: string) => Object.fromEntries((await db().selectFrom('provisioning_steps').select(['step', 'status', 'blocked_on']).where('onboarding_id', '=', id).execute()).map((s) => [s.step, s]));

async function saveFields(page: Page, id: string, section: string, fill: (page: Page) => Promise<void>): Promise<string> {
  await page.goto(`${BASE()}/platform/onboarding/${id}/intake/${section}`);
  await fill(page);
  await page.click('button:has-text("Save section")');
  const status = page.locator('main form [role=status], main form [role=alert]').first();
  await status.waitFor();
  return (await status.textContent()) ?? '';
}

describe('onboarding, from sold to live', () => {
  let admin: Watched;
  let id: string;
  let orgId: string;

  it('starts at the moment of sale and shows what the intake is missing, section by section', async () => {
    admin = await newVisitor();
    await signInPlatform(admin.page);
    const page = admin.page;
    await page.goto(`${BASE()}/platform/onboarding`);
    await page.fill('input[name=tradingName]', 'Bella Trattoria');
    await page.fill('input[name=contactEmail]', OWNER);
    await page.fill('input[name=contactFirstName]', 'Bella');
    await page.click('button:has-text("Start")');
    await page.waitForURL(/\/platform\/onboarding\/[0-9a-f-]{36}$/);
    id = page.url().split('/').pop()!;
    const row = await onboardingRow(id);
    expect(row).toMatchObject({ status: 'intake', org_id: null });

    // Identity is half-filled from the sale: the page names what is still missing.
    expect(await page.textContent('[data-testid=section-identity]')).toMatch(/Missing: .*legalName/);
    expect(await page.locator('button:has-text("Start provisioning")').count()).toBe(0);

    // A bad value is refused with the reason; a half-finished section is saved and reported as such.
    const bad = await saveFields(page, id, 'identity', async (p) => {
      await p.fill('input[name=legalName]', 'Bella Trattoria Pty Ltd');
      await p.fill('input[name=slug]', 'Not A Slug!');
    });
    expect(bad).toMatch(/slug/i);
    const half = await saveFields(page, id, 'identity', async (p) => {
      await p.fill('input[name=legalName]', 'Bella Trattoria Pty Ltd');
      await p.fill('input[name=slug]', '');
    });
    expect(half).toMatch(/Still missing: slug/);
    expect(((await onboardingRow(id)).intake as { identity: { legalName: string } }).identity.legalName).toBe('Bella Trattoria Pty Ltd');
    // Nothing answers at the address yet.
    expect((await fetch(`http://${SLUG}.tables.localhost:${PORT()}/`)).status).toBe(404);
  });

  it('is resumable: a second sitting finishes the intake', async () => {
    const page = admin.page;
    // A new sitting: sign in again in a fresh browser and pick up where it stopped.
    await admin.context.close();
    admin = await newVisitor();
    await signInPlatform(admin.page);
    const p2 = admin.page;
    await p2.goto(`${BASE()}/platform/onboarding/${id}/intake/identity`);
    expect(await p2.inputValue('input[name=legalName]')).toBe('Bella Trattoria Pty Ltd');
    void page;

    expect(
      await saveFields(p2, id, 'identity', async (p) => {
        await p.fill('input[name=slug]', SLUG);
        await p.fill('input[name=pcLast]', 'Rossi');
        await p.fill('input[name=pcMobile]', '0412 000 111');
      }),
    ).toMatch(/complete/);
    expect(
      await saveFields(p2, id, 'brand', async (p) => {
        await p.selectOption('select[name=skeleton]', 'editorial');
        await p.fill('input[name=primary]', '#14532D');
        await p.fill('textarea[name=toneOfVoice]', 'Warm and unhurried. We talk like family.');
      }),
    ).toMatch(/complete/);
    expect(
      await saveFields(p2, id, 'venues', async (p) => {
        await p.fill('input[name=name]', 'Bella Trattoria');
        await p.fill('input[name=addressLine1]', '12 Norton Street');
        await p.fill('input[name=suburb]', 'Carlton');
        await p.fill('input[name=state]', 'VIC');
        await p.fill('input[name=postcode]', '3053');
        await p.fill('input[name=phone]', '03 5550 1234');
        await p.fill('input[name=email]', 'ciao@bella.example');
        await p.selectOption('select[name=timezone]', 'Australia/Melbourne');
        for (const d of ['2', '3', '4', '5', '6']) await p.check(`input[name=hours_day][value="${d}"]`);
        await p.fill('input[name=hours_opens]', '17:00');
        await p.fill('input[name=hours_closes]', '22:00');
        await p.fill('input[name=hours_service]', 'dinner');
      }),
    ).toMatch(/complete/);
    expect(await saveFields(p2, id, 'services', async (p) => p.check('input[name=services][value="dine-in"]'))).toMatch(/complete/);
    expect(
      await saveFields(p2, id, 'content', async (p) => {
        await p.fill('input[name=tagline]', 'Pasta made this morning.');
        await p.fill('textarea[name=about]', 'A family room in Carlton since 1987.');
      }),
    ).toMatch(/complete/);
    expect(
      await saveFields(p2, id, 'migration', async (p) => {
        await p.fill('input[name=existingSiteUrl]', 'http://old.bella.example');
        await p.fill('input[name=customDomain]', CUSTOM);
        await p.fill('textarea[name=sitemapUrls]', 'http://old.bella.example/our-menu.html\nhttp://old.bella.example/the-family/');
      }),
    ).toMatch(/complete/);

    // The team goes in through the JSON editor.
    await p2.goto(`${BASE()}/platform/onboarding/${id}/intake/team`);
    await p2.fill('textarea[name=json]', JSON.stringify({ staff: [{ email: `marco@${SLUG}.test`, firstName: 'Marco', role: 'manager' }] }));
    await p2.click('button:has-text("Save JSON")');
    await p2.waitForSelector('main form [role=status]');

    await p2.goto(`${BASE()}/platform/onboarding/${id}`);
    await p2.screenshot({ path: `${SHOTS}/platform-onboarding-intake.png`, fullPage: true, caret: 'initial' });
    const intake = (await onboardingRow(id)).intake as Record<string, unknown>;
    expect(Object.keys(intake).sort()).toEqual(['brand', 'content', 'identity', 'migration', 'services', 'team', 'venues']);
  });

  it('provisions the org; the custom domain waits on DNS and finishes after the records are added', async () => {
    const page = admin.page;
    await page.click('button:has-text("Start provisioning")');
    await eventually(async () => (await steps(id)).custom_domain?.status === 'blocked', 'custom domain blocked on DNS', 60_000);
    await eventually(async () => (await steps(id)).staff?.status === 'done', 'staff invited', 60_000);
    const row = await onboardingRow(id);
    orgId = row.org_id!;
    expect(orgId).toBeTruthy();
    const s = await steps(id);
    expect(s.org!.status).toBe('done');
    expect(s.subdomain!.status).toBe('done');
    expect(s.pages!.status).toBe('done');
    expect(s.custom_domain!.blocked_on).toMatch(/Waiting for DNS/);

    // The board says what it is blocked on, in words, and shows the records to add.
    await page.goto(`${BASE()}/platform/onboarding`);
    const boardRow = page.locator('[data-testid=onboarding-row]', { hasText: 'Bella Trattoria' });
    expect(await boardRow.textContent()).toMatch(/Waiting for DNS/);
    await page.screenshot({ path: `${SHOTS}/platform-onboarding-board.png`, fullPage: true, caret: 'initial' });
    await page.goto(`${BASE()}/platform/onboarding/${id}`);
    expect(await page.locator('[data-testid=step-custom_domain]').getAttribute('data-status')).toBe('blocked');
    expect(await page.locator('[data-testid=step-custom_domain]').textContent()).toContain('sim-verify=');
    await page.screenshot({ path: `${SHOTS}/platform-onboarding-blocked.png`, fullPage: true, caret: 'initial' });

    // The venue has not added the records: checking again leaves it blocked.
    await page.locator('[data-testid=step-custom_domain] button:has-text("Check again")').click();
    await new Promise((r) => setTimeout(r, 4000));
    expect((await steps(id)).custom_domain!.status).toBe('blocked');

    // The venue adds its DNS records (simulated), and the same button finishes the step.
    await devPost('verify-domain', { kind: 'hosting', name: CUSTOM });
    await page.reload();
    await page.locator('[data-testid=step-custom_domain] button:has-text("Check again")').click();
    await eventually(async () => (await steps(id)).custom_domain?.status === 'done', 'custom domain verified', 30_000);
    const domain = await db().selectFrom('domains').select(['host', 'verified_at']).where('org_id', '=', orgId).where('host', '=', CUSTOM).executeTakeFirstOrThrow();
    expect(domain.verified_at).not.toBeNull();

  });

  it('records hands-on minutes', async () => {
    const page = admin.page;
    await page.goto(`${BASE()}/platform/onboarding/${id}`);
    await page.fill('input[name=minutes]', '25');
    await page.fill('input[name=note]', 'Walked the owner through adding DNS records at their registrar');
    await page.click('button:has-text("Record")');
    await eventually(async () => (await onboardingRow(id)).manual_touch_minutes === 25, 'minutes recorded');
    const touch = await db().selectFrom('onboarding_touches').select(['minutes', 'note']).where('onboarding_id', '=', id).executeTakeFirstOrThrow();
    expect(touch).toMatchObject({ minutes: 25 });
    expect(touch.note).toContain('DNS records');
  });

  it('go-live is gated: refused while checks fail, allowed once the owner has done their part', async () => {
    const page = admin.page;
    await page.goto(`${BASE()}/platform/onboarding/${id}?checks=1`);
    await page.waitForSelector('[data-testid=checklist]');
    const failing = await page.locator('[data-check][data-status=fail]').evaluateAll((els) => els.map((e) => e.getAttribute('data-check')));
    expect(failing).toEqual(expect.arrayContaining(['menu_confirmed', 'hours_confirmed', 'transactional_email', 'staff_signed_in']));
    await page.screenshot({ path: `${SHOTS}/platform-onboarding-checks-failing.png`, fullPage: true, caret: 'initial' });
    await page.click('button:has-text("Go live")');
    await page.waitForSelector('main form [role=alert]');
    expect(await page.locator('main form [role=alert]').first().textContent()).toMatch(/Not ready to go live/);
    expect((await onboardingRow(id)).status).not.toBe('live');
    expect((await db().selectFrom('orgs').select('status').where('id', '=', orgId).executeTakeFirstOrThrow()).status).toBe('onboarding');

    // The owner signs in to the console for the first time (accepting the invitation) …
    const ownerBrowser = await newVisitor();
    await signInStaff(ownerBrowser.page, OWNER);
    await ownerBrowser.context.close();
    // … enters a menu, confirms it and the hours, and sends the test email: console functions, called as the owner.
    const owner = await staffAs(OWNER, SLUG);
    const app = await opsApp();
    const venue = await db().selectFrom('venues').select('id').where('org_id', '=', orgId).executeTakeFirstOrThrow();
    const sent = await app.tenant(owner.orgId, owner.principal, async (ctx) => {
      const m = await menu.createMenu(ctx, { venueId: venue.id, name: 'Dinner' });
      const sec = await menu.createSection(ctx, { menuId: m.id, name: 'Pasta' });
      await menu.createItem(ctx, { sectionId: sec.id, name: 'Gnocchi al pomodoro', priceCents: 2800, allergens: ['gluten'] });
      await onboarding.confirmGoLiveItem(ctx, { key: 'menu_confirmed' });
      await onboarding.confirmGoLiveItem(ctx, { key: 'hours_confirmed' });
      return onboarding.sendGoLiveTestEmail(ctx);
    });
    // The provider reports the test email delivered (a signed webhook to /webhooks/messages/sim-email).
    await eventually(async () => (await db().selectFrom('messages').select('provider_message_id').where('id', '=', sent.messageId).executeTakeFirstOrThrow()).provider_message_id, 'test email sent', 30_000);
    const delivered = await devPost<{ status: number }>('message-event', { messageId: sent.messageId, event: 'delivered' });
    expect(delivered.status).toBe(200);
    expect((await db().selectFrom('messages').select('status').where('id', '=', sent.messageId).executeTakeFirstOrThrow()).status).toBe('delivered');

    await page.goto(`${BASE()}/platform/onboarding/${id}?checks=1`);
    await page.waitForSelector('[data-testid=checklist]');
    const stillFailing = await page.locator('[data-check][data-status=fail]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-check')}: ${e.textContent}`));
    expect(stillFailing).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/platform-onboarding-checks-passing.png`, fullPage: true, caret: 'initial' });

    await page.click('button:has-text("Go live")');
    await eventually(async () => (await onboardingRow(id)).status === 'live', 'onboarding live');
    const org = await db().selectFrom('orgs').select(['status', 'slug']).where('id', '=', orgId).executeTakeFirstOrThrow();
    expect(org).toEqual({ status: 'live', slug: SLUG });
    expect((await db().selectFrom('venues').select('status').where('org_id', '=', orgId).executeTakeFirstOrThrow()).status).toBe('live');
    expect((await db().selectFrom('audit_log').select('id').where('org_id', '=', orgId).where('action', '=', 'org.went_live').execute()).length).toBe(1);
    expect((await db().selectFrom('events').select('id').where('org_id', '=', orgId).where('name', '=', 'org.went_live').execute()).length).toBe(1);

    // Live on its subdomain, and the time-to-live numbers count it.
    const site = await fetch(`http://${SLUG}.tables.localhost:${PORT()}/`);
    expect(site.status).toBe(200);
    expect(await site.text()).toContain("Bella Trattoria");
    await page.goto(`${BASE()}/platform/onboarding?all=1`);
    expect(await page.locator('[data-testid=onboarding-row]', { hasText: 'Bella Trattoria' }).textContent()).toMatch(/Live/);
    await page.screenshot({ path: `${SHOTS}/platform-onboarding-live.png`, fullPage: true, caret: 'initial' });
    // Going live twice changes nothing.
    await page.goto(`${BASE()}/platform/onboarding/${id}`);
    expect(await page.locator('button:has-text("Go live")').count()).toBe(0);
  });

  it('closing the org needs its name typed and a reason, detaches its custom domain and takes the site down', async () => {
    const page = admin.page;
    await page.goto(`${BASE()}/platform/tenants/${orgId}`);
    await page.fill('input[name=reason]', 'End-to-end test: the venue left the platform.');
    await page.fill('input[name=confirm]', 'wrong-name');
    await page.click('button:has-text("Close organisation")');
    await page.waitForSelector('main form [role=alert]');
    expect((await db().selectFrom('orgs').select('status').where('id', '=', orgId).executeTakeFirstOrThrow()).status).toBe('live');

    await page.goto(`${BASE()}/platform/tenants/${orgId}`);
    await page.fill('input[name=reason]', 'End-to-end test: the venue left the platform.');
    await page.fill('input[name=confirm]', SLUG);
    await page.click('button:has-text("Close organisation")');
    await page.waitForSelector('[data-testid=org-closed]');
    await eventually(async () => (await db().selectFrom('orgs').select('status').where('id', '=', orgId).executeTakeFirstOrThrow()).status === 'closed', 'org closed');
    expect(await db().selectFrom('domains').select('host').where('org_id', '=', orgId).where('kind', '=', 'custom').execute()).toEqual([]);
    const audit = await db().selectFrom('audit_log').select('after').where('org_id', '=', orgId).where('action', '=', 'org.closed').executeTakeFirstOrThrow();
    expect(JSON.stringify(audit.after)).toContain(CUSTOM);
    const domains = await (await fetch(`${BASE()}/api/dev/ops/domains`)).json() as { data: Array<{ name: string }> };
    expect(domains.data.find((d) => d.name === CUSTOM)).toBeUndefined();
    await eventually(async () => (await fetch(`http://${SLUG}.tables.localhost:${PORT()}/`)).status === 404, 'site gone', 30_000);
    expect(admin.problems).toEqual([]);
    await admin.context.close();
  });
});
