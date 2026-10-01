import { z } from 'zod';
import { type App, type Ctx, type Principal, AppError, audit, forbidden, invalid, isAppError, isInternal, json, notFound, requireOwner, staffOf, track, keyedRegistry, register } from '@ros/core';
import { queueMessage } from '../comms/outbox';
import { defineTemplate } from '../comms/templates';
import { clearHostCache, listDomains, resolveHost } from '../tenancy/domains';
import { setOrgStatus } from '../tenancy/orgs';
import { updateVenue } from '../tenancy/venues';
import { listPublishedPages } from '../website/pages';
import { cacheTags, revalidateAfterCommit } from '../website/revalidate';
import { getSite } from '../website/site';
import { validateRestaurantJsonLd } from '../website/structured';
import { orgWentLive } from './module';
import { PROVISIONER, requirePlatformAdmin } from './platform';

/**
 * The go-live checklist (docs/ONBOARDING.md section 4): gated, not advisory. Each check is a
 * function that answers pass, fail or not-applicable with the reason in plain words, and an
 * org cannot be switched to live while any check fails. Modules add their own checks (menu
 * confirmed, a test payment taken, the kitchen screen paired …) to the registry.
 */
export type CheckStatus = 'pass' | 'fail' | 'not_applicable';

export interface CheckResult {
  status: CheckStatus;
  reason: string;
}

export interface GoLiveCheckContext {
  app: App;
  orgId: string;
  onboardingId: string;
  /** The org's venues that are not closed. */
  venues: Array<{ id: string; name: string }>;
  /** The intake as saved. */
  intake: Record<string, unknown>;
  /** What the owner has confirmed, by check key. */
  confirmations: Record<string, { at: string; staffId: string | null }>;
}

export interface GoLiveCheckDef {
  key: string;
  label: string;
  order: number;
  /** True when the check needs the owner's own yes (confirmGoLiveItem) as well as the facts. */
  needsOwnerConfirmation?: boolean;
  /**
   * For a check that needs the owner's yes: what exactly they are saying yes to, in plain words
   * (the hours themselves, the size of the menu). Throws an AppError when there is nothing to
   * confirm yet. Shown as the question before confirmGoLiveItem is called for them.
   */
  whatIsConfirmed?(c: GoLiveCheckContext): Promise<string>;
  /**
   * How a failing check is put right, for whoever is driving setup (an owner's assistant): the
   * assistant tool that does it, if one does, and whether only the owner in person can.
   */
  fix?: { how: string; tool?: string; ownerOnly?: boolean };
  /** Open tenant transactions as needed. Throwing counts as a fail: a check never passes by accident. */
  run(c: GoLiveCheckContext): Promise<CheckResult>;
}

const registry = keyedRegistry<GoLiveCheckDef>('onboarding.goLiveChecks');

export function registerGoLiveCheck(def: GoLiveCheckDef): GoLiveCheckDef {
  if (!/^[a-z][a-z0-9_]*$/.test(def.key)) throw new Error(`Go-live check ${def.key} must be snake_case`);
  return register(registry, def.key, def, 'Go-live check');
}

