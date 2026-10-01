import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { Page } from 'playwright';
import { BASE, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff } from './helpers';
import { devPost } from './ops-helpers';

/**
 * The loyalty counter, driven as front of house and a manager would: join a guest up, give a
 * member a reward code, and see the points spent only when a sale carrying that code reaches the
 * ledger from the till. A code can also be cancelled (points freed) or, by a manager, confirmed
 * by hand with a reason when the till never matched it.
 */

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

const run = Date.now().toString(36);

const balanceOf = async (accountId: string) => Number((await db().selectFrom('loyalty_transactions').select(sql<string>`coalesce(sum(points), 0)`.as('n')).where('account_id', '=', accountId).executeTakeFirstOrThrow()).n);

/** A diner member with plenty of points and nothing held, so three $5 codes are affordable. */
async function richMember(orgId: string) {
  const rows = await db()
    .selectFrom('loyalty_accounts as a')
    .innerJoin('loyalty_transactions as t', 't.account_id', 'a.id')
    .innerJoin('customers as c', 'c.id', 'a.customer_id')
    .select(['a.id', 'a.member_code', sql<string>`sum(t.points)`.as('balance')])
    .where('a.org_id', '=', orgId)
    .where('a.status', '=', 'active')
    .where('c.status', '=', 'active')
    .where((eb) => eb.not(eb.exists(eb.selectFrom('redemptions as r').select('r.id').whereRef('r.account_id', '=', 'a.id').where('r.status', '=', 'issued'))))
    .groupBy(['a.id', 'a.member_code'])
    .having(sql<number>`sum(t.points)`, '>=', 3000)
    .orderBy(sql`sum(t.points)`, 'desc')
    .limit(1)
    .execute();
  if (!rows[0]) throw new Error('no fixture member with 3,000 points');
  return { id: rows[0].id, memberCode: rows[0].member_code, balance: Number(rows[0].balance) };
}

async function openMember(page: Page, memberCode: string, accountId: string): Promise<void> {
  await page.goto(`${BASE()}/console/loyalty/counter`);
  await page.selectOption('select[name=by]', 'code');
  await page.fill('[data-testid=lookup-value]', memberCode);
  await page.getByRole('button', { name: 'Look up' }).click();
  await page.waitForURL(new RegExp(`member=${accountId}`));
  await page.locator('[data-testid=counter-balance]').waitFor();
}

const shownBalance = async (page: Page) => Number((await page.textContent('[data-testid=counter-balance]'))!.replace(/\D/g, ''));

/** Press "Give code" on a reward and return the code the database now holds for it. */
async function giveCode(page: Page, accountId: string, reward: string, points: number): Promise<{ id: string; code: string; points: number }> {
  const before = await db().selectFrom('redemptions').select('id').where('account_id', '=', accountId).execute();
  const item = page.locator('li', { hasText: reward }).filter({ has: page.getByRole('button', { name: 'Give code' }) });
  await item.getByRole('button', { name: 'Give code' }).click();
  const issued = await eventually(
    async () => (await db().selectFrom('redemptions').select(['id', 'code', 'points', 'status', 'channel', 'issued_staff_id']).where('account_id', '=', accountId).where('id', 'not in', before.length ? before.map((b) => b.id) : ['00000000-0000-0000-0000-000000000000']).executeTakeFirst()) ?? null,
    `a redemption issued for ${reward}`,
  );
  expect(issued).toMatchObject({ status: 'issued', channel: 'counter', points });
  expect(issued.issued_staff_id).not.toBeNull();
  // The code appears on the counter, waiting for its sale.
  await page.locator('tr', { hasText: issued.code }).waitFor();
  return { id: issued.id, code: issued.code, points: issued.points };
}

const giveFiveDollarCode = (page: Page, accountId: string) => giveCode(page, accountId, '$5 off', 500);

