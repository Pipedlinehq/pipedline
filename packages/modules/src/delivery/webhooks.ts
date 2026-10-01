import { z } from 'zod';
import {
  type App,
  type ConnectionHandle,
  type ConnectionRow,
  type CourierEvent,
  AppError,
  adapterFor,
  claimWebhookEvent,
  defineJob,
  defineSchedule,
  enqueue,
  finishWebhookEvent,
  getPlug,
  markConnectionHealth,
  notFound,
  releaseWebhookEvent,
  resolveConnection,
  sha256Hex,
} from '@ros/core';
import { requestCourierJob, applyProviderState } from './dispatch';
import { deliveryModule } from './module';
import { IN_FLIGHT, WORKER, loadDelivery } from './rows';

const CONNECTION_COLUMNS = ['id', 'org_id', 'venue_id', 'plug_key', 'status', 'scopes', 'secret_ref', 'external_account_id', 'config', 'connected_at', 'last_ok_at', 'last_error', 'expires_at'] as const;

export interface CourierWebhookArgs {
  /** Which plug's endpoint was called, from the route: 'uber-direct', 'doordash-drive', 'sim-courier-a'. Never from the body. */
  plugKey: string;
  /** The body exactly as received: the signature is over these bytes. */
  rawBody: string;
  headers: Record<string, string | undefined>;
  /** The public URL the provider called. */
  url: string;
}

export interface CourierWebhookResult {
  status: 'processed' | 'duplicate' | 'ignored';
}

/**
 * A courier service says a delivery moved. Nothing in the body is believed:
 *
 *   1. the delivery it names is used only to find whose signature to expect
 *   2. the signature is checked on the raw body with that delivery's connection secret
 *   3. the event is claimed, so a replay has no second effect
 *   4. the delivery is fetched again from the provider, and that is what is recorded
 *
 * An unknown delivery, a missing signature and a wrong one all get the same answer. If
 * anything fails after the claim, the claim is released and the error rethrown, so the
 * provider's retry is handled afresh (the route answers non-2xx on a thrown error).
 */
export async function handleCourierWebhook(app: App, args: CourierWebhookArgs): Promise<CourierWebhookResult> {
  const denied = () => new AppError('unauthenticated', 'Signature check failed.');
  let adapterKey: string | undefined;
  try {
    adapterKey = getPlug(args.plugKey).adapters.courier;
  } catch {
    adapterKey = undefined;
  }
  if (!adapterKey || !app.adapters.has('courier', adapterKey)) throw notFound('Not found');
  const adapter = app.adapters.get('courier', adapterKey);

  let event: CourierEvent | null = null;
  try {
    event = adapter.parseWebhook(args.rawBody);
  } catch {
    event = null;
  }
  if (!event?.externalRef || !event.eventId) throw denied();

  // app.db: a webhook arrives before we know whose it is. The delivery's connection is found by
  // the provider's own id only to learn whose secret to check; nothing else is read or trusted.
  const rows = await app.db
    .selectFrom('deliveries')
    .select(['id', 'org_id', 'connection_id'])
    .where('provider', '=', args.plugKey)
    .where('external_ref', '=', event.externalRef)
    .execute();
  const verified: Array<{ deliveryId: string; orgId: string; conn: ConnectionRow; handle: ConnectionHandle }> = [];
  for (const r of rows) {
    if (!r.connection_id) continue;
    const conn = await app.db.selectFrom('connections').select(CONNECTION_COLUMNS).where('id', '=', r.connection_id).where('status', 'in', ['connected', 'unhealthy']).executeTakeFirst();
    if (!conn) continue;
    let handle: ConnectionHandle;
    try {
      handle = await resolveConnection(app, conn);
    } catch {
      continue;
    }
    const secret = handle.credentials.webhookSecret;
    if (!secret) continue;
    const url = typeof handle.config.webhookUrl === 'string' ? handle.config.webhookUrl : args.url;
    if (adapter.verifyWebhook({ rawBody: args.rawBody, headers: args.headers, url, signingSecret: secret })) verified.push({ deliveryId: r.id, orgId: r.org_id, conn, handle });
  }
  if (!verified.length) throw denied();

  const claim = await claimWebhookEvent(app, { provider: `courier:${args.plugKey}`, eventId: `${event.externalRef}:${event.eventId}`, eventType: event.status, payloadDigest: sha256Hex(args.rawBody) });
  if (!claim) return { status: 'duplicate' };

  try {
    for (const v of verified) {
      let state;
      try {
        state = await adapter.get(v.handle, event.externalRef);
      } catch (e) {
        await markConnectionHealth(app, v.conn.id, { ok: false, error: ((e as Error)?.message ?? 'unknown error').slice(0, 300) });
        throw new AppError('provider_error', 'The courier service could not be reached. It will be tried again shortly.');
      }
      if (!state) continue;
      const fetched = state;
      await app.tenant(v.orgId, WORKER, (ctx) => applyProviderState(ctx, v.deliveryId, fetched, 'webhook', { event_id: event!.eventId, hinted: event!.status, fetched: fetched.status }));
    }
  } catch (e) {
    await releaseWebhookEvent(app, claim);
    throw e;
  }
  await finishWebhookEvent(app, claim, { status: 'processed', orgId: verified[0]!.orgId, connectionId: verified[0]!.conn.id });
  return { status: 'processed' };
}

