import { z } from 'zod';
import {
  type App,
  type ConnectionRow,
  type Ctx,
  type EspProfile,
  type EspSuppression,
  adapterFor,
  defineEvent,
  defineJob,
  definePlug,
  defineSchedule,
  enqueue,
  enqueuePlatform,
  getPlug,
  invalid,
  json,
  markConnectionHealth,
  notFound,
  once,
  connect,
  requireOwner,
  requireStaff,
  resolveConnection,
  revokeConnection,
  sha256Hex,
  digestOf,
  track,
} from '@ros/core';
import { onConsentChanged } from '../identity/consents';
import { setOrgSettings } from '../tenancy/orgs';
import { ESP_SETTINGS_NAMESPACE, emailMarketingTier, espSettings } from './connected';
import { addSuppression, isSuppressed, normaliseAddress } from './suppression';
import { optOut } from './webhooks';

/**
 * The connected email platform (docs/modules/comms.md section 7). A venue keeps its own
 * platform and flows; we stay the record for consent.
 *
 * One sync run per connection, in this order:
 *   1. push suppressions made here (opt-outs, bounces) for guests the platform may hold
 *   2. pull the platform's unsubscribes, complaints and bounces and apply them here through
 *      comms.optOut, so consent and suppression move together (a conflict ends "not consented")
 *   3. push profiles that changed, with their consent and a few properties
 *   4. push events (order placed, visit, points earned) with idempotency keys
 *
 * Nothing is pushed for a guest who holds no marketing consent, except the suppression that
 * keeps a guest who once consented unsubscribed on the platform too. Every provider call goes
 * through once() with the same key given to the platform, and what was pushed is remembered
 * per guest, so a replayed run sends nothing new.
 */

// ── Plugs ───────────────────────────────────────────────────────────────────

export const simEspPlug = definePlug({
  key: 'sim-esp',
  name: 'Simulated email platform',
  description: 'A connected email platform held in memory. For development and tests.',
  kind: 'adapter',
  tier: 'first_party',
  adapters: { esp: 'sim-esp' },
  auth: 'api_key',
  scopes: ['profiles:write', 'events:write', 'subscriptions:write', 'profiles:read'],
  venueScoped: false,
  simulated: true,
});

/** Scopes are Klaviyo's own private-key scope names. */
export const klaviyoPlug = definePlug({
  key: 'klaviyo',
  name: 'Klaviyo',
  description: 'Keep your Klaviyo flows. We push guests who agreed to marketing, their consent and their orders, and bring Klaviyo unsubscribes back.',
  kind: 'adapter',
  tier: 'curated',
  adapters: { esp: 'klaviyo' },
  auth: 'api_key',
  scopes: ['profiles:read', 'profiles:write', 'events:write', 'subscriptions:write', 'lists:write'],
  venueScoped: false,
});

export const emailPlatformSynced = defineEvent({
  name: 'email_platform.synced',
  module: 'comms',
  description: 'A sync with the venue\'s own email platform finished. Counts only.',
  properties: z.object({
    connection_id: z.string(),
    profiles_pushed: z.number().int(),
    events_pushed: z.number().int(),
    suppressions_pushed: z.number().int(),
    suppressions_pulled: z.number().int(),
  }),
});

const WORKER = { kind: 'worker' as const, job: 'comms.esp_sync' };
const CONN_COLS = ['id', 'org_id', 'venue_id', 'plug_key', 'status', 'scopes', 'secret_ref', 'external_account_id', 'config', 'connected_at', 'last_ok_at', 'last_error', 'expires_at'] as const;
const BATCH = 500;
/**
 * Local cursors look back this far on every run. A consent or a sale committed by a transaction
 * that began before the last run read would otherwise fall behind its cursor for good; re-reading
 * the window is free because every push is keyed (digest per guest, once() per event).
 */