describe('console: the loyalty counter', () => {
  it('front of house joins a guest up at the counter: a customer and a membership, and no marketing consent', async () => {
    const diner = await orgBySlug('oak-diner');
    const email = `counter.join.${run}@example.com`;
    const v = await newVisitor();
    await signInStaff(v.page, 'host@oak-diner.test');
    await v.page.goto(`${BASE()}/console/loyalty/counter`);
    const join = v.page.locator('form', { has: v.page.getByRole('button', { name: 'Join', exact: true }) });
    await join.locator('input[name=firstName]').fill('Casey');
    await join.locator('input[name=lastName]').fill('Counter');
    await join.locator('input[name=email]').fill(email);
    await join.getByRole('button', { name: 'Join', exact: true }).click();
    await v.page.waitForURL(/member=[0-9a-f-]{36}&joined=1/);
    await v.page.getByText('Welcome aboard: Casey Counter is now a member.').waitFor();
    // Neither the email nor a name goes into the address bar: only the membership's id.
    expect(v.page.url()).not.toContain('example.com');

    const customer = await db().selectFrom('customers').select(['id', 'first_name', 'last_name', 'status']).where('org_id', '=', diner.orgId).where('primary_email', '=', email).executeTakeFirstOrThrow();
    expect(customer).toMatchObject({ first_name: 'Casey', last_name: 'Counter', status: 'active' });
    const account = await db().selectFrom('loyalty_accounts').select(['id', 'status', 'enrolled_venue_id']).where('customer_id', '=', customer.id).executeTakeFirstOrThrow();
    expect(account).toMatchObject({ status: 'active', enrolled_venue_id: diner.venueId });
    expect(new URL(v.page.url()).searchParams.get('member')).toBe(account.id);
    // Joining at the counter is not agreeing to marketing: staff cannot give a guest's consent.
    const consents = await db().selectFrom('consents').select(['purpose', 'status']).where('customer_id', '=', customer.id).execute();
    expect(consents.filter((c) => c.status === 'granted')).toEqual([]);

    // The same guest again is recognised, not enrolled twice.
    await v.page.goto(`${BASE()}/console/loyalty/counter`);
    const again = v.page.locator('form', { has: v.page.getByRole('button', { name: 'Join', exact: true }) });
    await again.locator('input[name=email]').fill(email);
    await again.getByRole('button', { name: 'Join', exact: true }).click();
    await v.page.waitForURL(/already=1/);
    await v.page.getByText('was already a member. Nothing was changed.').waitFor();
    expect((await db().selectFrom('loyalty_accounts').select('id').where('customer_id', '=', customer.id).execute()).length).toBe(1);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a reward code holds the points; they are spent when a sale with that code arrives from the till', async () => {
    const diner = await orgBySlug('oak-diner');
    const member = await richMember(diner.orgId);
    const v = await newVisitor();
    await signInStaff(v.page, 'host@oak-diner.test');
    await openMember(v.page, member.memberCode, member.id);
    const available = await shownBalance(v.page);

    const r = await giveFiveDollarCode(v.page, member.id);
    // Held, not spent: the ledger of points is untouched and the counter shows 500 fewer to spend.
    expect(await balanceOf(member.id)).toBe(member.balance);
    await v.page.reload();
    expect(await shownBalance(v.page)).toBe(available - 500);

    // The guest pays at the till; the cashier applies the code as a $5 discount. The sale reaches us by webhook.
    const sale = await devPost<{ paymentId: string; delivery: { status: number } }>('sale', { venueId: diner.venueId, discountCode: r.code, discountCents: 500 });
    expect(sale.delivery.status).toBe(200);
    const redeemed = await eventually(async () => {
      const row = await db().selectFrom('redemptions').select(['status', 'transaction_id', 'redeemed_at', 'redeemed_venue_id', 'forced']).where('id', '=', r.id).executeTakeFirstOrThrow();
      return row.status === 'redeemed' ? row : null;
    }, 'the redemption matched to its sale');
    expect(redeemed).toMatchObject({ redeemed_venue_id: diner.venueId, forced: false });
    const txn = await db().selectFrom('transactions').select(['id', 'external_ref', 'discount_cents']).where('id', '=', redeemed.transaction_id!).executeTakeFirstOrThrow();
    expect(txn).toMatchObject({ external_ref: sale.paymentId, discount_cents: 500 });

    // The burn is one row in the points ledger, tied to the redemption and the sale.
    const burns = await db().selectFrom('loyalty_transactions').select(['kind', 'points', 'redemption_id', 'source_transaction_id']).where('account_id', '=', member.id).where('redemption_id', '=', r.id).execute();
    expect(burns).toEqual([{ kind: 'burn', points: -500, redemption_id: r.id, source_transaction_id: txn.id }]);

    // The same webhook again spends nothing more.
    await devPost('replay', {});
    await new Promise((res) => setTimeout(res, 1500));
    expect((await db().selectFrom('loyalty_transactions').select('id').where('redemption_id', '=', r.id).execute()).length).toBe(1);

    // On the counter the code is gone from the waiting list and the balance is what the ledger says.
    await v.page.reload();
    expect(await v.page.locator('tr', { hasText: r.code }).count()).toBe(0);
    // The sale may also have earned points if the till named the member; the screen follows the ledger either way.
    expect(await shownBalance(v.page)).toBe(await balanceOf(member.id));
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a code is cancelled and its points freed; a manager confirms another by hand with a reason, and front of house cannot', async () => {
    const diner = await orgBySlug('oak-diner');
    const member = await richMember(diner.orgId);
    const host = await newVisitor();
    await signInStaff(host.page, 'host@oak-diner.test');
    await openMember(host.page, member.memberCode, member.id);
    const available = await shownBalance(host.page);
    const toCancel = await giveFiveDollarCode(host.page, member.id);
    // A member holds one live code per reward: the second code is for a different one.
    const toForce = await giveCode(host.page, member.id, 'Free fries', 900);
    await host.page.reload();
    expect(await shownBalance(host.page)).toBe(available - 1400);

    // Front of house may cancel a code but is not offered "confirm by hand".
    expect(await host.page.getByRole('button', { name: 'Confirm by hand' }).count()).toBe(0);
    await host.page.locator('tr', { hasText: toCancel.code }).getByRole('button', { name: 'Cancel' }).click();
    const cancel = host.page.getByRole('dialog', { name: `Cancel code ${toCancel.code}` });
    await cancel.getByText('held for it are free').waitFor();
    await cancel.locator('textarea[name=reason]').fill('Guest changed their mind.');
    await cancel.getByRole('button', { name: 'Cancel code' }).click();
    // The row leaves the list with its dialog: the answer is still said.
    await host.page.getByTestId('console-flash').getByText('Code cancelled. The points are free again.').waitFor();
    const voided = await db().selectFrom('redemptions').select(['status', 'void_reason', 'voided_at']).where('id', '=', toCancel.id).executeTakeFirstOrThrow();
    expect(voided.status).toBe('voided');
    expect(voided.void_reason).toBe('Guest changed their mind.');
    expect((await db().selectFrom('loyalty_transactions').select('id').where('redemption_id', '=', toCancel.id).execute()).length).toBe(0);
    await host.page.reload();
    expect(await shownBalance(host.page)).toBe(available - 900);
    expect(await host.page.locator('tr', { hasText: toCancel.code }).count()).toBe(0);
    expect(host.problems).toEqual([]);
    await host.context.close();

    // The manager: the guest got their $5 off but the till never matched the sale.
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await openMember(v.page, member.memberCode, member.id);
    const before = await balanceOf(member.id);
    await v.page.locator('tr', { hasText: toForce.code }).getByRole('button', { name: 'Confirm by hand' }).click();
    const force = v.page.getByRole('dialog', { name: `Confirm ${toForce.code} by hand` });
    await force.getByText('are spent from their balance now').waitFor();
    // A reason is required: the form will not submit without one.
    await force.getByRole('button', { name: 'Spend the points' }).click();
    expect((await db().selectFrom('redemptions').select('status').where('id', '=', toForce.id).executeTakeFirstOrThrow()).status).toBe('issued');
    const reason = `The till was offline at lunch (${run}).`;
    await force.locator('textarea[name=reason]').fill(reason);
    await force.getByRole('button', { name: 'Spend the points' }).click();
    await v.page.getByTestId('console-flash').getByText('Confirmed by hand. 900 points were spent.').waitFor();

    const forced = await db().selectFrom('redemptions').select(['status', 'forced', 'force_reason', 'redeemed_staff_id', 'transaction_id']).where('id', '=', toForce.id).executeTakeFirstOrThrow();
    expect(forced).toMatchObject({ status: 'redeemed', forced: true, force_reason: reason, transaction_id: null });
    expect(forced.redeemed_staff_id).not.toBeNull();
    expect(await balanceOf(member.id)).toBe(before - 900);
    const audit = await db().selectFrom('audit_log').select(['action', 'actor_kind', 'after']).where('org_id', '=', diner.orgId).where('entity_id', '=', toForce.id).orderBy('occurred_at', 'desc').execute();
    const forcedAudit = audit.find((a) => JSON.stringify(a.after).includes(reason));
    expect(forcedAudit?.actor_kind).toBe('staff');
    await v.page.reload();
    expect(await v.page.locator('tr', { hasText: toForce.code }).count()).toBe(0);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
