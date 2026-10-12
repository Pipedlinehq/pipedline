import { z } from 'zod';
import { type Ctx, AppError, GUEST_FACING_ROLES, audit, isInternal, notFound, requireOwner, requireStaff, sql, staffOf, hookList, keyedRegistry } from '@ros/core';
import { getConsents } from './consents';
import { type ListFrame, listWhere, parseListQuery } from './lists';
import { normaliseEmail, normalisePhone } from './normalise';

export interface CustomerView {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  birthday: string | null;
  /** Where they live, as they or staff gave it. Lists can ask "suburb is Newtown". */
  suburb: string | null;
  postcode: string | null;
  allergyNotes: string | null;
  /** Staff-only. Never returned to the guest or to an assistant. */
  notes: string | null;
  firstSeenVenueId: string | null;
  acquisition: { source: string; creatorId: string | null; campaignId: string | null; code: string | null; at: Date };
  createdAt: Date;
}

const COLS = [
  'id',
  'first_name',
  'last_name',
  'primary_email',
  'primary_phone',
  'birthday',
  'suburb',
  'postcode',
  'allergy_notes',
  'notes',
  'first_seen_venue_id',
  'acquisition_source',
  'acquisition_creator_id',
  'acquisition_campaign_id',
  'acquisition_code',
  'acquisition_at',
  'created_at',
  'status',
  'merged_into_id',
] as const;

/** Who may read a customer record: staff at front-of-house level or above, the guest themself, internal code. */
function assertMayRead(ctx: Ctx, customerId: string): 'staff' | 'guest' | 'internal' {
  if (isInternal(ctx)) return 'internal';
  if (staffOf(ctx)) {
    requireStaff(ctx, { anyOf: GUEST_FACING_ROLES });
    return 'staff';
  }
  if (ctx.principal.kind === 'guest' && ctx.principal.customerId === customerId) return 'guest';
  throw new AppError('not_found', 'Customer not found');
}

export async function getCustomer(ctx: Ctx, customerId: string): Promise<CustomerView> {
  const who = assertMayRead(ctx, customerId);
  let r = await ctx.db.selectFrom('customers').select(COLS).where('id', '=', customerId).executeTakeFirst();
  // A merged record answers as the record it was merged into.
  if (r?.status === 'merged' && r.merged_into_id && who !== 'guest') {
    r = await ctx.db.selectFrom('customers').select(COLS).where('id', '=', r.merged_into_id).executeTakeFirst();
  }
  if (!r || r.status !== 'active') throw notFound('Customer not found');
  return {
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.primary_email,
    phone: r.primary_phone,
    birthday: r.birthday,
    suburb: r.suburb,
    postcode: r.postcode,
    allergyNotes: r.allergy_notes,
    notes: who === 'guest' ? null : r.notes,
    firstSeenVenueId: r.first_seen_venue_id,
    acquisition: {
      source: r.acquisition_source,
      creatorId: r.acquisition_creator_id,
      campaignId: r.acquisition_campaign_id,
      code: r.acquisition_code,
      at: r.acquisition_at,
    },
    createdAt: r.created_at,
  };
}

export interface CustomerSummary {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  allergyNotes: string | null;
  createdAt: Date;
}

/** Find customers by name, email or phone. Staff only. */
export async function searchCustomers(ctx: Ctx, args: { q: string; limit?: number }): Promise<CustomerSummary[]> {
  requireStaff(ctx, { anyOf: GUEST_FACING_ROLES });
  const q = args.q.trim();
  if (q.length < 2) return [];
  const limit = Math.min(args.limit ?? 20, 50);
  const email = normaliseEmail(q);
  const phone = /\d{6,}/.test(q.replace(/\D/g, '')) ? normalisePhone(q) : null;
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const rows = await ctx.db
    .selectFrom('customers')
    .select(['id', 'first_name', 'last_name', 'primary_email', 'primary_phone', 'allergy_notes', 'created_at'])
    .where('status', '=', 'active')
    .where((eb) =>
      eb.or([
        ...(email ? [eb('primary_email', '=', email)] : []),
        ...(phone ? [eb('primary_phone', '=', phone)] : []),
        eb('first_name', 'ilike', like),
        eb('last_name', 'ilike', like),
        eb('primary_email', 'ilike', like),
        eb(sql<string>`coalesce(first_name, '') || ' ' || coalesce(last_name, '')`, 'ilike', like),
      ]),
    )
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Guest',
    email: r.primary_email,
    phone: r.primary_phone,
    allergyNotes: r.allergy_notes,
    createdAt: r.created_at,
  }));
}

