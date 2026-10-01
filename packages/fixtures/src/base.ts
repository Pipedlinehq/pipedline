import { type App, type CanonicalLine, type CanonicalTransaction, type IdentityHint, addDays, json, localDate, taxIncluded, zonedTimeToUtc } from '@ros/core';
import { identity, ledger, tenancy } from '@ros/modules';
import { CAMPAIGNS, CREATORS, DINER_MENU, FIRST_NAMES, LAST_NAMES, MODIFIER_GROUPS, type FixtureItem } from './data';
import { createRng, type Rng } from './rng';

const TZ = 'Australia/Sydney';
const WORKER = { kind: 'worker' as const, job: 'fixtures' };
const HISTORY_DAYS = 540;

export interface SeedOptions {
  /** "Today". Every date in the fixtures is relative to it. */
  now: Date;
  /** Moves the app clock, so history is written with the timestamps it would have had. */
  setNow(at: Date): void;
  /** 1 = the documented size (about 3,000 sales at the single venue). Lower for a quick seed. */
  scale?: number;
}

interface VenueSpec {
  slug: string;
  name: string;
  suburb: string;
  postcode: string;
  lat: number;
  lng: number;
  capacity: number;
  dineIn: boolean;
  share: number;
}

interface OrgSpec {
  slug: string;
  legalName: string;
  tradingName: string;
  seed: number;
  customers: number;
  sales: number;
  venues: VenueSpec[];
  staff: Array<{ email: string; firstName: string; lastName: string; roles: Array<{ venue: string; role: 'manager' | 'host' | 'kitchen' | 'front_of_house' | 'read_only' }> }>;
}

export const FIXTURE_ORGS: OrgSpec[] = [
  {
    slug: 'oak-diner',
    legalName: 'Oak Diner Pty Ltd (fixture)',
    tradingName: 'Oak Diner',
    seed: 101,
    customers: 400,
    sales: 3000,
    venues: [{ slug: 'main', name: 'Oak Diner', suburb: 'Surry Hills', postcode: '2010', lat: -33.8861, lng: 151.2111, capacity: 60, dineIn: true, share: 1 }],
    staff: [
      { email: 'manager@oak-diner.test', firstName: 'Morgan', lastName: 'Manager', roles: [{ venue: 'main', role: 'manager' }] },
      { email: 'host@oak-diner.test', firstName: 'Harper', lastName: 'Host', roles: [{ venue: 'main', role: 'front_of_house' }] },
      { email: 'kitchen@oak-diner.test', firstName: 'Kai', lastName: 'Kitchen', roles: [{ venue: 'main', role: 'kitchen' }] },
    ],
  },
  {
    slug: 'oak-group',
    legalName: 'Oak Group Pty Ltd (fixture)',
    tradingName: 'Oak Group',
    seed: 202,
    customers: 260,
    sales: 1800,
    venues: [
      { slug: 'cbd', name: 'Oak Group CBD', suburb: 'Sydney', postcode: '2000', lat: -33.8688, lng: 151.2093, capacity: 90, dineIn: true, share: 0.5 },
      { slug: 'newtown', name: 'Oak Group Newtown', suburb: 'Newtown', postcode: '2042', lat: -33.8977, lng: 151.1786, capacity: 50, dineIn: true, share: 0.32 },
      // Pickup only: exercises a venue with dine-in switched off.
      { slug: 'bondi', name: 'Oak Group Bondi', suburb: 'Bondi Beach', postcode: '2026', lat: -33.8908, lng: 151.2743, capacity: 0, dineIn: false, share: 0.18 },
    ],
    staff: [
      // Roles at two of the three venues.
      { email: 'manager@oak-group.test', firstName: 'Riley', lastName: 'Regional', roles: [{ venue: 'cbd', role: 'manager' }, { venue: 'newtown', role: 'manager' }] },
      { email: 'host@oak-group.test', firstName: 'Noa', lastName: 'Newtown', roles: [{ venue: 'newtown', role: 'front_of_house' }] },
      { email: 'accounts@oak-group.test', firstName: 'Avery', lastName: 'Accounts', roles: [{ venue: 'cbd', role: 'read_only' }, { venue: 'newtown', role: 'read_only' }, { venue: 'bondi', role: 'read_only' }] },
    ],
  },
];