const OVERLAP_MS = 10 * 60_000;
const back = (d: Date | null): Date | null => (d ? new Date(d.getTime() - OVERLAP_MS) : null);
const later = (a: Date | null, b: Date | null): Date | null => (!a ? b : !b ? a : a > b ? a : b);
export const ESP_SYNC_EVERY_MINUTES = 15;
/** Sources of an opt-out that came FROM the platform; never echoed back to it. */
const FROM_PLATFORM = 'esp_unsubscribe';
const FROM_PLATFORM_COMPLAINT = 'esp_complaint';
const FROM_PLATFORM_SOURCES = [FROM_PLATFORM, FROM_PLATFORM_COMPLAINT];

function espPlugKeys(): string[] {
  return ['sim-esp', 'klaviyo'].filter((k) => {
    try {
      return !!getPlug(k).adapters.esp;
    } catch {
      return false;
    }
  });
}

async function espConnections(ctx: Ctx, statuses: ConnectionRow['status'][] = ['connected', 'unhealthy']): Promise<ConnectionRow[]> {
  const keys = espPlugKeys();
  return ctx.db.selectFrom('connections').select(CONN_COLS).where('plug_key', 'in', keys).where('venue_id', 'is', null).where('status', 'in', statuses).execute() as Promise<ConnectionRow[]>;
}

// ── Console functions ───────────────────────────────────────────────────────

export const connectEmailPlatformInput = z.object({
  plugKey: z.string().min(1),
  /** The platform's account id (for Klaviyo, the public/site id). */
  externalAccountId: z.string().min(1).max(200),
  credentials: z.record(z.string(), z.string()),
  config: z.record(z.string(), z.unknown()).optional(),
  /** 'connected' (default): the platform sends marketing email. 'native': sync only; we keep sending. */
  tier: z.enum(['native', 'connected']).default('connected'),
});

export interface EmailPlatformStatus {
  connectionId: string;
  plugKey: string;
  name: string;
  status: ConnectionRow['status'];
  externalAccountId: string;
  tier: 'native' | 'connected';
  lastRunAt: Date | null;
  lastOkAt: Date | null;
  lastError: string | null;
  lastCounts: Record<string, number> | null;
  profilesSubscribed: number;
  profilesSuppressed: number;
}

/**
 * Connect the org's own email platform. The whole guest list is at stake, so an owner does it.
 * The first sync is queued straight away.
 */
export async function connectEmailPlatform(ctx: Ctx, raw: z.input<typeof connectEmailPlatformInput>): Promise<EmailPlatformStatus> {
  const input = connectEmailPlatformInput.parse(raw);
  requireOwner(ctx);
  const plug = getPlug(input.plugKey);
  if (!plug.adapters.esp) throw invalid(`${plug.name} is not an email platform.`);
  const row = await connect(ctx, { plugKey: plug.key, externalAccountId: input.externalAccountId, credentials: input.credentials, config: input.config ?? {} });
  const now = ctx.now();
  // Orders and points from before today are history, not events: nothing is back-filled.
  await ctx.db
    .insertInto('esp_sync_state')
    .values({ connection_id: row.id, org_id: ctx.orgId, orders_through: now, points_through: now })
    .onConflict((oc) => oc.column('connection_id').doNothing())
    .execute();
  await setOrgSettings(ctx, ESP_SETTINGS_NAMESPACE, espSettings, { emailMarketingTier: input.tier });
  await enqueue(ctx, espSyncJob, { connectionId: row.id }, { key: `connect:${row.id}:${now.toISOString()}` });
  return (await emailPlatformStatus(ctx)).find((s) => s.connectionId === row.id)!;
}

/** Disconnect. Marketing email goes back to the native tier. */
export async function disconnectEmailPlatform(ctx: Ctx, connectionId: string): Promise<void> {
  requireOwner(ctx);
  const row = (await espConnections(ctx, ['connected', 'unhealthy', 'pending'])).find((c) => c.id === connectionId);
  if (!row) throw notFound('Connection not found');
  await revokeConnection(ctx, connectionId);
  if (!(await espConnections(ctx)).length) await setOrgSettings(ctx, ESP_SETTINGS_NAMESPACE, espSettings, { emailMarketingTier: 'native' });
}

