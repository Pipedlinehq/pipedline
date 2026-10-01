import { z } from 'zod';
import {
  type App,
  type Ctx,
  AppError,
  GUEST_FACING_ROLES,
  adapterFor,
  defineJob,
  enqueue,
  findConnectionFor,
  hmacHex,
  invalid,
  json,
  localParts,
  once,
  requireStaff,
  resolveConnection,
  track,
  zonedTimeToUtc,
  addDays,
  type ConnectionHandle,
} from '@ros/core';
import { hasConsent } from '../identity/consents';
import { getOrg, getOrgSettings } from '../tenancy/orgs';
import { commsSettings, defaultCommsSettings, messageSent, messageSuppressed } from './module';
import { isSuppressed, normaliseAddress } from './suppression';
import { emailMarketingTier } from './connected';
import { getTemplateDef, renderTemplate } from './templates';

export interface QueueInput {
  templateKey: string;
  channel: 'email' | 'sms';
  /** Two queues with the same key produce one message. Build it from what the message is about. */
  idempotencyKey: string;
  variables: Record<string, unknown>;
  customerId?: string | null;
  /** Defaults to the customer's primary address for the channel. */
  to?: string | null;
  venueId?: string | null;
  campaignId?: string | null;
  flowId?: string | null;
  sendAt?: Date;
}

export interface QueueResult {
  messageId: string;
  status: 'queued' | 'suppressed';
  reason?: string;
}

/**
 * Put a message in the outbox, in the same transaction as the change that caused it. Nothing
 * is sent from a request handler; a worker drains the queue (docs/modules/comms.md section 1).
 *
 * A marketing message needs a customer who holds the matching consent. One that does not, or
 * whose address is suppressed, is recorded as suppressed rather than dropped, so "why did this
 * guest not get it" has an answer.
 */
export async function queueMessage(ctx: Ctx, input: QueueInput): Promise<QueueResult> {
  const def = getTemplateDef(input.templateKey, input.channel);
  if (!def) throw invalid(`No ${input.channel} template is defined for ${input.templateKey}.`);
  const variables = def.variables.parse(input.variables);

  let to = input.to ?? null;
  if (!to && input.customerId) {
    const c = await ctx.db.selectFrom('customers').select(['primary_email', 'primary_phone']).where('id', '=', input.customerId).executeTakeFirst();
    to = (input.channel === 'email' ? c?.primary_email : c?.primary_phone) ?? null;
  }
  const address = to ? normaliseAddress(input.channel, to) : null;

  let suppressedFor: string | null = null;
  if (!address) suppressedFor = 'no_address';
  else if (def.kind === 'marketing') {
    if (!input.customerId) suppressedFor = 'no_customer';
    else if (!(await hasConsent(ctx, input.customerId, input.channel === 'email' ? 'marketing_email' : 'marketing_sms'))) suppressedFor = 'no_consent';
  }
  // Connected tier: the venue's own email platform sends its marketing email from its flows.
  if (!suppressedFor && def.kind === 'marketing' && input.channel === 'email' && (await emailMarketingTier(ctx)) === 'connected') {
    suppressedFor = 'connected_platform';
  }
  if (!suppressedFor && address) {
    const s = await isSuppressed(ctx, input.channel, address);
    // A transactional message still goes to someone who unsubscribed from marketing; never to a dead or complaining address.
    if (s && (def.kind === 'marketing' || s === 'bounced_hard' || s === 'complained')) suppressedFor = s;
  }

  const inserted = await ctx.db
    .insertInto('messages')
    .values({
      org_id: ctx.orgId,
      venue_id: input.venueId ?? null,
      customer_id: input.customerId ?? null,
      channel: input.channel,
      kind: def.kind,
      template_key: input.templateKey,
      payload: json(variables),
      to_address: address ?? '',
      status: suppressedFor ? 'suppressed' : 'queued',
      error: suppressedFor,
      idempotency_key: input.idempotencyKey,
      campaign_id: input.campaignId ?? null,
      flow_id: input.flowId ?? null,
      queued_at: ctx.now(),
      next_attempt_at: input.sendAt ?? ctx.now(),
    })
    .onConflict((oc) => oc.columns(['org_id', 'idempotency_key']).doNothing())
    .returning(['id', 'status'])
    .executeTakeFirst();

  if (!inserted) {
    const existing = await ctx.db
      .selectFrom('messages')
      .select(['id', 'status', 'error'])
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirstOrThrow();
    return { messageId: existing.id, status: existing.status === 'suppressed' ? 'suppressed' : 'queued', reason: existing.error ?? undefined };
  }

  if (suppressedFor) {
    await track(
      ctx,
      messageSuppressed,
      { message_id: inserted.id, channel: input.channel, kind: def.kind, template_key: input.templateKey, campaign_id: input.campaignId ?? null, flow_id: input.flowId ?? null, reason: suppressedFor },
      { customerId: input.customerId ?? null, venueId: input.venueId ?? null, source: 'comms' },
    );
    return { messageId: inserted.id, status: 'suppressed', reason: suppressedFor };
  }

  await enqueue(ctx, sendMessageJob, { messageId: inserted.id }, { key: inserted.id, runAt: input.sendAt });
  return { messageId: inserted.id, status: 'queued' };
}

