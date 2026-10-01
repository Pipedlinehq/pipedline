import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type App, type Principal, AppError, audit, conflict, json, notFound, parsePatch, rateLimit, sql } from '@ros/core';
import { membershipsOf } from '../auth/sessions';
import { ORG_QUOTA_NAMESPACE, type OrgQuota, orgQuota, writeOrgQuota } from '../tenancy/quota';
import { plainText } from '../website/safe';
import { INTAKE_VERSION } from './intake';
import { requirePlatformAdmin } from './platform';
import { runProvisioning } from './provisioning';

/**
 * Self-serve start (docs/PIPEDLINE.md "What has to change" section 1). A person who has proved
 * their email by signing in gets an organisation and one draft venue with themself as owner,
 * and provisioning runs by itself: no platform admin lets them in.
 *
 * It is the same machinery the platform path uses. This opens an onboarding (origin
 * `self_serve`) with a short intake, and runs the same registered provisioning steps over it.
 * What a finished intake would have carried (address, hours, services, copy) is not known yet:
 * the owner, or their assistant through the setup tools, fills it in afterwards, and the venue
 * stays a draft (org `onboarding`, venue `setup`) until its owner takes it live.
 *
 * The service is free, so what stands between it and abuse is here:
 *   - the email is proved (a staff session exists only after a one-time code was entered);
 *   - one draft organisation per person: a second start returns the first. Only someone who
 *     already owns a live organisation may start another, and then only one at a time;
 *   - starts are rate-limited per person and per address, new organisations per address per day;
 *   - a free organisation holds a capped number of venues (tenancy `quota.max_venues`).
 */
export const SELF_SERVE_LIMITS = {
  /** Calls to start, per person. A repeat call is cheap, but it is still a call. */
  perPerson: { limit: 5, windowSeconds: 3600 },
  /** Calls to start, per client address. */
  perAddress: { limit: 20, windowSeconds: 3600 },
  /** New organisations from one client address in a day. */
  newOrgsPerAddress: { limit: 3, windowSeconds: 86_400 },
} as const;

const TOO_MANY = 'Too many venues have been started from here. Try again later.';

const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Choose a time zone such as Australia/Sydney.');

export const selfServeStartInput = z.object({
  /** What the venue is called. The site address is made from it. */
  venueName: plainText(200),
  /** The owner's first name. When absent, the start of their email address stands in until they change it. */
  firstName: plainText(80).optional(),
  timezone: timezone.default('Australia/Sydney'),
  /** Start a further organisation. Only for a person who already owns a live one and has no draft. */
  another: z.boolean().default(false),
});
export type SelfServeStartInput = z.input<typeof selfServeStartInput>;

export interface SelfServeStart {
  orgId: string;
  venueId: string | null;
  onboardingId: string | null;
  /** The platform subdomain the venue's site answers on. */
  host: string | null;
  /** False when the person was returned to an organisation they already belong to. */
  created: boolean;
}

const RESERVED = new Set(['www', 'app', 'api', 'admin', 'console', 'hub', 'mcp', 'mail', 'status', 'platform', 'static', 'assets']);

function slugBase(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return s.length >= 3 ? s : `venue-${s || 'new'}`.replace(/-+$/g, '');
}

/** A site address nobody holds. Platform read: slugs are unique across every organisation. */
async function freeSlug(db: App['db'], name: string, salt: string): Promise<string> {
  const base = slugBase(name);
  const candidates = [base, ...[0, 1, 2, 3].map((i) => `${base}-${salt.replace(/-/g, '').slice(i * 4, i * 4 + 4)}`)];
  for (const slug of candidates) {
    if (RESERVED.has(slug)) continue;
    const taken = await db.selectFrom('orgs').select('id').where('slug', '=', slug).executeTakeFirst();
    if (!taken) return slug;
  }
  throw conflict('That name could not be given a site address. Try a slightly different name.');
}

function firstNameFrom(email: string): string {
  const local = email.split('@')[0] ?? '';
  const word = local.split(/[^a-zA-Z]+/).find((w) => w.length > 1) ?? 'Owner';
  return word[0]!.toUpperCase() + word.slice(1).toLowerCase();
}

async function describe(app: App, orgId: string, created: boolean): Promise<SelfServeStart> {
  // Platform read, for the person who has just been made (or found to be) a member of this org.
  const onboarding = await app.db.selectFrom('onboardings').select('id').where('org_id', '=', orgId).executeTakeFirst();
  const venue = await app.db.selectFrom('venues').select('id').where('org_id', '=', orgId).where('status', '!=', 'closed').orderBy('created_at').executeTakeFirst();
  const domain = await app.db.selectFrom('domains').select('host').where('org_id', '=', orgId).where('is_primary', '=', true).where('verified_at', 'is not', null).executeTakeFirst();
  return { orgId, venueId: venue?.id ?? null, onboardingId: onboarding?.id ?? null, host: domain?.host ?? null, created };
}

/**
 * Start a venue for the person signed in. `actor` is the principal their session resolved to
 * (auth.authenticate): a staff principal, with or without an organisation chosen. Returns the
 * organisation to act for; the caller then points the session at it (auth.selectOrg).
 *
 * Takes the App, not a Ctx: the organisation does not exist until provisioning's first step
 * has run, so this is platform work by nature (CLAUDE.md rule 1: sign-in and provisioning).
 */
