import { z } from 'zod';
import {
  type App,
  type ConnectionRow,
  type Ctx,
  RemoteMcpAuthError,
  connect,
  defineJob,
  defineSchedule,
  enqueue,
  getPlug,
  invalid,
  isAppError,
  localDate,
  markConnectionHealth,
  noPayload,
  resolveConnection,
} from '@ros/core';
import { defineTemplate } from '../comms/templates';
import { queueMessage } from '../comms/outbox';
import { consoleUrl } from './confirm';
import { hubModule } from './module';
import { checkPinned, mcpPlugs, plugReviews } from './plugs';

/**
 * Keeping remote plugs honest between requests (docs/modules/hub.md section 9):
 *   - "Plug token expired → connection marked unhealthy, its tools withdrawn, owner notified."
 *   - "Remote plug's tool list changed → withdrawn until re-reviewed."
 * The gateway checks both on every request that needs a plug. This job checks them on a
 * schedule too, so an unhealthy connection recovers without anyone calling a tool, and a
 * changed list is noticed (and logged for the platform) before a venue trips over it.
 */
const WORKER = { kind: 'worker' as const, job: 'hub.check_plugs' };
const SELECT = ['id', 'org_id', 'venue_id', 'plug_key', 'status', 'scopes', 'secret_ref', 'external_account_id', 'config', 'connected_at', 'last_ok_at', 'last_error', 'expires_at'] as const;

export const plugUnhealthy = defineTemplate({
  key: 'hub.plug_unhealthy',
  channel: 'email',
  kind: 'transactional',
  description: 'Tells the person who connected a service that it stopped accepting its access key, so its tools are withdrawn from assistants.',
  subject: '{{service}} needs reconnecting',
  body: 'Hi {{first_name}},\n\n{{service}} is no longer accepting the access key saved for {{org_name}}, so its tools have been withdrawn from your assistants until it is reconnected.\n\nReconnect it at {{console_url}}.',
  variables: z.object({ first_name: z.string(), service: z.string(), console_url: z.string().url() }),
});

/**
 * Mark a plug's connection unhealthy and tell the person who connected it (or the owners), at
 * most once a day per connection. Its tools are withdrawn by the status alone.
 */
export async function markPlugUnhealthy(app: App, connection: Pick<ConnectionRow, 'id' | 'org_id' | 'plug_key'>, error: string): Promise<void> {
  await markConnectionHealth(app, connection.id, { ok: false, error });
  try {
    await app.tenant(connection.org_id, WORKER, async (ctx) => {
      const row = await ctx.db.selectFrom('connections').select(['connected_by_staff_id', 'venue_id']).where('id', '=', connection.id).executeTakeFirst();
      if (!row) return;
      let people = row.connected_by_staff_id
        ? await ctx.db.selectFrom('staff').select(['id', 'first_name', 'email', 'status']).where('id', '=', row.connected_by_staff_id).execute()
        : [];
      people = people.filter((p) => p.status !== 'disabled');
      if (!people.length) people = await ctx.db.selectFrom('staff').select(['id', 'first_name', 'email', 'status']).where('is_owner', '=', true).where('status', '!=', 'disabled').execute();
      const org = await ctx.db.selectFrom('orgs').select('timezone').where('id', '=', ctx.orgId).executeTakeFirstOrThrow();
      const day = localDate(ctx.now(), org.timezone);
      for (const p of people) {
        await queueMessage(ctx, {
          templateKey: plugUnhealthy.key,
          channel: 'email',
          to: p.email,
          venueId: row.venue_id,
          idempotencyKey: `hub.plug_unhealthy:${connection.id}:${p.id}:${day}`,
          variables: { first_name: p.first_name, service: getPlug(connection.plug_key).name, console_url: consoleUrl(app) },
        });
      }
    });
  } catch (e) {
    // The connection is already marked; a notice that could not be queued must not undo that.
    app.log.error('hub: could not queue the plug-unhealthy notice', { connectionId: connection.id, error: (e as Error).message?.slice(0, 200) });
  }
}

export interface PlugCheck {
  connectionId: string;
  plug: string;
  /** Whether the service answered with the saved access key. */
  reachable: 'yes' | 'refused' | 'no';
  /** How its live tool list stands against the reviewed one. `unknown` when it could not be read. */
  pinned: 'pinned' | 'not_reviewed' | 'changed' | 'unknown';
  changedTools: string[];
}