const HOURS = [
  // Closed Monday. Lunch Tue–Sun, dinner Tue–Sat.
  ...[2, 3, 4, 5, 6, 0].map((d) => ({ dayOfWeek: d, opensAt: '12:00', closesAt: '15:00', serviceType: 'lunch' })),
  ...[2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, opensAt: '17:30', closesAt: '22:00', serviceType: 'dinner' })),
];
const DAY_WEIGHT = [1.0, 0, 0.8, 0.9, 1.0, 1.5, 1.7]; // Sun … Sat

interface MenuRef {
  id: string;
  item: FixtureItem;
  section: string;
  catalogId: string;
}

interface Visit {
  at: Date;
  venueIdx: number;
  customerIdx: number | null;
  channel: 'dine-in' | 'pickup';
}

interface GuestSpec {
  idx: number;
  first: string;
  last: string;
  email: string | null;
  phone: string | null;
  homeVenue: number;
  acquisition: identity.Acquisition;
  consents: { email: boolean; sms: boolean; card: boolean; ads: boolean };
}

function serviceTime(rng: Rng, weekday: number): string {
  const dinner = weekday !== 0 && rng.chance(0.65);
  const [startH, startM, span] = dinner ? [17, 30, 240] : [12, 0, 165];
  // Bunch arrivals toward the middle of the service.
  const offset = Math.floor(((rng.next() + rng.next()) / 2) * span);
  const total = startH * 60 + startM + offset;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}`;
}

function openDayOnOrAfter(date: string): string {
  let d = date;
  while (new Date(`${d}T12:00:00Z`).getUTCDay() === 1) d = addDays(d, 1);
  return d;
}

function buildLines(rng: Rng, menu: MenuRef[], covers: number): CanonicalLine[] {
  const count = Math.max(1, Math.round(covers * (1.6 + rng.next() * 1.4)));
  const chosen = new Map<string, { ref: MenuRef; qty: number; modifiers: Array<{ name: string; priceCents: number }> }>();
  for (let i = 0; i < count; i++) {
    const ref = rng.weighted(menu.map((m) => [m, m.item.weight] as const));
    const modifiers: Array<{ name: string; priceCents: number }> = [];
    for (const g of ref.item.groups ?? []) {
      const group = MODIFIER_GROUPS[g]!;
      if (group.required || rng.chance(0.35)) {
        const [name, price] = rng.pick(group.options);
        modifiers.push({ name, priceCents: price });
      }
    }
    const key = `${ref.id}|${modifiers.map((m) => m.name).join(',')}`;
    const prior = chosen.get(key);
    if (prior) prior.qty++;
    else chosen.set(key, { ref, qty: 1, modifiers });
  }
  return [...chosen.values()].map((c, i) => {
    const unit = c.ref.item.price + c.modifiers.reduce((s, m) => s + m.priceCents, 0);
    const total = unit * c.qty;
    return {
      lineNo: i + 1,
      externalItemId: c.ref.catalogId,
      name: c.ref.item.name,
      category: c.ref.section,
      qty: c.qty,
      unitPriceCents: unit,
      modifiers: c.modifiers,
      discountCents: 0,
      taxCents: taxIncluded(total, 1000),
      totalCents: total,
    };
  });
}

async function seedMenu(app: App, orgId: string, venueId: string, venueSlug: string, rng: Rng): Promise<MenuRef[]> {
  return app.tenant(orgId, WORKER, async (ctx) => {
    const menu = await ctx.db.insertInto('menus').values({ org_id: orgId, venue_id: venueId, name: 'All day' }).returning('id').executeTakeFirstOrThrow();
    const groupIds = new Map<string, string>();
    let gi = 0;
    for (const [name, g] of Object.entries(MODIFIER_GROUPS)) {
      const row = await ctx.db
        .insertInto('modifier_groups')
        .values({ org_id: orgId, venue_id: venueId, name, selection_type: g.selection, min_selections: g.min, max_selections: g.max, is_required: g.required, sort_order: gi++ })
        .returning('id')
        .executeTakeFirstOrThrow();
      groupIds.set(name, row.id);
      await ctx.db
        .insertInto('modifiers')
        .values(g.options.map(([optName, delta], i) => ({ org_id: orgId, venue_id: venueId, group_id: row.id, name: optName, price_delta_cents: delta, is_default: i === 0 && g.required, sort_order: i })))
        .execute();
    }
    const refs: MenuRef[] = [];
    let si = 0;
    for (const section of DINER_MENU) {
      const s = await ctx.db
        .insertInto('menu_sections')
        .values({ org_id: orgId, venue_id: venueId, menu_id: menu.id, name: section.name, sort_order: si++ })
        .returning('id')
        .executeTakeFirstOrThrow();
      let ii = 0;
      for (const item of section.items) {
        // Per-venue menus diverge a little: prices differ and one venue drops a dish.
        if (venueSlug === 'bondi' && item.name.startsWith('Beef tartare')) continue;
        const price = venueSlug === 'cbd' ? item.price + 200 : item.price;
        const catalogId = `simcat-${venueSlug}-${section.name.toLowerCase()}-${ii}`;
        const row = await ctx.db
          .insertInto('menu_items')
          .values({
            org_id: orgId,
            venue_id: venueId,
            section_id: s.id,
            name: item.name,
            description: item.description ?? null,
            price_cents: price,
            sort_order: ii++,
            dietary_tags: item.tags ?? [],
            allergens: item.allergens ?? [],
            prep_minutes: item.prep,
            is_alcohol: item.alcohol ?? false,
            pos_catalog_id: catalogId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        for (const [gIdx, g] of (item.groups ?? []).entries()) {
          await ctx.db.insertInto('item_modifier_groups').values({ org_id: orgId, item_id: row.id, group_id: groupIds.get(g)!, sort_order: gIdx }).execute();
        }
        refs.push({ id: row.id, item: { ...item, price }, section: section.name, catalogId });
      }
    }
    void rng;
    return refs;
  });
}

function planGuests(rng: Rng, spec: OrgSpec, count: number): GuestSpec[] {
  const guests: GuestSpec[] = [];
  for (let i = 0; i < count; i++) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const hasEmail = rng.chance(0.8);
    const hasPhone = !hasEmail || rng.chance(0.5);
    const source = rng.weighted([
      ['organic', 40],
      ['walk-in', 20],
      ['criota', 17],
      ['meta', 10],
      ['google', 6],
      ['qr', 7],
    ] as const);
    const acquisition: identity.Acquisition =
      source === 'criota'
        ? { source, creatorId: rng.pick(CREATORS), campaignId: rng.pick(CAMPAIGNS), landingPath: '/' }
        : source === 'meta'
          ? { source, campaignId: 'meta_reserve_acquisition', landingPath: '/offer' }
          : { source };
    guests.push({
      idx: i,
      first,
      last,
      email: hasEmail ? `${first}.${last}.${i}@guests.${spec.slug}.example`.toLowerCase() : null,
      phone: hasPhone ? `+614${String(10_000_000 + spec.seed * 10_000 + i).slice(0, 8)}` : null,
      homeVenue: spec.venues.indexOf(rng.weighted(spec.venues.map((v) => [v, v.share] as const))),
      acquisition,
      consents: {
        email: hasEmail && rng.chance(0.65),
        sms: hasPhone && rng.chance(0.4),
        card: rng.chance(0.15),
        ads: rng.chance(0.1),
      },
    });
  }
  return guests;
}

function planVisits(rng: Rng, spec: OrgSpec, guests: GuestSpec[], totalSales: number, now: Date): Visit[] {
  const today = localDate(now, TZ);
  const start = addDays(today, -HISTORY_DAYS);
  const visits: Visit[] = [];
  const at = (date: string) => {
    const d = openDayOnOrAfter(date);
    return zonedTimeToUtc(d, serviceTime(rng, new Date(`${d}T12:00:00Z`).getUTCDay()), TZ);
  };
  const venueFor = (home: number) => (spec.venues.length > 1 && rng.chance(0.2) ? rng.int(0, spec.venues.length - 1) : home);
  const channelFor = (venueIdx: number): Visit['channel'] => (!spec.venues[venueIdx]!.dineIn || rng.chance(0.3) ? 'pickup' : 'dine-in');

  for (const g of guests) {
    // Long tail: most guests come once; a few come often.
    const n = rng.weighted([
      [1, 55],
      [2, 20],
      [rng.int(3, 5), 12],
      [rng.int(6, 12), 8],
      [rng.int(13, 40), 5],
    ] as const);
    // More first visits in recent months than early ones: the venue is growing.
    let day = addDays(start, Math.floor(Math.sqrt(rng.next()) * (HISTORY_DAYS - 2)));
    for (let v = 0; v < n; v++) {
      if (day > today) break;
      const venueIdx = venueFor(g.homeVenue);
      visits.push({ at: at(day), venueIdx, customerIdx: g.idx, channel: channelFor(venueIdx) });
      day = addDays(day, Math.max(3, Math.round(-Math.log(1 - rng.next()) * (n > 5 ? 18 : 45))));
    }
  }

  // The rest of the room: people who paid and were never identified.
  while (visits.length < totalSales) {
    let day = addDays(start, rng.int(0, HISTORY_DAYS - 1));
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (!rng.chance(DAY_WEIGHT[weekday]! / 1.7)) continue;
    // A gentle summer lift (December to February).
    const month = Number(day.slice(5, 7));
    if (![12, 1, 2].includes(month) && rng.chance(0.12)) continue;
    day = openDayOnOrAfter(day);
    const venueIdx = spec.venues.indexOf(rng.weighted(spec.venues.map((v) => [v, v.share] as const)));
    visits.push({ at: at(day), venueIdx, customerIdx: null, channel: channelFor(venueIdx) });
  }

  return visits.filter((v) => v.at < now).sort((a, b) => a.at.getTime() - b.at.getTime());
}

export async function seedOrg(app: App, spec: OrgSpec, opts: SeedOptions): Promise<void> {
  const scale = opts.scale ?? 1;
  const rng = createRng(spec.seed);
  const historyStart = new Date(opts.now.getTime() - (HISTORY_DAYS + 5) * 86_400_000);
  opts.setNow(historyStart);

  const first = spec.venues[0]!;
  const created = await app.platform('fixtures', (pctx) =>
    tenancy.createOrg(pctx, {
      slug: spec.slug,
      legalName: spec.legalName,
      tradingName: spec.tradingName,
      abn: '00 000 000 000',
      cuisineTags: ['steakhouse', 'modern-australian'],
      priceBand: 3,
      owner: { email: `owner@${spec.slug}.test`, firstName: 'Olive', lastName: 'Owner' },
      venue: { slug: first.slug, name: first.name, suburb: first.suburb, state: 'NSW', postcode: first.postcode, lat: first.lat, lng: first.lng, capacity: first.capacity || undefined, addressLine1: '1 Fixture Street' },
    }),
  );
  const orgId = created.orgId;
  await app.platform('fixtures', (pctx) => tenancy.setOrgStatus(pctx, orgId, 'live'));

  const venueIds: string[] = [created.venueId];
  await app.tenant(orgId, WORKER, async (ctx) => {
    for (const v of spec.venues.slice(1)) {
      const row = await tenancy.createVenue(ctx, { slug: v.slug, name: v.name, suburb: v.suburb, state: 'NSW', postcode: v.postcode, lat: v.lat, lng: v.lng, capacity: v.capacity || null, addressLine1: '1 Fixture Street' });
      venueIds.push(row.id);
    }
    for (const id of venueIds) {
      await tenancy.updateVenue(ctx, id, { status: 'live' });
      await tenancy.setTradingHours(ctx, id, HOURS);
    }
    // A public holiday closure, so hour exceptions are exercised.
    await tenancy.setHourException(ctx, venueIds[0]!, { date: addDays(localDate(opts.now, TZ), 5), closed: true, reason: 'Public holiday' });
  });

  // Staff are inserted directly: an invitation would queue an email, and fixtures send nothing.
  for (const s of spec.staff) {
    const user = await app.db
      .insertInto('users')
      .values({ email: s.email, name: `${s.firstName} ${s.lastName}` })
      .onConflict((oc) => oc.column('email').doUpdateSet((eb) => ({ email: eb.ref('excluded.email') })))
      .returning('id')
      .executeTakeFirstOrThrow();
    const staff = await app.db
      .insertInto('staff')
      .values({ org_id: orgId, user_id: user.id, first_name: s.firstName, last_name: s.lastName, email: s.email, status: 'active' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await app.db
      .insertInto('staff_venues')
      .values(s.roles.map((r) => ({ org_id: orgId, staff_id: staff.id, venue_id: venueIds[spec.venues.findIndex((v) => v.slug === r.venue)]!, role: r.role })))
      .execute();
  }

  const menus: MenuRef[][] = [];
  for (const [i, v] of spec.venues.entries()) menus.push(await seedMenu(app, orgId, venueIds[i]!, v.slug, rng));

  const guests = planGuests(rng, spec, Math.max(20, Math.round(spec.customers * scale)));
  const visits = planVisits(rng, spec, guests, Math.max(60, Math.round(spec.sales * scale)), opts.now);
  const customerIds = new Map<number, string>();
  const seen = new Set<number>();
  let n = 0;

  // Replay history in order, a batch per transaction, with the clock at each sale's own time.
  const BATCH = 40;
  for (let i = 0; i < visits.length; i += BATCH) {
    const batch = visits.slice(i, i + BATCH);
    const newlyConsenting: GuestSpec[] = [];
    await app.tenant(orgId, WORKER, async (ctx) => {
      for (const visit of batch) {
        opts.setNow(visit.at);
        n++;
        const venueId = venueIds[visit.venueIdx]!;
        const guest = visit.customerIdx === null ? null : guests[visit.customerIdx]!;
        let customerId: string | null = null;

        if (guest) {
          const hints: IdentityHint[] = [];
          if (guest.email) hints.push({ kind: 'email', value: guest.email });
          if (guest.phone) hints.push({ kind: 'phone', value: guest.phone });
          if (!seen.has(guest.idx)) {
            const r = await identity.resolveCustomer(ctx, {
              hints,
              via: visit.channel === 'pickup' ? 'online-order' : 'pos',
              venueId,
              profile: { firstName: guest.first, lastName: guest.last },
              acquisition: { ...guest.acquisition, at: visit.at },
            });
            customerIds.set(guest.idx, r.customerId!);
            seen.add(guest.idx);
            if (guest.consents.email) await identity.grantConsent(ctx, { customerId: r.customerId!, purpose: 'marketing_email', source: 'import', sourceDetail: 'fixture: sign-up form', consentedAt: visit.at });
            if (guest.consents.sms) await identity.grantConsent(ctx, { customerId: r.customerId!, purpose: 'marketing_sms', source: 'import', sourceDetail: 'fixture: sign-up form', consentedAt: visit.at });
            if (guest.consents.ads) await identity.grantConsent(ctx, { customerId: r.customerId!, purpose: 'ad_platform_sharing', source: 'import', sourceDetail: 'fixture: sign-up form', consentedAt: visit.at });
            if (guest.consents.card) newlyConsenting.push(guest);
          }
          customerId = customerIds.get(guest.idx)!;
          // A consenting guest sometimes just taps and says nothing: the card alone must find them.
          if (guest.consents.card && !newlyConsenting.includes(guest) && rng.chance(0.5)) customerId = null;
        }

        const covers = visit.channel === 'pickup' ? rng.int(1, 2) : rng.int(1, 4);
        const lines = buildLines(rng, menus[visit.venueIdx]!, covers);
        const subtotal = lines.reduce((s, l) => s + l.totalCents, 0);
        const discount = rng.chance(0.06) ? Math.round(subtotal * 0.1) : 0;
        const tip = visit.channel === 'dine-in' && rng.chance(0.25) ? Math.round(((subtotal - discount) * rng.int(5, 12)) / 100) : 0;
        const total = subtotal - discount + tip;
        const refundRoll = rng.next();
        const status = refundRoll < 0.01 ? 'refunded' : refundRoll < 0.015 ? 'partially_refunded' : 'completed';
        const refunded = status === 'refunded' ? total : status === 'partially_refunded' ? Math.round(total / 3) : 0;

        // Every card payment carries a card reference. It is kept only for a consenting guest.
        const identityHints: IdentityHint[] = [{ kind: 'card_fingerprint', value: guest ? `fp-${spec.slug}-${guest.idx}` : `fp-${spec.slug}-anon-${rng.int(1, 900)}` }];
        if (rng.chance(0.74)) identityHints.push({ kind: 'card_par', value: guest ? `par-${spec.slug}-${guest.idx}` : `par-${spec.slug}-anon-${rng.int(1, 900)}` });

        const txn: CanonicalTransaction = {
          source: visit.channel === 'pickup' ? 'online-order' : 'sim',
          externalRef: `fx-${spec.slug}-${n}`,
          occurredAt: visit.at,
          channel: visit.channel,
          status,
          subtotalCents: subtotal,
          discountCents: discount,
          taxCents: taxIncluded(subtotal - discount, 1000),
          tipCents: tip,
          totalCents: total,
          refundedCents: refunded,
          currency: 'AUD',
          tenderType: 'card',
          tableLabel: visit.channel === 'dine-in' ? String(rng.int(1, 24)) : null,
          lines,
          identityHints,
          raw: { id: `fx-${spec.slug}-${n}`, card_details: { card: { brand: rng.pick(['VISA', 'MASTERCARD', 'EFTPOS']), last_4: String(rng.int(1000, 9999)), fingerprint: identityHints[0]!.value } } },
        };
        await ledger.recordTransaction(ctx, txn, { venueId, customerId, via: visit.channel === 'pickup' ? 'online-order' : 'pos' });
      }
    });

    // Card recognition is ticked by the guest, never imported: record it as the guest would, at a sign-up.
    for (const g of newlyConsenting) {
      await app.tenant(orgId, { kind: 'anon' }, (ctx) =>
        identity.grantConsent(ctx, { customerId: customerIds.get(g.idx)!, purpose: 'card_recognition', source: 'loyalty_signup', sourceDetail: 'fixture' }),
      );
    }
  }

  await seedWebSessions(app, orgId, venueIds, spec, rng, opts, scale);
  opts.setNow(opts.now);
}

/** Ninety days of site visits, so funnels and campaign reports have something to show. */
async function seedWebSessions(app: App, orgId: string, venueIds: string[], spec: OrgSpec, rng: Rng, opts: SeedOptions, scale: number): Promise<void> {
  const count = Math.round(1200 * scale * (spec.sales / 3000));
  const sessions: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    const at = new Date(opts.now.getTime() - rng.next() * 90 * 86_400_000);
    const id = rng.uuid();
    const venueId = venueIds[rng.int(0, venueIds.length - 1)]!;
    const src = rng.weighted([
      ['direct', 38],
      ['google', 24],
      ['instagram', 16],
      ['criota', 14],
      ['meta', 8],
    ] as const);
    const creator = src === 'criota' ? rng.pick(CREATORS) : null;
    const campaign = src === 'criota' ? rng.pick(CAMPAIGNS) : src === 'meta' ? 'meta_reserve_acquisition' : null;
    const attribution = {
      utm_source: src === 'direct' ? null : src,
      utm_medium: src === 'meta' ? 'paid_social' : src === 'google' ? 'organic' : src === 'direct' ? null : 'social',
      utm_campaign: campaign,
      creator_id: creator,
      campaign_id: campaign,
      code: null,
    };
    sessions.push({
      id,
      org_id: orgId,
      venue_id: venueId,
      first_seen_at: at,
      last_seen_at: new Date(at.getTime() + rng.int(20, 600) * 1000),
      landing_path: rng.pick(['/', '/', '/menu', '/menu', '/offer']),
      referrer: src === 'google' ? 'https://www.google.com/' : src === 'instagram' ? 'https://l.instagram.com/' : null,
      device_class: rng.weighted([['mobile', 78], ['desktop', 18], ['tablet', 4]] as const),
      ...attribution,
    });
    const base = { org_id: orgId, venue_id: venueId, session_id: id, source: 'web', ...attribution };
    events.push({ ...base, name: 'session.started', occurred_at: at, properties: json({ landing_path: '/', referrer_host: null, device_class: 'mobile' }) });
    events.push({ ...base, name: 'page.viewed', occurred_at: at, properties: json({ path: '/' }) });
    if (rng.chance(0.62)) {
      events.push({ ...base, name: 'menu.viewed', occurred_at: new Date(at.getTime() + 15_000), properties: json({ surface: 'site' }) });
      if (rng.chance(0.4)) events.push({ ...base, name: 'link.clicked', occurred_at: new Date(at.getTime() + 60_000), properties: json({ kind: rng.pick(['directions', 'call', 'order']) }) });
    }
  }
  await app.tenant(orgId, WORKER, async (ctx) => {
    for (let i = 0; i < sessions.length; i += 500) await ctx.db.insertInto('visitor_sessions').values(sessions.slice(i, i + 500) as never).execute();
    for (let i = 0; i < events.length; i += 500) await ctx.db.insertInto('events').values(events.slice(i, i + 500) as never).execute();
  });
}
