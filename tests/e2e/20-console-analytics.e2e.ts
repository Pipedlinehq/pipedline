import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { analytics } from '@ros/modules';
import { BASE, closeBrowser, closeDb, db, newVisitor, orgBySlug, signInStaff } from './helpers';

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

/** Net sales and orders straight from the ledger, by the catalogue's written definition. */
async function ledgerNet(venueIds: string[], from: string, to: string) {
  const r = await sql<{ net: string | null; orders: string }>`
    select sum(coalesce(round((t.total_cents - t.tax_cents - t.tip_cents)::numeric * greatest(t.total_cents - t.refunded_cents, 0) / nullif(t.total_cents, 0)), 0)) as net,
           count(*) as orders
    from transactions t join venues v on v.id = t.venue_id
    where t.venue_id = any(${venueIds}::uuid[])
      and t.status in ('completed', 'refunded', 'partially_refunded')
      and (t.occurred_at at time zone v.timezone)::date between ${from}::date and ${to}::date`.execute(db());
  return { net: Number(r.rows[0]!.net ?? 0), orders: Number(r.rows[0]!.orders) };
}

describe('console analytics: numbers that trace to the ledger', () => {
  it("the overview's headline net sales and orders equal a direct query of the ledger, and say which dates they cover", async () => {
    const diner = await orgBySlug('oak-diner');
    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    await v.page.goto(`${BASE()}/console?period=last_28_days&compare=previous_period`);

    const net = Number(await v.page.getAttribute('[data-testid=kpi-tiles] [data-metric=net_sales]', 'data-value'));
    const orders = Number(await v.page.getAttribute('[data-testid=kpi-tiles] [data-metric=orders]', 'data-value'));
    const prov = v.page.locator('[data-testid=kpi-tiles] ~ [data-testid=provenance]').first();
    const from = (await prov.getAttribute('data-from'))!;
    const to = (await prov.getAttribute('data-to'))!;
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const ledger = await ledgerNet([diner.venueId], from, to);
    expect(ledger.orders).toBeGreaterThan(0);
    expect(net).toBe(ledger.net);
    expect(orders).toBe(ledger.orders);
    // The number on screen is the same number, formatted.
    const shown = await v.page.locator('[data-metric=net_sales]').innerText();
    // The console shows a whole-dollar amount of $1,000 or more without ".00" (ui/format.ts money()).
    const wholeAndLarge = ledger.net % 100 === 0 && Math.abs(ledger.net) >= 100_000;
    expect(shown).toContain(new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: wholeAndLarge ? 0 : 2 }).format(ledger.net / 100));
    // It says where it came from and what it was compared with.
    expect(await prov.innerText()).toMatch(/compared with .* read from/);

    // Today leads, against a like-for-like baseline.
    expect(await v.page.locator('[data-testid=today-summary]').innerText()).toMatch(/^Today to \d{2}:\d{2}:/);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a group owner looking at all venues sees the sum of every venue, from the ledger', async () => {
    const group = await orgBySlug('oak-group');
    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-group.test');
    await v.page.goto(`${BASE()}/console/analytics?period=last_90_days&compare=none&venue=all`);
    const net = Number(await v.page.getAttribute('[data-metric=net_sales]', 'data-value'));
    const prov = v.page.locator('[data-testid=provenance]').first();
    const ledger = await ledgerNet(group.venues.map((x) => x.id), (await prov.getAttribute('data-from'))!, (await prov.getAttribute('data-to'))!);
    expect(net).toBe(ledger.net);
    expect(await prov.innerText()).toContain('Oak Group Bondi');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('every analytics screen opens cleanly, charts switch to their table, and caveats are on the page', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    for (const p of ['/console', '/console/analytics', '/console/analytics/menu?by=category', '/console/analytics/customers', '/console/analytics/marketing?by=creator', '/console/analytics/views', '/console/analytics/benchmarks', '/console/analytics/digest', '/console/analytics/dictionary', '/console/analytics/settings']) {
      const res = await v.page.goto(`${BASE()}${p}`);
      expect(res?.status(), p).toBe(200);
      expect(await v.page.locator('h1').count(), p).toBeGreaterThan(0);
    }
    await v.page.goto(`${BASE()}/console/analytics`);
    const chart = v.page.locator('figure', { hasText: 'Net sales' }).first();
    await chart.getByRole('button', { name: 'Show table' }).click();
    expect(await chart.locator('tbody tr').count()).toBeGreaterThan(0);
    await v.page.goto(`${BASE()}/console`);
    expect(await v.page.locator('details', { hasText: 'Read these numbers with this in mind' }).count()).toBeGreaterThan(0);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('the weekly digest reads as findings, and the dictionary defines every metric and event', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    await v.page.goto(`${BASE()}/console/analytics/digest`);
    const digest = v.page.locator('[data-testid=digest]').first();
    expect(await digest.innerText()).toMatch(/net sales \$[\d,.]+ from \d+ orders/);

    await v.page.goto(`${BASE()}/console/analytics/dictionary`);
    const catalogue = analytics.metricCatalogue();
    expect(await v.page.locator('[data-testid=dictionary-metric]').count()).toBe(catalogue.metrics.length);
    expect(await v.page.locator('[data-testid=dictionary-event]').count()).toBeGreaterThan(10);
    expect(await v.page.locator('main').innerText()).toContain(catalogue.metrics.find((m) => m.key === 'net_sales')!.how_it_is_computed);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a manager saves a question as a pinned view; it appears on the overview; it is stored as the question, not the answer', async () => {
    const diner = await orgBySlug('oak-diner');
    const name = `Tips by daypart ${Date.now()}`;
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/analytics/views?period=last_28_days&compare=previous_period&m=tips&m=net_sales&d=daypart`);
    await v.page.locator('[data-testid=explore-answer]').waitFor();
    await v.page.fill('input[name=name]', name);
    await v.page.check('input[type=checkbox][name=pinned]');
    await v.page.getByRole('button', { name: 'Save view' }).click();
    await v.page.getByText(`Saved as “${name}” and pinned`).waitFor();

    const row = await db().selectFrom('saved_views').select(['id', 'query', 'is_pinned']).where('org_id', '=', diner.orgId).where('name', '=', name).executeTakeFirstOrThrow();
    expect(row.is_pinned).toBe(true);
    expect(row.query).toMatchObject({ metrics: ['tips', 'net_sales'], dimensions: ['daypart'], period: 'last_28_days', compareTo: 'previous_period' });
    const audit = await db().selectFrom('audit_log').select('action').where('entity_id', '=', row.id).execute();
    expect(audit.map((a) => a.action)).toContain('analytics.view_saved');

    await v.page.goto(`${BASE()}/console`);
    expect(await v.page.locator('[data-testid=pinned-view]', { hasText: name }).count()).toBe(1);

    // Tidy up through the UI: delete asks first and says nothing but the view goes.
    await v.page.goto(`${BASE()}/console/analytics/views`);
    const line = v.page.locator('[data-testid=saved-view]', { hasText: name });
    await line.getByRole('button', { name: 'Delete' }).click();
    await v.page.getByRole('dialog').getByRole('button', { name: 'Delete the view' }).click();
    // The row, and its dialog with it, leave the page once the view is gone.
    await line.waitFor({ state: 'detached' });
    expect(await db().selectFrom('saved_views').select('id').where('id', '=', row.id).executeTakeFirst()).toBeUndefined();
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('the export downloads the same answer as a CSV and is recorded', async () => {
    const diner = await orgBySlug('oak-diner');
    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    const q = { metrics: ['net_sales', 'orders'], dimensions: ['channel'], period: 'last_28_days', filters: { venue: diner.venueId } };
    const res = await v.page.request.get(`${BASE()}/console/analytics/export?format=csv&q=${encodeURIComponent(JSON.stringify(q))}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition']).toMatch(/attachment; filename="metrics_/);
    expect(await res.text()).toMatch(/net_sales/);
    const audit = await db().selectFrom('audit_log').select('action').where('org_id', '=', diner.orgId).where('action', '=', 'analytics.exported').execute();
    expect(audit.length).toBeGreaterThan(0);
    await v.context.close();
  });
});