export function listGoLiveChecks(): GoLiveCheckDef[] {
  return [...registry.values()].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

/** For tests that register a check of their own. */
export function unregisterGoLiveCheck(key: string): void {
  registry.delete(key);
}

export interface ChecklistItem extends CheckResult {
  key: string;
  label: string;
  needsOwnerConfirmation: boolean;
  confirmedAt: string | null;
  fix: GoLiveCheckDef['fix'] | null;
}

export interface Checklist {
  onboardingId: string;
  orgId: string;
  /** True when nothing fails: the org may go live. */
  ready: boolean;
  items: ChecklistItem[];
}

const pass = (reason: string): CheckResult => ({ status: 'pass', reason });
const fail = (reason: string): CheckResult => ({ status: 'fail', reason });
const notApplicable = (reason: string): CheckResult => ({ status: 'not_applicable', reason });

async function checkContext(app: App, onboarding: { id: string; org_id: string | null; intake: unknown; confirmations: unknown }): Promise<GoLiveCheckContext> {
  if (!onboarding.org_id) throw invalid('The organisation has not been created yet. Run provisioning first.');
  const orgId = onboarding.org_id;
  const venues = await app.tenant(orgId, PROVISIONER, (ctx) => ctx.db.selectFrom('venues').select(['id', 'name']).where('status', '!=', 'closed').orderBy('created_at').execute());
  const confirmations = (onboarding.confirmations ?? {}) as GoLiveCheckContext['confirmations'];
  return { app, orgId, onboardingId: onboarding.id, venues, intake: (onboarding.intake ?? {}) as Record<string, unknown>, confirmations };
}

async function evaluate(app: App, onboarding: { id: string; org_id: string | null; intake: unknown; confirmations: unknown }): Promise<Checklist> {
  const c = await checkContext(app, onboarding);
  const { orgId, confirmations } = c;

  const items: ChecklistItem[] = [];
  for (const def of listGoLiveChecks()) {
    let result: CheckResult;
    try {
      result = await def.run(c);
    } catch (e) {
      result = fail(`This check could not be run: ${isAppError(e) ? e.message : 'an unexpected error'}.`);
    }
    items.push({ key: def.key, label: def.label, needsOwnerConfirmation: def.needsOwnerConfirmation ?? false, confirmedAt: confirmations[def.key]?.at ?? null, fix: def.fix ?? null, ...result });
  }
  return { onboardingId: onboarding.id, orgId, ready: items.every((i) => i.status !== 'fail'), items };
}

const ONBOARDING_COLS = ['id', 'org_id', 'status', 'origin', 'intake', 'confirmations', 'sold_at', 'live_at', 'manual_touch_minutes'] as const;

async function loadById(app: App, onboardingId: string) {
  if (!z.string().uuid().safeParse(onboardingId).success) throw notFound('Onboarding not found');
  // Platform read: the checklist is run by us, across whichever org is being onboarded.
  const row = await app.db.selectFrom('onboardings').select(ONBOARDING_COLS).where('id', '=', onboardingId).executeTakeFirst();
  if (!row) throw notFound('Onboarding not found');
  return row;
}

/** Run every check now. Platform side. */
export async function runGoLiveChecks(app: App, actor: Principal, input: { onboardingId: string }): Promise<Checklist> {
  await requirePlatformAdmin(app, actor);
  return evaluate(app, await loadById(app, input.onboardingId));
}

/** The same checklist for the org's own owner, so they can see what stands between them and live. */
export async function getGoLiveChecklist(app: App, orgId: string, principal: Principal): Promise<Checklist> {
  const row = await app.tenant(orgId, principal, async (ctx) => {
    requireOwner(ctx);
    return ctx.db.selectFrom('onboardings').select(ONBOARDING_COLS).executeTakeFirst();
  });
  if (!row) throw notFound('Onboarding not found');
  return evaluate(app, row);
}

/**
 * The same checklist for a caller already inside the org's transaction (an assistant's tool).
 * Owner only. The checks read what is committed, each in its own short transaction.
 */
export async function getOwnGoLiveChecklist(ctx: Ctx): Promise<Checklist & { live: boolean; origin: 'platform' | 'self_serve' }> {
  requireOwner(ctx);
  const row = await ctx.db.selectFrom('onboardings').select(ONBOARDING_COLS).executeTakeFirst();
  if (!row) throw notFound('Onboarding not found');
  return { ...(await evaluate(ctx.app, row)), live: row.status === 'live', origin: row.origin };
}

/**
 * What the owner would be confirming for one check, in plain words, before `confirmGoLiveItem`
 * records their yes. Owner only. Throws when the check is not one to confirm, or there is
 * nothing to confirm yet (no hours set, no menu).
 */
export async function describeGoLiveConfirmation(ctx: Ctx, input: { key: string }): Promise<{ key: string; label: string; what: string; confirmedAt: string | null }> {
  requireOwner(ctx);
  const def = registry.get(input.key);
  if (!def?.needsOwnerConfirmation) {
    const keys = listGoLiveChecks().filter((d) => d.needsOwnerConfirmation).map((d) => d.key);
    throw notFound(`That is not something to confirm. What an owner confirms: ${keys.join(', ')}.`);
  }
  const row = await ctx.db.selectFrom('onboardings').select(ONBOARDING_COLS).executeTakeFirst();
  if (!row) throw notFound('Onboarding not found');
  const c = await checkContext(ctx.app, row);
  return { key: def.key, label: def.label, what: def.whatIsConfirmed ? await def.whatIsConfirmed(c) : def.label, confirmedAt: c.confirmations[def.key]?.at ?? null };
}

/**
 * The owner's own yes to a check that needs it ("these are our hours"). Only a signed-in
 * owner: nobody at the platform, and no background job, can confirm on a venue's behalf.
 */
export async function confirmGoLiveItem(ctx: Ctx, input: { key: string }): Promise<void> {
  const def = registry.get(input.key);
  if (!def?.needsOwnerConfirmation) throw notFound('That is not something to confirm.');
  if (isInternal(ctx)) throw forbidden('Only an owner can confirm this.');
  const owner = requireOwner(ctx);
  const row = await ctx.db.selectFrom('onboardings').select(['id', 'confirmations']).executeTakeFirst();
  if (!row) throw notFound('Onboarding not found');
  const confirmations = { ...((row.confirmations ?? {}) as Record<string, unknown>), [def.key]: { at: ctx.now().toISOString(), staffId: owner?.staffId ?? null } };
  await ctx.db.updateTable('onboardings').set({ confirmations: json(confirmations) }).where('id', '=', row.id).execute();
  await audit(ctx, { action: 'onboarding.confirmed', entityType: 'onboarding', entityId: row.id, after: { item: def.key } });
}

export const goLiveTestEmail = defineTemplate({
  key: 'onboarding.test_send',
  channel: 'email',
  kind: 'transactional',
  description: 'The go-live test: proves that transactional email from this org is delivered.',
  subject: 'Test email from {{org_name}}',
  body: 'This is a test from {{org_name}}.\n\nIt confirms that emails to your guests, such as order confirmations and receipts, are being delivered. There is nothing you need to do.',
  variables: z.object({}),
});

/** Queue the go-live test email to the acting owner (or, from the platform, to the org's first owner). */
export async function sendGoLiveTestEmail(ctx: Ctx): Promise<{ messageId: string; to: string }> {
  requireOwner(ctx);
  const me = staffOf(ctx);
  const owner = me
    ? await ctx.db.selectFrom('staff').select('email').where('id', '=', me.staffId).executeTakeFirst()
    : await ctx.db.selectFrom('staff').select('email').where('is_owner', '=', true).where('status', '!=', 'disabled').orderBy('created_at').executeTakeFirst();
  if (!owner) throw invalid('This organisation has no owner to send the test to.');
  // One test per ten minutes per org: pressing the button twice sends one email.
  const bucket = Math.floor(ctx.now().getTime() / 600_000);
  const queued = await queueMessage(ctx, { templateKey: goLiveTestEmail.key, channel: 'email', to: owner.email, idempotencyKey: `onboarding.test_send:${ctx.orgId}:${bucket}`, variables: {} });
  return { messageId: queued.messageId, to: owner.email };
}

/** How long a sent message may go without a bounce before we take it as delivered by a provider that reports no delivery events. */
const NO_BOUNCE_MINUTES = 5;

// ── The spine's checks ─────────────────────────────────────────────────────────────────────

registerGoLiveCheck({
  key: 'hours_confirmed',
  label: 'Trading hours set and confirmed by the owner',
  order: 10,
  needsOwnerConfirmation: true,
  fix: { how: 'Set the opening hours (venue_update), then the owner confirms they are right.', tool: 'go_live_confirm' },
  async whatIsConfirmed(c) {
    const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const lines: string[] = [];
    await c.app.tenant(c.orgId, PROVISIONER, async (ctx) => {
      for (const v of c.venues) {
        const rows = await ctx.db.selectFrom('trading_hours').select(['day_of_week', 'opens_at', 'closes_at']).where('venue_id', '=', v.id).orderBy('day_of_week').orderBy('opens_at').execute();
        if (!rows.length) throw invalid(`No opening hours are set for ${v.name} yet. Set them first.`);
        lines.push(`${v.name}: ${rows.map((r) => `${DAY[r.day_of_week]} ${r.opens_at.slice(0, 5)} to ${r.closes_at.slice(0, 5)}`).join(', ')}; closed on any other day`);
      }
    });
    return `these are the opening hours. ${lines.join('. ')}`;
  },
  async run(c) {
    if (!c.venues.length) return fail('There is no venue yet.');
    const withHours = await c.app.tenant(c.orgId, PROVISIONER, async (ctx) => new Set((await ctx.db.selectFrom('trading_hours').select('venue_id').distinct().execute()).map((r) => r.venue_id)));
    const without = c.venues.filter((v) => !withHours.has(v.id));
    if (without.length) return fail(`No trading hours are set for ${without.map((v) => v.name).join(', ')}.`);
    const confirmed = c.confirmations.hours_confirmed;
    if (!confirmed) return fail('The hours are set, but the owner has not confirmed them yet.');
    return pass(`Hours are set at ${c.venues.length === 1 ? 'the venue' : `all ${c.venues.length} venues`} and were confirmed by the owner on ${confirmed.at.slice(0, 10)}.`);
  },
});

registerGoLiveCheck({
  key: 'domain_live',
  label: 'Site reachable on a verified domain',
  order: 20,
  async run(c) {
    const domains = await c.app.tenant(c.orgId, PROVISIONER, (ctx) => listDomains(ctx));
    const primary = domains.find((d) => d.isPrimary && d.verified) ?? domains.find((d) => d.verified);
    if (!primary) return fail('No verified domain points at this organisation.');
    const resolved = await resolveHost(c.app, primary.host);
    if (!resolved || resolved.orgId !== c.orgId) return fail(`${primary.host} does not resolve to this organisation.`);
    const waiting = domains.filter((d) => d.kind === 'custom' && !d.verified).map((d) => d.host);
    // Live on the subdomain first, always: a custom domain still waiting on DNS does not hold up going live.
    return pass(waiting.length ? `Live on ${primary.host}. ${waiting.join(', ')} will take over once its DNS records are in place.` : `Live on ${primary.host}.`);
  },
});

registerGoLiveCheck({
  key: 'transactional_email',
  label: 'Transactional email delivering (test send)',
  order: 30,
  fix: { how: 'Send the test email to the owner, then wait about five minutes for it to be delivered.', tool: 'go_live_test_email' },
  async run(c) {
    const m = await c.app.tenant(c.orgId, PROVISIONER, (ctx) =>
      ctx.db
        .selectFrom('messages')
        .select(['status', 'error', 'sent_at', 'to_address'])
        .where('template_key', '=', goLiveTestEmail.key)
        .orderBy('queued_at', 'desc')
        .limit(1)
        .executeTakeFirst(),
    );
    if (!m) return fail('No test email has been sent yet. Send one from the go-live page.');
    if (m.status === 'delivered') return pass(`The test email to ${m.to_address} was delivered.`);
    if (m.status === 'sent' && m.sent_at) {
      const minutes = (c.app.clock().getTime() - m.sent_at.getTime()) / 60_000;
      if (minutes >= NO_BOUNCE_MINUTES) return pass(`The test email to ${m.to_address} was accepted by the provider and has not bounced.`);
      return fail(`The test email to ${m.to_address} has been sent. Waiting for the provider to confirm delivery.`);
    }
    if (m.status === 'queued' || m.status === 'sending') return fail('The test email is still in the queue.');
    return fail(`The test email to ${m.to_address} was not delivered (${m.error ?? m.status}).`);
  },
});

registerGoLiveCheck({
  key: 'staff_signed_in',
  label: 'An owner has signed in to the console',
  order: 40,
  fix: { how: 'An owner signs in to the console with their email address.', ownerOnly: true },
  async run(c) {
    const staff = await c.app.tenant(c.orgId, PROVISIONER, (ctx) => ctx.db.selectFrom('staff').select(['user_id', 'is_owner']).where('status', '!=', 'disabled').execute());
    if (!staff.length) return fail('Nobody has been added to the team.');
    // Sessions are a platform table (a person may belong to two orgs); only whether one exists is read.
    const signedIn = await c.app.db
      .selectFrom('sessions')
      .select('user_id')
      .distinct()
      .where('kind', '=', 'staff')
      .where('user_id', 'in', staff.map((s) => s.user_id))
      .where((eb) => eb.or([eb('org_id', '=', c.orgId), eb('org_id', 'is', null)]))
      .execute();
    const ids = new Set(signedIn.map((s) => s.user_id));
    if (!staff.some((s) => s.is_owner && ids.has(s.user_id))) {
      return fail(ids.size ? 'Team members have signed in, but no owner has yet.' : 'Nobody on the team has signed in yet.');
    }
    return pass(`${ids.size} of ${staff.length} team members have signed in, including an owner.`);
  },
});

const websiteOff = (e: unknown) => isAppError(e) && e.code === 'module_disabled';

registerGoLiveCheck({
  key: 'pages_published',
  label: 'Website pages published',
  order: 50,
  fix: { how: 'The site\'s starting pages are made a minute or two after the website is switched on. If they are still missing, the owner publishes the home page in the console.' },
  async run(c) {
    try {
      const pages = await c.app.tenant(c.orgId, PROVISIONER, (ctx) => listPublishedPages(ctx));
      if (!pages.some((p) => p.slug === 'home')) return fail('The home page has not been published.');
      return pass(`${pages.length} ${pages.length === 1 ? 'page is' : 'pages are'} published, including the home page.`);
    } catch (e) {
      if (websiteOff(e)) return notApplicable('The website is switched off for this organisation.');
      throw e;
    }
  },
});

registerGoLiveCheck({
  key: 'structured_data_valid',
  label: 'Structured data complete for search engines',
  order: 60,
  fix: { how: 'Fill in the venue details named as missing (address, phone number, opening hours).', tool: 'venue_update' },
  async run(c) {
    const problems: string[] = [];
    let checked = 0;
    for (const venue of c.venues) {
      try {
        const site = await c.app.tenant(c.orgId, PROVISIONER, (ctx) => getSite(ctx, { venueId: venue.id }));
        checked++;
        const verdict = validateRestaurantJsonLd(site.structuredData ?? {});
        if (!verdict.valid) problems.push(`${venue.name} is missing: ${verdict.missing.join(', ')}`);
      } catch (e) {
        if (!websiteOff(e)) throw e;
      }
    }
    if (!checked) return notApplicable('The website is switched off for this organisation.');
    if (problems.length) return fail(`${problems.join('. ')}.`);
    return pass(`Restaurant details are complete for ${checked === 1 ? 'the venue' : `${checked} venues`}.`);
  },
});

// ── Going live ─────────────────────────────────────────────────────────────────────────────

/** Hours from "sold" to live, to one decimal place. null until the org is live. */
export function timeToLiveHours(o: { sold_at: Date; live_at: Date | null }): number | null {
  if (!o.live_at) return null;
  return Math.round(((o.live_at.getTime() - o.sold_at.getTime()) / 3_600_000) * 10) / 10;
}

export interface GoLiveResult {
  orgId: string;
  liveAt: Date;
  timeToLiveHours: number;
  manualTouchMinutes: number;
  checklist: Checklist;
}

/**
 * Switch an org and its venues to live. Refuses, naming what fails, while any check does.
 * Safe to call again: an org that is already live stays as it is.
 */
export async function goLive(app: App, actor: Principal, input: { onboardingId: string }): Promise<GoLiveResult> {
  const { adminUserId } = await requirePlatformAdmin(app, actor);
  const onboarding = await loadById(app, input.onboardingId);
  const checklist = await evaluate(app, onboarding);
  const orgId = checklist.orgId;
  if (onboarding.status === 'live' && onboarding.live_at) {
    return { orgId, liveAt: onboarding.live_at, timeToLiveHours: timeToLiveHours(onboarding)!, manualTouchMinutes: onboarding.manual_touch_minutes, checklist };
  }
  refuseWhileFailing(checklist);
  // One transaction inside the org: statuses, the onboarding record, the audit entry and the event move together.
  return app.tenant(orgId, { kind: 'platform', adminUserId, reason: 'go-live' }, (ctx) => switchLive(ctx, onboarding, checklist));
}

function refuseWhileFailing(checklist: Checklist): void {
  const failing = checklist.items.filter((i) => i.status === 'fail');
  if (failing.length) {
    throw new AppError('conflict', `Not ready to go live: ${failing.map((f) => f.label).join('; ')}.`, { failing: failing.map((f) => ({ key: f.key, label: f.label, reason: f.reason })) });
  }
}

/** The switch itself, in the org's own transaction: whoever is allowed to throw it has been checked by the caller. */
async function switchLive(ctx: Ctx, onboarding: { id: string; sold_at: Date; manual_touch_minutes: number }, checklist: Checklist): Promise<GoLiveResult> {
  const { app, orgId } = ctx;
  const liveAt = ctx.now();
  await setOrgStatus({ app, db: ctx.db, reason: 'go-live', now: ctx.now }, orgId, 'live');
  const venues = await ctx.db.selectFrom('venues').select('id').where('status', '=', 'setup').execute();
  for (const v of venues) await updateVenue(ctx, v.id, { status: 'live' });
  await ctx.db.updateTable('onboardings').set({ status: 'live', live_at: liveAt }).where('id', '=', onboarding.id).execute();
  const hours = timeToLiveHours({ sold_at: onboarding.sold_at, live_at: liveAt })!;
  await audit(ctx, {
    action: 'org.went_live',
    entityType: 'org',
    entityId: orgId,
    before: { status: 'onboarding' },
    after: { status: 'live', venues: venues.length, checklist: checklist.items.map((i) => ({ key: i.key, status: i.status })) },
  });
  await track(ctx, orgWentLive, { onboarding_id: onboarding.id, hours_to_live: hours, manual_touch_minutes: onboarding.manual_touch_minutes });
  // robots.txt and every cached page depend on the org being live.
  revalidateAfterCommit(ctx, [cacheTags.org(orgId)]);
  ctx.afterCommit(clearHostCache);
  return { orgId, liveAt, timeToLiveHours: hours, manualTouchMinutes: onboarding.manual_touch_minutes, checklist };
}

/**
 * A self-serve organisation is taken live by its own owner (docs/PIPEDLINE.md section 1): the
 * same checklist, the same refusal while anything fails, the same switch. An organisation the
 * platform team is onboarding is still taken live by them.
 */
export async function goLiveAsOwner(ctx: Ctx): Promise<GoLiveResult> {
  if (isInternal(ctx)) throw forbidden('Only an owner can do that.');
  requireOwner(ctx);
  const onboarding = await ctx.db.selectFrom('onboardings').select(ONBOARDING_COLS).forUpdate().executeTakeFirst();
  if (!onboarding) throw notFound('Onboarding not found');
  if (onboarding.origin !== 'self_serve') throw forbidden('This organisation is being set up with the platform team, who take it live once the checklist passes.');
  const checklist = await evaluate(ctx.app, onboarding);
  if (onboarding.status === 'live' && onboarding.live_at) {
    return { orgId: ctx.orgId, liveAt: onboarding.live_at, timeToLiveHours: timeToLiveHours(onboarding)!, manualTouchMinutes: onboarding.manual_touch_minutes, checklist };
  }
  refuseWhileFailing(checklist);
  return switchLive(ctx, onboarding, checklist);
}
