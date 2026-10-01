import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { useTestEnv } from '@ros/testkit';
import { loyalty, offers } from '@ros/modules';
import { WORKER } from './helpers';

/** What the fixture seeder (packages/fixtures/src/seeders/30-loyalty-offers.ts) leaves behind, read back. */
describe('loyalty and offers fixtures', () => {
  const t = useTestEnv();
  const orgs = () => [t.fixture.diner, t.fixture.group];

  it('both orgs have a programme with tiers and rewards, switched on at every venue, and a realistic share of customers enrolled', async () => {
    for (const org of orgs()) {
      const program = await t.app.tenant(org.orgId, WORKER, (ctx) => loyalty.getProgramSettings(ctx));
      expect(program).toMatchObject({ isActive: true, pointsPerDollar: 5 });
      expect(program!.tiers.map((x) => x.name)).toEqual(['Bronze', 'Silver', 'Gold']);
      expect((await t.app.tenant(org.orgId, WORKER, (ctx) => loyalty.listRewards(ctx))).length).toBeGreaterThanOrEqual(4);
      const on = await t.db.selectFrom('venue_modules').select('venue_id').where('org_id', '=', org.orgId).where('module_key', 'in', ['loyalty', 'offers']).where('enabled', '=', true).execute();
      expect(on).toHaveLength(Object.keys(org.venues).length * 2);

      const n = (
        await sql<{ members: number; customers: number; tiers: number }>`
          select (select count(*)::int from loyalty_accounts where org_id = ${org.orgId}) as members,
                 (select count(*)::int from customers where org_id = ${org.orgId} and status = 'active') as customers,
                 (select count(distinct tier_id)::int from loyalty_accounts where org_id = ${org.orgId}) as tiers`.execute(t.db)
      ).rows[0]!;
      expect(n.members / n.customers).toBeGreaterThan(0.15);
      expect(n.members / n.customers).toBeLessThan(0.6);
      expect(n.tiers).toBe(3);
    }
  });

  it('history earned: every sale a member made from the day before they joined has points, exactly once', async () => {
    for (const org of orgs()) {
      const r = (
        await sql<{ eligible: number; unearned: number; doubled: number }>`
          with eligible as (
            select t.id
            from transactions t
            join loyalty_accounts a on a.customer_id = t.customer_id and a.status = 'active'
            where t.org_id = ${org.orgId}
              and t.status in ('completed', 'partially_refunded')
              and t.subtotal_cents - t.discount_cents >= 100
              and t.occurred_at >= a.enrolled_at - interval '24 hours')
          select (select count(*)::int from eligible) as eligible,
                 (select count(*)::int from eligible e where not exists (
                    select 1 from loyalty_transactions lt where lt.source_transaction_id = e.id and lt.kind = 'earn')) as unearned,
                 (select count(*)::int from (
                    select source_transaction_id from loyalty_transactions
                    where org_id = ${org.orgId} and kind = 'earn' group by 1 having count(*) > 1) d) as doubled`.execute(t.db)
      ).rows[0]!;
      expect(r.eligible).toBeGreaterThan(100);
      expect(r.unearned).toBe(0);
      expect(r.doubled).toBe(0);
      // The same figure, as the console reports it.
      const summary = await t.app.tenant(org.orgId, WORKER, (ctx) => loyalty.getLoyaltySummary(ctx, { days: 60 }));
      expect(summary.earnCoverage.memberSales).toBeGreaterThan(0);
      expect(summary.points.outstanding).toBeGreaterThan(0);
      expect(summary.liabilityCents).toBe(summary.points.outstanding);
    }
  });

  it('there is a spread of balances, none negative, and redemptions in every state with points burned only for the redeemed ones', async () => {
    for (const org of orgs()) {
      const balances = (await sql<{ b: number }>`select sum(points)::int as b from loyalty_transactions where org_id = ${org.orgId} group by account_id`.execute(t.db)).rows.map((x) => x.b);
      expect(Math.min(...balances)).toBeGreaterThanOrEqual(0);
      expect(balances.filter((b) => b < 500).length).toBeGreaterThan(5);
      expect(balances.filter((b) => b >= 2000).length).toBeGreaterThan(5);

      const byStatus = await sql<{ status: string; n: number; burned: number }>`
        select r.status::text as status, count(*)::int as n,
               count(*) filter (where exists (select 1 from loyalty_transactions lt where lt.redemption_id = r.id and lt.kind = 'burn'))::int as burned
        from redemptions r where r.org_id = ${org.orgId} group by 1`.execute(t.db);
      const get = (s: string) => byStatus.rows.find((x) => x.status === s) ?? { n: 0, burned: 0 };
      expect(get('redeemed').n).toBeGreaterThan(5);
      expect(get('redeemed').burned).toBe(get('redeemed').n);
      expect(get('expired').n).toBeGreaterThan(0);
      expect(get('expired').burned).toBe(0);
      expect(get('voided').burned).toBe(0);
      expect(get('issued').n).toBe(0);
    }
  });

  it('a welcome and a comeback offer have codes issued, claimed and redeemed, and the seeder sent nobody anything', async () => {
    for (const org of orgs()) {
      const summary = await t.app.tenant(org.orgId, WORKER, (ctx) => offers.getOffersSummary(ctx));
      for (const kind of ['welcome', 'comeback']) {
        const o = summary.offers.find((x) => x.kind === kind)!;
        expect(o.issued).toBeGreaterThan(10);
        expect(o.claimed).toBeGreaterThan(3);
        expect(o.redeemed).toBeGreaterThan(2);
        expect(o.claimed).toBeGreaterThanOrEqual(o.redeemed);
        expect(o.revenueCents).toBeGreaterThan(o.discountCents);
      }
      expect(summary.offers.find((x) => x.kind === 'creator')).toMatchObject({ active: true, issued: 0 });
      const live = await t.db.selectFrom('offer_codes').select('id').where('org_id', '=', org.orgId).where('status', 'in', ['issued', 'claimed']).where('expires_at', '<=', t.clock()).execute();
      expect(live).toEqual([]);
      const messages = await t.db.selectFrom('messages').select('id').where('org_id', '=', org.orgId).where((eb) => eb.or([eb('template_key', 'like', 'loyalty.%'), eb('template_key', 'like', 'offers.%')])).execute();
      expect(messages).toEqual([]);
    }
  });
});
