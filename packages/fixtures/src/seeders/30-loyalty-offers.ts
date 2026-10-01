import { type App, type CanonicalLine, type CanonicalTransaction, type Principal, addDays, localDate, percentOf, setModule, taxIncluded, zonedTimeToUtc } from '@ros/core';
import { identity, ledger, loyalty, offers } from '@ros/modules';
import type { SeedOptions } from '../base';
import { CAMPAIGNS, CREATORS } from '../data';
import type { ModuleSeeder } from '../index';
import type { Fixture, FixtureOrg } from '../load';
import { createRng, type Rng } from '../rng';

/**
 * Loyalty and offers for the fixture orgs (docs/MODULES.md contract item 5).
 *
 *   - both modules on at every venue; a programme with three tiers and a handful of rewards
 *     per org (one org expires points a year after they were earned, the other after a quiet spell)
 *   - a realistic share of the existing customers enrolled at a point in their own history,
 *     regulars far more often than one-timers; every sale they made from then on earns through
 *     the same back-fill the module offers a venue that switches loyalty on late
 *   - counter redemptions over the last seven weeks: most paid for by a till sale carrying the
 *     code, a few matched by amount, force-confirmed, cancelled or left to lapse
 *   - a welcome and a comeback offer with codes issued, claimed, redeemed and expired, and a
 *     creator offer ready to be asked for
 *
 * Nothing is sent: members are imported silently and codes are issued without a message.
 */

const WORKER: Principal = { kind: 'worker', job: 'fixtures' };
const ANON: Principal = { kind: 'anon' };
const MINUTE = 60_000;
const DAY = 86_400_000;
const TZ = 'Australia/Sydney';

/**
 * A moment when the fixture venues are trading, on the given local date or the next open day.
 * They are closed on Mondays, serve lunch every other day and dinner Tuesday to Saturday
 * (base.ts); a sale seeded outside those hours would be a sale on a day the venue was shut.
 */
function duringService(rng: Rng, near: Date | string): Date {
  let date = typeof near === 'string' ? near : localDate(near, TZ);
  while (new Date(`${date}T12:00:00Z`).getUTCDay() === 1) date = addDays(date, 1);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const dinner = weekday !== 0 && rng.chance(0.6);
  const [start, span] = dinner ? [17 * 60 + 30, 225] : [12 * 60, 145];
  const minute = start + rng.int(0, span);
  return zonedTimeToUtc(date, `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`, TZ);
}

interface OrgPlan {
  seed: number;
  prefix: string;
  program: Parameters<typeof loyalty.saveProgram>[1];
  /** Overall appetite for joining; a regular is still far likelier to join than a one-timer. */
  enrolShare: number;
}

const PLANS: Record<string, OrgPlan> = {
  'oak-diner': {
    seed: 3101,
    prefix: 'OAK',
    program: { name: 'Oak Diner Rewards', pointsPerDollar: 5, pointsRounding: 'floor', pointValueCents: 1, expiryPolicy: 'fixed', expiryMonths: 12, enrolmentBonus: 100, birthdayBonus: 250 },
    enrolShare: 1,
  },
  'oak-group': {
    seed: 3202,
    prefix: 'UMG',
    program: { name: 'Oak Group Club', pointsPerDollar: 5, pointsRounding: 'round', pointValueCents: 1, expiryPolicy: 'rolling', expiryMonths: 9, enrolmentBonus: 200, birthdayBonus: 300 },
    enrolShare: 0.85,
  },
};

const TIERS = [
  { name: 'Bronze', thresholdPoints: 0, windowMonths: 12, multiplier: 1, perks: ['Points on every visit'], sortOrder: 0 },
  { name: 'Silver', thresholdPoints: 1500, windowMonths: 12, multiplier: 1.25, perks: ['Points on every visit', 'A quarter more points'], sortOrder: 1 },
  { name: 'Gold', thresholdPoints: 5000, windowMonths: 12, multiplier: 1.5, perks: ['Points on every visit', 'Half as many points again', 'First call on new menu nights'], sortOrder: 2 },
];

