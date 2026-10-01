import type { App } from './app';

/**
 * Webhook de-duplication. Providers retry and replay; every inbound event is claimed here by
 * (provider, event id) before it is acted on, so a repeat is recognised and skipped.
 */
export interface ClaimedWebhook {
  id: string;
}

/** Returns a claim when this event has not been seen before, or null when it is a repeat. */
export async function claimWebhookEvent(
  app: App,
  args: { provider: string; eventId: string; eventType?: string | null; payloadDigest?: string | null },
): Promise<ClaimedWebhook | null> {
  const row = await app.db
    .insertInto('webhook_events')
    .values({
      provider: args.provider,
      event_id: args.eventId,
      event_type: args.eventType ?? null,
      payload_digest: args.payloadDigest ?? null,
      received_at: app.clock(),
    })
    .onConflict((oc) => oc.columns(['provider', 'event_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return row ?? null;
}

export async function finishWebhookEvent(
  app: App,
  claim: ClaimedWebhook,
  outcome: { status: 'processed' | 'ignored'; orgId?: string | null; connectionId?: string | null },
): Promise<void> {
  await app.db
    .updateTable('webhook_events')
    .set({ status: outcome.status, org_id: outcome.orgId ?? null, connection_id: outcome.connectionId ?? null, processed_at: app.clock() })
    .where('id', '=', claim.id)
    .execute();
}

/** Processing failed: forget the claim so the provider's retry is handled afresh. */
export async function releaseWebhookEvent(app: App, claim: ClaimedWebhook): Promise<void> {
  await app.db.deleteFrom('webhook_events').where('id', '=', claim.id).execute();
}
