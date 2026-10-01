import { type Ctx, audit, requireStaff } from '@ros/core';
import { onConsentChanged } from '../identity/consents';
import { normaliseEmail, normalisePhone } from '../identity/normalise';

export type SuppressionReason = 'unsubscribed' | 'bounced_hard' | 'complained' | 'manual';

export function normaliseAddress(channel: 'email' | 'sms', raw: string): string | null {
  return channel === 'email' ? normaliseEmail(raw) : normalisePhone(raw);
}

export async function isSuppressed(ctx: Ctx, channel: 'email' | 'sms', address: string): Promise<SuppressionReason | null> {
  const value = normaliseAddress(channel, address);
  if (!value) return 'manual';
  const r = await ctx.db.selectFrom('suppressions').select('reason').where('channel', '=', channel).where('value', '=', value).executeTakeFirst();
  return r?.reason ?? null;
}

/**
 * Suppress an address. Checked at send time, per org, and it survives list re-imports: an
 * import never deletes from this table (docs/modules/comms.md section 4).
 */
export async function addSuppression(ctx: Ctx, channel: 'email' | 'sms', address: string, reason: SuppressionReason): Promise<void> {
  const value = normaliseAddress(channel, address);
  if (!value) return;
  await ctx.db
    .insertInto('suppressions')
    .values({ org_id: ctx.orgId, channel, value, reason, created_at: ctx.now() })
    // A bounce or complaint outranks a plain unsubscribe and is never downgraded by one.
    .onConflict((oc) =>
      oc.columns(['org_id', 'channel', 'value']).doUpdateSet((eb) => ({
        reason: eb
          .case()
          .when('suppressions.reason', 'in', ['bounced_hard', 'complained'])
          .then(eb.ref('suppressions.reason'))
          .else(eb.ref('excluded.reason'))
          .end(),
      })),
    )
    .execute();
}

export async function addManualSuppression(ctx: Ctx, channel: 'email' | 'sms', address: string): Promise<void> {
  requireStaff(ctx, { minRole: 'manager' });
  await addSuppression(ctx, channel, address, 'manual');
  await audit(ctx, { action: 'suppression.added', entityType: 'suppression', after: { channel } });
}

/** Lift a suppression. Only an unsubscribe can be lifted, and only by the guest consenting again. */
async function liftUnsubscribe(ctx: Ctx, channel: 'email' | 'sms', address: string): Promise<void> {
  const value = normaliseAddress(channel, address);
  if (!value) return;
  await ctx.db.deleteFrom('suppressions').where('channel', '=', channel).where('value', '=', value).where('reason', '=', 'unsubscribed').execute();
}

// Consent and suppression move together: an opt-out anywhere is an opt-out everywhere.
onConsentChanged(async (ctx, change) => {
  const channel = change.purpose === 'marketing_email' ? 'email' : change.purpose === 'marketing_sms' ? 'sms' : null;
  if (!channel) return;
  const c = await ctx.db.selectFrom('customers').select(['primary_email', 'primary_phone']).where('id', '=', change.customerId).executeTakeFirst();
  const address = channel === 'email' ? c?.primary_email : c?.primary_phone;
  if (!address) return;
  if (change.action === 'revoked') await addSuppression(ctx, channel, address, change.source === 'provider_complaint' ? 'complained' : 'unsubscribed');
  else await liftUnsubscribe(ctx, channel, address);
});