/** Sync health for the console: last run, last error, what the platform holds. */
export async function emailPlatformStatus(ctx: Ctx): Promise<EmailPlatformStatus[]> {
  requireStaff(ctx, { minRole: 'manager' });
  const rows = await espConnections(ctx, ['connected', 'unhealthy', 'pending']);
  const tier = await emailMarketingTier(ctx);
  const out: EmailPlatformStatus[] = [];
  for (const r of rows) {
    const s = await ctx.db.selectFrom('esp_sync_state').selectAll().where('connection_id', '=', r.id).executeTakeFirst();
    const counts = await ctx.db
      .selectFrom('esp_sync_profiles')
      .select(['state', (eb) => eb.fn.countAll<number>().as('n')])
      .where('connection_id', '=', r.id)
      .groupBy('state')
      .execute();
    out.push({
      connectionId: r.id,
      plugKey: r.plug_key,
      name: getPlug(r.plug_key).name,
      status: r.status,
      externalAccountId: r.external_account_id,
      tier,
      lastRunAt: s?.last_run_at ?? null,
      lastOkAt: s?.last_ok_at ?? r.last_ok_at,
      lastError: s?.last_error ?? r.last_error,
      lastCounts: (s?.last_counts as Record<string, number> | null) ?? null,
      profilesSubscribed: Number(counts.find((c) => c.state === 'subscribed')?.n ?? 0),
      profilesSuppressed: Number(counts.find((c) => c.state === 'suppressed')?.n ?? 0),
    });
  }
  return out;
}

/** "Sync now" in the console. */
export async function requestEmailPlatformSync(ctx: Ctx, connectionId: string): Promise<void> {
  requireStaff(ctx, { minRole: 'manager' });
  const row = (await espConnections(ctx)).find((c) => c.id === connectionId);
  if (!row) throw notFound('Connection not found');
  await enqueue(ctx, espSyncJob, { connectionId }, { key: `manual:${connectionId}:${ctx.now().toISOString()}` });
}

// ── The sync ────────────────────────────────────────────────────────────────

export interface EspSyncResult {
  status: 'done' | 'skipped';
  suppressionsPushed: number;
  suppressionsPulled: number;
  profilesPushed: number;
  eventsPushed: number;
}

interface Pending {
  channel: 'email' | 'sms';
  value: string;
  reason: EspSuppression['reason'];
  at: Date;
}

const hashed = (v: string) => sha256Hex(v).slice(0, 24);

