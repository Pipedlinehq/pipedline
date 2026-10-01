import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { simPosToken } from '@ros/adapters';
import { useTestEnv } from '@ros/testkit';
import { analytics, ledger, tenancy } from '@ros/modules';
import { type SimulatedHistory, simulateHistory, tenantZeroAcceptance } from '../../../../scripts/tenant-zero';

/**
 * The tenant-zero acceptance script , run against the simulated POS with a
 * simulated history shaped like a Saturday butcher's. It must pass on a clean ingest, and it
 * must fail, saying where, when the ledger and the provider disagree, when a raw card
 * identifier is stored, and when another org can read a row.
 */
describe('tenant zero: the acceptance script against a simulated history', () => {
  const t = useTestEnv();
  const WORKER = { kind: 'worker' as const, job: 'test' };
  const ACCOUNT = 'simpos-acct-tenant-zero';
  const LOCATION = 'simpos-loc-tenant-zero';
  const CARD_SALES = 1000;
  let orgId = '';
  let venueId = '';
  let history: SimulatedHistory;

  const run = (over: Partial<Parameters<typeof tenantZeroAcceptance>[1]> = {}) => tenantZeroAcceptance(t.app, { org: 'tenant-zero-test', months: 16, ...over });

  it('passes on a clean back-fill: totals to the cent, nothing changed by a second ingest, the Saturday share, no card identifier, no leak', async () => {
    const made = await t.app.platform('test: a fresh org for tenant zero', (pctx) =>
      tenancy.createOrg(pctx, { slug: 'tenant-zero-test', legalName: 'Tenant Zero Pty Ltd', tradingName: 'Tenant Zero Meats', owner: { email: 'owner@tenant-zero.test', firstName: 'Owen' }, venue: { name: 'Tenant Zero Meats' } }),
    );
    orgId = made.orgId;
    venueId = made.venueId;
    await t.app.tenant(orgId, WORKER, (ctx) =>
      ledger.connectPos(ctx, { plugKey: 'sim-pos', venueId, externalAccountId: ACCOUNT, locationRef: LOCATION, credentials: { accessToken: simPosToken(ACCOUNT), webhookSecret: 'whsec-tenant-zero' }, backfillMonths: 0 }),
    );
    history = simulateHistory(t.sim.pos, { accountRef: ACCOUNT, locationRef: LOCATION, cardSales: CARD_SALES, months: 16, now: t.clock(), timezone: 'Australia/Sydney', saturdayShare: 0.959 });
    expect(history).toMatchObject({ cardSales: CARD_SALES, cashSales: 20 });
    const providerSays = t.sim.pos.totals({ accountRef: ACCOUNT, locationRef: LOCATION });
    const listBefore = t.sim.pos.calls.listTransactions;

    const report = await run({ expect: { cardCount: CARD_SALES, weekdayShare: { saturday: 0.959 }, shareTolerance: 0.03 } });
    expect(report.text).toContain('RESULT: PASS. Every check passed.');
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => [c.key, c.ok])).toEqual([
      ['connection', true],
      ['backfill', true],
      ['totals', true],
      ['idempotent', true],
      ['weekday_share', true],
      ['card_identifiers', true],
      ['isolation', true],
    ]);

    // The ledger holds what the provider holds, counted by this test from the database itself.
    // Sales made through this platform's own application that it holds no order for are real
    // sales and are counted (only one whose order is in the ledger is left to the ordering module).
    const sales = CARD_SALES + history.cashSales + history.platformSales;
    expect(report.numbers.provider.sales).toBe(sales);
    expect(report.numbers.ledger).toEqual(report.numbers.provider);
    expect(report.numbers.ledger.cardSales).toBe(CARD_SALES + history.platformSales);
    const inDb = await t.db.selectFrom('transactions').select((eb) => [eb.fn.countAll<number>().as('n'), eb.fn.sum<number>('total_cents').as('total')]).where('org_id', '=', orgId).executeTakeFirstOrThrow();
    expect(Number(inDb.n)).toBe(sales);
    expect(Number(inDb.total)).toBe(report.numbers.ledger.totalCents);
    expect(report.numbers.ledger.totalCents).toBe(providerSays.totalCents);
    expect(report.numbers.gaps).toEqual({ missing: 0, different: 0, extra: 0, explained: history.voided });
    expect(report.text).toContain('not counted: it was cancelled before it was ever a sale');

    // The first run wrote every sale; the second wrote none.
    expect(report.numbers.firstRun.created).toBe(sales);
    expect(report.numbers.secondRun).toMatchObject({ created: 0, changed: 0 });
    // (The rolling sync re-reads its overlap, so a few sales are seen, unchanged, twice.)
    expect(report.numbers.secondRun.unchanged).toBeGreaterThanOrEqual(sales);
    // Read-only towards the provider: it was only ever asked to list sales.
    expect(t.sim.pos.calls.listTransactions).toBeGreaterThan(listBefore);
    expect(t.sim.pos.calls).toMatchObject({ pushOrder: 0, applyDiscount: 0 });

    // Saturday carries the revenue, and the shares add up.
    expect(report.numbers.weekdayShare.saturday).toBeGreaterThan(0.92);
    expect(Object.values(report.numbers.weekdayShare).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9);
    // Every card sale carried a fingerprint and an account reference; the search knew them all and found none.
    expect(report.numbers.cardSearch.identifiersKnown).toBeGreaterThanOrEqual(CARD_SALES * 2);
    expect(report.numbers.cardSearch).toMatchObject({ hits: 0 });
    expect(report.numbers.cardSearch.columns).toBeGreaterThan(150);
    // Both fixture orgs, and an org that does not exist, looked for its rows.
    expect(report.numbers.isolation).toMatchObject({ orgsProbed: 3, leaks: 0 });
    // The report never shows a card identifier or a guest's address.
    expect(report.text).not.toMatch(/sim-fp-|sim-par-|@history\.example/);
  }, 240_000);

  it('fails, naming the sale, when the ledger holds a sale the provider does not', async () => {
    await t.app.tenant(orgId, WORKER, (ctx) =>
      ledger.recordTransaction(
        ctx,
        { source: 'sim', externalRef: 'ghost-sale-1', occurredAt: new Date(t.clock().getTime() - 3 * 86_400_000), channel: 'retail', status: 'completed', subtotalCents: 12345, discountCents: 0, taxCents: 1122, tipCents: 0, totalCents: 12345, refundedCents: 0, currency: 'AUD', tenderType: 'card', lines: [], identityHints: [] },
        { venueId },
      ),
    );
    const report = await run();
    expect(report.ok).toBe(false);
    const totals = report.checks.find((c) => c.key === 'totals')!;
    expect(totals.ok).toBe(false);
    expect(report.numbers.gaps).toMatchObject({ missing: 0, extra: 1 });
    expect(report.numbers.ledger.sales - report.numbers.provider.sales).toBe(1);
    expect(totals.lines.join('\n')).toMatch(/In the ledger, not at the provider \(1\):\n\s+ghost-sale-1 .* ledger \$123\.45 completed {2}provider: absent/);
    expect(totals.lines).toContain('Difference: 1 sales, $123.45');
    // The weekday figures no longer match the provider's either, and it says which day.
    expect(report.checks.find((c) => c.key === 'weekday_share')!.ok).toBe(false);
    expect(report.text).toMatch(/RESULT: FAIL\. 2 of 7 checks failed/);
    // A known figure the ledger does not reach is a failure too.
    await sql`delete from transaction_attributions where transaction_id in (select id from transactions where external_ref = 'ghost-sale-1')`.execute(t.db);
    await t.db.deleteFrom('transactions').where('org_id', '=', orgId).where('external_ref', '=', 'ghost-sale-1').execute();
    // The sale was removed behind the ledger's back (a test-only delete), so the derived facts are rebuilt from it.
    await analytics.backfill(t.app, orgId);
    const short = await run({ expect: { cardCount: CARD_SALES * 2, totalCents: 1 } });
    expect(short.checks.find((c) => c.key === 'totals')!.ok).toBe(false);
    expect(short.checks.find((c) => c.key === 'totals')!.lines.filter((l) => l.includes('OUTSIDE'))).toHaveLength(2);
  }, 240_000);

  it('fails when a raw card identifier is stored anywhere, by value or by key, without printing it', async () => {
    const card = t.sim.pos.sales({ accountRef: ACCOUNT, locationRef: LOCATION }).find((p) => p.card_details)!.card_details!.card;
    const customer = await t.db.selectFrom('customers').select('id').where('org_id', '=', orgId).limit(1).executeTakeFirstOrThrow();
    await t.db.updateTable('customers').set({ notes: `Paid with card ${card.fingerprint} last time.` }).where('id', '=', customer.id).execute();
    await t.db.insertInto('audit_log').values({ org_id: orgId, actor_kind: 'worker', action: 'test.planted', entity_type: 'test', after: JSON.stringify({ payment: { card: { payment_account_reference: 'anything' } } }) as never }).execute();

    const report = await run();
    expect(report.ok).toBe(false);
    const check = report.checks.find((c) => c.key === 'card_identifiers')!;
    expect(check.ok).toBe(false);
    expect(check.lines).toContain('  FOUND  customers.notes: 1 raw card identifier(s) found');
    expect(check.lines).toContain('  FOUND  audit_log.after: 1 row(s) hold a card-identifier key');
    expect(report.numbers.cardSearch.hits).toBe(2);
    expect(report.text).not.toContain(card.fingerprint);
    // Everything else still passes: the failure is this check alone.
    expect(report.checks.filter((c) => !c.ok).map((c) => c.key)).toEqual(['card_identifiers']);

    await t.db.updateTable('customers').set({ notes: null }).where('id', '=', customer.id).execute();
    await t.db.deleteFrom('audit_log').where('action', '=', 'test.planted').execute();
  }, 240_000);

  it('fails when another org can read a row of this one', async () => {
    // Take row-level security off one table, as a migration that forgot it would.
    await sql`alter table transaction_lines disable row level security`.execute(t.db);
    try {
      const report = await run();
      const check = report.checks.find((c) => c.key === 'isolation')!;
      expect(check.ok).toBe(false);
      expect(check.lines.some((l) => /LEAK {2}org "oak-diner" can read [\d,]+ row\(s\) of transaction_lines/.test(l))).toBe(true);
      expect(check.lines.some((l) => l.includes('an org id that names no org can read'))).toBe(true);
      expect(report.ok).toBe(false);
    } finally {
      await sql`alter table transaction_lines enable row level security`.execute(t.db);
    }
    expect((await run()).ok).toBe(true);
  }, 240_000);

  it('refuses an org it cannot find, or one with no connected point of sale', async () => {
    await expect(run({ org: 'no-such-org' })).rejects.toThrow('No org "no-such-org" in this database.');
    await t.db.updateTable('connections').set({ status: 'revoked' }).where('org_id', '=', orgId).execute();
    await expect(run()).rejects.toThrow('has no connected point of sale');
  });
});
