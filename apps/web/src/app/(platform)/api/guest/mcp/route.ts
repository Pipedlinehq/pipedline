import { guestPlugin } from '@ros/modules';
import { clientIp } from '@/lib/http';
import { app } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

/**
 * The public assistant connection (docs/modules/guest-plugin.md): a guest's assistant (ChatGPT,
 * Claude) adds this address to find Pipedline venues, read menus and hours, book a table and
 * start a pickup order paid for on the venue's own page. No sign-in. The handler limits requests
 * per address and per venue itself; it is separate from the staff connection at /api/mcp.
 */
async function serve(req: Request): Promise<Response> {
  return guestPlugin.handleGuestMcpRequest(app(), req, { ip: clientIp(req) });
}

export { serve as GET, serve as POST, serve as DELETE };
