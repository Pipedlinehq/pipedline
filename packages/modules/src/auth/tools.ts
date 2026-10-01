import { z } from 'zod';
import { defineTool } from '@ros/core';
import { getOrg } from '../tenancy/orgs';
import { getVenue } from '../tenancy/venues';
import { inviteStaff } from './staff';

const ROLE_WORDS: Record<string, string> = {
  manager: 'a manager',
  host: 'a host',
  kitchen: 'kitchen staff',
  front_of_house: 'front of house',
  read_only: 'a read-only member',
};

/**
 * `team_invite` (docs/PIPEDLINE.md "What has to change" section 2), pinned to the console's
 * `inviteStaff`: a manager may add people below manager at venues they manage; only an owner
 * may add a manager. Another owner is not something an assistant adds: that is done by an
 * owner in the console, because an owner can do everything, including ending everyone else's access.
 */
export const teamInviteTool = defineTool({
  name: 'team_invite',
  module: 'console',
  title: 'Invite a person to the team',
  description:
    'Add a person to the venue\'s team with a role and email them an invitation to sign in. Roles: manager, host, kitchen, front_of_house, read_only. Only an owner can add a manager. Another owner is added by an owner in the console, not here. Ask for the person\'s name, email address and role; do not guess them.',
  effect: 'write',
  scope: 'team:write',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({
    email: z.string().trim().toLowerCase().email(),
    first_name: z.string().trim().min(1).max(100),
    last_name: z.string().trim().min(1).max(100).optional(),
    role: z.enum(['manager', 'host', 'kitchen', 'front_of_house', 'read_only']),
  }),
  output: z.object({ first_name: z.string(), role: z.string(), status: z.string(), what_next: z.string() }),
  async propose({ ctx, venueId }, input) {
    const venue = await getVenue(ctx, venueId!);
    const org = await getOrg(ctx);
    const name = [input.first_name, input.last_name].filter(Boolean).join(' ');
    return {
      question: `Invite ${name} (${input.email}) to ${org.tradingName} as ${ROLE_WORDS[input.role]} at ${venue.name}? They are emailed an invitation and sign in with that address.`,
      commit: async () => {
        const made = await inviteStaff(ctx, {
          email: input.email,
          firstName: input.first_name,
          lastName: input.last_name ?? null,
          isOwner: false,
          roles: [{ venueId: venue.id, role: input.role }],
        });
        return { first_name: made.firstName, role: input.role, status: made.status, what_next: `${made.firstName} has been emailed an invitation. They sign in with ${input.email}; there is no password.` };
      },
    };
  },
});
