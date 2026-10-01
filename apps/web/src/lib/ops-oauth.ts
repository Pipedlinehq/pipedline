import 'server-only';
import { hub } from '@ros/modules';
import { clientIp } from './http';
import { app } from './runtime';

/**
 * The hub's sign-in for assistants (packages/modules/src/hub/CLAUDE.md): two published documents
 * under /.well-known and three OAuth endpoints under /api/hub/oauth. The module serves them
 * all from one function, including its own per-address limits and CORS answers; the web app
 * only mounts it. Anything the module does not recognise is a 404.
 */
export async function serveOAuth(req: Request): Promise<Response> {
  const res = await hub.handleOAuthRequest(app(), req, { ip: clientIp(req) });
  return res ?? new Response('Not found', { status: 404 });
}
