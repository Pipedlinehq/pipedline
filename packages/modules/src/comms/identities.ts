import { z } from 'zod';
import { type Ctx, audit, forbidden, isInternal, json, notFound, requireOwner, requireStaff } from '@ros/core';

export interface SendingIdentityView {
  id: string;
  channel: 'email' | 'sms';
  kind: 'transactional' | 'marketing';
  domain: string | null;
  fromEmail: string | null;
  fromName: string | null;
  smsSenderId: string | null;
  status: string;
  dnsRecords: unknown;
}

export async function listSendingIdentities(ctx: Ctx): Promise<SendingIdentityView[]> {
  requireStaff(ctx, { minRole: 'manager' });
  const rows = await ctx.db.selectFrom('sending_identities').selectAll().orderBy('created_at').execute();
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    kind: r.kind,
    domain: r.domain,
    fromEmail: r.from_email,
    fromName: r.from_name,
    smsSenderId: r.sms_sender_id,
    status: r.status,
    dnsRecords: r.dns_records,
  }));
}

export const sendingIdentityInput = z.discriminatedUnion('channel', [
  z.object({
    channel: z.literal('email'),
    domain: z.string().toLowerCase().regex(/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/),
    fromLocalPart: z.string().regex(/^[a-z0-9._-]{1,64}$/i).default('hello'),
    fromName: z.string().min(1).max(100),
  }),
  z.object({ channel: z.literal('sms'), smsSenderId: z.string().min(3).max(15) }),
]);

/**
 * Register the org's own marketing identity: a sending domain, or an SMS sender id. It starts
 * pending; provisioning verifies the DNS records or the sender registration before it can send.
 */
export async function addSendingIdentity(
  ctx: Ctx,
  raw: z.input<typeof sendingIdentityInput>,
  provider: { key: string; providerDomainId?: string; dnsRecords?: unknown },
): Promise<SendingIdentityView> {
  requireOwner(ctx);
  const input = sendingIdentityInput.parse(raw);
  const r = await ctx.db
    .insertInto('sending_identities')
    .values({
      org_id: ctx.orgId,
      channel: input.channel,
      kind: 'marketing',
      domain: input.channel === 'email' ? input.domain : null,
      from_email: input.channel === 'email' ? `${input.fromLocalPart}@${input.domain}` : null,
      from_name: input.channel === 'email' ? input.fromName : null,
      sms_sender_id: input.channel === 'sms' ? input.smsSenderId : null,
      provider: provider.key,
      provider_domain_id: provider.providerDomainId ?? null,
      dns_records: provider.dnsRecords === undefined ? null : json(provider.dnsRecords),
      status: 'pending',
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'sending_identity.added', entityType: 'sending_identity', entityId: r.id, after: { channel: r.channel, domain: r.domain } });
  return {
    id: r.id,
    channel: r.channel,
    kind: r.kind,
    domain: r.domain,
    fromEmail: r.from_email,
    fromName: r.from_name,
    smsSenderId: r.sms_sender_id,
    status: r.status,
    dnsRecords: r.dns_records,
  };
}

/** Provisioning marks an identity verified once the provider confirms it. Internal callers only. */
export async function setSendingIdentityStatus(ctx: Ctx, id: string, status: 'pending' | 'verified' | 'failed' | 'suspended'): Promise<void> {
  // Never an owner: a venue cannot declare its own domain verified.
  if (!isInternal(ctx)) throw forbidden('Verification is confirmed by the sending provider.');
  const r = await ctx.db
    .updateTable('sending_identities')
    .set({ status, verified_at: status === 'verified' ? ctx.now() : null })
    .where('id', '=', id)
    .returning('id')
    .executeTakeFirst();
  if (!r) throw notFound('Sending identity not found');
  await audit(ctx, { action: 'sending_identity.status', entityType: 'sending_identity', entityId: id, after: { status } });
}
