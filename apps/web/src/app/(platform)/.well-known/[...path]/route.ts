import { serveOAuth } from '@/lib/ops-oauth';

export const dynamic = 'force-dynamic';

/**
 * /.well-known/oauth-protected-resource[/api/mcp] and /.well-known/oauth-authorization-server:
 * what the MCP server is called and how an assistant signs in to it (hub.handleOAuthRequest).
 * Platform host only; every other /.well-known path is a 404.
 */
export { serveOAuth as GET, serveOAuth as OPTIONS };
