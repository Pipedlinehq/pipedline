import { z } from 'zod';
import { defineTool } from '@ros/core';
import { getVenue } from '../tenancy/venues';
import { describePosSignIn, startPosSignIn } from './pos-oauth';

/**
 * `connection_start` (docs/PIPEDLINE.md "What has to change" section 2): the assistant gets a
 * sign-in link for its person to open, and nothing else. The password, the code the provider
 * sends back, the tokens and the choice of location never pass through the assistant: they
 * are the console's callback page and `completePosOAuth`, in the person's own signed-in browser.
 */
export const connectionStartTool = defineTool({
  name: 'connection_start',
  module: 'ledger',
  title: 'Start connecting a service the owner signs in to',
  description:
    'Start connecting an outside service that is connected by signing in (the till and payments: Square). Returns a link. Give the link to the person: they open it in a browser where they are signed in to the console, sign in at the service and approve. Nothing is connected until they do; check with connections_list afterwards. You never see their password or any token. `service` is the key from connections_list or plugins_list.',
  effect: 'write',
  scope: 'connections:write',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({
    service: z.string().trim().min(1).max(60).describe('The service key, e.g. "square"'),
    access: z.enum(['read_only', 'full']).default('full').describe('read_only brings sales in and changes nothing at the service. full also allows online payments and sending orders to the till'),
  }),
  output: z.object({ service: z.string(), name: z.string(), sign_in_link: z.string(), link_expires: z.string(), asks_for: z.array(z.string()), what_next: z.string() }),
  async propose({ ctx, venueId }, input) {
    const venue = await getVenue(ctx, venueId!);
    const what = describePosSignIn(ctx, { plugKey: input.service, access: input.access });
    return {
      question: `Start connecting ${what.plugName} to ${venue.name}? You will be given a link to open in your browser, where you sign in at ${what.plugName} and approve ${input.access === 'read_only' ? 'read-only access (sales come in; nothing is changed there)' : 'access to read sales, take online payments and send orders to the till'}. Nothing is connected until you do that.`,
      commit: async () => {
        const started = await startPosSignIn(ctx, { plugKey: input.service, venueId: venue.id, access: input.access });
        return {
          service: started.plugKey,
          name: started.plugName,
          sign_in_link: started.url,
          link_expires: started.expiresAt.toISOString(),
          asks_for: started.scopes,
          what_next: `Give this link to the person. They open it in a browser where they are signed in to the console, sign in at ${started.plugName} and approve. It works once and for 15 minutes. Then call connections_list to see that ${started.plugName} is connected.`,
        };
      },
    };
  },
});