/** Check every remote plug connection of one organisation. Provider calls are made outside any transaction. Safe to run twice. */
export async function checkPlugConnections(app: App, orgId: string): Promise<PlugCheck[]> {
  const plugs = mcpPlugs(app);
  if (!plugs.length) return [];
  const { rows, reviews } = await app.tenant(orgId, WORKER, async (ctx) => ({
    rows: await ctx.db
      .selectFrom('connections')
      .select(SELECT)
      .where('plug_key', 'in', plugs.map((p) => p.key))
      .where('status', 'in', ['connected', 'unhealthy'])
      .execute(),
    reviews: await plugReviews(ctx, plugs.map((p) => p.key)),
  }));

  const out: PlugCheck[] = [];
  for (const row of rows) {
    const plug = plugs.find((p) => p.key === row.plug_key)!;
    const check: PlugCheck = { connectionId: row.id, plug: plug.key, reachable: 'no', pinned: 'unknown', changedTools: [] };
    out.push(check);
    if (!app.adapters.has('remote_mcp', plug.adapters.remote_mcp!)) continue;
    try {
      const handle = await resolveConnection(app, row);
      const live = await app.adapters.get('remote_mcp', plug.adapters.remote_mcp!).listTools(handle);
      check.reachable = 'yes';
      await markConnectionHealth(app, row.id, { ok: true });
      const pinned = checkPinned(reviews.get(plug.key), live);
      check.pinned = pinned.state;
      if (pinned.state === 'changed') {
        check.changedTools = pinned.tools;
        app.log.warn('hub: a plug changed its tool list after review; its tools are withdrawn until it is reviewed again', { plug: plug.key, tools: pinned.tools });
      }
    } catch (e) {
      if (e instanceof RemoteMcpAuthError || isAppError(e)) {
        check.reachable = 'refused';
        if (row.status === 'connected') await markPlugUnhealthy(app, row, 'The service refused the saved access key.');
      } else {
        // An outage at the service is not the venue's to fix: the connection keeps its status.
        app.log.warn('hub: a plug could not be reached', { plug: plug.key, error: (e as Error).message?.slice(0, 200) });
      }
    }
  }
  return out;
}

export const checkPlugsJob = defineJob({
  kind: 'hub.check_plugs',
  schema: noPayload,
  maxAttempts: 3,
  async handler(app, job) {
    if (job.orgId) await checkPlugConnections(app, job.orgId);
  },
});

/** True when the hub is switched on at any venue of the org. Platform scheduler: reads outside a tenant. */
async function hubOnAnywhere(app: App, orgId: string): Promise<boolean> {
  const row = await app.db.selectFrom('venue_modules').select('venue_id').where('org_id', '=', orgId).where('module_key', '=', hubModule.key).where('enabled', '=', true).executeTakeFirst();
  return !!row;
}

export const checkPlugsSchedule = defineSchedule({
  key: 'hub.check_plugs',
  everyMinutes: 15,
  scope: 'org',
  job: checkPlugsJob,
  payload: () => ({}),
  appliesTo: hubOnAnywhere,
});

export const connectMcpPlugInput = z.object({
  plugKey: z.string().trim().min(1).max(60),
  /** The access key the venue created at the service, shown there once. Sealed; never stored on the connection row. */
  accessKey: z.string().trim().min(8).max(500),
  /** Which account at the service, as the venue knows it. Only tells two connections to one plug apart. */
  account: z.string().trim().min(1).max(120).default('default'),
  venueId: z.string().uuid().nullish(),
  /** What the venue lets the plug do through the gateway: 'read', 'write'. Default: everything the plug may be granted. */
  scopes: z.array(z.string()).optional(),
});

/**
 * Connect a remote MCP plug with the access key the venue was given by the service. The key is
 * sealed in the secret store. Nothing is sent to the service here (no provider call inside a
 * transaction): a job checks the connection straight afterwards and marks it unhealthy if the
 * key is refused. Connecting does not offer the plug's tools to assistants: the venue switches
 * that on in `enabled_plugs`, and a key needs the plug's scope.
 */
export async function connectMcpPlug(ctx: Ctx, raw: z.input<typeof connectMcpPlugInput>): Promise<ConnectionRow> {
  const input = connectMcpPlugInput.parse(raw);
  const plug = getPlug(input.plugKey);
  if (plug.kind !== 'mcp' || !plug.adapters.remote_mcp) throw invalid(`${plug.name} is not connected with an access key.`);
  const row = await connect(ctx, {
    plugKey: plug.key,
    venueId: input.venueId ?? null,
    externalAccountId: input.account,
    scopes: input.scopes,
    credentials: { token: input.accessKey },
  });
  await enqueue(ctx, checkPlugsJob, {}, { key: `connect:${row.id}:${ctx.now().toISOString()}` });
  return row;
}
