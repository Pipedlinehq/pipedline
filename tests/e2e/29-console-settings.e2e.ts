import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { BASE, closeBrowser, closeDb, db, eventually, inbox, newVisitor, orgBySlug, signInStaff } from './helpers';

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

const run = Date.now().toString(36);

/**
 * Confirm the one open dialog by its confirm button. When the change removes the control that
 * opened it (a revoked key has no Revoke button), the refreshed page drops the dialog with it;
 * otherwise the dialog shows the answer. Either way the caller reads the database back.
 */
async function confirmIn(page: Page, button: string, expectText: RegExp): Promise<void> {
  const dialog = page.locator('dialog[open]');
  await dialog.getByRole('button', { name: button }).click();
  await page.waitForFunction(
    (re) => {
      const d = document.querySelector('dialog[open]');
      return !d || new RegExp(re, 'i').test(d.textContent ?? '');
    },
    expectText.source,
  );
  expect(await page.locator('dialog[open] [role=alert]').count()).toBe(0);
}

describe('console settings: keys, team, screens, features', () => {
  it('an owner creates an assistant key: shown once, only its hash stored; then revokes it', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    await v.page.goto(`${BASE()}/console/settings/assistants`);
    const name = `E2E key ${run}`;
    await v.page.fill('input[name=name]', name);
    await v.page.click('button:has-text("Create key")');
    const shown = v.page.getByTestId('new-agent-key');
    await shown.waitFor();
    const key = (await shown.textContent())!.trim();
    expect(key).toMatch(/^ros_agent_[A-Za-z0-9_-]{43}$/);

    const row = await eventually(() => db().selectFrom('agent_keys').selectAll().where('name', '=', name).executeTakeFirst(), 'agent key row');
    expect(Buffer.isBuffer(row.key_hash) && row.key_hash.length).toBe(32);
    const stored = JSON.stringify({ ...row, key_hash: row.key_hash.toString('hex') });
    expect(stored).not.toContain(key.slice('ros_agent_'.length + 8));
    expect(row.key_prefix.length).toBeLessThan(key.length);
    const audited = await db().selectFrom('audit_log').select(['action', 'after']).where('entity_id', '=', row.id).execute();
    expect(audited.map((a) => a.action)).toContain('agent_key.created');
    expect(JSON.stringify(audited)).not.toContain(key.slice(20));

    // Shown once: a reload has no trace of it.
    await v.page.reload();
    await v.page.getByTestId(`agent-key-${name}`).waitFor();
    expect(await v.page.content()).not.toContain(key.slice(20));

    await v.page.getByTestId(`revoke-key-${name}`).click();
    await confirmIn(v.page, 'Revoke key', /Key revoked/);
    await eventually(async () => (await db().selectFrom('agent_keys').select(['revoked_at']).where('id', '=', row.id).executeTakeFirstOrThrow()).revoked_at, 'key revoked');
    await v.page.getByTestId(`agent-key-${name}`).getByText('Revoked').waitFor();
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('an owner invites a team member: staff row, venue role, and the invitation email', async () => {
    const diner = await orgBySlug('oak-diner');
    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    await v.page.goto(`${BASE()}/console/settings/team`);
    const email = `e2e-${run}@oak-diner.test`;
    const form = v.page.getByTestId('invite-form');
    await form.locator('input[name=firstName]').fill('Eddie');
    await form.locator('input[name=lastName]').fill('Endtoend');
    await form.locator('input[name=email]').fill(email);
    await form.locator(`select[name="role:${diner.venueId}"]`).selectOption('host');
    await form.getByRole('button', { name: 'Send invitation' }).click();
    await v.page.getByText(`Invited ${email}`).waitFor();

    const staff = await db().selectFrom('staff').select(['id', 'status', 'org_id', 'is_owner']).where('email', '=', email).executeTakeFirstOrThrow();
    expect(staff).toMatchObject({ status: 'invited', org_id: diner.orgId, is_owner: false });
    const roles = await db().selectFrom('staff_venues').select(['venue_id', 'role']).where('staff_id', '=', staff.id).execute();
    expect(roles).toEqual([{ venue_id: diner.venueId, role: 'host' }]);
    const mail = await eventually(async () => (await inbox(email)).find((m) => /added to/i.test(m.subject ?? '')), 'invitation email');
    expect(mail.body).toContain('/console');
    await v.page.getByTestId(`staff-${email}`).getByText('Invited').waitFor();
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a manager pairs a kitchen screen (code shown once, only a hash stored) and revokes it', async () => {
    const diner = await orgBySlug('oak-diner');
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/settings/screens`);
    const name = `Pass ${run}`;
    await v.page.fill('input[name=name]', name);
    await v.page.click('button:has-text("Get a pairing code")');
    const code = (await v.page.getByTestId('pairing-code').textContent())!.trim();
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    const device = await eventually(() => db().selectFrom('devices').selectAll().where('name', '=', name).executeTakeFirst(), 'device row');
    expect(device).toMatchObject({ venue_id: diner.venueId, purpose: 'kitchen', revoked_at: null });
    expect(device.pairing_code_hash).not.toBeNull();
    expect(JSON.stringify(device)).not.toContain(code);

    await v.page.getByTestId(`revoke-device-${name}`).waitFor();
    await v.page.getByTestId(`revoke-device-${name}`).click();
    await confirmIn(v.page, 'Revoke this screen', /Screen revoked/);
    await eventually(async () => (await db().selectFrom('devices').select(['revoked_at']).where('id', '=', device.id).executeTakeFirstOrThrow()).revoked_at, 'screen revoked');
    const after = await db().selectFrom('devices').select(['revoked_at', 'token_hash']).where('id', '=', device.id).executeTakeFirstOrThrow();
    expect(after.revoked_at).not.toBeNull();
    expect(after.token_hash).toBeNull();
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('switching a feature off at one venue takes its screens away; switching it on brings them back', async () => {
    const group = await orgBySlug('oak-group');
    const bondi = group.venues.find((x) => x.slug === 'bondi')!;
    const state = () => db().selectFrom('venue_modules').select('enabled').where('venue_id', '=', bondi.id).where('module_key', '=', 'offers').executeTakeFirst();
    expect((await state())?.enabled).toBe(true);

    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-group.test');
    await v.page.goto(`${BASE()}/console/settings/features`);
    await Promise.all([v.page.waitForLoadState('networkidle'), v.page.selectOption('#venue-select', { label: 'Oak Group Bondi' })]);
    await v.page.waitForFunction(() => document.body.innerText.includes('What is switched on at Oak Group Bondi'));
    const offersLink = v.page.locator('nav[aria-label=Console] a[href="/console/offers"]');
    expect(await offersLink.count()).toBe(1);

    try {
      await v.page.getByTestId('switch-off-offers').click();
      await confirmIn(v.page, 'Switch it off', /Offers is now off/);
      await eventually(async () => (await state())?.enabled === false, 'offers off at Bondi');
      await v.page.goto(`${BASE()}/console/settings/features`);
      expect(await offersLink.count()).toBe(0);
      await v.page.goto(`${BASE()}/console/offers`);
      expect(await v.page.locator('main').innerText()).toMatch(/switched off|not here/i);
    } finally {
      await v.page.goto(`${BASE()}/console/settings/features`);
      await v.page.getByTestId('switch-on-offers').locator('button').click();
      await eventually(async () => (await state())?.enabled === true, 'offers back on at Bondi');
    }
    await v.page.goto(`${BASE()}/console/settings/features`);
    expect(await offersLink.count()).toBe(1);
    const audited = await db().selectFrom('audit_log').select('after').where('entity_id', '=', `${bondi.id}:offers`).where('action', '=', 'module.set').orderBy('occurred_at', 'desc').limit(2).execute();
    expect(audited.map((a) => (a.after as { enabled: boolean }).enabled)).toEqual([true, false]);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