/** The token in an unsubscribe link: the message id and a signature only this org's key can make. */
export async function unsubscribeToken(app: App, orgId: string, messageId: string): Promise<string> {
  const key = await app.secrets.orgKey(orgId, 'unsubscribe_links');
  return `${messageId}.${hmacHex(key, messageId).slice(0, 32)}`;
}

interface Prepared {
  adapterKey: string;
  conn: { row: Awaited<ReturnType<typeof findConnectionFor>> } | null;
  msg: {
    channel: 'email' | 'sms';
    kind: 'transactional' | 'marketing';
    to: string;
    from: { email?: string; name?: string; smsSenderId?: string };
    subject: string | null;
    body: string;
    html: string | null;
    unsubscribeUrl: string | null;
  };
  templateKey: string;
  campaignId: string | null;
  flowId: string | null;
  customerId: string | null;
  venueId: string | null;
}

type PrepareOutcome = { action: 'send'; prepared: Prepared } | { action: 'skip' } | { action: 'defer'; until: Date };

/** Transaction one of a send: decide whether it may go, render it, and mark it as going. */
async function prepare(ctx: Ctx, messageId: string, unsubscribe: string): Promise<PrepareOutcome> {
  const m = await ctx.db.selectFrom('messages').selectAll().where('id', '=', messageId).forUpdate().executeTakeFirst();
  if (!m || (m.status !== 'queued' && m.status !== 'sending')) return { action: 'skip' };

  const suppress = async (reason: string): Promise<PrepareOutcome> => {
    await ctx.db.updateTable('messages').set({ status: 'suppressed', error: reason }).where('id', '=', m.id).execute();
    await track(
      ctx,
      messageSuppressed,
      { message_id: m.id, channel: m.channel, kind: m.kind, template_key: m.template_key, campaign_id: m.campaign_id, flow_id: m.flow_id, reason },
      { customerId: m.customer_id, venueId: m.venue_id, source: 'comms' },
    );
    return { action: 'skip' };
  };

  // Checked again at send time: the guest may have opted out since this was queued.
  const s = await isSuppressed(ctx, m.channel, m.to_address);
  if (s && (m.kind === 'marketing' || s === 'bounced_hard' || s === 'complained')) return suppress(s);
  if (m.kind === 'marketing') {
    if (!m.customer_id || !(await hasConsent(ctx, m.customer_id, m.channel === 'email' ? 'marketing_email' : 'marketing_sms'))) {
      return suppress('no_consent');
    }
    // Queued before the venue moved to the connected tier: their platform sends it now.
    if (m.channel === 'email' && (await emailMarketingTier(ctx)) === 'connected') return suppress('connected_platform');
  }

  const org = await getOrg(ctx);
  const settings = await getOrgSettings(ctx, 'comms', commsSettings, defaultCommsSettings);
  const now = ctx.now();

  if (m.kind === 'marketing') {
    // Quiet hours (SMS) and the org's daily cap: wait, never drop.
    const local = localParts(now, org.timezone);
    const hhmm = local.time.slice(0, 5);
    if (m.channel === 'sms') {
      const { start, end } = settings.smsQuietHours;
      const quiet = start > end ? hhmm >= start || hhmm < end : hhmm >= start && hhmm < end;
      if (quiet) {
        const day = start > end && hhmm >= start ? addDays(local.date, 1) : local.date;
        return { action: 'defer', until: zonedTimeToUtc(day, `${end}:00`, org.timezone) };
      }
    }
    const cap = m.channel === 'email' ? settings.dailyMarketingEmailCap : settings.dailyMarketingSmsCap;
    const dayStart = zonedTimeToUtc(local.date, '00:00:00', org.timezone);
    const sentToday = await ctx.db
      .selectFrom('messages')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('kind', '=', 'marketing')
      .where('channel', '=', m.channel)
      .where('sent_at', '>=', dayStart)
      .executeTakeFirstOrThrow();
    if (Number(sentToday.n) >= cap) {
      return { action: 'defer', until: zonedTimeToUtc(addDays(local.date, 1), m.channel === 'sms' ? `${settings.smsQuietHours.end}:00` : '08:00:00', org.timezone) };
    }
  }

  const cfg = ctx.app.config;
  const host = await ctx.db
    .selectFrom('domains')
    .select('host')
    .where('is_primary', '=', true)
    .where('verified_at', 'is not', null)
    .orderBy('venue_id', (ob) => ob.asc().nullsFirst())
    .executeTakeFirst();
  const unsubscribeUrl = m.kind === 'marketing' && m.channel === 'email' && host ? `${cfg.scheme}://${host.host}/u/${unsubscribe}` : null;

  const { rendered } = await renderTemplate(ctx, m.template_key, m.channel, (m.payload ?? {}) as Record<string, unknown>, {
    orgName: org.tradingName,
    unsubscribeUrl,
    senderAddressLine: settings.senderAddressLine,
  });

  let from: Prepared['msg']['from'];
  let connRow: Awaited<ReturnType<typeof findConnectionFor>> = null;
  if (m.kind === 'transactional') {
    from =
      m.channel === 'email'
        ? { email: `${org.slug}@${cfg.comms.platformSendingDomain}`, name: org.tradingName }
        : { smsSenderId: cfg.comms.platformSmsSender };
  } else {
    // Marketing goes out on the org's own verified identity: their list, their reputation.
    const identity = await ctx.db
      .selectFrom('sending_identities')
      .select(['from_email', 'from_name', 'sms_sender_id'])
      .where('channel', '=', m.channel)
      .where('kind', '=', 'marketing')
      .where('status', '=', 'verified')
      .executeTakeFirst();
    if (!identity) {
      await ctx.db.updateTable('messages').set({ status: 'failed', error: 'no_verified_sending_identity' }).where('id', '=', m.id).execute();
      return { action: 'skip' };
    }
    from =
      m.channel === 'email'
        ? { email: identity.from_email ?? undefined, name: identity.from_name ?? org.tradingName }
        : { smsSenderId: identity.sms_sender_id ?? undefined };
    connRow = await findConnectionFor(ctx, 'message', m.venue_id);
  }

  await ctx.db
    .updateTable('messages')
    .set({ status: 'sending', subject: rendered.subject, rendered_body: rendered.text, attempts: m.attempts + 1, error: null })
    .where('id', '=', m.id)
    .execute();

  return {
    action: 'send',
    prepared: {
      adapterKey: m.channel === 'email' ? cfg.comms.emailAdapter : cfg.comms.smsAdapter,
      conn: connRow ? { row: connRow } : null,
      msg: { channel: m.channel, kind: m.kind, to: m.to_address, from, subject: rendered.subject, body: rendered.text, html: rendered.html, unsubscribeUrl },
      templateKey: m.template_key,
      campaignId: m.campaign_id,
      flowId: m.flow_id,
      customerId: m.customer_id,
      venueId: m.venue_id,
    },
  };
}

