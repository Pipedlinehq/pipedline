import { z } from 'zod';
import { type App, type Ctx, type PlatformPrincipal, type Principal, audit, conflict, forbidden, notFound, requireOwner } from '@ros/core';
import { plainText } from '../website/safe';
import { requirePlatformAdmin } from './platform';

/**
 * Our own access to a tenant (docs/THREAT_MODEL.md section 9): opened by a platform admin with
 * a reason, recorded where the venue's owner can read it, and closed when the work is done.
 * No role inside a tenant's org can open it.
 */
export const openSupportAccessInput = z.object({
  orgId: z.string().uuid(),
  /** Why we are going in. The venue's owner reads this. */
  reason: plainText(500, { min: 10 }),
});

export interface SupportAccessGrant {
  id: string;
  orgId: string;
  startedAt: Date;
  /** The principal to act as inside the org while this access is open. */
  principal: PlatformPrincipal;
}

export async function openSupportAccess(app: App, actor: Principal, raw: z.input<typeof openSupportAccessInput>): Promise<SupportAccessGrant> {
  const { adminUserId } = await requirePlatformAdmin(app, actor);
  const input = openSupportAccessInput.parse(raw);
  const org = await app.db.selectFrom('orgs').select('id').where('id', '=', input.orgId).executeTakeFirst();
  if (!org) throw notFound('Organisation not found');
  const principal: PlatformPrincipal = { kind: 'platform', adminUserId, reason: `support: ${input.reason}` };
  // Written inside the org, in one transaction with its audit entry, so the record and the
  // entry in the venue's own audit log cannot exist without each other.
  return app.tenant(input.orgId, principal, async (ctx) => {
    const open = await ctx.db.selectFrom('support_access').select('id').where('admin_user_id', '=', adminUserId).where('ended_at', 'is', null).executeTakeFirst();
    if (open) throw conflict('You already have support access open for this organisation. Close it first.');
    const row = await ctx.db
      .insertInto('support_access')
      .values({ org_id: ctx.orgId, admin_user_id: adminUserId, reason: input.reason, started_at: ctx.now() })
      .returning(['id', 'started_at'])
      .executeTakeFirstOrThrow();
    await audit(ctx, { action: 'support.access_opened', entityType: 'support_access', entityId: row.id, after: { reason: input.reason } });
    return { id: row.id, orgId: input.orgId, startedAt: row.started_at, principal };
  });
}

export async function closeSupportAccess(app: App, actor: Principal, input: { accessId: string }): Promise<void> {
  const { adminUserId } = await requirePlatformAdmin(app, actor);
  if (!z.string().uuid().safeParse(input.accessId).success) throw notFound('Support access not found');
  // The table is append-only to tenant transactions, so the end time is written by the platform.
  const row = await app.db
    .updateTable('support_access')
    .set({ ended_at: app.clock() })
    .where('id', '=', input.accessId)
    .where('ended_at', 'is', null)
    .returning(['id', 'org_id'])
    .executeTakeFirst();
  if (!row) throw notFound('Support access not found');
  await app.tenant(row.org_id, { kind: 'platform', adminUserId, reason: 'support: closing access' }, (ctx) =>
    audit(ctx, { action: 'support.access_closed', entityType: 'support_access', entityId: row.id }),
  );
}

/**
 * The principal a platform admin acts as inside an org. Refused unless that admin has support
 * access open there, so nobody at the platform is inside a tenant off the record.
 */
export async function supportPrincipal(app: App, actor: Principal, input: { orgId: string }): Promise<PlatformPrincipal> {
  const { adminUserId } = await requirePlatformAdmin(app, actor);
  if (!z.string().uuid().safeParse(input.orgId).success) throw notFound('Organisation not found');
  const open = await app.db
    .selectFrom('support_access')
    .select(['id', 'reason'])
    .where('org_id', '=', input.orgId)
    .where('admin_user_id', '=', adminUserId)
    .where('ended_at', 'is', null)
    .executeTakeFirst();
  if (!open) throw forbidden('Open support access for this organisation first, with the reason.');
  return { kind: 'platform', adminUserId, reason: `support: ${open.reason}` };
}

export interface SupportAccessView {
  id: string;
  /** Who at the platform opened it. */
  by: string;
  reason: string;
  startedAt: Date;
  /** null while the access is still open. */
  endedAt: Date | null;
}

/** Every time the platform has been inside this org, newest first. For the org's owner. */
export async function listSupportAccess(ctx: Ctx): Promise<SupportAccessView[]> {
  requireOwner(ctx);
  const rows = await ctx.db.selectFrom('support_access').select(['id', 'admin_user_id', 'reason', 'started_at', 'ended_at']).orderBy('started_at', 'desc').limit(200).execute();
  if (!rows.length) return [];
  // `users` is a platform table. Only the names of the admins on this org's own records are read.
  const admins = await ctx.app.db
    .selectFrom('users')
    .select(['id', 'name'])
    .where('id', 'in', [...new Set(rows.map((r) => r.admin_user_id))])
    .execute();
  const names = new Map(admins.map((a) => [a.id, a.name]));
  return rows.map((r) => ({ id: r.id, by: names.get(r.admin_user_id) ?? 'Platform support', reason: r.reason, startedAt: r.started_at, endedAt: r.ended_at }));
}
