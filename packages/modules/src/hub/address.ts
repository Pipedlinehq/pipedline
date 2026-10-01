import type { App } from '@ros/core';

/**
 * Where the hub's MCP server and its sign-in live, and what they are called (ported from Criota's
 * `mcp/address.ts`). One place, because the names appear in the 401 challenge, in two published
 * documents, in every code and token, and an assistant compares them as strings.
 *
 * All of it is on the platform host (`app.config.platformHost`), never a tenant's domain:
 *
 *   /api/mcp                                          the MCP endpoint (handleMcpRequest)
 *   /.well-known/oauth-protected-resource/api/mcp     what the server is called (RFC 9728)
 *   /.well-known/oauth-authorization-server           how to sign in (RFC 8414)
 *   /console/oauth/authorize                          the consent page (a console page, built by the web app)
 *   /api/hub/oauth/token | /register | /revoke        OAuth endpoints (handleOAuthRequest)
 */
export const MCP_PATH = '/api/mcp';
export const OAUTH_PATH = '/api/hub/oauth';

export function platformOrigin(app: App): string {
  return `${app.config.scheme}://${app.config.platformHost}`;
}

/** The address a person gives their assistant, and the only resource tokens are issued for. */
export function mcpResourceUrl(app: App): string {
  return `${platformOrigin(app)}${MCP_PATH}`;
}

/** Who issues the tokens: this platform. */
export function oauthIssuer(app: App): string {
  return platformOrigin(app);
}

export function oauthEndpoints(app: App) {
  const o = platformOrigin(app);
  return {
    authorize: `${o}/console/oauth/authorize`,
    token: `${o}${OAUTH_PATH}/token`,
    register: `${o}${OAUTH_PATH}/register`,
    revoke: `${o}${OAUTH_PATH}/revoke`,
    resourceMetadata: `${o}/.well-known/oauth-protected-resource${MCP_PATH}`,
    documentation: `${o}/console/assistants`,
  };
}