interface MenuLine {
  name: string;
  priceCents: number;
  catalogId: string | null;
  section: string;
}

function buildSale(rng: Rng, menu: MenuLine[], at: Date, ref: string, minSubtotal: number): CanonicalTransaction {
  const lines: CanonicalLine[] = [];
  let subtotal = 0;
  while (subtotal < minSubtotal || lines.length < 2) {
    const item = rng.pick(menu);
    lines.push({ lineNo: lines.length + 1, externalItemId: item.catalogId, name: item.name, category: item.section, qty: 1, unitPriceCents: item.priceCents, modifiers: [], discountCents: 0, taxCents: taxIncluded(item.priceCents, 1000), totalCents: item.priceCents });
    subtotal += item.priceCents;
  }
  return {
    source: 'sim',
    externalRef: ref,
    occurredAt: at,
    channel: 'dine-in',
    status: 'completed',
    subtotalCents: subtotal,
    discountCents: 0,
    taxCents: taxIncluded(subtotal, 1000),
    tipCents: 0,
    totalCents: subtotal,
    refundedCents: 0,
    currency: 'AUD',
    tenderType: 'card',
    tableLabel: String(rng.int(1, 24)),
    lines,
    identityHints: [],
  };
}

function withDiscount(txn: CanonicalTransaction, amountCents: number, discount: { name: string; code?: string } | null): CanonicalTransaction {
  const total = txn.subtotalCents - amountCents;
  return { ...txn, discountCents: amountCents, taxCents: taxIncluded(total, 1000), totalCents: total, discounts: discount ? [{ name: discount.name, code: discount.code ?? null, amountCents }] : undefined };
}

