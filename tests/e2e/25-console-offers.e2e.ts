import { afterAll, describe, expect, it } from 'vitest';
import { BASE, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff } from './helpers';

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

describe('console: offers', () => {
  it('a manager creates an offer and issues a code; both rows are in the database and the code is listed', async () => {
    const { orgId } = await orgBySlug('oak-diner');
    const tag = Date.now().toString(36).toUpperCase().slice(-5);
    const name = `E2E lunch voucher ${tag}`;
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');

    await v.page.goto(`${BASE()}/console/offers`);
    await v.page.getByRole('link', { name: 'New offer' }).click();
    await v.page.waitForURL(/\/console\/offers\/new$/);
    await v.page.fill('input[name=name]', name);
    await v.page.selectOption('select[name=kind]', 'voucher');
    await v.page.selectOption('select[name=discountKind]', 'fixed');
    await v.page.fill('input[name=value]', '7.50');
    await v.page.fill('input[name=minSpend]', '20');
    await v.page.fill('input[name=codePrefix]', `E${tag}`);
    await v.page.uncheck('input[name=requiresClaim]');
    await v.page.getByRole('button', { name: 'Create offer' }).click();
    await v.page.waitForURL(/\/console\/offers\/[0-9a-f-]{36}\?created=1/);

    const offer = await db()
      .selectFrom('offers')
      .select(['id', 'kind', 'value_cents', 'min_spend_cents', 'code_prefix', 'requires_claim', 'is_active'])
      .where('org_id', '=', orgId)
      .where('name', '=', name)
      .executeTakeFirstOrThrow();
    expect(offer).toMatchObject({ kind: 'voucher', value_cents: 750, min_spend_cents: 2000, code_prefix: `E${tag}`, requires_claim: false, is_active: true });
    expect(v.page.url()).toContain(offer.id);
    const created = await db().selectFrom('audit_log').select('id').where('action', '=', 'offer.created').where('entity_id', '=', offer.id).execute();
    expect(created).toHaveLength(1);

    await v.page.getByRole('button', { name: 'Issue a code' }).click();
    const message = await v.page.getByText(/^Code \S+ issued/).textContent();
    const code = message!.match(/^Code (\S+) issued/)![1]!;
    expect(code.startsWith(`E${tag}`)).toBe(true);

    const row = await eventually(() => db().selectFrom('offer_codes').select(['offer_id', 'status', 'source', 'customer_id']).where('code', '=', code).executeTakeFirst(), 'the issued code row');
    expect(row).toMatchObject({ offer_id: offer.id, status: 'claimed', source: 'staff', customer_id: null });

    await v.page.reload();
    await v.page.locator('[data-testid=codes]').getByRole('cell', { name: code, exact: true }).waitFor();
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('read-only staff see the offers but no way to create one', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'accounts@oak-group.test');
    await v.page.goto(`${BASE()}/console/offers`);
    await v.page.getByRole('heading', { name: 'Offers' }).waitFor();
    expect(await v.page.getByRole('link', { name: 'New offer' }).count()).toBe(0);
    await v.page.goto(`${BASE()}/console/offers/new`);
    await v.page.getByText('Your role does not include this').waitFor();
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