/** Step 1, read side: suppressions made here since the cursor, for guests who once consented or were pushed. */
async function localSuppressions(ctx: Ctx, connectionId: string, since: Date | null): Promise<Pending[]> {
  const out = new Map<string, Pending>();
  let revoked = ctx.db
    .selectFrom('consent_events as e')
    .innerJoin('customers as c', 'c.id', 'e.customer_id')
    .select(['e.purpose', 'e.occurred_at', 'e.source', 'c.primary_email', 'c.primary_phone'])
    .where('e.action', '=', 'revoked')
    .where('e.purpose', 'in', ['marketing_email', 'marketing_sms'])
    .where('e.source', 'not in', FROM_PLATFORM_SOURCES);
  if (since) revoked = revoked.where('e.occurred_at', '>', since);
  for (const r of await revoked.execute()) {
    const channel = r.purpose === 'marketing_email' ? 'email' : 'sms';
    const value = channel === 'email' ? r.primary_email : r.primary_phone;
    if (!value) continue;
    // Still revoked? A guest who opted back in since is not pushed as unsubscribed.
    out.set(`${channel}:${value}`, { channel, value, reason: r.source === 'provider_complaint' ? 'complained' : 'unsubscribed', at: r.occurred_at });
  }
  let sup = ctx.db.selectFrom('suppressions').select(['channel', 'value', 'reason', 'created_at']);
  if (since) sup = sup.where('created_at', '>', since);
  for (const s of await sup.execute()) {
    const col = s.channel === 'email' ? 'primary_email' : 'primary_phone';
    const purpose = s.channel === 'email' ? 'marketing_email' : 'marketing_sms';
    // Only for an address whose guest once consented here, or that the platform already holds from us.
    const known = await ctx.db
      .selectFrom('customers as c')
      .select('c.id')
      .where(`c.${col}`, '=', s.value)
      .where((eb) =>
        eb.or([
          eb.exists(eb.selectFrom('consents as k').select('k.id').whereRef('k.customer_id', '=', 'c.id').where('k.purpose', '=', purpose)),
          eb.exists(eb.selectFrom('esp_sync_profiles as p').select('p.customer_id').whereRef('p.customer_id', '=', 'c.id').where('p.connection_id', '=', connectionId)),
        ]),
      )
      .executeTakeFirst();
    if (!known) continue;
    // An opt-out that came from the platform is not sent back to it.
    const last = await ctx.db
      .selectFrom('consent_events')
      .select('source')
      .where('customer_id', '=', known.id)
      .where('purpose', '=', purpose)
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (last && FROM_PLATFORM_SOURCES.includes(last.source) && (s.reason === 'unsubscribed' || s.reason === 'complained')) continue;
    out.set(`${s.channel}:${s.value}`, { channel: s.channel, value: s.value, reason: s.reason, at: s.created_at });
  }
  // Drop anyone who holds the consent again now.
  const result: Pending[] = [];
  for (const p of out.values()) {
    const col = p.channel === 'email' ? 'primary_email' : 'primary_phone';
    const purpose = p.channel === 'email' ? 'marketing_email' : 'marketing_sms';
    const granted = await ctx.db
      .selectFrom('customers as c')
      .innerJoin('consents as k', 'k.customer_id', 'c.id')
      .select('c.id')
      .where(`c.${col}`, '=', p.value)
      .where('k.purpose', '=', purpose)
      .where('k.status', '=', 'granted')
      .executeTakeFirst();
    const stillSuppressed = await isSuppressed(ctx, p.channel, p.value);
    if (!granted || stillSuppressed) result.push(p);
  }
  return result;
}

/** Step 2, write side: apply what the platform reports. Idempotent: an opt-out already recorded is not recorded again. */
async function applyPulled(ctx: Ctx, pulled: EspSuppression[]): Promise<number> {
  let applied = 0;
  for (const s of pulled) {
    const value = normaliseAddress(s.channel, s.value);
    if (!value) continue;
    if (s.reason === 'bounced_hard' || s.reason === 'manual') {
      if ((await isSuppressed(ctx, s.channel, value)) === s.reason) continue;
      await addSuppression(ctx, s.channel, value, s.reason);
      applied++;
      continue;
    }
    const col = s.channel === 'email' ? 'primary_email' : 'primary_phone';
    const purpose = s.channel === 'email' ? 'marketing_email' : 'marketing_sms';
    const stillConsented = await ctx.db
      .selectFrom('customers as c')
      .innerJoin('consents as k', 'k.customer_id', 'c.id')
      .select('c.id')
      .where(`c.${col}`, '=', value)
      .where('k.purpose', '=', purpose)
      .where('k.status', '=', 'granted')
      .executeTakeFirst();
    if (!stillConsented && (await isSuppressed(ctx, s.channel, value))) continue;
    // A conflict (consented here, unsubscribed there) resolves to "not consented".
    if (s.reason === 'complained') await addSuppression(ctx, s.channel, value, 'complained');
    await optOut(ctx, s.channel, value, null, s.reason === 'complained' ? FROM_PLATFORM_COMPLAINT : FROM_PLATFORM);
    applied++;
  }
  return applied;
}

interface ProfilePlan {
  customerId: string;
  profile: EspProfile;
  digest: string;
}