// ── Reconciliation: a lost webhook must not leave a delivery stuck ────────────

const STALE_MINUTES = 10;

/** Ask the provider about one delivery in flight and record what it says. */
export const refreshDeliveryJob = defineJob({
  kind: 'delivery.refresh',
  schema: z.object({ deliveryId: z.string().uuid() }),
  maxAttempts: 3,
  async handler(app, job) {
    const orgId = job.orgId;
    if (!orgId) throw new Error('delivery.refresh needs an org');
    const prep = await app.tenant(orgId, WORKER, async (ctx) => {
      const d = await loadDelivery(ctx, job.payload.deliveryId);
      if (!IN_FLIGHT.includes(d.status) || !d.external_ref || !d.connection_id) return null;
      const conn = await ctx.db.selectFrom('connections').select(CONNECTION_COLUMNS).where('id', '=', d.connection_id).executeTakeFirst();
      return conn ? { d, conn } : null;
    });
    if (!prep) return;
    const adapter = adapterFor(app, 'courier', prep.conn);
    const state = await adapter.get(await resolveConnection(app, prep.conn), prep.d.external_ref!);
    if (!state) return;
    await app.tenant(orgId, WORKER, (ctx) => applyProviderState(ctx, prep.d.id, state, 'reconcile', { fetched: state.status }));
  },
});

/**
 * Every few minutes: each delivery in flight not heard of lately is fetched again, and a courier
 * request whose job died is queued again. Webhooks are hints; this is the backstop.
 */
export const reconcileDeliveriesJob = defineJob({
  kind: 'delivery.reconcile',
  schema: z.object({ bucket: z.string() }),
  maxAttempts: 3,
  async handler(app, job) {
    const orgId = job.orgId;
    if (!orgId) throw new Error('delivery.reconcile needs an org');
    await app.tenant(orgId, WORKER, async (ctx) => {
      const stale = new Date(ctx.now().getTime() - STALE_MINUTES * 60_000);
      const moving = await ctx.db
        .selectFrom('deliveries')
        .select('id')
        .where('status', 'in', IN_FLIGHT)
        .where((eb) => eb.or([eb('last_checked_at', 'is', null), eb('last_checked_at', '<', stale)]))
        .limit(200)
        .execute();
      for (const d of moving) await enqueue(ctx, refreshDeliveryJob, { deliveryId: d.id }, { key: `refresh:${d.id}:${job.payload.bucket}` });
      const unbooked = await ctx.db
        .selectFrom('deliveries')
        .select('id')
        .where('status', '=', 'quoted')
        .where('order_id', 'is not', null)
        .where('request_at', '<', stale)
        .where('requested_at', 'is', null)
        .limit(200)
        .execute();
      for (const d of unbooked) await enqueue(ctx, requestCourierJob, { deliveryId: d.id }, { key: `courier:${d.id}:again:${job.payload.bucket}` });
    });
  },
});

export const reconcileDeliveriesSchedule = defineSchedule({
  key: 'delivery.reconcile',
  everyMinutes: 5,
  scope: 'org',
  job: reconcileDeliveriesJob,
  payload: ({ bucket }) => ({ bucket: bucket.toISOString() }),
  // Platform scheduler: asked outside any tenant, only "does this org have a delivery under way".
  async appliesTo(app, orgId) {
    const on = await app.db.selectFrom('venue_modules').select('venue_id').where('org_id', '=', orgId).where('module_key', '=', deliveryModule.key).where('enabled', '=', true).limit(1).executeTakeFirst();
    if (!on) return false;
    const live = await app.db
      .selectFrom('deliveries')
      .select('id')
      .where('org_id', '=', orgId)
      .where((eb) => eb.or([eb('status', 'in', IN_FLIGHT), eb.and([eb('status', '=', 'quoted'), eb('request_at', 'is not', null)])]))
      .limit(1)
      .executeTakeFirst();
    return !!live;
  },
});