async function seedOrg(app: App, org: FixtureOrg, plan: OrgPlan, opts: SeedOptions): Promise<void> {
  const rng = createRng(plan.seed);
  const scale = opts.scale ?? 1;
  const now = opts.now;
  const venues = Object.values(org.venues);
  const programStart = new Date(now.getTime() - 420 * DAY);
  let saleNo = 0;
  const nextRef = () => `fx-${org.slug}-loyalty-${++saleNo}`;

  // Fixtures read the ledger directly to plan; everything they change goes through the modules.
  const menuRows = await app.db
    .selectFrom('menu_items as i')
    .innerJoin('menu_sections as s', 's.id', 'i.section_id')
    .select(['i.id', 'i.venue_id', 'i.name', 'i.price_cents', 'i.pos_catalog_id', 's.name as section'])
    .where('i.org_id', '=', org.orgId)
    .execute();
  const menus = new Map<string, MenuLine[]>();
  for (const r of menuRows) {
    if (r.section === 'Drinks') continue;
    const list = menus.get(r.venue_id) ?? [];
    list.push({ name: r.name, priceCents: r.price_cents, catalogId: r.pos_catalog_id, section: r.section });
    menus.set(r.venue_id, list);
  }
  const fries = menuRows.find((r) => r.venue_id === org.venueId && r.name === 'Fries, aioli');

  // ── Switch on, and set the programme up as it would have been fourteen months ago ──
  opts.setNow(programStart);
  const setup = await app.tenant(org.orgId, WORKER, async (ctx) => {
    for (const v of venues) {
      // One venue gives its codes a shorter life, so per-venue config is exercised.
      await setModule(ctx, loyalty.loyaltyModule, { venueId: v.id, enabled: true, config: v.slug === 'newtown' ? { redemptionExpiryMinutes: 10 } : {} });
      await setModule(ctx, offers.offersModule, { venueId: v.id, enabled: true });
    }
    await loyalty.saveProgram(ctx, plan.program);
    for (const tier of TIERS) await loyalty.saveTier(ctx, tier);
    const five = await loyalty.saveReward(ctx, { name: '$5 off', description: 'Five dollars off your bill.', costPoints: 500, kind: 'fixed', valueCents: 500 });
    const ten = await loyalty.saveReward(ctx, { name: '$10 off', description: 'Ten dollars off when you spend $30 or more.', costPoints: 1000, kind: 'fixed', valueCents: 1000, minSpendCents: 3000 });
    // A single venue can name the dish; across a group each venue has its own menu, so the reward is by value.
    await loyalty.saveReward(ctx, { name: 'Free fries', description: 'A side of fries on us.', costPoints: 900, kind: 'free_item', valueCents: 1100, menuItemId: venues.length === 1 ? (fries?.id ?? null) : null });
    await loyalty.saveReward(ctx, { name: '20% off, Tuesday to Thursday', description: 'A fifth off midweek when you spend $50 or more.', costPoints: 2500, kind: 'percent', percentOff: 20, minSpendCents: 5000, validDays: [2, 3, 4] });
    await loyalty.saveReward(ctx, { name: 'Winter dessert', description: 'Last winter\'s dessert reward.', costPoints: 700, kind: 'free_item', valueCents: 1600, isActive: false });

    const welcome = await offers.saveOffer(ctx, { kind: 'welcome', name: 'Welcome: $10 off your first order', discountKind: 'fixed', valueCents: 1000, minSpendCents: 4000, validityDays: 30, codePrefix: `${plan.prefix}-W` });
    const comeback = await offers.saveOffer(ctx, { kind: 'comeback', name: 'We have missed you: 15% off', discountKind: 'percent', percentOff: 15, validityDays: 21, codePrefix: `${plan.prefix}-C` });
    await offers.saveOffer(ctx, { kind: 'creator', name: 'Sydney Eats sent you: $15 off', discountKind: 'fixed', valueCents: 1500, minSpendCents: 5000, validityDays: 14, codePrefix: 'EATS', creatorId: CREATORS[0], campaignId: CAMPAIGNS[1] });
    return { five: five.id, ten: ten.id, welcome: welcome.id, comeback: comeback.id };
  });

  // ── Enrol a share of the existing customers, each at a point in their own history ──
  const active = new Set((await app.db.selectFrom('customers').select('id').where('org_id', '=', org.orgId).where('status', '=', 'active').execute()).map((c) => c.id));
  const visitRows = await app.db
    .selectFrom('transactions')
    .select(['customer_id', 'occurred_at', 'venue_id'])
    .where('org_id', '=', org.orgId)
    .where('customer_id', 'is not', null)
    .orderBy('occurred_at')
    .execute();
  const visits = new Map<string, Array<{ at: Date; venueId: string }>>();
  for (const v of visitRows) {
    if (!active.has(v.customer_id!)) continue;
    const list = visits.get(v.customer_id!) ?? [];
    list.push({ at: v.occurred_at, venueId: v.venue_id });
    visits.set(v.customer_id!, list);
  }

  const joining: Array<{ customerId: string; at: Date; venueId: string }> = [];
  for (const [customerId, v] of visits) {
    const appetite = v.length >= 6 ? 0.85 : v.length >= 3 ? 0.65 : v.length === 2 ? 0.45 : 0.25;
    if (!rng.chance(appetite * plan.enrolShare)) continue;
    // Most join on their first visit; some take a visit or two to be asked.
    const idx = Math.min(v.length - 1, rng.weighted([[0, 55], [1, 25], [2, 20]] as const));
    const asked = new Date(v[idx]!.at.getTime() + 5 * MINUTE);
    const at = asked > programStart ? asked : new Date(programStart.getTime() + rng.int(1, 30) * DAY);
    joining.push({ customerId, at, venueId: v[idx]!.venueId });
  }
  joining.sort((a, b) => a.at.getTime() - b.at.getTime());

  const members: string[] = [];
  for (let i = 0; i < joining.length; i += 20) {
    await app.tenant(org.orgId, WORKER, async (ctx) => {
      for (const j of joining.slice(i, i + 20)) {
        opts.setNow(j.at);
        // Importing a member earns for every sale of theirs from a day before they joined onward.
        await loyalty.importMember(ctx, { customerId: j.customerId, venueId: j.venueId, enrolledAt: j.at, bonus: true });
        members.push(j.customerId);
        if (rng.chance(0.4)) {
          const birthday = `${rng.int(1958, 2004)}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`;
          await identity.updateCustomer(ctx, j.customerId, { birthday });
        }
      }
    });
  }

  // Anything the enrolment pass did not reach (there should be nothing) earns here, and tiers settle as of today.
  opts.setNow(now);
  await app.tenant(org.orgId, WORKER, async (ctx) => {
    await loyalty.backfillEarning(ctx, {});
    await loyalty.refreshTiers(ctx);
  });

  // ── Counter redemptions over the last seven weeks ──
  const owner = await org.as('owner');
  const balances = await app.tenant(org.orgId, WORKER, (ctx) => loyalty.listMembers(ctx, { limit: 200 }));
  const spenders = balances.filter((m) => m.balance >= 600).slice(0, Math.max(6, Math.round(30 * scale)));
  for (const m of spenders) {
    const rewardId = m.balance >= 1400 && rng.chance(0.4) ? setup.ten : setup.five;
    const value = rewardId === setup.ten ? 1000 : 500;
    const at = duringService(rng, addDays(localDate(now, TZ), -rng.int(1, 49)));
    const venueId = venues[rng.int(0, venues.length - 1)]!.id;
    const fate = rng.weighted([['paid', 66], ['amount', 8], ['forced', 8], ['voided', 6], ['lapsed', 12]] as const);
    if (at.getTime() > now.getTime() - 3_600_000 || at.getTime() < m.enrolledAt.getTime() + DAY) continue;

    opts.setNow(at);
    const issued = await app.tenant(org.orgId, owner, (ctx) => loyalty.issueRedemption(ctx, { venueId, accountId: m.accountId, rewardId }));
    if (fate === 'paid' || fate === 'amount') {
      const paidAt = new Date(at.getTime() + rng.int(2, 8) * MINUTE);
      opts.setNow(paidAt);
      const base = buildSale(rng, menus.get(venueId)!, paidAt, nextRef(), 4000);
      // Either staff keyed the code in as the discount, or the till only knows "$5 off".
      const txn = withDiscount(base, value, fate === 'paid' ? { name: `Loyalty ${issued.code}`, code: issued.code } : null);
      await app.tenant(org.orgId, WORKER, (ctx) => ledger.recordTransaction(ctx, txn, { venueId, customerId: fate === 'paid' ? m.customerId : null, via: 'pos' }));
    } else if (fate === 'forced') {
      opts.setNow(new Date(at.getTime() + 35 * MINUTE));
      await app.tenant(org.orgId, owner, (ctx) => loyalty.forceConfirmRedemption(ctx, { venueId, redemptionId: issued.id, reason: 'Till was offline; the guest had the code on their phone' }));
    } else if (fate === 'voided') {
      opts.setNow(new Date(at.getTime() + 2 * MINUTE));
      await app.tenant(org.orgId, owner, (ctx) => loyalty.voidRedemption(ctx, { redemptionId: issued.id, reason: 'Guest changed their mind' }));
    }
  }

  // ── Welcome codes for the newest customers ──
  const customers = await app.db.selectFrom('customers').select(['id', 'created_at']).where('org_id', '=', org.orgId).where('status', '=', 'active').orderBy('created_at', 'desc').execute();
  const newest = customers.filter((c) => c.created_at.getTime() > now.getTime() - 75 * DAY).slice(0, Math.max(8, Math.round(45 * scale)));
  for (const c of newest.reverse()) {
    const issuedAt = new Date(c.created_at.getTime() + 3_600_000);
    if (issuedAt >= now) continue;
    opts.setNow(issuedAt);
    const { code } = await app.tenant(org.orgId, WORKER, (ctx) => offers.issueCode(ctx, { offerId: setup.welcome, customerId: c.id, source: 'flow:welcome' }));
    const path = rng.weighted([['ignored', 45], ['claimed', 25], ['claimed_redeemed', 22], ['redeemed_unclaimed', 8]] as const);
    if (path === 'ignored') continue;
    let at = new Date(issuedAt.getTime() + rng.int(2, 72) * 3_600_000);
    if (at >= now || at >= code.expiresAt) continue;
    if (path !== 'redeemed_unclaimed') {
      opts.setNow(at);
      await app.tenant(org.orgId, ANON, (ctx) => offers.claimCode(ctx, { code: code.code }));
      if (path === 'claimed') continue;
      at = new Date(at.getTime() + rng.int(1, 12) * DAY);
    } else {
      // Straight to the counter with the code from the email, a day or more after it arrived.
      at = new Date(at.getTime() + DAY);
    }
    at = duringService(rng, at);
    if (at >= now || at >= code.expiresAt) continue;
    opts.setNow(at);
    const venueId = visits.get(c.id)?.[0]?.venueId ?? org.venueId;
    const txn = withDiscount(buildSale(rng, menus.get(venueId)!, at, nextRef(), 4500), 1000, { name: 'Welcome offer', code: code.code });
    await app.tenant(org.orgId, WORKER, (ctx) => ledger.recordTransaction(ctx, txn, { venueId, customerId: c.id, via: 'pos' }));
  }

  // ── Comeback codes for guests who have gone quiet ──
  const lapsed = [...visits.entries()]
    .filter(([, v]) => {
      const last = v[v.length - 1]!.at.getTime();
      return last < now.getTime() - 60 * DAY && last > now.getTime() - 220 * DAY;
    })
    .slice(0, Math.max(8, Math.round(45 * scale)));
  for (const [customerId, v] of lapsed) {
    const issuedAt = new Date(now.getTime() - rng.int(2, 45) * DAY - rng.int(0, 600) * MINUTE);
    opts.setNow(issuedAt);
    const { code } = await app.tenant(org.orgId, WORKER, (ctx) => offers.issueCode(ctx, { offerId: setup.comeback, customerId, source: 'flow:winback' }));
    if (!rng.chance(0.4)) continue;
    let at = new Date(issuedAt.getTime() + rng.int(1, 96) * 3_600_000);
    if (at >= now || at >= code.expiresAt) continue;
    opts.setNow(at);
    await app.tenant(org.orgId, ANON, (ctx) => offers.claimCode(ctx, { code: code.code }));
    if (!rng.chance(0.45)) continue;
    at = duringService(rng, new Date(at.getTime() + rng.int(1, 9) * DAY));
    if (at >= now || at >= code.expiresAt) continue;
    opts.setNow(at);
    const venueId = v[v.length - 1]!.venueId;
    const base = buildSale(rng, menus.get(venueId)!, at, nextRef(), 4000);
    const txn = withDiscount(base, percentOf(base.subtotalCents, 15), { name: 'Comeback 15%', code: code.code });
    await app.tenant(org.orgId, WORKER, (ctx) => ledger.recordTransaction(ctx, txn, { venueId, customerId, via: 'pos' }));
  }

  // ── Bring everything up to today: lapsed codes, lapsed points, tiers ──
  opts.setNow(now);
  await app.tenant(org.orgId, WORKER, async (ctx) => {
    await loyalty.expireStaleRedemptions(ctx);
    await offers.expireCodes(ctx);
    await loyalty.expirePoints(ctx);
    await loyalty.refreshTiers(ctx);
  });
}

const seeder: ModuleSeeder = {
  module: 'loyalty-offers',
  async seed(app: App, fixture: Fixture, opts: SeedOptions): Promise<void> {
    for (const org of [fixture.diner, fixture.group]) {
      await seedOrg(app, org, PLANS[org.slug]!, opts);
      opts.setNow(opts.now);
    }
  },
};

export default seeder;
