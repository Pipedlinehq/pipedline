/**
 * Square sign-in (OAuth) against the SANDBOX, through the adapter.
 *
 *   pnpm tsx scripts/square-sandbox-oauth.ts probe     what can be checked with no person: how Square answers a bad
 *                                                      code, a bad refresh token and a wrong application secret
 *   pnpm tsx scripts/square-sandbox-oauth.ts flow      the real flow: waits on http://localhost:4567/callback, prints
 *                                                      the link to open, then exchanges, refreshes, lists and revokes
 *
 * For `flow`: in the Square Developer Dashboard (Sandbox), set the application's OAuth Redirect URL
 * to http://localhost:4567/callback, and open the sandbox test account's dashboard in the same
 * browser first (Square's sandbox sign-in needs it).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { OAuthRefusedError } from '@ros/core';
import { createSquareAdapter, createSquareOAuth } from '@ros/adapters';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
  }
}
const id = process.env.SQUARE_APPLICATION_ID;
const secret = process.env.SQUARE_APPLICATION_SECRET;
if (!id || !secret) throw new Error('Set SQUARE_APPLICATION_ID and SQUARE_APPLICATION_SECRET (sandbox).');
if (!id.startsWith('sandbox-')) throw new Error('Sandbox application ids only.');

const oauth = createSquareOAuth({ applicationId: id, applicationSecret: secret, environment: 'sandbox' });
const describe = (e: unknown) => `${e instanceof OAuthRefusedError ? 'REFUSED (venue must reconnect)' : 'OTHER (treated as an outage, retried)'}: ${(e as Error).message}`;
const mode = process.argv[2] ?? 'probe';

if (mode === 'probe') {
  const out: string[] = [];
  out.push(`authorize url: ${oauth.authorizeUrl({ state: 'STATE', scopes: ['MERCHANT_PROFILE_READ', 'PAYMENTS_READ', 'ORDERS_READ'] })}`);
  const page = await fetch(oauth.authorizeUrl({ state: 'probe', scopes: ['MERCHANT_PROFILE_READ'] }), { redirect: 'manual' });
  out.push(`authorize page answers HTTP ${page.status}${page.headers.get('location') ? ` → ${new URL(page.headers.get('location')!, 'https://x').pathname}` : ''}`);
  await oauth.exchangeCode({ code: 'not-a-real-code' }).then((t) => out.push(`bad code: UNEXPECTED success ${Object.keys(t)}`), (e) => out.push(`bad code → ${describe(e)}`));
  await oauth.refresh({ refreshToken: 'not-a-real-refresh-token' }).then(() => out.push('bad refresh token: UNEXPECTED success'), (e) => out.push(`bad refresh token → ${describe(e)}`));
  const wrong = createSquareOAuth({ applicationId: id, applicationSecret: `${secret.slice(0, -4)}XXXX`, environment: 'sandbox' });
  await wrong.refresh({ refreshToken: 'not-a-real-refresh-token' }).then(() => out.push('wrong secret: UNEXPECTED success'), (e) => out.push(`wrong application secret → ${describe(e)}`));
  console.log(out.join('\n'));
  process.exit(0);
}

const state = randomUUID();
const scopes = ['MERCHANT_PROFILE_READ', 'PAYMENTS_READ', 'ORDERS_READ'];
console.log(`\nOpen this in the browser where the sandbox test account's dashboard is open:\n\n${oauth.authorizeUrl({ state, scopes })}\n\nWaiting on http://localhost:4567/callback …`);
const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost:4567');
    if (u.pathname !== '/callback') return void res.writeHead(404).end();
    const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
    res.writeHead(200, { 'content-type': 'text/plain' }).end(ok ? 'Signed in. You can close this tab.' : `Not completed: ${u.searchParams.get('error') ?? 'state mismatch'}`);
    server.close();
    ok ? resolve(u.searchParams.get('code')!) : reject(new Error(`callback: ${u.searchParams.get('error') ?? 'state mismatch'} ${u.searchParams.get('error_description') ?? ''}`));
  }).listen(4567, '0.0.0.0');
  setTimeout(() => (server.close(), reject(new Error('timed out after 10 minutes'))), 600_000).unref();
});

const steps: string[] = [];
const tokens = await oauth.exchangeCode({ code });
steps.push(`PASS exchange code: access token received, expires ${tokens.expiresAt?.toISOString() ?? 'never'}, refresh token: ${tokens.refreshToken ? 'yes' : 'no'}, account ${tokens.externalAccountId ?? '?'}`);
await oauth.exchangeCode({ code }).then(() => steps.push('NOTE the same code was accepted twice'), (e) => steps.push(`PASS code is single-use → ${describe(e)}`));
const sq = createSquareAdapter();
const conn = (accessToken: string) => ({ id: 'x', orgId: 'x', venueId: null, plugKey: 'square', externalAccountId: '', scopes, config: { environment: 'sandbox' }, credentials: { accessToken } });
steps.push(`PASS token works: ${(await sq.listLocations(conn(tokens.accessToken))).map((l) => l.name).join(', ')}`);
const renewed = await oauth.refresh({ refreshToken: tokens.refreshToken! });
steps.push(`PASS refresh: new access token ${renewed.accessToken !== tokens.accessToken ? 'differs' : 'is the same'}, refresh token ${renewed.refreshToken === tokens.refreshToken ? 'unchanged' : 'rotated'}, expires ${renewed.expiresAt?.toISOString()}`);
steps.push(`PASS renewed token works: ${(await sq.listLocations(conn(renewed.accessToken))).length} location(s)`);
await oauth.revoke({ accessToken: renewed.accessToken, everything: true });
await sq.listLocations(conn(renewed.accessToken)).then(() => steps.push('FAIL token still works after revoke'), (e) => steps.push(`PASS revoked token is refused (${(e as Error).message.slice(0, 80)})`));
await oauth.refresh({ refreshToken: renewed.refreshToken ?? tokens.refreshToken! }).then(() => steps.push('FAIL refresh still works after revoke'), (e) => steps.push(`PASS refresh after revoke → ${describe(e)}`));
console.log(`\n${steps.join('\n')}`);
process.exit(steps.some((s) => s.startsWith('FAIL')) ? 1 : 0);
