import { type Ctx, type IdentityHint, track } from '@ros/core';
import { hasConsent } from './consents';
import { mergeCustomersUnchecked } from './merge';
import { customerCreated } from './module';
import { toStoredIdentities } from './normalise';

export interface Acquisition {
  /** 'criota' | 'organic' | 'walk-in' | 'referral' | 'meta' | 'google' | 'qr' | 'import' | … */
  source: string;
  creatorId?: string | null;
  campaignId?: string | null;
  code?: string | null;
  landingPath?: string | null;
  qrCodeId?: string | null;
  at?: Date;
}

export interface ResolveInput {
  hints: IdentityHint[];
  /** The surface that saw these identities: 'online-order', 'pos', 'loyalty', 'guest_login', 'import' … */
  via: string;
  venueId?: string | null;
  profile?: { firstName?: string | null; lastName?: string | null; birthday?: string | null };
  /** Stamped once if this call creates the customer; recorded as a later touch otherwise. */
  acquisition?: Acquisition;
  /** Default true. False = look up only. */
  createIfMissing?: boolean;
  /** True when the guest proved control of the email or phone (a one-time code). */
  verified?: boolean;
}

export interface ResolveResult {
  customerId: string | null;
  created: boolean;
  mergedFrom: string[];
}

/**
 * Find the one customer these identities belong to, creating or merging as needed.
 *
 * Identity arrives incrementally and out of order: a card today, a phone number next month, an
 * email later. Each new identity either matches a customer or becomes one; two customers that
 * turn out to share an identity are merged (docs/SCHEMA.md section 2).
 *
 * Card identifiers are looked up only in their per-org hashed form, never create a customer on
 * their own, and are attached only for a customer who holds the card-recognition consent.
 */
