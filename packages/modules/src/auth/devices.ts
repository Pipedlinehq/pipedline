import { z } from 'zod';
import { type App, type Ctx, type DevicePrincipal, AppError, audit, hashToken, newCode, newToken, notFound, rateLimit, requireStaff } from '@ros/core';

export const devicePairingInput = z.object({
  venueId: z.string().uuid(),
  name: z.string().min(1).max(60),
  purpose: z.enum(['kitchen', 'counter']),
});

/** Start pairing a kitchen or counter screen: a short code the screen types in within 15 minutes. */
export async function createDevicePairing(ctx: Ctx, raw: z.input<typeof devicePairingInput>): Promise<{ deviceId: string; code: string; expiresAt: Date }> {
  const input = devicePairingInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  const code = newCode(8);
  const expiresAt = new Date(ctx.now().getTime() + 15 * 60_000);
  const row = await ctx.db
    .insertInto('devices')
    .values({
      org_id: ctx.orgId,
      venue_id: input.venueId,
      name: input.name,
      purpose: input.purpose,
      pairing_code_hash: hashToken(code),
      pairing_expires_at: expiresAt,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'device.pairing_started', entityType: 'device', entityId: row.id, venueId: input.venueId, after: { name: input.name, purpose: input.purpose } });
  return { deviceId: row.id, code, expiresAt };
}

/** The screen redeems its code for a long-lived token bound to one venue and one purpose. */
export async function pairDevice(app: App, rawCode: string, meta: { ip?: string } = {}): Promise<{ token: string; orgId: string; venueId: string; purpose: 'kitchen' | 'counter' }> {
  if (meta.ip) await rateLimit(app, `pair:ip:${meta.ip}`, { limit: 10, windowSeconds: 600 });
  const code = rawCode.trim().toUpperCase();
  const { token, hash } = newToken('ros_d');
  const now = app.clock();
  const row = await app.db
    .updateTable('devices')
    .set({ token_hash: hash, paired_at: now, pairing_code_hash: null, pairing_expires_at: null, last_seen_at: now })
    .where('pairing_code_hash', '=', hashToken(code))
    .where('pairing_expires_at', '>', now)
    .where('revoked_at', 'is', null)
    .returning(['id', 'org_id', 'venue_id', 'purpose'])
    .executeTakeFirst();
  if (!row) throw new AppError('unauthenticated', 'That pairing code is not right, or it has expired.');
  return { token, orgId: row.org_id, venueId: row.venue_id, purpose: row.purpose };
}

export async function authenticateDevice(app: App, token: string | null | undefined): Promise<{ orgId: string; principal: DevicePrincipal } | null> {
  if (!token || !/^ros_d_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await app.db
    .selectFrom('devices')
    .select(['id', 'org_id', 'venue_id', 'purpose', 'last_seen_at'])
    .where('token_hash', '=', hashToken(token))
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (!row) return null;
  const now = app.clock();
  if (!row.last_seen_at || now.getTime() - row.last_seen_at.getTime() > 60_000) {
    await app.db.updateTable('devices').set({ last_seen_at: now }).where('id', '=', row.id).execute();
  }
  return { orgId: row.org_id, principal: { kind: 'device', deviceId: row.id, venueId: row.venue_id, purpose: row.purpose } };
}

export interface DeviceView {
  id: string;
  venueId: string;
  name: string;
  purpose: 'kitchen' | 'counter';
  paired: boolean;
  lastSeenAt: Date | null;
  revoked: boolean;
}

export async function listDevices(ctx: Ctx, venueId: string): Promise<DeviceView[]> {
  requireStaff(ctx, { venueId, minRole: 'manager' });
  const rows = await ctx.db
    .selectFrom('devices')
    .select(['id', 'venue_id', 'name', 'purpose', 'paired_at', 'last_seen_at', 'revoked_at'])
    .where('venue_id', '=', venueId)
    .orderBy('created_at')
    .execute();
  return rows.map((r) => ({ id: r.id, venueId: r.venue_id, name: r.name, purpose: r.purpose, paired: r.paired_at !== null, lastSeenAt: r.last_seen_at, revoked: r.revoked_at !== null }));
}

export async function revokeDevice(ctx: Ctx, deviceId: string): Promise<void> {
  const d = await ctx.db.selectFrom('devices').select(['id', 'venue_id']).where('id', '=', deviceId).executeTakeFirst();
  if (!d) throw notFound('Screen not found');
  requireStaff(ctx, { venueId: d.venue_id, minRole: 'manager' });
  await ctx.db.updateTable('devices').set({ revoked_at: ctx.now(), token_hash: null }).where('id', '=', deviceId).execute();
  await audit(ctx, { action: 'device.revoked', entityType: 'device', entityId: deviceId, venueId: d.venue_id });
}
