import { z } from 'zod';
import { type Ctx, type StaffRole, ROLE_RANK, audit, conflict, forbidden, invalid, notFound, requireOwner, requireStaff, hookList } from '@ros/core';
import { defineTemplate } from '../comms/templates';
import { queueMessage } from '../comms/outbox';
import { getOrg } from '../tenancy/orgs';
import { revokeUserSessions } from './sessions';

export const staffInvite = defineTemplate({
  key: 'staff.invite',
  channel: 'email',
  kind: 'transactional',
  description: 'Invites a person to sign in to a venue\'s console.',
  subject: 'You have been added to {{org_name}}',
  body: 'Hi {{first_name}},\n\n{{inviter}} has added you to {{org_name}}.\n\nSign in with this email address at {{console_url}}. There is no password: we email you a code each time.',
  variables: z.object({ first_name: z.string(), inviter: z.string(), console_url: z.string().url() }),
});

const ROLES = ['owner', 'manager', 'host', 'kitchen', 'front_of_house', 'read_only'] as const;

export const inviteStaffInput = z.object({
  email: z.string().email().toLowerCase(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().max(100).nullish(),
  phone: z.string().max(30).nullish(),
  isOwner: z.boolean().default(false),
  roles: z.array(z.object({ venueId: z.string().uuid(), role: z.enum(ROLES) })).default([]),
});

export interface StaffView {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string;
  isOwner: boolean;
  status: 'invited' | 'active' | 'disabled';
  roles: Array<{ venueId: string; role: StaffRole }>;
}

export async function listStaff(ctx: Ctx): Promise<StaffView[]> {
  requireStaff(ctx, { minRole: 'manager' });
  const staff = await ctx.db.selectFrom('staff').select(['id', 'first_name', 'last_name', 'email', 'is_owner', 'status']).orderBy('first_name').execute();
  const roles = await ctx.db.selectFrom('staff_venues').select(['staff_id', 'venue_id', 'role']).execute();
  return staff.map((s) => ({
    id: s.id,
    firstName: s.first_name,
    lastName: s.last_name,
    email: s.email,
    isOwner: s.is_owner,
    status: s.status,
    roles: roles.filter((r) => r.staff_id === s.id).map((r) => ({ venueId: r.venue_id, role: r.role })),
  }));
}

/**
 * Add a person to the org. An owner may grant anything. A manager may add people to venues
 * they manage, at roles below manager. Nobody can grant a role above their own.
 */
export async function inviteStaff(ctx: Ctx, raw: z.input<typeof inviteStaffInput>): Promise<StaffView> {
  const input = inviteStaffInput.parse(raw);
  const actor = requireStaff(ctx, { minRole: 'manager' });
  if (input.isOwner) requireOwner(ctx);
  if (!input.isOwner && !input.roles.length) throw invalid('Choose at least one venue and role.');
  for (const r of input.roles) {
    const mine = requireStaff(ctx, { venueId: r.venueId, minRole: 'manager' });
    if (mine && !mine.isOwner && ROLE_RANK[r.role] >= ROLE_RANK.manager) throw forbidden('Only an owner can add a manager or an owner.');
  }

  // `users` is platform-level (one person may work at two orgs), so it is written outside the tenant role.
  const user = await ctx.app.db
    .insertInto('users')
    .values({ email: input.email, name: [input.firstName, input.lastName].filter(Boolean).join(' '), phone: input.phone ?? null })
    .onConflict((oc) => oc.column('email').doUpdateSet((eb) => ({ email: eb.ref('excluded.email') })))
    .returning('id')
    .executeTakeFirstOrThrow();

  const existing = await ctx.db.selectFrom('staff').select('id').where('user_id', '=', user.id).executeTakeFirst();
  if (existing) throw conflict('That person is already on the team.');

  const staff = await ctx.db
    .insertInto('staff')
    .values({
      org_id: ctx.orgId,
      user_id: user.id,
      first_name: input.firstName,
      last_name: input.lastName ?? null,
      email: input.email,
      phone: input.phone ?? null,
      is_owner: input.isOwner,
      status: 'invited',
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const roles = input.isOwner
    ? (await ctx.db.selectFrom('venues').select('id').execute()).map((v) => ({ venueId: v.id, role: 'owner' as StaffRole }))
    : input.roles;
  if (roles.length) {
    await ctx.db
      .insertInto('staff_venues')
      .values(roles.map((r) => ({ org_id: ctx.orgId, staff_id: staff.id, venue_id: r.venueId, role: r.role })))
      .execute();
  }

  const org = await getOrg(ctx);
  const inviter = actor
    ? ((await ctx.db.selectFrom('staff').select('first_name').where('id', '=', actor.staffId).executeTakeFirst())?.first_name ?? 'A colleague')
    : org.tradingName;
  await queueMessage(ctx, {
    templateKey: 'staff.invite',
    channel: 'email',
    to: input.email,
    idempotencyKey: `staff.invite:${staff.id}`,
    variables: { first_name: input.firstName, inviter, console_url: `${ctx.app.config.scheme}://${ctx.app.config.platformHost}/console` },
  });
  await audit(ctx, { action: 'staff.invited', entityType: 'staff', entityId: staff.id, after: { isOwner: input.isOwner, roles } });
  return { id: staff.id, firstName: input.firstName, lastName: input.lastName ?? null, email: input.email, isOwner: input.isOwner, status: 'invited', roles };
}

export const setRolesInput = z.object({ roles: z.array(z.object({ venueId: z.string().uuid(), role: z.enum(ROLES) })) });

export async function setStaffRoles(ctx: Ctx, staffId: string, raw: z.input<typeof setRolesInput>): Promise<void> {
  requireOwner(ctx);
  const { roles } = setRolesInput.parse(raw);
  const target = await ctx.db.selectFrom('staff').select(['id', 'is_owner']).where('id', '=', staffId).executeTakeFirst();
  if (!target) throw notFound('Team member not found');
  if (target.is_owner) throw invalid('An owner holds every venue. Remove owner status first.');
  const before = await ctx.db.selectFrom('staff_venues').select(['venue_id', 'role']).where('staff_id', '=', staffId).execute();
  await ctx.db.deleteFrom('staff_venues').where('staff_id', '=', staffId).execute();
  if (roles.length) {
    await ctx.db
      .insertInto('staff_venues')
      .values(roles.map((r) => ({ org_id: ctx.orgId, staff_id: staffId, venue_id: r.venueId, role: r.role })))
      .execute();
  }
  await audit(ctx, { action: 'staff.roles_set', entityType: 'staff', entityId: staffId, before, after: roles });
}

type DisabledHandler = (ctx: Ctx, staffId: string) => Promise<void>;
const disabledHandlers = hookList<DisabledHandler>('auth.staffDisabled');

/** Modules that grant access on a staff member's behalf (assistant keys) revoke it here, in the same transaction. */
export function onStaffDisabled(handler: DisabledHandler): void {
  disabledHandlers.add(handler);
}

/** Remove a person's access now: their sessions and their assistant keys stop working in the same step. */
export async function disableStaff(ctx: Ctx, staffId: string): Promise<void> {
  const actor = requireOwner(ctx);
  if (actor && actor.staffId === staffId) throw invalid('You cannot remove your own access.');
  const target = await ctx.db.selectFrom('staff').select(['id', 'user_id', 'is_owner']).where('id', '=', staffId).executeTakeFirst();
  if (!target) throw notFound('Team member not found');
  if (target.is_owner) {
    const owners = await ctx.db.selectFrom('staff').select('id').where('is_owner', '=', true).where('status', '!=', 'disabled').execute();
    if (owners.length <= 1) throw invalid('An organisation needs at least one owner.');
  }
  await ctx.db.updateTable('staff').set({ status: 'disabled' }).where('id', '=', staffId).execute();
  for (const h of disabledHandlers.all()) await h(ctx, staffId);
  await audit(ctx, { action: 'staff.disabled', entityType: 'staff', entityId: staffId });
  const orgId = ctx.orgId;
  ctx.afterCommit(() => revokeUserSessions(ctx.app, target.user_id, orgId));
}