/** Step 3, read side: guests whose profile changed since the cursor and who hold a marketing consent. */
async function changedProfiles(ctx: Ctx, connectionId: string, since: Date | null): Promise<ProfilePlan[]> {
  let ids: string[];
  if (!since) {
    ids = (
      await ctx.db.selectFrom('consents').select('customer_id').distinct().where('purpose', 'in', ['marketing_email', 'marketing_sms']).where('status', '=', 'granted').execute()
    ).map((r) => r.customer_id);
  } else {
    const a = await ctx.db.selectFrom('consent_events').select('customer_id').distinct().where('occurred_at', '>', since).where('purpose', 'in', ['marketing_email', 'marketing_sms']).execute();
    const b = await ctx.db.selectFrom('transactions').select('customer_id').distinct().where('ingested_at', '>', since).where('customer_id', 'is not', null).execute();
    const c = await ctx.db.selectFrom('events').select('customer_id').distinct().where('name', '=', 'loyalty.tier_changed').where('occurred_at', '>', since).where('customer_id', 'is not', null).execute();
    ids = [...new Set([...a, ...b, ...c].map((r) => r.customer_id).filter((v): v is string => !!v))];
  }
  const plans: ProfilePlan[] = [];
  const chunkIds = ids.slice(0, BATCH * 4);
  if (!chunkIds.length) return plans;
  // Read in bulk: a first sync covers every consenting guest of the org.
  const customers = await ctx.db.selectFrom('customers').select(['id', 'first_name', 'last_name', 'primary_email', 'primary_phone', 'status']).where('id', 'in', chunkIds).execute();
  const consentRows = await ctx.db.selectFrom('consents').select(['customer_id', 'purpose', 'status', 'consented_at']).where('customer_id', 'in', chunkIds).where('purpose', 'in', ['marketing_email', 'marketing_sms']).execute();
  const orderRows = await ctx.db
    .selectFrom('transactions')
    .select(['customer_id', (eb) => eb.fn.min('occurred_at').as('first'), (eb) => eb.fn.max('occurred_at').as('last'), (eb) => eb.fn.countAll<number>().as('n')])
    .where('customer_id', 'in', chunkIds)
    .where('status', 'in', ['completed', 'partially_refunded'])
    .groupBy('customer_id')
    .execute();
  const tierRows = await ctx.db
    .selectFrom('events')
    .select(['customer_id', 'properties', 'occurred_at'])
    .where('customer_id', 'in', chunkIds)
    .where('name', '=', 'loyalty.tier_changed')
    .orderBy('occurred_at', 'asc')
    .execute();
  const priorRows = await ctx.db.selectFrom('esp_sync_profiles').select(['customer_id', 'digest']).where('connection_id', '=', connectionId).where('customer_id', 'in', chunkIds).execute();
  const tierOf = new Map<string, string | null>();
  for (const t of tierRows) tierOf.set(t.customer_id!, ((t.properties as { to?: string | null } | null)?.to ?? null) as string | null);
  const prior = new Map(priorRows.map((r) => [r.customer_id, r.digest]));
  const orders = new Map(orderRows.map((o) => [o.customer_id!, o]));
  for (const c of customers) {
    if (c.status !== 'active') continue;
    const id = c.id;
    const email = consentRows.find((k) => k.customer_id === id && k.purpose === 'marketing_email' && k.status === 'granted');
    const sms = consentRows.find((k) => k.customer_id === id && k.purpose === 'marketing_sms' && k.status === 'granted');
    const marketingEmail = !!email && !!c.primary_email;
    const marketingSms = !!sms && !!c.primary_phone;
    // No marketing consent: nothing about this guest goes to the platform (step 1 keeps them suppressed).
    if (!marketingEmail && !marketingSms) continue;
    const o = orders.get(id);
    const profile: EspProfile = {
      externalId: id,
      // Only the address the guest agreed to be marketed on leaves.
      email: marketingEmail ? c.primary_email : null,
      phone: marketingSms ? c.primary_phone : null,
      firstName: c.first_name,
      lastName: c.last_name,
      consents: { marketingEmail, marketingSms },
      consentedAt: { email: marketingEmail ? (email?.consented_at ?? null) : null, sms: marketingSms ? (sms?.consented_at ?? null) : null },
      properties: {
        first_order_at: o?.first ? new Date(o.first as unknown as string).toISOString() : null,
        last_order_at: o?.last ? new Date(o.last as unknown as string).toISOString() : null,
        order_count: Number(o?.n ?? 0),
        loyalty_tier: tierOf.get(id) ?? null,
      },
    };
    const digest = digestOf({ ...profile, consentedAt: { email: profile.consentedAt?.email?.toISOString() ?? null, sms: profile.consentedAt?.sms?.toISOString() ?? null } });
    if (prior.get(id) === digest) continue;
    plans.push({ customerId: id, profile, digest });
    if (plans.length >= BATCH) break;
  }
  return plans;
}

