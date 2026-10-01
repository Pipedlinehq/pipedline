'use server';

import type { StaffRole } from '@ros/core';
import { auth } from '@ros/modules';
import { act, bool, nullableText, text } from '@/lib/console-actions';
import { getConsole } from '@/lib/console';
import type { FormState } from '@/ui/client';

const ROLES: StaffRole[] = ['manager', 'host', 'kitchen', 'front_of_house', 'read_only'];

/** role:<venueId> fields, limited to venues the person can see. The service checks each one again. */
async function rolesFrom(fd: FormData): Promise<Array<{ venueId: string; role: StaffRole }>> {
  const c = await getConsole();
  const out: Array<{ venueId: string; role: StaffRole }> = [];
  for (const v of c.venues) {
    const role = text(fd, `role:${v.id}`) as StaffRole;
    if (ROLES.includes(role)) out.push({ venueId: v.id, role });
  }
  return out;
}

export async function invitePerson(_prev: FormState, fd: FormData): Promise<FormState> {
  const roles = await rolesFrom(fd);
  const email = text(fd, 'email');
  return act(
    (ctx) =>
      auth.inviteStaff(ctx, {
        email,
        firstName: text(fd, 'firstName'),
        lastName: nullableText(fd, 'lastName'),
        isOwner: bool(fd, 'isOwner'),
        roles,
      }),
    { success: `Invited ${email}. They get an email saying how to sign in.`, revalidate: '/console/settings/team' },
  );
}

export async function saveRoles(_prev: FormState, fd: FormData): Promise<FormState> {
  const roles = await rolesFrom(fd);
  const staffId = text(fd, 'staffId');
  return act((ctx) => auth.setStaffRoles(ctx, staffId, { roles }), { success: 'Roles saved. They apply from their next page load.', revalidate: '/console/settings/team' });
}

export async function removePerson(_prev: FormState, fd: FormData): Promise<FormState> {
  const staffId = text(fd, 'staffId');
  return act((ctx) => auth.disableStaff(ctx, staffId), { success: 'Access removed. Their sessions and assistant keys stopped working.', revalidate: '/console/settings/team' });
}
