import {
  type App,
  type Ctx,
  type MessageProviderEvent,
  AppError,
  claimWebhookEvent,
  findConnectionByAccount,
  finishWebhookEvent,
  hmacHex,
  json,
  releaseWebhookEvent,
  safeEqual,
  track,
} from '@ros/core';
import { revokeConsent } from '../identity/consents';
import { messageBounced, messageClicked, messageDelivered, messageOpened, messageUnsubscribed } from './module';
import { addSuppression, normaliseAddress } from './suppression';

const WORKER = { kind: 'worker' as const, job: 'comms.webhook' };

async function applyToMessage(ctx: Ctx, messageId: string, ev: MessageProviderEvent): Promise<void> {
  const m = await ctx.db
    .selectFrom('messages')
    .select(['id', 'channel', 'kind', 'template_key', 'campaign_id', 'flow_id', 'customer_id', 'venue_id', 'to_address', 'status'])
    .where('id', '=', messageId)
    .forUpdate()
    .executeTakeFirst();
  if (!m) return;

  await ctx.db
    .insertInto('message_events')
    .values({ org_id: ctx.orgId, message_id: m.id, event: ev.event, occurred_at: ev.occurredAt, metadata: json(ev.metadata ?? {}) })
    .execute();

  const props = { message_id: m.id, channel: m.channel, kind: m.kind, template_key: m.template_key, campaign_id: m.campaign_id, flow_id: m.flow_id };
  const opts = { customerId: m.customer_id, venueId: m.venue_id, occurredAt: ev.occurredAt, source: 'comms' as const };
  const emit = (def: typeof messageDelivered) => track(ctx, def, props, opts);

  switch (ev.event) {
    case 'delivered':
      if (m.status === 'sent' || m.status === 'sending') {
        await ctx.db.updateTable('messages').set({ status: 'delivered', delivered_at: ev.occurredAt }).where('id', '=', m.id).execute();
      }
      await emit(messageDelivered);
      break;
    case 'opened':
      await emit(messageOpened);
      break;
    case 'clicked':
      await emit(messageClicked);
      break;
    case 'bounced':
    case 'failed':
      await ctx.db.updateTable('messages').set({ status: 'bounced', error: ev.event }).where('id', '=', m.id).execute();
      if (ev.hardBounce) await addSuppression(ctx, m.channel, m.to_address, 'bounced_hard');
      await emit(messageBounced);
      break;
    case 'complained':
    case 'unsubscribed': {
      const via = ev.event === 'complained' ? 'provider_complaint' : 'provider_unsubscribe';
      await optOut(ctx, m.channel, m.to_address, m.customer_id, via);
      await track(ctx, messageUnsubscribed, { ...props, via }, opts);
      break;
    }
    default:
      break;
  }
}

/** An opt-out, from any route: suppress the address and withdraw the matching consent. */
export async function optOut(ctx: Ctx, channel: 'email' | 'sms', address: string, customerId: string | null, via: string): Promise<void> {
  await addSuppression(ctx, channel, address, via === 'provider_complaint' ? 'complained' : 'unsubscribed');
  const value = normaliseAddress(channel, address);
  let ids = customerId ? [customerId] : [];
  if (!ids.length && value) {
    const col = channel === 'email' ? 'primary_email' : 'primary_phone';
    ids = (await ctx.db.selectFrom('customers').select('id').where(col, '=', value).where('status', '=', 'active').execute()).map((r) => r.id);
  }
  for (const id of ids) {
    await revokeConsent(ctx, { customerId: id, purpose: channel === 'email' ? 'marketing_email' : 'marketing_sms', source: via });
  }
}

export interface WebhookArgs {
  adapterKey: string;
  rawBody: string;
  headers: Record<string, string | undefined>;
  url: string;
}

/**
 * Delivery, bounce, complaint and opt-out events from a sending provider. Verified on the raw
 * body, de-duplicated by the provider's event id, and applied inside the owning org.
 */
