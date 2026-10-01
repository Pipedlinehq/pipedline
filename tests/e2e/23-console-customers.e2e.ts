import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identity } from '@ros/modules';
import { configFromEnv } from '@ros/runtime';
import { createTestApp, fakeClock } from '../../packages/testkit/src/app';
import { E2E_CLOCK_START } from './global-setup';
import { BASE, closeBrowser, closeDb, db, newVisitor, orgBySlug, signInStaff } from './helpers';

/**
 * Customers in the console: a host finds a guest and withdraws a consent at the guest's request;
 * a manager and a kitchen role see what their role allows; the owner exports the guest's data and
 * erases them. The guest is made for this file (as a checkout would make them), so the fixture's
 * own guests are left as they were.
 */

const stamp = Date.now();
const email = `ezra.erase.${stamp}@example.com`;
let customerId: string;

beforeAll(async () => {
  const diner = await orgBySlug('oak-diner');
  const t = createTestApp(process.env.E2E_DATABASE_URL!, { clock: fakeClock(new Date(E2E_CLOCK_START)), config: configFromEnv() });
  try {
    const r = await t.app.tenant(diner.orgId, { kind: 'worker', job: 'e2e' }, (ctx) =>
      identity.resolveCustomer(ctx, { hints: [{ kind: 'email', value: email }], via: 'online-order', profile: { firstName: 'Ezra', lastName: `Erase${stamp}` } }),
    );
    customerId = r.customerId!;
    // The guest ticks the marketing box themselves; staff never can.
    await t.app.tenant(diner.orgId, { kind: 'guest', customerId }, (ctx) => identity.grantConsent(ctx, { customerId, purpose: 'marketing_email', source: 'checkout' }));
  } finally {
    await t.close();
  }
});

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

describe('console: customers', () => {
  it('a host finds the guest by email and withdraws their marketing consent at their request', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'host@oak-diner.test');
    await v.page.goto(`${BASE()}/console/customers`);
    await v.page.fill('input[name=q]', email);
    await v.page.getByRole('button', { name: 'Search' }).click();
    await v.page.getByRole('link', { name: `Ezra Erase${stamp}` }).click();
    await v.page.getByRole('heading', { name: `Ezra Erase${stamp}` }).waitFor();

    // A host may not export or erase; those belong to the owner.
    expect(await v.page.getByRole('button', { name: 'Export their data' }).count()).toBe(0);
    expect(await v.page.getByTestId('erase').count()).toBe(0);
    // Staff can withdraw, never grant: the other purposes offer nothing to press.
    expect(await v.page.getByTestId('withdraw-marketing_sms').count()).toBe(0);

    await v.page.getByTestId('withdraw-marketing_email').click();
    const dialog = v.page.getByRole('dialog', { name: /Withdraw/ });
    await dialog.getByText('Only the guest can agree again').waitFor();
    await dialog.locator('textarea[name=reason]').fill('Asked at the counter');
    await dialog.getByRole('button', { name: 'Withdraw consent' }).click();
    // The row re-renders as withdrawn (the dialog goes with the button it belonged to).
    await v.page.getByTestId('consent-marketing_email').getByText(/via staff, at their request/).waitFor();

    const consent = await db().selectFrom('consents').select(['status', 'source', 'source_detail']).where('customer_id', '=', customerId).where('purpose', '=', 'marketing_email').executeTakeFirstOrThrow();
    expect(consent).toEqual({ status: 'revoked', source: 'staff_on_request', source_detail: 'Asked at the counter' });
    const ev = await db().selectFrom('consent_events').select(['action', 'source']).where('customer_id', '=', customerId).where('action', '=', 'revoked').executeTakeFirstOrThrow();
    expect(ev.source).toBe('staff_on_request');
    const audit = await db().selectFrom('audit_log').select(['actor_kind']).where('entity_id', '=', customerId).where('action', '=', 'consent.revoked').executeTakeFirstOrThrow();
    expect(audit.actor_kind).toBe('staff');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a manager edits the guest\'s details but is not offered export or erase; a kitchen role cannot open customers', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/customers/${customerId}`);
    await v.page.fill('textarea[name=allergyNotes]', 'Sesame <script>alert(1)</script>');
    await v.page.getByRole('button', { name: 'Save details' }).click();
    await v.page.getByText('Saved.').waitFor();
    const row = await db().selectFrom('customers').select('allergy_notes').where('id', '=', customerId).executeTakeFirstOrThrow();
    expect(row.allergy_notes).toBe('Sesame <script>alert(1)</script>');
    await v.page.reload();
    await v.page.getByText('Sesame <script>alert(1)</script>').first().waitFor();
    expect(await v.page.getByRole('button', { name: 'Export their data' }).count()).toBe(0);
    expect(await v.page.getByTestId('erase').count()).toBe(0);
    expect(v.problems).toEqual([]);
    await v.context.close();

    const k = await newVisitor();
    await signInStaff(k.page, 'kitchen@oak-diner.test');
    await k.page.goto(`${BASE()}/console/customers/${customerId}`);
    await k.page.getByText('Your role does not include this').waitFor();
    expect(await k.page.getByText(email).count()).toBe(0);
    expect(k.problems).toEqual([]);
    await k.context.close();
  });

  it('the owner exports everything held about the guest, then erases them', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    await v.page.goto(`${BASE()}/console/customers/${customerId}`);
    const [download] = await Promise.all([v.page.waitForEvent('download'), v.page.getByRole('button', { name: 'Export their data' }).click()]);
    const body = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    expect(body.customer.email).toBe(email);
    expect(body.consents.find((c: { purpose: string }) => c.purpose === 'marketing_email').granted).toBe(false);
    expect(await db().selectFrom('audit_log').select('id').where('entity_id', '=', customerId).where('action', '=', 'customer.exported').execute()).toHaveLength(1);

    await v.page.getByTestId('erase').click();
    const dialog = v.page.getByRole('dialog', { name: /Erase/ });
    await dialog.getByText('This cannot be undone').waitFor();
    await dialog.locator('input[name=confirm]').fill('ERASE');
    await dialog.getByRole('button', { name: 'Erase permanently' }).click();
    await v.page.waitForURL(/\/console\/customers\?erased=1/);

    const gone = await db().selectFrom('customers').select(['status', 'primary_email', 'first_name', 'allergy_notes']).where('id', '=', customerId).executeTakeFirstOrThrow();
    expect(gone).toEqual({ status: 'deleted', primary_email: null, first_name: null, allergy_notes: null });
    expect(await db().selectFrom('customer_identities').select('id').where('customer_id', '=', customerId).execute()).toHaveLength(0);
    expect(await db().selectFrom('audit_log').select('actor_kind').where('entity_id', '=', customerId).where('action', '=', 'customer.erased').executeTakeFirstOrThrow()).toEqual({ actor_kind: 'staff' });
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
