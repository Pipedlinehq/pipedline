import { serveOAuth } from '@/lib/ops-oauth';

export const dynamic = 'force-dynamic';

/**
 * POST /api/hub/oauth/{register,token,revoke}: the OAuth endpoints an assistant's client calls
 * (hub.handleOAuthRequest). No session and no same-origin check: these are called by other
 * programs and authenticate by client, code and verifier. The consent page a person sees is
 * /console/oauth/authorize, which belongs to the console.
 */
export { serveOAuth as GET, serveOAuth as POST, serveOAuth as OPTIONS };
