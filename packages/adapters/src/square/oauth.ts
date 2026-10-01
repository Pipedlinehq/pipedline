import { type OAuthPort, type OAuthTokens, OAuthRefusedError } from '@ros/core';
import { SQUARE_API_VERSION } from './client';

/**
 * Square OAuth (authorisation-code flow): how a venue connects its Square account by signing
 * in at Square, and how the platform keeps that access alive (ports/oauth.ts).
 *
 * UNVERIFIED LIVE. Written from Square's documentation as read on 2026-10-01 and tested only
 * against payloads built from it, with a stubbed fetch. Never run against Square or its sandbox.
 *
 * Endpoints used (developer.squareup.com/docs/oauth-api, /reference/square/o-auth-api):
 *   GET  {host}/oauth2/authorize?client_id&scope&session=false&state
 *        scope is space-separated; `session=false` is required of a production application.
 *        Square redirects to the Redirect URL registered in the Developer Console with
 *        `code` and `state`, or `error` and `error_description` when the seller declines.
 *   POST {host}/oauth2/token    { client_id, client_secret, grant_type: 'authorization_code', code }
 *                               { client_id, client_secret, grant_type: 'refresh_token', refresh_token }
 *        → { access_token, token_type, expires_at, merchant_id, refresh_token, short_lived }
 *   POST {host}/oauth2/revoke   `Authorization: Client <application secret>`
 *                               { client_id, access_token, revoke_only_access_token } → { success }
 *   host: https://connect.squareup.com, or https://connect.squareupsandbox.com for the sandbox.
 *
 * Token lifetime: an access token lasts 30 days. Square recommends renewing every 7 days or
 * less, which is what `refreshAheadMs` (23 days of life left) amounts to. In this flow the
 * refresh token does not change and does not expire.
 *
 * Not confirmed by the pages read:
 *   - `redirect_uri` is not sent on either call: the pages describe it for the PKCE flow, and
 *     the code flow uses the URL registered in the Developer Console
 *   - how Square words a refused refresh (revoked by the seller) as against a wrong application
 *     secret: every 4xx but 429 is reported as OAuthRefusedError, and the caller checks the
 *     existing access token before believing it
 *   - that an authorisation code can be exchanged only once
 */
const HOSTS = { production: 'https://connect.squareup.com', sandbox: 'https://connect.squareupsandbox.com' } as const;
const DAY = 86_400_000;

export interface SquareOAuthOptions {
  applicationId: string;
  applicationSecret: string;
  environment?: 'sandbox' | 'production';
  /** The signature key of the application's webhook subscription. Copied onto every connection as `webhookSecret`. */
  webhookSignatureKey?: string;
  /** The notification URL registered for that subscription. Square signs it, so it is pinned on every connection. */
  webhookUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  apiVersion?: string;
}

interface SquareTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_at?: string;
  merchant_id?: string;
}

export function createSquareOAuth(opts: SquareOAuthOptions): OAuthPort {
  const environment = opts.environment ?? 'production';
  const host = HOSTS[environment];

  async function post<T>(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<T> {
    let res: Response;
    try {
      res = await (opts.fetch ?? fetch)(new URL(path, host), {
        method: 'POST',
        headers: { 'Square-Version': opts.apiVersion ?? SQUARE_API_VERSION, 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new Error(`square: request to ${path} did not complete (${(e as Error).name})`);
    }
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      // Status and Square's codes only: the body of a token call can echo a token or the secret.
      const errors = (parsed as { errors?: Array<{ category?: string; code?: string }> } | null)?.errors;
      const codes = Array.isArray(errors) ? errors.map((e) => `${e.category ?? 'ERROR'}/${e.code ?? 'UNKNOWN'}`).join(', ') : 'no error body';
      const message = `square: ${res.status} on ${path} (${codes})`;
      // Verified against the sandbox (2026-10-01): a wrong application id or secret is answered
      // 401 {"type":"service.not_authorized"} with no `errors` list, while a dead code or refresh
      // token is 401 with errors[AUTHENTICATION_ERROR/UNAUTHORIZED]. The first is our own
      // misconfiguration: no venue should be told to reconnect because of it.
      if ((parsed as { type?: string } | null)?.type === 'service.not_authorized') {
        throw new Error(`square: ${res.status} on ${path}: Square does not accept this application's id and secret`);
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new OAuthRefusedError(message);
      throw new Error(message);
    }
    return (parsed ?? {}) as T;
  }

  function tokensOf(r: SquareTokenResponse, keepRefreshToken: string | null): OAuthTokens {
    if (!r.access_token || !r.merchant_id) throw new Error('square: the token answer had no access token or merchant id');
    const expiresAt = r.expires_at ? new Date(r.expires_at) : null;
    return {
      accessToken: r.access_token,
      refreshToken: r.refresh_token ?? keepRefreshToken,
      expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
      externalAccountId: r.merchant_id,
    };
  }

  return {
    key: 'square',
    refreshAheadMs: 23 * DAY,

    authorizeUrl({ state, scopes }) {
      const url = new URL('/oauth2/authorize', host);
      url.searchParams.set('client_id', opts.applicationId);
      url.searchParams.set('scope', scopes.join(' '));
      url.searchParams.set('session', 'false');
      url.searchParams.set('state', state);
      return url.toString();
    },

    async exchangeCode({ code }) {
      const r = await post<SquareTokenResponse>('/oauth2/token', {
        client_id: opts.applicationId,
        client_secret: opts.applicationSecret,
        grant_type: 'authorization_code',
        code,
      });
      return tokensOf(r, null);
    },

    async refresh({ refreshToken }) {
      const r = await post<SquareTokenResponse>('/oauth2/token', {
        client_id: opts.applicationId,
        client_secret: opts.applicationSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      return tokensOf(r, refreshToken);
    },

    async revoke({ accessToken, everything }) {
      try {
        await post('/oauth2/revoke', { client_id: opts.applicationId, access_token: accessToken, revoke_only_access_token: !everything }, { Authorization: `Client ${opts.applicationSecret}` });
      } catch (e) {
        // A token Square no longer knows is already revoked.
        if (e instanceof OAuthRefusedError && / (401|404) /.test(e.message)) return;
        throw e;
      }
    },

    connectionDefaults() {
      const credentials: Record<string, string> = opts.webhookSignatureKey ? { webhookSecret: opts.webhookSignatureKey } : {};
      return {
        credentials,
        config: { environment, applicationId: opts.applicationId, ...(opts.webhookUrl ? { webhookUrl: opts.webhookUrl } : {}) },
      };
    },
  };
}
