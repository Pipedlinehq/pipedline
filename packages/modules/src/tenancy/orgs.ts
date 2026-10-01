import { z } from 'zod';
import {
  type App,
  type Ctx,
  type PlatformCtx,
  AppError,
  audit,
  conflict,
  forbidden,
  invalid,
  isUniqueViolation,
  json,
  listModuleDefs,
  notFound,
  requireOwner,
  requireStaff,
} from '@ros/core';
import { PLATFORM_ONLY_NAMESPACES } from './quota';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'console', 'hub', 'mcp', 'mail', 'status', 'platform', 'static', 'assets']);

export const createOrgInput = z.object({
  slug: z.string().toLowerCase().regex(SLUG, 'Use 3–40 lowercase letters, numbers or hyphens.'),
  legalName: z.string().min(1).max(200),
  tradingName: z.string().min(1).max(200),
  abn: z.string().max(20).optional(),
  timezone: z.string().default('Australia/Sydney'),
  currency: z.string().length(3).default('AUD'),
  cuisineTags: z.array(z.string()).default([]),
  priceBand: z.number().int().min(1).max(4).optional(),
  owner: z.object({
    email: z.string().email().toLowerCase(),
    firstName: z.string().min(1),
    lastName: z.string().optional(),
    phone: z.string().optional(),
  }),
  venue: z.object({
    slug: z.string().toLowerCase().regex(SLUG).optional(),
    name: z.string().min(1),
    timezone: z.string().optional(),
    addressLine1: z.string().optional(),
    suburb: z.string().optional(),
    state: z.string().optional(),
    postcode: z.string().optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    capacity: z.number().int().positive().optional(),
  }),
  /** Module keys to switch on at the first venue. Dependencies must be included. */
  modules: z.array(z.string()).default([]),
});
export type CreateOrgInput = z.input<typeof createOrgInput>;

export interface CreatedOrg {
  orgId: string;
  venueId: string;
  ownerUserId: string;
  ownerStaffId: string;
  host: string;
}

/**
 * Creates an org, its first venue, the owner, and a live subdomain. Platform code only:
 * this is the first step of provisioning (docs/ONBOARDING.md section 3) and what fixtures use.
 */