interface EventPlan {
  key: string;
  profileExternalId: string;
  name: string;
  occurredAt: Date;
  properties: Record<string, unknown>;
}

/** Step 4, read side: orders and points since the cursors, for guests who hold a marketing consent. */
async function newEvents(ctx: Ctx, ordersThrough: Date | null, pointsThrough: Date | null): Promise<{ events: EventPlan[]; ordersThrough: Date | null; pointsThrough: Date | null }> {
  const consenting = async (customerId: string) =>
    !!(await ctx.db.selectFrom('consents').select('id').where('customer_id', '=', customerId).where('purpose', 'in', ['marketing_email', 'marketing_sms']).where('status', '=', 'granted').executeTakeFirst());
  const events: EventPlan[] = [];
  let oq = ctx.db
    .selectFrom('transactions as t')
    .innerJoin('venues as v', 'v.id', 't.venue_id')
    .select(['t.id', 't.customer_id', 't.occurred_at', 't.ingested_at', 't.channel', 't.total_cents', 't.currency', 't.status', 'v.name as venue'])
    .where('t.customer_id', 'is not', null)
    .orderBy('t.ingested_at')
    .limit(BATCH);
  if (ordersThrough) oq = oq.where('t.ingested_at', '>', ordersThrough);
  const orders = await oq.execute();
  let newOrders = ordersThrough;
  for (const o of orders) {
    newOrders = o.ingested_at;
    if (o.status === 'pending' || o.status === 'voided' || !(await consenting(o.customer_id!))) continue;
    events.push({
      key: `ros:txn:${o.id}`,
      profileExternalId: o.customer_id!,
      name: o.channel === 'dine-in' ? 'Visited' : 'Placed Order',
      occurredAt: o.occurred_at,
      properties: { transaction_id: o.id, venue: o.venue, channel: o.channel, value: o.total_cents / 100, currency: o.currency },
    });
  }
  let pq = ctx.db.selectFrom('events').select(['id', 'customer_id', 'occurred_at', 'properties']).where('name', '=', 'loyalty.earned').where('customer_id', 'is not', null).orderBy('occurred_at').limit(BATCH);
  if (pointsThrough) pq = pq.where('occurred_at', '>', pointsThrough);
  const points = await pq.execute();
  let newPoints = pointsThrough;
  for (const p of points) {
    newPoints = p.occurred_at;
    if (!(await consenting(p.customer_id!))) continue;
    const props = p.properties as { points?: number };
    events.push({ key: `ros:evt:${p.id}`, profileExternalId: p.customer_id!, name: 'Earned Points', occurredAt: p.occurred_at, properties: { points: props.points ?? 0 } });
  }
  return { events, ordersThrough: newOrders, pointsThrough: newPoints };
}

async function saveState(app: App, orgId: string, connectionId: string, values: Record<string, unknown>): Promise<void> {
  await app.tenant(orgId, WORKER, (ctx) =>
    ctx.db
      .updateTable('esp_sync_state')
      .set(values as never)
      .where('connection_id', '=', connectionId)
      .execute(),
  );
}

