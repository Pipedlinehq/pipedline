import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { BASE, chooseVenue, closeBrowser, closeDb, db, newVisitor, orgBySlug, signInStaff } from './helpers';
import { SHOTS, devPost, pairKitchenScreen, signInPlatformOnce } from './ops-helpers';
import { siteUrl, visitor } from './site-helpers';

/**
 * An automated accessibility pass (axe-core, WCAG 2.0/2.1 A and AA rules) over the main pages of
 * every surface: both fixture brands' venue sites, the staff console, the kitchen screen and the
 * platform pages. A page fails on any violation axe rates serious or critical.
 *
 * What this does and does not show: axe finds what a machine can find (contrast, names, roles,
 * labels, structure). It does not replace a person using a screen reader or a keyboard.
 */

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

interface Finding {
  where: string;
  rule: string;
  impact: string;
  help: string;
  nodes: string[];
}

async function audit(page: Page, where: string): Promise<Finding[]> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      where,
      rule: v.id,
      impact: v.impact!,
      help: v.help,
      nodes: v.nodes.slice(0, 4).map((n) => `${n.target.join(' ')} :: ${(n.failureSummary ?? '').split('\n').slice(1, 3).join(' | ').trim()} :: ${n.html.slice(0, 160)}`),
    }));
}

const report = (findings: Finding[]) => findings.map((f) => `\n[${f.where}] ${f.impact} ${f.rule}: ${f.help}\n    ${f.nodes.join('\n    ')}`).join('');

