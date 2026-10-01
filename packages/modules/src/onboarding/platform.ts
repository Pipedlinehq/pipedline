import { type App, type PlatformPrincipal, type Principal, AppError, forbidden } from '@ros/core';

/**
 * The principal provisioning acts as inside an org. Internal: role checks do not apply, and
 * functions that refuse venue staff (marking a domain or a sending identity verified) accept it.
 */
export const PROVISIONER: PlatformPrincipal = { kind: 'platform', reason: 'provisioning' };

/**
 * Platform surfaces (the onboarding wizard, the status board, tenant health, support access)
 * are for platform admins only. The admin is checked against platform_admins on every call,
 * never taken on the principal's word: no role inside a tenant's org, however senior, passes
 * (docs/THREAT_MODEL.md section 9).
 */
export async function requirePlatformAdmin(app: App, actor: Principal): Promise<{ adminUserId: string }> {
  if (actor.kind !== 'platform' || !actor.adminUserId) {
    if (actor.kind === 'anon') throw new AppError('unauthenticated', 'Sign in to do that.');
    throw forbidden('Only the platform team can do that.');
  }
  // platform_admins is a platform table: no tenant transaction can read it.
  const admin = await app.db.selectFrom('platform_admins').select('user_id').where('user_id', '=', actor.adminUserId).executeTakeFirst();
  if (!admin) throw forbidden('Only the platform team can do that.');
  return { adminUserId: admin.user_id };
}