/** One sync run for one connection. Safe to run twice: a replay pushes nothing new. */
export async function syncEmailPlatform(app: App, args: { orgId: string; connectionId: string }): Promise<EspSyncResult> {
  const { orgId, connectionId } = args;
  const result: EspSyncResult = { status: 'skipped', suppressionsPushed: 0, suppressionsPulled: 0, profilesPushed: 0, eventsPushed: 0 };
  const start = await app.tenant(orgId, WORKER, async (ctx) => {
    const row = (await espConnections(ctx)).find((c) => c.id === connectionId);
    if (!row) return null;
    await ctx.db.insertInto('esp_sync_state').values({ connection_id: row.id, org_id: ctx.orgId }).onConflict((oc) => oc.column('connection_id').doNothing()).execute();
    const state = await ctx.db.selectFrom('esp_sync_state').selectAll().where('connection_id', '=', row.id).executeTakeFirstOrThrow();
    return { row, state };
  });
  if (!start) return result;
  const { row, state } = start;
  const runAt = app.clock();
  const adapter = adapterFor(app, 'esp', row);

  try {
    const handle = await resolveConnection(app, row);

    // 1. Push what was suppressed here.
    const pushedThrough = app.clock();
    const pending = await app.tenant(orgId, WORKER, (ctx) => localSuppressions(ctx, row.id, back(state.suppressions_pushed_through)));
    for (const p of pending) {
      const s: EspSuppression = { channel: p.channel, value: p.value, reason: p.reason, at: p.at };
      if (!adapter.pushSuppression) break;
      const key = `esp:${row.id}:sup:${p.channel}:${hashed(p.value)}:${p.reason}:${p.at.toISOString()}`;
      const r = await once(app, { orgId, key, kind: 'esp_suppression' }, async () => {
        await adapter.pushSuppression!(handle, s);
        return { ok: true };
      });
      if (!r.replayed) result.suppressionsPushed++;
      await app.tenant(orgId, WORKER, async (ctx) => {
        const col = p.channel === 'email' ? 'primary_email' : 'primary_phone';
        const ids = await ctx.db.selectFrom('customers').select('id').where(col, '=', p.value).execute();
        for (const { id } of ids) {
          await ctx.db
            .insertInto('esp_sync_profiles')
            .values({ connection_id: row.id, org_id: ctx.orgId, customer_id: id, digest: `suppressed:${p.channel}`, state: 'suppressed', pushed_at: ctx.now() })
            .onConflict((oc) => oc.columns(['connection_id', 'customer_id']).doUpdateSet({ digest: `suppressed:${p.channel}`, state: 'suppressed', pushed_at: ctx.now() }))
            .execute();
        }
      });
    }
    await saveState(app, orgId, row.id, { suppressions_pushed_through: pushedThrough });

    // 2. Pull the platform's opt-outs and apply them here.
    const since = state.suppressions_pulled_through ?? new Date(0);
    const pulled = await adapter.pullSuppressions(handle, since);
    result.suppressionsPulled = await app.tenant(orgId, WORKER, (ctx) => applyPulled(ctx, pulled));
    const latest = pulled.reduce((m, s) => (s.at > m ? s.at : m), since);
    await saveState(app, orgId, row.id, { suppressions_pulled_through: latest });

    // 3. Profiles.
    const profilesThrough = app.clock();
    const plans = await app.tenant(orgId, WORKER, (ctx) => changedProfiles(ctx, row.id, back(state.profiles_through)));
    for (const plan of plans) {
      const key = `esp:${row.id}:profile:${plan.customerId}:${plan.digest.slice(0, 24)}`;
      const r = await once(app, { orgId, key, kind: 'esp_profile' }, async () => {
        await adapter.upsertProfile(handle, plan.profile);
        return { ok: true };
      });
      if (!r.replayed) result.profilesPushed++;
      await app.tenant(orgId, WORKER, (ctx) =>
        ctx.db
          .insertInto('esp_sync_profiles')
          .values({ connection_id: row.id, org_id: ctx.orgId, customer_id: plan.customerId, digest: plan.digest, state: 'subscribed', pushed_at: ctx.now() })
          .onConflict((oc) => oc.columns(['connection_id', 'customer_id']).doUpdateSet({ digest: plan.digest, state: 'subscribed', pushed_at: ctx.now() }))
          .execute(),
      );
    }
    if (plans.length < BATCH) await saveState(app, orgId, row.id, { profiles_through: profilesThrough });

    // 4. Events.
    const ev = await app.tenant(orgId, WORKER, (ctx) => newEvents(ctx, back(state.orders_through), back(state.points_through)));
    for (const e of ev.events) {
      const key = `esp:${row.id}:event:${e.key}`;
      const r = await once(app, { orgId, key, kind: 'esp_event' }, async () => {
        await adapter.trackEvent(handle, { profileExternalId: e.profileExternalId, name: e.name, occurredAt: e.occurredAt, properties: e.properties, idempotencyKey: e.key });
        return { ok: true };
      });
      if (!r.replayed) result.eventsPushed++;
    }
    const counts = { profiles_pushed: result.profilesPushed, events_pushed: result.eventsPushed, suppressions_pushed: result.suppressionsPushed, suppressions_pulled: result.suppressionsPulled };
    await app.tenant(orgId, WORKER, async (ctx) => {
      await ctx.db
        .updateTable('esp_sync_state')
        .set({ orders_through: later(state.orders_through, ev.ordersThrough), points_through: later(state.points_through, ev.pointsThrough), last_run_at: runAt, last_ok_at: ctx.now(), last_error: null, last_counts: json(counts) })
        .where('connection_id', '=', row.id)
        .execute();
      await track(ctx, emailPlatformSynced, { connection_id: row.id, ...counts });
    });
    await markConnectionHealth(app, row.id, { ok: true });
    result.status = 'done';
    return result;
  } catch (e) {
    const message = (e as Error).message.slice(0, 500);
    await saveState(app, orgId, row.id, { last_run_at: runAt, last_error: message });
    await markConnectionHealth(app, row.id, { ok: false, error: message });
    throw e;
  }
}

