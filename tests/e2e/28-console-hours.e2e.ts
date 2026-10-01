import { afterAll, describe, expect, it } from 'vitest';
import { BASE, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff } from './helpers';

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

describe('console: hours', () => {
  it('a manager adds a closure for a date, it is stored and audited, and removing it restores the weekly hours', async () => {
    const { venueId } = await orgBySlug('oak-diner');
    // A date in 2027 unlikely to be taken, different on each run.
    const day = new Date(Date.UTC(2027, 0, 1) + (Date.now() % 300) * 86_400_000).toISOString().slice(0, 10);
    const reason = `E2E private event ${Date.now().toString(36)}`;

    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/hours`);
    await v.page.fill('input[type=date][name=date]', day);
    await v.page.selectOption('select[name=mode]', 'closed');
    await v.page.fill('input[name=reason]', reason);
    await v.page.getByRole('button', { name: 'Add exception' }).click();
    await v.page.getByText(`${day}: closed.`).waitFor();

    const row = await db().selectFrom('hour_exceptions').select(['closed', 'opens_at', 'closes_at', 'reason']).where('venue_id', '=', venueId).where('date', '=', day).executeTakeFirstOrThrow();
    expect(row).toEqual({ closed: true, opens_at: null, closes_at: null, reason });
    const audit = await db().selectFrom('audit_log').select(['actor_kind', 'after']).where('action', '=', 'hours.exception_set').where('venue_id', '=', venueId).orderBy('occurred_at', 'desc').executeTakeFirstOrThrow();
    expect(audit.actor_kind).toBe('staff');
    expect(JSON.stringify(audit.after)).toContain(day);

    const listed = v.page.getByTestId(`exception-${day}`);
    await listed.getByText(reason).waitFor();
    await listed.getByRole('button', { name: 'Remove' }).click();
    await eventually(async () => !(await db().selectFrom('hour_exceptions').select('date').where('venue_id', '=', venueId).where('date', '=', day).executeTakeFirst()), 'the exception removed');
    await v.page.getByTestId(`exception-${day}`).waitFor({ state: 'detached' });
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('opening hours for a date need both times, and the page says so', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/hours`);
    await v.page.fill('input[type=date][name=date]', '2027-12-30');
    await v.page.selectOption('select[name=mode]', 'open');
    await v.page.getByRole('button', { name: 'Add exception' }).click();
    await v.page.getByRole('alert').filter({ hasText: 'Give opening and closing times' }).waitFor();
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('front-of-house staff cannot reach the hours editor', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'host@oak-diner.test');
    expect(await v.page.getByRole('link', { name: 'Hours' }).count()).toBe(0);
    await v.page.goto(`${BASE()}/console/hours`);
    await v.page.getByText('Your role does not include this').waitFor();
    expect(await v.page.getByRole('button', { name: 'Save weekly hours' }).count()).toBe(0);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
