import { describe, expect, it } from 'vitest';
import { OAuthRefusedError } from '@ros/core';
import { SQUARE_API_VERSION } from '../src/square/client';
import { createSquareOAuth } from '../src/square/oauth';
import { stubFetch } from './stub-fetch';

/**
 * Square OAuth against shapes copied from Square's documentation (read 2026-10-01). These prove
 * the adapter does what the documentation describes. They do not prove Square behaves as
 * documented: nothing here has been run against Square or its sandbox.
 */
const APP_ID = 'sq0idp-test-application';
const SECRET = 'sq0csp-test-application-secret';
// The example answer on developer.squareup.com/reference/square/o-auth-api/obtain-token.
const TOKEN_ANSWER = {
  access_token: 'EAAl3ikZIe18J-2-cHlV2bL4-EaZHGoJUhtEBT7QA6-7AgwIHw8Xe1IoUvGsNxA',
  token_type: 'bearer',
  expires_at: '2025-04-03T18:31:06Z',
  merchant_id: 'MLQW2MYBY81PZ',
  refresh_token: 'EQAAl0OcByu3IYJYScGGg-8E5YNf0r0b6jCTCMy5nOcRZ4ok0wbWAL8vY3tZWNcc',
  short_lived: false,
};
const oauth = (r: { fetch: typeof fetch }, over: Record<string, unknown> = {}) => createSquareOAuth({ applicationId: APP_ID, applicationSecret: SECRET, fetch: r.fetch, ...over });