// ── Jobs, schedule, and keeping the platform in step with consent ───────────

export const espSyncJob = defineJob({
  kind: 'comms.esp_sync',
  schema: z.object({ connectionId: z.string().uuid() }),
  maxAttempts: 4,
  async handler(app, job) {
    if (!job.orgId) throw new Error('comms.esp_sync is an org job');
    await syncEmailPlatform(app, { orgId: job.orgId, connectionId: job.payload.connectionId });
  },
});

export const espSyncAllJob = defineJob({
  kind: 'comms.esp_sync_all',
  schema: z.object({ bucket: z.string() }),
  maxAttempts: 3,
  async handler(app, job) {
    const orgId = job.orgId;
    if (!orgId) throw new Error('comms.esp_sync_all is an org job');
    await app.tenant(orgId, WORKER, async (ctx) => {
      for (const c of await espConnections(ctx)) await enqueue(ctx, espSyncJob, { connectionId: c.id }, { key: `sched:${c.id}:${job.payload.bucket}` });
    });
  },
});

export const espSyncSchedule = defineSchedule({
  key: 'comms.esp_sync',
  everyMinutes: ESP_SYNC_EVERY_MINUTES,
  scope: 'org',
  job: espSyncAllJob,
  payload: ({ bucket }) => ({ bucket: bucket.toISOString() }),
  async appliesTo(app, orgId) {
    // app.db: the scheduler runs outside any tenant and asks only whether this org has an email platform at all.
    const row = await app.db
      .selectFrom('connections')
      .select('id')
      .where('org_id', '=', orgId)
      .where('plug_key', 'in', espPlugKeys())
      .where('status', 'in', ['connected', 'unhealthy'])
      .limit(1)
      .executeTakeFirst();
    return !!row;
  },
});

// A consent change here reaches the platform promptly: an opt-out is pushed, a new opt-in subscribed.
onConsentChanged(async (ctx, change) => {
  if (change.purpose !== 'marketing_email' && change.purpose !== 'marketing_sms') return;
  if (FROM_PLATFORM_SOURCES.includes(change.source)) return;
  const conns = await espConnections(ctx);
  for (const c of conns) {
    await enqueue(ctx, espSyncJob, { connectionId: c.id }, { key: `consent:${c.id}:${change.customerId}:${change.purpose}:${change.action}:${ctx.now().toISOString()}` });
  }
});

/** For platform tooling: run every due sync for one org now (tests, "sync now" across connections). */
export async function enqueueEspSyncs(app: App, orgId: string): Promise<void> {
  await enqueuePlatform(app, espSyncAllJob, orgId, { bucket: app.clock().toISOString() }, { key: `now:${app.clock().toISOString()}` });
}