export async function resolveCustomer(ctx: Ctx, input: ResolveInput): Promise<ResolveResult> {
  const stored = await toStoredIdentities(ctx.app, ctx.orgId, input.hints);
  const strong = stored.filter((s) => !s.isCard);
  if (!stored.length) return { customerId: null, created: false, mergedFrom: [] };

  const found = await ctx.db
    .selectFrom('customer_identities as ci')
    .innerJoin('customers as c', 'c.id', 'ci.customer_id')
    .select(['ci.customer_id', 'ci.kind', 'ci.value', 'c.created_at'])
    .where('c.status', '=', 'active')
    .where((eb) => eb.or(stored.map((s) => eb.and([eb('ci.kind', '=', s.kind), eb('ci.value', '=', s.value)]))))
    .execute();

  const candidates = [...new Map(found.map((f) => [f.customer_id, f.created_at])).entries()].sort((a, b) => a[1].getTime() - b[1].getTime());
  let customerId: string | null = candidates[0]?.[0] ?? null;
  const mergedFrom: string[] = [];
  let created = false;

  // More than one record claims these identities: they are one person. The oldest record wins.
  for (const [loserId] of candidates.slice(1)) {
    await mergeCustomersUnchecked(ctx, { winnerId: customerId!, loserId, reason: `shared identity seen via ${input.via}` });
    mergedFrom.push(loserId);
  }

  if (!customerId) {
    if (input.createIfMissing === false || !strong.length) return { customerId: null, created: false, mergedFrom };
    const email = strong.find((s) => s.kind === 'email')?.value ?? null;
    const phone = strong.find((s) => s.kind === 'phone')?.value ?? null;
    const hintName = input.hints.find((h) => h.firstName || h.lastName);
    const acq = input.acquisition;
    const row = await ctx.db
      .insertInto('customers')
      .values({
        org_id: ctx.orgId,
        primary_email: email,
        primary_phone: phone,
        first_name: input.profile?.firstName ?? hintName?.firstName ?? null,
        last_name: input.profile?.lastName ?? hintName?.lastName ?? null,
        birthday: input.profile?.birthday ?? null,
        first_seen_venue_id: input.venueId ?? null,
        acquisition_source: acq?.source ?? (input.via === 'pos' ? 'walk-in' : 'organic'),
        acquisition_creator_id: acq?.creatorId ?? null,
        acquisition_campaign_id: acq?.campaignId ?? null,
        acquisition_code: acq?.code ?? null,
        acquisition_landing_path: acq?.landingPath ?? null,
        acquisition_qr_code_id: acq?.qrCodeId ?? null,
        acquisition_at: acq?.at ?? ctx.now(),
        created_at: ctx.now(),
      })
      .returning(['id', 'acquisition_source'])
      .executeTakeFirstOrThrow();
    customerId = row.id;
    created = true;
    await track(ctx, customerCreated, { acquisition_source: row.acquisition_source, via: input.via }, {
      customerId,
      venueId: input.venueId ?? null,
      attribution: { creatorId: acq?.creatorId, campaignId: acq?.campaignId, code: acq?.code },
    });
  } else if (input.acquisition && (input.acquisition.creatorId || input.acquisition.campaignId || input.acquisition.code)) {
    // The first touch is already stamped and never changes; this is a later one.
    await ctx.db
      .insertInto('customer_touchpoints')
      .values({
        org_id: ctx.orgId,
        customer_id: customerId,
        occurred_at: input.acquisition.at ?? ctx.now(),
        channel: input.acquisition.source,
        campaign_id: input.acquisition.campaignId ?? null,
        creator_id: input.acquisition.creatorId ?? null,
        code: input.acquisition.code ?? null,
      })
      .execute();
  }

  // Attach identities this customer does not yet hold.
  const have = new Set(found.filter((f) => f.customer_id === customerId || mergedFrom.includes(f.customer_id)).map((f) => `${f.kind}:${f.value}`));
  const cardAllowed = stored.some((s) => s.isCard) ? await hasConsent(ctx, customerId, 'card_recognition') : false;
  for (const s of stored) {
    if (have.has(`${s.kind}:${s.value}`)) continue;
    if (s.isCard && !cardAllowed) continue;
    const inserted = await ctx.db
      .insertInto('customer_identities')
      .values({
        org_id: ctx.orgId,
        customer_id: customerId,
        kind: s.kind,
        value: s.value,
        source: input.via,
        verified_at: input.verified && (s.kind === 'email' || s.kind === 'phone') ? ctx.now() : null,
      })
      .onConflict((oc) => oc.columns(['org_id', 'kind', 'value']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) {
      // Lost a race: another transaction attached this identity to a different record. Same person.
      const holder = await ctx.db
        .selectFrom('customer_identities')
        .select('customer_id')
        .where('kind', '=', s.kind)
        .where('value', '=', s.value)
        .executeTakeFirst();
      if (holder && holder.customer_id !== customerId) {
        await mergeCustomersUnchecked(ctx, { winnerId: holder.customer_id, loserId: customerId, reason: `shared identity seen via ${input.via}` });
        mergedFrom.push(customerId);
        customerId = holder.customer_id;
        created = false;
      }
    }
  }

  if (input.verified) {
    const verifiable = strong.filter((s) => s.kind === 'email' || s.kind === 'phone');
    for (const s of verifiable) {
      await ctx.db
        .updateTable('customer_identities')
        .set({ verified_at: ctx.now() })
        .where('customer_id', '=', customerId)
        .where('kind', '=', s.kind)
        .where('value', '=', s.value)
        .where('verified_at', 'is', null)
        .execute();
    }
  }

  // Fill blanks on an existing record; never overwrite what is there.
  if (!created) {
    const email = strong.find((s) => s.kind === 'email')?.value;
    const phone = strong.find((s) => s.kind === 'phone')?.value;
    const hintName = input.hints.find((h) => h.firstName || h.lastName);
    const first = input.profile?.firstName ?? hintName?.firstName;
    const last = input.profile?.lastName ?? hintName?.lastName;
    if (email || phone || first || last || input.profile?.birthday) {
      await ctx.db
        .updateTable('customers')
        .set((eb) => ({
          ...(email ? { primary_email: eb.fn.coalesce('primary_email', eb.val(email)) } : {}),
          ...(phone ? { primary_phone: eb.fn.coalesce('primary_phone', eb.val(phone)) } : {}),
          ...(first ? { first_name: eb.fn.coalesce('first_name', eb.val(first)) } : {}),
          ...(last ? { last_name: eb.fn.coalesce('last_name', eb.val(last)) } : {}),
          ...(input.profile?.birthday ? { birthday: eb.fn.coalesce('birthday', eb.val(input.profile.birthday)) } : {}),
        }))
        .where('id', '=', customerId)
        .execute();
    }
  }

  return { customerId, created, mergedFrom };
}

/**
 * Link the card a consenting guest just paid with, so later taps are recognised. Requires the
 * card-recognition consent; without it nothing is stored. Returns how many links were added.
 */
export async function linkCard(ctx: Ctx, customerId: string, hints: IdentityHint[], via: string): Promise<number> {
  const cards = hints.filter((h) => h.kind === 'card_fingerprint' || h.kind === 'card_par');
  if (!cards.length) return 0;
  if (!(await hasConsent(ctx, customerId, 'card_recognition'))) return 0;
  const stored = await toStoredIdentities(ctx.app, ctx.orgId, cards);
  let added = 0;
  for (const s of stored) {
    const r = await ctx.db
      .insertInto('customer_identities')
      .values({ org_id: ctx.orgId, customer_id: customerId, kind: s.kind, value: s.value, source: via })
      .onConflict((oc) => oc.columns(['org_id', 'kind', 'value']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (r) added++;
  }
  return added;
}
