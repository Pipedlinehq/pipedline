import { hub } from '@ros/modules';
import { rateLimit, isAppError } from '@ros/core';
import { clientIp } from '@/lib/http';
import { app } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

/**
 * The hub: a venue's assistant connects here with a key issued in the console
 * (docs/modules/hub.md). The handler authenticates the key itself; this route only adds a
 * per-address limit in front, so an unauthenticated flood cannot reach it.
 */
async function serve(req: Request): Promise<Response> {
  const ip = clientIp(req);
  try {
    await rateLimit(app(), `mcp:ip:${ip ?? 'unknown'}`, { limit: 600, windowSeconds: 60 });
  } catch (e) {
    if (isAppError(e)) return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: e.message }, id: null }), { status: 429, headers: { 'content-type': 'application/json' } });
    throw e;
  }
  return hub.handleMcpRequest(app(), req, { ip });
}

export { serve as GET, serve as POST, serve as DELETE };