describe('Square OAuth (documented shapes, unverified against Square)', () => {
  it('builds the authorisation URL: client id, space-separated scopes, session=false, state; never the secret', () => {
    const url = new URL(oauth(stubFetch(() => undefined)).authorizeUrl({ state: 'st.ate', scopes: ['MERCHANT_PROFILE_READ', 'PAYMENTS_READ', 'ORDERS_READ'] }));
    expect(`${url.origin}${url.pathname}`).toBe('https://connect.squareup.com/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: APP_ID, scope: 'MERCHANT_PROFILE_READ PAYMENTS_READ ORDERS_READ', session: 'false', state: 'st.ate' });
    expect(url.toString()).not.toContain(SECRET);
  });

  it('uses the sandbox host for a sandbox application', async () => {
    const r = stubFetch(() => ({ body: TOKEN_ANSWER }));
    const o = oauth(r, { environment: 'sandbox' });
    expect(o.authorizeUrl({ state: 's', scopes: ['PAYMENTS_READ'] })).toMatch(/^https:\/\/connect\.squareupsandbox\.com\/oauth2\/authorize\?/);
    await o.exchangeCode({ code: 'c' });
    expect(r.calls[0]!.url.origin).toBe('https://connect.squareupsandbox.com');
  });

  it('exchanges a code for tokens', async () => {
    const r = stubFetch(() => ({ body: TOKEN_ANSWER }));
    const tokens = await oauth(r).exchangeCode({ code: 'sq0cgb-code' });
    const call = r.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url.toString()).toBe('https://connect.squareup.com/oauth2/token');
    expect(call.headers['square-version']).toBe(SQUARE_API_VERSION);
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body).toEqual({ client_id: APP_ID, client_secret: SECRET, grant_type: 'authorization_code', code: 'sq0cgb-code' });
    expect(tokens).toEqual({ accessToken: TOKEN_ANSWER.access_token, refreshToken: TOKEN_ANSWER.refresh_token, expiresAt: new Date('2025-04-03T18:31:06Z'), externalAccountId: 'MLQW2MYBY81PZ' });
  });

  it('refreshes with the refresh token, and keeps the old one when the answer carries none', async () => {
    const { refresh_token: _dropped, ...withoutRefresh } = TOKEN_ANSWER;
    const r = stubFetch(() => ({ body: { ...withoutRefresh, access_token: 'EAAl-new', expires_at: '2026-10-31T00:00:00Z' } }));
    const tokens = await oauth(r).refresh({ refreshToken: 'EQAAl-refresh' });
    expect(r.calls[0]!.body).toEqual({ client_id: APP_ID, client_secret: SECRET, grant_type: 'refresh_token', refresh_token: 'EQAAl-refresh' });
    expect(tokens).toEqual({ accessToken: 'EAAl-new', refreshToken: 'EQAAl-refresh', expiresAt: new Date('2026-10-31T00:00:00Z'), externalAccountId: 'MLQW2MYBY81PZ' });
  });

  it('a 4xx is a refusal the venue must fix; a 429 or 5xx is an outage to retry', async () => {
    const refused = stubFetch(() => ({ status: 401, body: { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: `bad ${SECRET}` }] } }));
    const err = await oauth(refused)
      .refresh({ refreshToken: 'EQAAl-refresh' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OAuthRefusedError);
    expect(err.message).toBe('square: 401 on /oauth2/token (AUTHENTICATION_ERROR/UNAUTHORIZED)');
    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toContain('EQAAl-refresh');

    for (const status of [429, 500, 503]) {
      const down = stubFetch(() => ({ status, body: {} }));
      const e = await oauth(down)
        .refresh({ refreshToken: 'x' })
        .catch((x) => x);
      expect(e, String(status)).not.toBeInstanceOf(OAuthRefusedError);
      expect(e.message).toMatch(new RegExp(`square: ${status} on /oauth2/token`));
    }
    const network = (async () => {
      throw new TypeError('socket hang up');
    }) as unknown as typeof fetch;
    const e = await createSquareOAuth({ applicationId: APP_ID, applicationSecret: SECRET, fetch: network })
      .exchangeCode({ code: 'c' })
      .catch((x) => x);
    expect(e).not.toBeInstanceOf(OAuthRefusedError);
    expect(e.message).toBe('square: request to /oauth2/token did not complete (TypeError)');
  });

  it('an answer with no access token or merchant is an error, not a half-made connection', async () => {
    const r = stubFetch(() => ({ body: { token_type: 'bearer' } }));
    await expect(oauth(r).exchangeCode({ code: 'c' })).rejects.toThrow(/no access token/);
  });

  it('revokes with the application secret as "Client", one token or everything', async () => {
    const r = stubFetch(() => ({ body: { success: true } }));
    await oauth(r).revoke({ accessToken: 'EAAl-token', everything: false });
    await oauth(r).revoke({ accessToken: 'EAAl-token', everything: true });
    expect(r.calls[0]!.url.toString()).toBe('https://connect.squareup.com/oauth2/revoke');
    expect(r.calls[0]!.headers.authorization).toBe(`Client ${SECRET}`);
    expect(r.calls[0]!.body).toEqual({ client_id: APP_ID, access_token: 'EAAl-token', revoke_only_access_token: true });
    expect(r.calls[1]!.body.revoke_only_access_token).toBe(false);
  });

  it('revoking a token Square no longer knows is not an error; an outage is', async () => {
    for (const status of [401, 404]) {
      const r = stubFetch(() => ({ status, body: { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED' }] } }));
      await expect(oauth(r).revoke({ accessToken: 't', everything: false })).resolves.toBeUndefined();
    }
    const down = stubFetch(() => ({ status: 500, body: {} }));
    await expect(oauth(down).revoke({ accessToken: 't', everything: false })).rejects.toThrow(/500/);
  });

  it('hands every connection the platform webhook key, the environment and the application id', () => {
    const o = oauth(stubFetch(() => undefined), { environment: 'sandbox', webhookSignatureKey: 'sig-key', webhookUrl: 'https://console.example.test/webhooks/pos/square' });
    expect(o.connectionDefaults()).toEqual({ credentials: { webhookSecret: 'sig-key' }, config: { environment: 'sandbox', applicationId: APP_ID, webhookUrl: 'https://console.example.test/webhooks/pos/square' } });
    expect(oauth(stubFetch(() => undefined)).connectionDefaults()).toEqual({ credentials: {}, config: { environment: 'production', applicationId: APP_ID } });
  });

  it('renews with 23 days of a 30-day token left: every 7 days, as Square recommends', () => {
    expect(oauth(stubFetch(() => undefined)).refreshAheadMs).toBe(23 * 86_400_000);
  });
});