export const sendMessageJob = defineJob({
  kind: 'comms.send',
  schema: z.object({ messageId: z.string().uuid(), deferral: z.number().int().optional() }),
  maxAttempts: 6,
  async handler(app, job) {
    const orgId = job.orgId;
    if (!orgId) throw new Error('comms.send needs an org');
    const { messageId } = job.payload;
    const worker = { kind: 'worker' as const, job: 'comms.send' };
    const token = await unsubscribeToken(app, orgId, messageId);

    const outcome = await app.tenant(orgId, worker, (ctx) => prepare(ctx, messageId, token));
    if (outcome.action === 'skip') return;
    if (outcome.action === 'defer') {
      await app.tenant(orgId, worker, async (ctx) => {
        await ctx.db.updateTable('messages').set({ next_attempt_at: outcome.until }).where('id', '=', messageId).execute();
        const n = (job.payload.deferral ?? 0) + 1;
        await enqueue(ctx, sendMessageJob, { messageId, deferral: n }, { runAt: outcome.until, key: `${messageId}:d${n}` });
      });
      return;
    }

    const p = outcome.prepared;
    try {
      const adapter = p.conn?.row ? adapterFor(app, 'message', p.conn.row) : app.adapters.get('message', p.adapterKey);
      let handle: ConnectionHandle | null = null;
      if (p.conn?.row) handle = await resolveConnection(app, p.conn.row);
      const sent = await once(app, { orgId, key: `msg:${messageId}`, kind: 'message' }, () =>
        adapter.send(handle, { idempotencyKey: `msg:${messageId}`, ...p.msg }),
      );
      await app.tenant(orgId, worker, async (ctx) => {
        await ctx.db
          .updateTable('messages')
          .set({
            status: 'sent',
            provider: adapter.key,
            provider_message_id: sent.result.providerMessageId,
            cost_cents: sent.result.costCents ?? null,
            sent_at: ctx.now(),
            error: null,
          })
          .where('id', '=', messageId)
          .where('status', '=', 'sending')
          .execute();
        await ctx.db.insertInto('message_events').values({ org_id: orgId, message_id: messageId, event: 'sent', occurred_at: ctx.now() }).execute();
        await track(
          ctx,
          messageSent,
          { message_id: messageId, channel: p.msg.channel, kind: p.msg.kind, template_key: p.templateKey, campaign_id: p.campaignId, flow_id: p.flowId },
          { customerId: p.customerId, venueId: p.venueId, source: 'comms' },
        );
      });
    } catch (e) {
      const last = job.attempt >= 6;
      await app.tenant(orgId, worker, async (ctx) => {
        await ctx.db
          .updateTable('messages')
          .set({ status: last ? 'failed' : 'queued', error: (e as Error).message.slice(0, 500) })
          .where('id', '=', messageId)
          .where('status', '=', 'sending')
          .execute();
      });
      if (!last) throw e instanceof AppError ? e : new AppError('provider_error', (e as Error).message);
    }
  },
});

export interface MessageView {
  id: string;
  channel: 'email' | 'sms';
  kind: 'transactional' | 'marketing';
  templateKey: string;
  to: string;
  status: string;
  subject: string | null;
  renderedBody: string | null;
  error: string | null;
  queuedAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
}

/** What a guest was actually sent, for a dispute or a support question. */
export async function listMessagesForCustomer(ctx: Ctx, customerId: string, limit = 50): Promise<MessageView[]> {
  requireStaff(ctx, { anyOf: GUEST_FACING_ROLES });
  const rows = await ctx.db
    .selectFrom('messages')
    .select(['id', 'channel', 'kind', 'template_key', 'to_address', 'status', 'subject', 'rendered_body', 'error', 'queued_at', 'sent_at', 'delivered_at'])
    .where('customer_id', '=', customerId)
    .orderBy('queued_at', 'desc')
    .limit(Math.min(limit, 200))
    .execute();
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    kind: r.kind,
    templateKey: r.template_key,
    to: r.to_address,
    status: r.status,
    subject: r.subject,
    renderedBody: r.rendered_body,
    error: r.error,
    queuedAt: r.queued_at,
    sentAt: r.sent_at,
    deliveredAt: r.delivered_at,
  }));
}
