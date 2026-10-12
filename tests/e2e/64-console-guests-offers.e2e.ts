import { afterAll, describe, expect, it } from 'vitest';
import { BASE, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff } from './helpers';

/**
 * Guests and Offers, wave 2 (docs/CONSOLE_IA.md section 9, patterns 5 and 6): a manager builds a
 * guest list with the condition picker and with words, counts it and saves it; creates an offer
 * for that list whose summary the server writes; sets a Sunday surcharge and is refused a card
 * surcharge. Every write is read back from the database.
 */

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

const run = Date.now().toString(36);

describe('console: guest lists, offers and surcharges', () => {
  it('a manager builds a guest list from conditions, counts it, saves it, then rewrites it in words', async () => {
    const diner = await orgBySlug('oak-diner');
    const name = `Lapsed emailers ${run}`;
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');

    // The default lists are there, built in, and cannot be deleted.
    await v.page.goto(`${BASE()}/console/customers/lists`);
    await v.page.getByRole('heading', { name: 'Guest lists' }).waitFor();
    const rows = v.page.locator('[data-testid=guest-list-row]');
    expect(await rows.count()).toBeGreaterThanOrEqual(5);
    for (const built of ['Regulars', 'New this month', 'Said yes to email', 'Lapsed 60+ days', 'Big spenders']) {
      expect(await rows.filter({ hasText: built }).first().getByText('Built in').count()).toBe(1);
    }
    await rows.filter({ hasText: 'Lapsed 60+ days' }).first().getByRole('link', { name: 'Lapsed 60+ days' }).click();
    await v.page.getByTestId('list-rule').waitFor();
    expect(await v.page.getByTestId('delete-list').count()).toBe(0);
    expect(await v.page.getByTestId('list-rule').innerText()).toContain('last visit more than 60 days ago');

    // The builder: last visit more than 60 days ago, and said yes to email.
    await v.page.goto(`${BASE()}/console/customers/lists/new`);
    await v.page.fill('input[name=name]', name);
    const first = v.page.locator('[data-testid=list-condition]').nth(0);
    await first.getByLabel('Operator').selectOption('more_than_days_ago');
    await first.getByLabel('Days').fill('60');
    await v.page.getByRole('button', { name: 'Add a condition' }).click();
    const second = v.page.locator('[data-testid=list-condition]').nth(1);
    await second.getByLabel('Field').selectOption('email_yes');
    expect(await v.page.getByTestId('list-text').innerText()).toContain('last visit more than 60 days ago and said yes to email is yes');
    await v.page.getByTestId('list-preview').click();
    await v.page.getByTestId('list-count').waitFor();
    expect(await v.page.getByTestId('list-count').innerText()).toMatch(/\d[\d,]* guests match across the organisation/);
    await v.page.getByRole('button', { name: 'Create list' }).click();
    await v.page.waitForURL(/\/console\/customers\/lists\/[0-9a-f-]{36}\?created=1/);

    const seg = await db().selectFrom('segments').select(['id', 'definition', 'is_system', 'org_id']).where('org_id', '=', diner.orgId).where('name', '=', name).executeTakeFirstOrThrow();
    expect(seg).toMatchObject({ definition: { query: 'last visit more than 60 days ago and said yes to email is yes' }, is_system: false });
    expect(v.page.url()).toContain(seg.id);
    expect(await v.page.getByTestId('list-rule').innerText()).toContain('Guests who last visit was more than 60 days ago and said yes to email');
    await v.page.getByTestId('list-counts').waitFor();
    expect(await v.page.getByTestId('list-usage').innerText()).toContain('Nothing uses this list yet');

    // The same list in words: check the wording, then save.
    await v.page.getByTestId('list-mode-text').click();
    const box = v.page.getByTestId('list-text-input');
    expect(await box.inputValue()).toBe('last visit more than 60 days ago and said yes to email is yes');
    await box.fill('(spend more than $500 or visits more than 10) and said yes to email');
    await v.page.getByTestId('list-parse').click();
    await v.page.getByTestId('list-parsed').waitFor();
    expect(await v.page.getByTestId('list-parsed').innerText()).toContain('Guests who (have spent more than $500, or have more than 10 visits) and said yes to email');
    await v.page.getByRole('button', { name: 'Save list' }).click();
    await eventually(async () => {
      const row = await db().selectFrom('segments').select('definition').where('id', '=', seg.id).executeTakeFirstOrThrow();
      return JSON.stringify(row.definition) === JSON.stringify({ query: '(spend more than $500 or visits more than 10) and said yes to email is yes' });
    }, 'the list rewritten in words');
    // A rule the grammar refuses is refused in place, and the row is unchanged.
    await box.fill('visits > 10');
    await v.page.getByTestId('list-parse').click();
    await v.page.getByTestId('list-parse-error').waitFor();
    expect(await v.page.getByTestId('list-parse-error').innerText()).toContain('I do not understand ">"');
    const audits = await db().selectFrom('audit_log').select('action').where('entity_id', '=', seg.id).orderBy('occurred_at').execute();
    expect(audits.map((a) => a.action)).toEqual(['segment.created', 'segment.updated']);

    // The Customers index can show the list's guests as a view.
    await v.page.goto(`${BASE()}/console/customers?view=all&f=1&list=${seg.id}`);
    await v.page.getByTestId('views-customers').waitFor();
    expect(await v.page.getByTestId('view-tokens').innerText()).toContain(name);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a manager creates an automatic offer for a guest list; the summary is written by the server and the views place it', async () => {
    const diner = await orgBySlug('oak-diner');
    const name = `Tuesday pasta night ${run}`;
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/offers/new`);
    await v.page.fill('input[name=name]', name);
    await v.page.selectOption('select[name=method]', 'automatic');
    await v.page.selectOption('select[name=discountKind]', 'percent');
    await v.page.fill('input[name=percentOff]', '15');
    await v.page.selectOption('select[name=appliesTo]', 'category');
    await v.page.fill('input[name=category]', 'Mains');
    await v.page.selectOption('select[name=audience]', 'list');
    const lapsed = await v.page.locator('select[name=segmentId] option', { hasText: 'Lapsed 60+ days' }).first().getAttribute('value');
    await v.page.selectOption('select[name=segmentId]', lapsed!);
    for (const d of ['2', '3', '4']) await v.page.check(`input[name=days][value="${d}"]`);
    await v.page.fill('input[name=services]', 'dinner');
    await v.page.fill('input[name=endsAt]', '2026-11-30T22:00');
    await v.page.fill('input[name=perGuestLimit]', '1');
    await v.page.getByRole('button', { name: 'Create offer' }).click();
    await v.page.waitForURL(/\/console\/offers\/[0-9a-f-]{36}\?created=1/);

    const offer = await db()
      .selectFrom('offers')
      .select(['id', 'method', 'applies_to', 'category', 'audience', 'segment_id', 'days', 'services', 'per_guest_limit', 'ends_at', 'is_active'])
      .where('org_id', '=', diner.orgId)
      .where('name', '=', name)
      .executeTakeFirstOrThrow();
    expect(offer).toMatchObject({ method: 'automatic', applies_to: 'category', category: 'Mains', audience: 'list', segment_id: lapsed, days: [2, 3, 4], services: ['dinner'], per_guest_limit: 1, is_active: true });
    expect(offer.ends_at).not.toBeNull();
    expect(v.page.url()).toContain(offer.id);
    expect(await v.page.getByTestId('offer-summary').innerText()).toBe('15% off any main for Lapsed 60+ days, Tuesday to Thursday dinner, until 30 Nov, one per guest, applied automatically, not with other offers');

    // Views: it is Active now; switched off it moves to Switched off.
    await v.page.goto(`${BASE()}/console/offers`);
    await v.page.getByTestId('views-offers').waitFor();
    await v.page.locator(`[data-testid=offer-${offer.id}]`).waitFor();
    expect(await v.page.locator(`[data-testid=offer-${offer.id}]`).getAttribute('data-status')).toBe('active');
    await v.page.goto(`${BASE()}/console/offers?view=scheduled`);
    await v.page.getByTestId('views-offers').waitFor();
    expect(await v.page.locator(`[data-testid=offer-${offer.id}]`).count()).toBe(0);
    await v.page.goto(`${BASE()}/console/offers/${offer.id}`);
    await v.page.getByRole('button', { name: 'Switch off' }).click();
    await eventually(async () => (await db().selectFrom('offers').select('is_active').where('id', '=', offer.id).executeTakeFirstOrThrow()).is_active === false, 'the offer switched off');
    await v.page.goto(`${BASE()}/console/offers?view=off`);
    await v.page.locator(`[data-testid=offer-${offer.id}]`).waitFor();
    const audits = await db().selectFrom('audit_log').select('action').where('entity_id', '=', offer.id).orderBy('occurred_at').execute();
    expect(audits.map((a) => a.action)).toEqual(['offer.created', 'offer.switched']);
    // The list says the offer uses it.
    await v.page.goto(`${BASE()}/console/customers/lists/${lapsed}`);
    await v.page.getByTestId('list-usage').waitFor();
    expect(await v.page.getByTestId('list-usage').innerText()).toContain(name);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a manager sets a Sunday surcharge with the legal line, and a card surcharge is refused with the date of the ban', async () => {
    const diner = await orgBySlug('oak-diner');
    const name = `Sunday surcharge ${run}`;
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/offers/surcharges`);
    await v.page.getByRole('heading', { name: 'Surcharges' }).waitFor();
    expect(await v.page.getByTestId('card-surcharge-note').innerText()).toContain('1 October 2026');

    await v.page.fill('input[name=name]', name);
    await v.page.selectOption('select[name=kind]', 'sunday');
    await v.page.fill('input[name=percent]', '10');
    await v.page.getByRole('button', { name: 'Add surcharge' }).click();
    await v.page.getByText('A surcharge of 10% applies on Sundays.').first().waitFor();
    const row = await eventually(() => db().selectFrom('surcharges').select(['id', 'kind', 'percent_bp', 'venue_id', 'is_active']).where('org_id', '=', diner.orgId).where('name', '=', name).executeTakeFirst(), 'the surcharge row');
    expect(row).toMatchObject({ kind: 'sunday', percent_bp: 1000, venue_id: diner.venueId, is_active: true });
    await v.page.reload();
    await v.page.locator('[data-testid=surcharge-row]', { hasText: name }).waitFor();
    expect(await v.page.getByTestId('surcharge-menu-line').innerText()).toContain('A surcharge of 10% applies on Sundays.');

    // A card surcharge: refused in plain words, nothing saved.
    await v.page.fill('input[name=name]', `Card surcharge ${run}`);
    await v.page.selectOption('select[name=kind]', 'days');
    await v.page.check('input[name=days][value="5"]');
    await v.page.fill('input[name=percent]', '1.5');
    await v.page.getByRole('button', { name: 'Add surcharge' }).click();
    await v.page.getByText(/From 1 October 2026 a business in Australia may not add a surcharge for paying by eftpos, Mastercard or Visa/).waitFor();
    expect(await db().selectFrom('surcharges').select('id').where('org_id', '=', diner.orgId).where('name', '=', `Card surcharge ${run}`).execute()).toEqual([]);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
