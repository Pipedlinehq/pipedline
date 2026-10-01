import { afterAll, describe, expect, it } from 'vitest';
import { BASE, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff } from './helpers';

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

/** A member of the single-venue fixture with a phone number, for lookups and adjustments. */
async function dinerMember() {
  const { orgId } = await orgBySlug('oak-diner');
  return db()
    .selectFrom('loyalty_accounts as a')
    .innerJoin('customers as c', 'c.id', 'a.customer_id')
    .select(['a.id', 'c.primary_phone'])
    .where('a.org_id', '=', orgId)
    .where('a.status', '=', 'active')
    .where('c.status', '=', 'active')
    .where('c.primary_phone', 'is not', null)
    .orderBy('a.enrolled_at')
    .executeTakeFirstOrThrow();
}

describe('console: loyalty', () => {
  it('a manager adjusts a member\'s points with a reason; the points ledger and the audit log both record it', async () => {
    const member = await dinerMember();
    const reason = `E2E goodwill for a cold coffee ${Date.now()}`;
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/loyalty/members/${member.id}`);
    const before = Number((await v.page.textContent('[data-testid=member-balance]'))!.replace(/\D/g, ''));

    await v.page.click('[data-testid=adjust-points]');
    const dialog = v.page.locator('dialog[open]');
    await dialog.locator('select[name=direction]').selectOption('add');
    await dialog.locator('input[name=points]').fill('37');
    expect(await dialog.locator('[data-testid=adjust-preview]').textContent()).toContain(`to ${(before + 37).toLocaleString('en-AU')}`);
    await dialog.locator('textarea[name=reason]').fill(reason);
    await dialog.getByRole('button', { name: 'Make the adjustment' }).click();
    await dialog.getByText(/The balance is now/).waitFor();

    const row = await eventually(
      () => db().selectFrom('loyalty_transactions').select(['kind', 'points', 'note', 'venue_id']).where('account_id', '=', member.id).where('note', '=', reason).executeTakeFirst(),
      'the adjustment in the points ledger',
    );
    expect(row).toMatchObject({ kind: 'adjust', points: 37 });
    const audit = await db()
      .selectFrom('audit_log')
      .select(['actor_kind', 'after'])
      .where('action', '=', 'loyalty.points_adjusted')
      .where('entity_id', '=', member.id)
      .orderBy('occurred_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit.actor_kind).toBe('staff');
    expect(JSON.stringify(audit.after)).toContain(reason);

    // Once the dialog is closed the page shows the new balance.
    await v.page.reload();
    expect(Number((await v.page.textContent('[data-testid=member-balance]'))!.replace(/\D/g, ''))).toBe(before + 37);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('front of house finds a member at the counter but has no way to adjust points', async () => {
    const member = await dinerMember();
    const v = await newVisitor();
    await signInStaff(v.page, 'host@oak-diner.test');

    // No member list and no programme settings for this role.
    await v.page.goto(`${BASE()}/console/loyalty`);
    expect(await v.page.getByRole('link', { name: 'Members' }).count()).toBe(0);
    expect(await v.page.getByRole('link', { name: 'Programme and tiers' }).count()).toBe(0);
    await v.page.goto(`${BASE()}/console/loyalty/members`);
    await v.page.getByText('Your role does not include this').waitFor();

    // The counter: look the guest up by the phone number they give.
    await v.page.goto(`${BASE()}/console/loyalty/counter`);
    await v.page.selectOption('select[name=by]', 'phone');
    await v.page.fill('[data-testid=lookup-value]', member.primary_phone!);
    await v.page.getByRole('button', { name: 'Look up' }).click();
    await v.page.waitForURL(new RegExp(`member=${member.id}`));
    await v.page.locator('[data-testid=counter-balance]').waitFor();
    // The phone number never goes into the address bar.
    expect(v.page.url()).not.toContain(member.primary_phone!.replace('+', ''));

    // The member's record is readable, but the adjustment control is not there.
    await v.page.goto(`${BASE()}/console/loyalty/members/${member.id}`);
    await v.page.locator('[data-testid=member-balance]').waitFor();
    expect(await v.page.locator('[data-testid=adjust-points]').count()).toBe(0);

    const host = await db().selectFrom('staff').select('id').where('email', '=', 'host@oak-diner.test').executeTakeFirstOrThrow();
    const byHost = await db().selectFrom('audit_log').select('id').where('action', '=', 'loyalty.points_adjusted').where('actor_id', '=', host.id).execute();
    expect(byHost).toEqual([]);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