describe('accessibility: no serious or critical axe violations', () => {
  it('venue sites: both brands, at phone and desktop width', async () => {
    const group = await orgBySlug('oak-group');
    const table = await db().selectFrom('qr_codes').select('code').where('venue_id', '=', group.venues.find((x) => x.slug === 'newtown')!.id).where('kind', '=', 'table').where('is_active', '=', true).orderBy('label').executeTakeFirstOrThrow();
    const findings: Finding[] = [];
    for (const mobile of [true, false]) {
      const v = await visitor({ mobile });
      const pages: Array<[string, string]> = [
        ['diner home', siteUrl('oak-diner', '/')],
        ['diner menu', siteUrl('oak-diner', '/menu')],
        ['diner about', siteUrl('oak-diner', '/about')],
        ['diner contact', siteUrl('oak-diner', '/contact')],
        ['diner order', siteUrl('oak-diner', '/order')],
        ['diner account sign-in', siteUrl('oak-diner', '/account/login')],
        ['diner offer', siteUrl('oak-diner', '/offer')],
        ['diner not found', siteUrl('oak-diner', '/no-such-page')],
        ['group home (location picker)', siteUrl('oak-group', '/')],
        ['group newtown home (venue brand override)', siteUrl('oak-group', '/at/newtown')],
        ['group newtown menu', siteUrl('oak-group', '/at/newtown/menu')],
        ['group cbd order', siteUrl('oak-group', '/at/cbd/order')],
        ['group newtown menu at a table', siteUrl('oak-group', `/q/${table.code}`)],
      ];
      for (const [name, url] of pages) {
        const res = await v.page.goto(url);
        await v.page.waitForLoadState('networkidle');
        if (res && res.status() >= 500) throw new Error(`${name} answered ${res.status()}`);
        findings.push(...(await audit(v.page, `${name} (${mobile ? 'phone' : 'desktop'})`)));
      }
      // The order page with an item's options open: a dialog, the most-used interaction on the site.
      await v.page.goto(siteUrl('oak-diner', '/order'));
      const item = v.page.locator('[data-order-item] button').first();
      if (await item.count()) {
        await item.click();
        await v.page.waitForSelector('dialog[open]');
        findings.push(...(await audit(v.page, `diner order, item dialog (${mobile ? 'phone' : 'desktop'})`)));
      }
      if (mobile) await v.page.screenshot({ path: `${SHOTS}/a11y-site-order-dialog-phone.png` });
      await v.context.close();
    }
    expect(findings, report(findings)).toEqual([]);
  });

  it('the console: its main screens as a manager, and the owner-only ones', async () => {
    const findings: Finding[] = [];
    const diner = await orgBySlug('oak-diner');
    const order = await db().selectFrom('orders').select('id').where('org_id', '=', diner.orgId).where('status', 'not in', ['draft', 'pending_payment']).orderBy('created_at', 'desc').executeTakeFirst();
    const customer = await db().selectFrom('customers').select('id').where('org_id', '=', diner.orgId).where('status', '=', 'active').executeTakeFirst();
    const member = await db().selectFrom('loyalty_accounts').select('id').where('org_id', '=', diner.orgId).where('status', '=', 'active').executeTakeFirst();
    const approval = await db().selectFrom('approvals').select('id').where('org_id', '=', diner.orgId).orderBy('created_at', 'desc').executeTakeFirst();
    const campaign = await db().selectFrom('campaigns').select('id').where('org_id', '=', diner.orgId).executeTakeFirst();
    const sitePage = await db().selectFrom('pages').select('id').where('org_id', '=', diner.orgId).where('slug', '=', 'home').executeTakeFirst();
    const offer = await db().selectFrom('offers').select('id').where('org_id', '=', diner.orgId).executeTakeFirst();

    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    const paths = [
      '/console',
      '/console/orders',
      '/console/orders?view=all',
      '/console/orders?view=attention',
      order ? `/console/orders/${order.id}` : null,
      '/console/approvals',
      approval ? `/console/approvals/${approval.id}` : null,
      '/console/customers',
      customer ? `/console/customers/${customer.id}` : null,
      '/console/loyalty',
      '/console/loyalty/counter',
      member ? `/console/loyalty/counter?member=${member.id}` : null,
      '/console/loyalty/members',
      member ? `/console/loyalty/members/${member.id}` : null,
      '/console/loyalty/program',
      '/console/loyalty/rewards',
      '/console/offers',
      offer ? `/console/offers/${offer.id}` : null,
      '/console/offers/new',
      '/console/campaigns',
      campaign ? `/console/campaigns/${campaign.id}` : null,
      '/console/campaigns/new',
      '/console/campaigns/segments',
      '/console/campaigns/flows',
      '/console/reviews',
      '/console/menu',
      '/console/menu/import',
      '/console/qr',
      '/console/delivery',
      '/console/website',
      sitePage ? `/console/website/pages/${sitePage.id}` : null,
      '/console/website/brand',
      '/console/website/media',
      '/console/website/redirects',
      '/console/website/settings',
      '/console/hours',
      '/console/analytics',
      '/console/analytics/marketing',
      '/console/analytics/menu',
      '/console/analytics/customers',
      '/console/analytics/digest',
      '/console/analytics/dictionary',
      '/console/analytics/views',
      '/console/settings/features',
      '/console/settings/connections',
      '/console/settings/assistants',
      '/console/settings/team',
      '/console/settings/screens',
    ].filter((p): p is string => !!p);
    for (const path of paths) {
      const res = await v.page.goto(`${BASE()}${path}`);
      await v.page.waitForLoadState('networkidle');
      if (res && res.status() >= 500) throw new Error(`${path} answered ${res.status()}`);
      findings.push(...(await audit(v.page, path)));
    }
    // A confirmation dialog, open: every console action that matters goes through one.
    await v.page.goto(`${BASE()}/console/settings/features`);
    await v.page.locator('[data-testid^=switch-off-]').first().click();
    await v.page.waitForSelector('dialog[open]');
    findings.push(...(await audit(v.page, '/console/settings/features, confirmation dialog')));
    // And at phone width, where the navigation stacks above the page.
    await v.page.setViewportSize({ width: 390, height: 844 });
    for (const path of ['/console', '/console/orders', '/console/menu', '/console/delivery']) {
      await v.page.goto(`${BASE()}${path}`);
      await v.page.waitForLoadState('networkidle');
      findings.push(...(await audit(v.page, `${path} (phone)`)));
    }
    expect(v.problems).toEqual([]);
    await v.context.close();

    const owner = await newVisitor();
    await signInStaff(owner.page, 'owner@oak-group.test');
    await owner.page.goto(`${BASE()}/console`);
    await chooseVenue(owner.page, 'Oak Group CBD');
    for (const path of ['/console/settings/privacy', '/console/settings/connections', '/console/settings/assistants', '/console/delivery', '/console/campaigns/flows', '/console/analytics/benchmarks', '/console/analytics/settings', '/console/reviews/listings', '/console/reviews/settings', '/console/campaigns/settings']) {
      const res = await owner.page.goto(`${BASE()}${path}`);
      await owner.page.waitForLoadState('networkidle');
      if (res && res.status() >= 500) throw new Error(`${path} answered ${res.status()}`);
      findings.push(...(await audit(owner.page, `${path} (owner)`)));
    }
    expect(owner.problems).toEqual([]);
    await owner.context.close();

    // Signed out: the way in.
    const anon = await newVisitor();
    for (const path of ['/login', '/login?email=someone%40example.com&sent=1']) {
      await anon.page.goto(`${BASE()}${path}`);
      findings.push(...(await audit(anon.page, path)));
    }
    await anon.context.close();
    expect(findings, report(findings)).toEqual([]);
  });

  it('the kitchen screen: pairing, a live board with tickets, the 86 panel and the reject panel', async () => {
    const findings: Finding[] = [];
    const group = await orgBySlug('oak-group');
    const newtown = group.venues.find((x) => x.slug === 'newtown')!;
    const v = await newVisitor();
    await v.page.setViewportSize({ width: 1280, height: 800 });
    await v.page.goto(`${BASE()}/kitchen`);
    await v.page.waitForLoadState('networkidle');
    findings.push(...(await audit(v.page, 'kitchen pairing')));

    await devPost('order', { venueId: newtown.id, guestName: 'Axe Audit', note: 'No onion please' });
    await pairKitchenScreen(v.page, newtown.id, 'A11y screen');
    await v.page.locator('[data-testid=ticket]').first().waitFor({ timeout: 20_000 });
    findings.push(...(await audit(v.page, 'kitchen board')));
    await v.page.screenshot({ path: `${SHOTS}/a11y-kitchen-board.png` });

    await v.page.getByRole('button', { name: '86', exact: true }).click();
    await v.page.locator('[data-item]').first().waitFor();
    findings.push(...(await audit(v.page, 'kitchen 86 panel')));
    await v.page.getByRole('button', { name: 'Close' }).click();

    const reject = v.page.locator('[data-action=reject]:not([disabled])').first();
    if (await reject.count()) {
      await reject.click();
      await v.page.getByRole('dialog').waitFor();
      findings.push(...(await audit(v.page, 'kitchen reject panel')));
      await v.page.getByRole('button', { name: 'Close' }).click();
    }
    await v.context.close();
    expect(findings, report(findings)).toEqual([]);
  });

  it('platform pages: sign-in, overview, tenants, a tenant, onboarding, an onboarding, plugs', async () => {
    const findings: Finding[] = [];
    const diner = await orgBySlug('oak-diner');
    const v = await newVisitor();
    await v.page.goto(`${BASE()}/platform/login`);
    findings.push(...(await audit(v.page, '/platform/login')));
    await signInPlatformOnce(v.page);
    const onboarding = await db().selectFrom('onboardings').select('id').orderBy('created_at', 'desc').executeTakeFirst();
    const paths = ['/platform', '/platform/tenants', `/platform/tenants/${diner.orgId}`, '/platform/onboarding', onboarding ? `/platform/onboarding/${onboarding.id}` : null, onboarding ? `/platform/onboarding/${onboarding.id}/intake/identity` : null, '/platform/plugs'].filter((p): p is string => !!p);
    for (const path of paths) {
      const res = await v.page.goto(`${BASE()}${path}`);
      await v.page.waitForLoadState('networkidle');
      if (res && res.status() >= 500) throw new Error(`${path} answered ${res.status()}`);
      findings.push(...(await audit(v.page, path)));
    }
    // The development tools are pages people use too.
    for (const path of ['/dev', '/dev/inbox']) {
      await v.page.goto(`${BASE()}${path}`);
      await v.page.waitForLoadState('networkidle');
      findings.push(...(await audit(v.page, path)));
    }
    expect(v.problems).toEqual([]);
    await v.context.close();
    expect(findings, report(findings)).toEqual([]);
  });
});