export async function handleMessageWebhook(app: App, args: WebhookArgs): Promise<{ applied: number; duplicates: number; unmatched: number }> {
  const adapter = app.adapters.get('message', args.adapterKey);
  const secret = app.config.comms.webhookSecrets[args.adapterKey];
  if (!secret || !adapter.verifyWebhook({ rawBody: args.rawBody, headers: args.headers, url: args.url, signingSecret: secret })) {
    throw new AppError('unauthenticated', 'Signature check failed.');
  }
  const events = adapter.parseWebhook(args.rawBody);
  let applied = 0;
  let duplicates = 0;
  let unmatched = 0;

  for (const ev of events) {
    const fresh = await claimWebhookEvent(app, { provider: `message:${adapter.key}`, eventId: ev.eventId, eventType: ev.event });
    if (!fresh) {
      duplicates++;
      continue;
    }

    let orgId: string | null = null;
    let messageId: string | null = null;
    if (ev.providerMessageId) {
      const m = await app.db
        .selectFrom('messages')
        .select(['id', 'org_id'])
        .where('provider', '=', adapter.key)
        .where('provider_message_id', '=', ev.providerMessageId)
        .executeTakeFirst();
      if (m) {
        orgId = m.org_id;
        messageId = m.id;
      }
    } else if (ev.event === 'unsubscribed' && ev.accountRef && ev.address) {
      // A STOP reply: no message is named, but the account it arrived on belongs to one org.
      const conn = await findConnectionByAccount(app, adapter.key, ev.accountRef);
      orgId = conn?.org_id ?? null;
    }

    if (!orgId) {
      unmatched++;
      await finishWebhookEvent(app, fresh, { status: 'ignored' });
      continue;
    }

    try {
      await app.tenant(orgId, WORKER, async (ctx) => {
        if (messageId) await applyToMessage(ctx, messageId, ev);
        else if (ev.address) await optOut(ctx, adapter.channels.includes('sms') ? 'sms' : 'email', ev.address, null, 'sms_stop');
      });
      await finishWebhookEvent(app, fresh, { status: 'processed', orgId });
      applied++;
    } catch (e) {
      await releaseWebhookEvent(app, fresh);
      throw e;
    }
  }
  return { applied, duplicates, unmatched };
}

/**
 * One-click unsubscribe from the link in a marketing email. The token proves control of the
 * mailbox, so no sign-in is asked for. Returns the org's trading name for the confirmation page.
 */
export async function unsubscribeByToken(app: App, orgId: string, token: string): Promise<{ ok: boolean }> {
  const [messageId, sig] = token.split('.');
  if (!messageId || !sig || !/^[0-9a-f-]{36}$/.test(messageId)) return { ok: false };
  const key = await app.secrets.orgKey(orgId, 'unsubscribe_links');
  if (!safeEqual(hmacHex(key, messageId).slice(0, 32), sig)) return { ok: false };
  return app.tenant(orgId, { kind: 'worker', job: 'comms.unsubscribe' }, async (ctx) => {
    const m = await ctx.db
      .selectFrom('messages')
      .select(['id', 'channel', 'kind', 'template_key', 'campaign_id', 'flow_id', 'customer_id', 'venue_id', 'to_address'])
      .where('id', '=', messageId)
      .executeTakeFirst();
    if (!m) return { ok: false };
    await optOut(ctx, m.channel, m.to_address, m.customer_id, 'unsubscribe_link');
    await ctx.db.insertInto('message_events').values({ org_id: ctx.orgId, message_id: m.id, event: 'unsubscribed', occurred_at: ctx.now() }).execute();
    await track(
      ctx,
      messageUnsubscribed,
      { message_id: m.id, channel: m.channel, kind: m.kind, template_key: m.template_key, campaign_id: m.campaign_id, flow_id: m.flow_id, via: 'unsubscribe_link' },
      { customerId: m.customer_id, venueId: m.venue_id, source: 'comms' },
    );
    return { ok: true };
  });
}