export async function createOrg(pctx: PlatformCtx, raw: CreateOrgInput): Promise<CreatedOrg> {
  const input = createOrgInput.parse(raw);
  if (RESERVED.has(input.slug)) throw invalid('That address is reserved. Choose another.');
  const db = pctx.db;

  let org;
  try {
    org = await db
      .insertInto('orgs')
      .values({
        slug: input.slug,
        legal_name: input.legalName,
        trading_name: input.tradingName,
        abn: input.abn ?? null,
        timezone: input.timezone,
        currency: input.currency,
        cuisine_tags: input.cuisineTags,
        price_band: input.priceBand ?? null,
      })
      .returning(['id', 'slug'])
      .executeTakeFirstOrThrow();
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('That address is already taken.');
    throw e;
  }

  const venue = await db
    .insertInto('venues')
    .values({
      org_id: org.id,
      slug: input.venue.slug ?? 'main',
      name: input.venue.name,
      timezone: input.venue.timezone ?? input.timezone,
      address_line1: input.venue.addressLine1 ?? null,
      suburb: input.venue.suburb ?? null,
      state: input.venue.state ?? null,
      postcode: input.venue.postcode ?? null,
      lat: input.venue.lat ?? null,
      lng: input.venue.lng ?? null,
      phone: input.venue.phone ?? null,
      email: input.venue.email ?? null,
      capacity: input.venue.capacity ?? null,
      cuisine_tags: input.cuisineTags,
      price_band: input.priceBand ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const user = await db
    .insertInto('users')
    .values({ email: input.owner.email, name: [input.owner.firstName, input.owner.lastName].filter(Boolean).join(' '), phone: input.owner.phone ?? null })
    .onConflict((oc) => oc.column('email').doUpdateSet((eb) => ({ email: eb.ref('excluded.email') })))
    .returning('id')
    .executeTakeFirstOrThrow();

  const staff = await db
    .insertInto('staff')
    .values({
      org_id: org.id,
      user_id: user.id,
      first_name: input.owner.firstName,
      last_name: input.owner.lastName ?? null,
      email: input.owner.email,
      phone: input.owner.phone ?? null,
      is_owner: true,
      status: 'active',
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await db.insertInto('staff_venues').values({ org_id: org.id, staff_id: staff.id, venue_id: venue.id, role: 'owner' }).execute();

  const host = `${org.slug}.${pctx.app.config.tenantRootDomain}`;
  await db
    .insertInto('domains')
    .values({ org_id: org.id, venue_id: null, host, kind: 'subdomain', is_primary: true, verified_at: pctx.now() })
    .execute();

  const wanted = new Set(input.modules);
  for (const def of listModuleDefs()) {
    if (def.spine || !wanted.has(def.key)) continue;
    const missing = def.dependsOn.filter((d) => !wanted.has(d) && !listModuleDefs().find((m) => m.key === d)?.spine);
    if (missing.length) throw invalid(`${def.name} needs ${missing.join(', ')} switched on too.`);
    await db
      .insertInto('venue_modules')
      .values({
        org_id: org.id,
        venue_id: venue.id,
        module_key: def.key,
        enabled: true,
        config: json(def.defaultConfig),
        config_version: def.configVersion,
        enabled_at: pctx.now(),
      })
      .execute();
  }

  return { orgId: org.id, venueId: venue.id, ownerUserId: user.id, ownerStaffId: staff.id, host };
}

export interface OrgView {
  id: string;
  slug: string;
  legalName: string;
  tradingName: string;
  abn: string | null;
  country: string;
  currency: string;
  timezone: string;
  taxInclusive: boolean;
  taxRateBp: number;
  status: 'onboarding' | 'live' | 'paused' | 'closed';
  plan: string;
  cuisineTags: string[];
  priceBand: number | null;
  benchmarkOptIn: boolean;
  settings: Record<string, unknown>;
}

/** The org this transaction acts for. No role check: every principal may know whose site it is on. */
export async function getOrg(ctx: Ctx): Promise<OrgView> {
  const r = await ctx.db.selectFrom('orgs').selectAll().where('id', '=', ctx.orgId).executeTakeFirst();
  if (!r) throw notFound('Organisation not found');
  return {
    id: r.id,
    slug: r.slug,
    legalName: r.legal_name,
    tradingName: r.trading_name,
    abn: r.abn,
    country: r.country,
    currency: r.currency,
    timezone: r.timezone,
    taxInclusive: r.tax_inclusive,
    taxRateBp: r.tax_rate_bp,
    status: r.status,
    plan: r.plan,
    cuisineTags: r.cuisine_tags,
    priceBand: r.price_band,
    benchmarkOptIn: r.benchmark_opt_in,
    settings: (r.settings ?? {}) as Record<string, unknown>,
  };
}

export const updateOrgInput = z
  .object({
    tradingName: z.string().min(1).max(200),
    legalName: z.string().min(1).max(200),
    abn: z.string().max(20).nullable(),
    cuisineTags: z.array(z.string()),
    priceBand: z.number().int().min(1).max(4).nullable(),
    benchmarkOptIn: z.boolean(),
  })
  .partial();

export async function updateOrg(ctx: Ctx, raw: z.input<typeof updateOrgInput>): Promise<OrgView> {
  requireOwner(ctx);
  const input = updateOrgInput.parse(raw);
  const before = await getOrg(ctx);
  await ctx.db
    .updateTable('orgs')
    .set({
      ...(input.tradingName !== undefined ? { trading_name: input.tradingName } : {}),
      ...(input.legalName !== undefined ? { legal_name: input.legalName } : {}),
      ...(input.abn !== undefined ? { abn: input.abn } : {}),
      ...(input.cuisineTags !== undefined ? { cuisine_tags: input.cuisineTags } : {}),
      ...(input.priceBand !== undefined ? { price_band: input.priceBand } : {}),
      ...(input.benchmarkOptIn !== undefined ? { benchmark_opt_in: input.benchmarkOptIn } : {}),
    })
    .where('id', '=', ctx.orgId)
    .execute();
  const after = await getOrg(ctx);
  await audit(ctx, { action: 'org.updated', entityType: 'org', entityId: ctx.orgId, before, after });
  return after;
}

/**
 * Org-level settings live in orgs.settings under a namespace per module, each with its own
 * schema. A module reads and writes only its own namespace.
 */
export async function getOrgSettings<T>(ctx: Ctx, namespace: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  const r = await ctx.db.selectFrom('orgs').select('settings').where('id', '=', ctx.orgId).executeTakeFirstOrThrow();
  const stored = ((r.settings ?? {}) as Record<string, unknown>)[namespace];
  if (stored === undefined) return fallback;
  const parsed = schema.safeParse(stored);
  return parsed.success ? parsed.data : fallback;
}

export async function setOrgSettings<T>(ctx: Ctx, namespace: string, schema: z.ZodType<T>, value: T): Promise<T> {
  requireStaff(ctx, { minRole: 'manager' });
  // What the platform sets for an organisation (its quota) is not the organisation's to change.
  if (PLATFORM_ONLY_NAMESPACES.has(namespace)) throw forbidden('Only the platform team can change that.');
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid('That setting is not valid.', { issues: parsed.error.issues });
  const r = await ctx.db.selectFrom('orgs').select('settings').where('id', '=', ctx.orgId).executeTakeFirstOrThrow();
  const settings = { ...((r.settings ?? {}) as Record<string, unknown>), [namespace]: parsed.data };
  await ctx.db.updateTable('orgs').set({ settings: json(settings) }).where('id', '=', ctx.orgId).execute();
  await audit(ctx, { action: 'org.settings', entityType: 'org', entityId: ctx.orgId, after: { namespace } });
  return parsed.data;
}

export async function setOrgStatus(pctx: PlatformCtx, orgId: string, status: OrgView['status']): Promise<void> {
  const r = await pctx.db.updateTable('orgs').set({ status }).where('id', '=', orgId).returning('id').executeTakeFirst();
  if (!r) throw new AppError('not_found', 'Organisation not found');
}

/** Every live org, for platform schedulers. Narrow by design: ids and time zones only. */
export async function listActiveOrgs(app: App): Promise<Array<{ id: string; slug: string; timezone: string }>> {
  return app.db.selectFrom('orgs').select(['id', 'slug', 'timezone']).where('status', 'in', ['onboarding', 'live']).execute();
}