export async function selfServeStart(app: App, actor: Principal, raw: SelfServeStartInput, meta: { ip?: string } = {}): Promise<SelfServeStart> {
  if (actor.kind !== 'staff' || !actor.userId) throw new AppError('unauthenticated', 'Sign in with your email address to start.');
  const input = selfServeStartInput.parse(raw);
  const userId = actor.userId;

  await rateLimit(app, `selfserve:user:${userId}`, SELF_SERVE_LIMITS.perPerson, TOO_MANY);
  if (meta.ip) await rateLimit(app, `selfserve:ip:${meta.ip}`, SELF_SERVE_LIMITS.perAddress, TOO_MANY);

  // The user row is what the sign-in proved; nothing about who this is comes from the request.
  const user = await app.db.selectFrom('users').select(['id', 'email', 'name']).where('id', '=', userId).executeTakeFirst();
  if (!user) throw new AppError('unauthenticated', 'Sign in with your email address to start.');

  const decided = await app.platform('self-serve start', async (pctx) => {
    // Two starts by one person at once must not make two organisations.
    await sql`select pg_advisory_xact_lock(hashtext(${`selfserve:${userId}`}))`.execute(pctx.db);

    const memberships = await membershipsOf(app, userId);
    const owned = memberships.filter((m) => m.isOwner);
    const statuses = owned.length ? await pctx.db.selectFrom('orgs').select(['id', 'status']).where('id', 'in', owned.map((m) => m.orgId)).execute() : [];
    const draft = owned.find((m) => statuses.find((s) => s.id === m.orgId)?.status === 'onboarding');
    const ownsLive = statuses.some((s) => s.status === 'live');

    // Someone who already belongs somewhere is returned to it, not given a second organisation.
    if (memberships.length && !(input.another && ownsLive && !draft)) {
      return { kind: 'existing' as const, orgId: (draft ?? owned[0] ?? memberships[0]!).orgId };
    }

    // A start that was opened but whose organisation was never made (a crash, a lost race for the address) is taken up again.
    const open = await pctx.db
      .selectFrom('onboardings')
      .select(['id', 'intake'])
      .where('started_by_user_id', '=', userId)
      .where('origin', '=', 'self_serve')
      .where('org_id', 'is', null)
      .executeTakeFirst();
    if (open) {
      const intake = (open.intake ?? {}) as { identity?: { slug?: string } };
      const slug = await freeSlug(pctx.db, input.venueName, open.id);
      if (intake.identity && intake.identity.slug !== slug) {
        await pctx.db.updateTable('onboardings').set({ intake: json({ ...intake, identity: { ...intake.identity, slug } }) }).where('id', '=', open.id).execute();
      }
      return { kind: 'run' as const, onboardingId: open.id };
    }

    if (meta.ip) await rateLimit(app, `selfserve:new:${meta.ip}`, SELF_SERVE_LIMITS.newOrgsPerAddress, TOO_MANY);

    const id = randomUUID();
    const slug = await freeSlug(pctx.db, input.venueName, id);
    const firstName = input.firstName ?? user.name?.split(/\s+/)[0] ?? firstNameFrom(user.email);
    const intake = {
      identity: { legalName: input.venueName, tradingName: input.venueName, slug, primaryContact: { firstName, email: user.email } },
      brand: { skeleton: 'minimal' },
      venues: { venues: [{ name: input.venueName, timezone: input.timezone }] },
    };
    const now = pctx.now();
    await pctx.db
      .insertInto('onboardings')
      .values({ id, org_id: null, status: 'intake', origin: 'self_serve', started_by_user_id: userId, intake: json(intake), intake_progress: json({}), intake_version: INTAKE_VERSION, sold_at: now })
      .execute();
    return { kind: 'run' as const, onboardingId: id };
  });

  if (decided.kind === 'existing') return describe(app, decided.orgId, false);

  // The same provisioning run the platform path queues as a job, run now: nothing in a
  // self-serve start waits on a provider, and the person is waiting for their venue.
  const run = await runProvisioning(app, decided.onboardingId);
  if (!run.orgId) {
    const failed = run.steps.find((s) => s.key === 'org');
    app.log.error('self-serve start: the organisation was not created', { onboardingId: decided.onboardingId, error: failed?.error ?? null });
    throw new AppError('unavailable', 'Your venue could not be set up just now. Try again in a moment.');
  }
  const orgId = run.orgId;

  await app.tenant(orgId, { kind: 'platform', reason: 'self-serve start' }, async (ctx) => {
    // The quota is written down once, so what a free organisation may hold is on its own record.
    // Checked rather than assumed: a start taken up again after a crash still gets it, and only once.
    const org = await ctx.db.selectFrom('orgs').select('settings').where('id', '=', ctx.orgId).executeTakeFirstOrThrow();
    if (((org.settings ?? {}) as Record<string, unknown>)[ORG_QUOTA_NAMESPACE] !== undefined) return;
    await writeOrgQuota(ctx, {});
    await audit(ctx, { action: 'org.self_serve_started', entityType: 'org', entityId: orgId, after: { onboardingId: decided.onboardingId, startedByUserId: userId } });
  });
  return describe(app, orgId, true);
}

/**
 * Raise or lower what one organisation may hold. Platform admin only: a quota is ours to set,
 * never the organisation's own (tenancy refuses the `quota` namespace to everyone else).
 */
export async function setOrgQuota(app: App, actor: Principal, raw: { orgId: string; quota: Partial<OrgQuota> }): Promise<OrgQuota> {
  const { adminUserId } = await requirePlatformAdmin(app, actor);
  if (!z.string().uuid().safeParse(raw.orgId).success) throw notFound('Organisation not found');
  const patch = parsePatch(orgQuota.partial(), raw.quota);
  // Platform read: does the organisation exist at all.
  const exists = await app.db.selectFrom('orgs').select('id').where('id', '=', raw.orgId).executeTakeFirst();
  if (!exists) throw notFound('Organisation not found');
  return app.tenant(raw.orgId, { kind: 'platform', adminUserId, reason: 'quota' }, (ctx) => writeOrgQuota(ctx, patch));
}