export const listCustomersInput = z
  .object({
    /** Visits are counted at this venue; omitted, at every venue the caller can see. */
    venueId: z.string().uuid().optional(),
    /** Name, email or phone, as a search box would send it. */
    q: z.string().trim().max(100).optional(),
    /** Guests first known on or after this instant ("new this month"). */
    createdSince: z.date().optional(),
    /** Guests holding this consent right now ("said yes to email"). */
    consent: z.enum(['marketing_email', 'marketing_sms', 'card_recognition', 'ad_platform_sharing']).optional(),
    /** Guests with at least this many sales in the last `withinDays` days ("regulars": 3 in 90). */
    regular: z.object({ minVisits: z.number().int().min(1).max(100), withinDays: z.number().int().min(1).max(730) }).optional(),
    /** Guests who have been in before but not for this many days ("lapsed 60+ days"). */
    lapsedDays: z.number().int().min(1).max(730).optional(),
    /** A guest-list rule in the plain query language (lists.ts), e.g. "last visit more than 60 days ago and said yes to email". */
    query: z.string().trim().min(1).max(600).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();

export interface CustomerListRow extends CustomerSummary {
  /** Sales in the ledger tied to this guest (at the venue asked for, or everywhere the caller sees). */
  visits: number;
  lastVisitAt: Date | null;
}

/**
 * Guests as a list (docs/CONSOLE_IA.md section 9, wave 1: the Customers index with its views).
 * Staff who deal with guests, and managers. Visits come from the sales ledger (a spine table
 * identity may read); consent from the guest's own current consents. Most recent visit first.
 */
export async function listCustomers(ctx: Ctx, raw: z.input<typeof listCustomersInput> = {}): Promise<CustomerListRow[]> {
  const input = listCustomersInput.parse(raw);
  requireStaff(ctx, { ...(input.venueId ? { venueId: input.venueId } : {}), anyOf: GUEST_FACING_ROLES });
  const now = ctx.now();
  const visits = ctx.db
    .selectFrom('transactions')
    .select((eb) => ['customer_id', eb.fn.count<string>('id').as('visits'), eb.fn.max('occurred_at').as('last_visit_at')])
    .where('customer_id', 'is not', null)
    .where('status', '<>', 'voided')
    .$if(!!input.venueId, (qb) => qb.where('venue_id', '=', input.venueId!))
    .groupBy('customer_id')
    .as('v');
  let q = ctx.db
    .selectFrom('customers as c')
    .leftJoin(visits, 'v.customer_id', 'c.id')
    .select(['c.id', 'c.first_name', 'c.last_name', 'c.primary_email', 'c.primary_phone', 'c.allergy_notes', 'c.created_at', 'v.visits', 'v.last_visit_at'])
    .where('c.status', '=', 'active')
    .orderBy(sql`coalesce(v.last_visit_at, c.created_at)`, 'desc')
    .limit(input.limit);
  const needle = input.q?.trim() ?? '';
  if (needle.length >= 2) {
    const email = normaliseEmail(needle);
    const phone = /\d{6,}/.test(needle.replace(/\D/g, '')) ? normalisePhone(needle) : null;
    const like = `%${needle.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    q = q.where((eb) =>
      eb.or([
        ...(email ? [eb('c.primary_email', '=', email)] : []),
        ...(phone ? [eb('c.primary_phone', '=', phone)] : []),
        eb('c.first_name', 'ilike', like),
        eb('c.last_name', 'ilike', like),
        eb('c.primary_email', 'ilike', like),
        eb(sql<string>`coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')`, 'ilike', like),
      ]),
    );
  }
  if (input.createdSince) q = q.where('c.created_at', '>=', input.createdSince);
  if (input.consent) {
    q = q.where((eb) => eb.exists(eb.selectFrom('consents as k').select('k.id').whereRef('k.customer_id', '=', 'c.id').where('k.purpose', '=', input.consent!).where('k.status', '=', 'granted')));
  }
  if (input.regular) {
    const since = new Date(now.getTime() - input.regular.withinDays * 86_400_000);
    const min = input.regular.minVisits;
    const atVenue = input.venueId ? sql` and t.venue_id = ${input.venueId}` : sql``;
    q = q.where(sql<boolean>`(select count(*) from transactions t where t.customer_id = c.id and t.status <> 'voided' and t.occurred_at >= ${since}${atVenue}) >= ${min}`);
  }
  if (input.lapsedDays) {
    const cutoff = new Date(now.getTime() - input.lapsedDays * 86_400_000);
    q = q.where('v.last_visit_at', 'is not', null).where('v.last_visit_at', '<', cutoff);
  }
  if (input.query) {
    // The rule is parsed to a tree and compiled to parameterised SQL; the text never reaches the query.
    const node = parseListQuery(input.query);
    const frame: ListFrame = { now, venueId: input.venueId ?? null };
    q = q.where(sql<boolean>`${listWhere(ctx, node, frame)}`);
  }
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Guest',
    email: r.primary_email,
    phone: r.primary_phone,
    allergyNotes: r.allergy_notes,
    createdAt: r.created_at,
    visits: Number(r.visits ?? 0),
    lastVisitAt: r.last_visit_at ?? null,
  }));
}

export const updateCustomerInput = z
  .object({
    firstName: z.string().max(100).nullable(),
    lastName: z.string().max(100).nullable(),
    birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    suburb: z.string().trim().max(80).nullable(),
    postcode: z.string().trim().max(12).nullable(),
    allergyNotes: z.string().max(2000).nullable(),
    notes: z.string().max(5000).nullable(),
  })
  .partial();

export async function updateCustomer(ctx: Ctx, customerId: string, raw: z.input<typeof updateCustomerInput>): Promise<CustomerView> {
  const who = assertMayRead(ctx, customerId);
  const input = updateCustomerInput.parse(raw);
  const before = await getCustomer(ctx, customerId);
  await ctx.db
    .updateTable('customers')
    .set({
      ...(input.firstName !== undefined ? { first_name: input.firstName } : {}),
      ...(input.lastName !== undefined ? { last_name: input.lastName } : {}),
      ...(input.birthday !== undefined ? { birthday: input.birthday } : {}),
      ...(input.suburb !== undefined ? { suburb: input.suburb || null } : {}),
      ...(input.postcode !== undefined ? { postcode: input.postcode || null } : {}),
      ...(input.allergyNotes !== undefined ? { allergy_notes: input.allergyNotes } : {}),
      ...(input.notes !== undefined && who !== 'guest' ? { notes: input.notes } : {}),
    })
    .where('id', '=', customerId)
    .execute();
  const after = await getCustomer(ctx, customerId);
  await audit(ctx, { action: 'customer.updated', entityType: 'customer', entityId: customerId, before: { ...before, email: undefined, phone: undefined }, after: { ...after, email: undefined, phone: undefined } });
  return after;
}

type DataProvider = (ctx: Ctx, customerId: string) => Promise<unknown>;
const dataProviders = keyedRegistry<DataProvider>('identity.dataProviders');
type EraseHandler = (ctx: Ctx, customerId: string) => Promise<void>;
const eraseHandlers = hookList<EraseHandler>('identity.eraseHandlers');

/** A module that holds data about a customer contributes it to the guest's export here. */
export function registerCustomerDataProvider(name: string, provider: DataProvider): void {
  dataProviders.set(name, provider);
}

/** A module that holds personal data about a customer removes or anonymises it here. */
export function onCustomerErase(handler: EraseHandler): void {
  eraseHandlers.add(handler);
}

/** Everything held about one guest, for the guest or the owner. */
export async function exportCustomer(ctx: Ctx, customerId: string): Promise<Record<string, unknown>> {
  const who = assertMayRead(ctx, customerId);
  if (who === 'staff') requireOwner(ctx);
  const customer = await getCustomer(ctx, customerId);
  const identities = await ctx.db
    .selectFrom('customer_identities')
    .select(['kind', 'value', 'verified_at', 'created_at'])
    .where('customer_id', '=', customerId)
    .execute();
  const transactions = await ctx.db
    .selectFrom('transactions')
    .select(['id', 'occurred_at', 'venue_id', 'channel', 'total_cents', 'currency', 'status'])
    .where('customer_id', '=', customerId)
    .orderBy('occurred_at')
    .execute();
  const out: Record<string, unknown> = {
    customer: { ...customer, notes: undefined },
    // A recognised card is shown as the fact that one is linked, not the stored hash.
    identities: identities.map((i) => (i.kind.startsWith('card_') ? { kind: i.kind, value: '(linked)', linkedAt: i.created_at } : i)),
    consents: await getConsents(ctx, customerId),
    transactions,
  };
  for (const [name, provider] of dataProviders) out[name] = await provider(ctx, customerId);
  await audit(ctx, { action: 'customer.exported', entityType: 'customer', entityId: customerId });
  return out;
}

/**
 * Erase a guest at their request. Contact details, identities and consents go; the ledger keeps
 * its rows with the customer unlinked, because the venue's sales figures are not the guest's data.
 */
export async function eraseCustomer(ctx: Ctx, customerId: string): Promise<void> {
  const who = assertMayRead(ctx, customerId);
  if (who === 'staff') requireOwner(ctx);
  const r = await ctx.db.selectFrom('customers').select(['id', 'status']).where('id', '=', customerId).executeTakeFirst();
  if (!r || r.status === 'deleted') throw notFound('Customer not found');

  for (const h of eraseHandlers.all()) await h(ctx, customerId);
  await ctx.db.deleteFrom('customer_identities').where('customer_id', '=', customerId).execute();
  await ctx.db.deleteFrom('consents').where('customer_id', '=', customerId).execute();
  await ctx.db.updateTable('transactions').set({ customer_id: null }).where('customer_id', '=', customerId).execute();
  await ctx.db.updateTable('transaction_attributions').set({ customer_id: null }).where('customer_id', '=', customerId).execute();
  await ctx.db.updateTable('visitor_sessions').set({ customer_id: null }).where('customer_id', '=', customerId).execute();
  await ctx.db
    .updateTable('customers')
    .set({
      status: 'deleted',
      primary_email: null,
      primary_phone: null,
      first_name: null,
      last_name: null,
      birthday: null,
      allergy_notes: null,
      notes: null,
    })
    .where('id', '=', customerId)
    .execute();
  await audit(ctx, { action: 'customer.erased', entityType: 'customer', entityId: customerId });
}
