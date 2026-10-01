/**
 * Square webhooks against the SANDBOX, end to end: a real payment is made in the sandbox, Square
 * posts its webhook to a public URL, and the platform's own handler verifies the signature,
 * re-fetches the sale and writes the ledger.
 *
 *   PUBLIC_URL=https://<tunnel> pnpm tsx scripts/square-sandbox-webhooks.ts
 *
 * It creates its OWN webhook subscription for the run and deletes it at the end. It never touches
 * a subscription that already exists on the account.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAppError } from '@ros/core';
import { createSquareAdapter } from '@ros/adapters';
import { ledger, tenancy } from '@ros/modules';
import { createTestApp, fakeClock } from '../packages/testkit/src/app';
import { createDatabase, migrateDatabase, startLocalPg } from '../packages/testkit/src/local-pg';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
  }
}
const token = process.env.SQUARE_SMOKE_ACCESS_TOKEN!;
const publicUrl = process.env.PUBLIC_URL;
if (!token || !publicUrl) throw new Error('Set SQUARE_SMOKE_ACCESS_TOKEN and PUBLIC_URL.');
const PATH = '/webhooks/pos/square';
const hookUrl = `${publicUrl}${PATH}`;
const HOST = 'https://connect.squareupsandbox.com';
const sqApi = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${HOST}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Square-Version': '2026-09-16', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
};

const lines: string[] = [];
const say = (ok: boolean, what: string) => void lines.push(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
const pg = await startLocalPg();
let subscriptionId: string | null = null;
try {
  const t = createTestApp(await createDatabase(pg, 'square_hooks').then(async (u) => (await migrateDatabase(u), u)), { clock: fakeClock(new Date()) });
  // The handler must use real time: Square's events are judged against "now".
  const tick = setInterval(() => t.clock.set(new Date()), 500);
  const square = createSquareAdapter();
  t.app.adapters.register('pos', square);
  t.app.adapters.register('payment', square);

  const sub = await sqApi('POST', '/v2/webhooks/subscriptions', {
    idempotency_key: randomUUID(),
    subscription: { name: `ros-check-${Date.now()}`, event_types: ['payment.created', 'payment.updated', 'refund.created', 'refund.updated'], notification_url: hookUrl, api_version: '2026-09-16' },
  });
  subscriptionId = sub.json.subscription?.id ?? null;
  const signatureKey: string | undefined = sub.json.subscription?.signature_key;
  if (!subscriptionId || !signatureKey) throw new Error(`could not create a test subscription: HTTP ${sub.status} ${JSON.stringify(sub.json.errors ?? {})}`);
  say(true, `created a separate test subscription ${subscriptionId} → ${hookUrl}`);

  const org = await t.app.platform('square webhook check', (p) =>
    tenancy.createOrg(p, { slug: 'square-hooks', legalName: 'Square Hooks', tradingName: 'Square Hooks', owner: { email: 'owner@square-hooks.test', firstName: 'Olive' }, venue: { name: 'Sandbox venue' } }),
  );
  const loc = (await sqApi('GET', '/v2/locations')).json.locations[0];
  await t.app.tenant(org.orgId, { kind: 'worker', job: 'square-hooks' }, (ctx) =>
    ledger.connectPos(ctx, {
      plugKey: 'square',
      venueId: org.venueId,
      externalAccountId: loc.merchant_id,
      locationRef: loc.id,
      credentials: { accessToken: token, webhookSecret: signatureKey },
      // No applicationId: this run's payment is made outside any order of ours, like a till sale.
      config: { environment: 'sandbox', currency: 'AUD', webhookUrl: hookUrl },
      scopes: ledger.SQUARE_READ_SCOPES,
    }),
  );

  const seen: Array<{ type: string; status: number; outcome: string; raw: string; headers: Record<string, string | undefined> }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
      let status = 200;
      let outcome = '';
      try {
        const r = await ledger.handlePosWebhook(t.app, { plugKey: 'square', rawBody, headers, url: hookUrl });
        outcome = `${r.status} created=${r.created} changed=${r.changed} unchanged=${r.unchanged} skipped=${r.skipped}`;
      } catch (e) {
        status = isAppError(e) ? e.status : 500;
        outcome = `error: ${(e as Error).message}`;
      }
      let type = '?';
      try {
        type = JSON.parse(rawBody).type;
      } catch {}
      seen.push({ type, status, outcome, raw: rawBody, headers });
      res.writeHead(status).end();
    });
  }).listen(4568, '0.0.0.0');
  await new Promise((r) => setTimeout(r, 3000));

  const run = randomUUID().slice(0, 8);
  const pay = await sqApi('POST', '/v2/payments', { idempotency_key: `hook-${run}`, source_id: 'cnon:card-nonce-ok', amount_money: { amount: 4321, currency: 'AUD' }, location_id: loc.id, reference_id: `HOOK-${run}` });
  const paymentId: string = pay.json.payment?.id;
  say(!!paymentId, `made a sandbox payment ${paymentId} for $43.21`);

  const ledgerRow = () => t.db.selectFrom('transactions').select(['status', 'total_cents', 'refunded_cents', 'raw']).where('org_id', '=', org.orgId).where('external_ref', '=', paymentId).executeTakeFirst();
  const waitFor = async (pred: () => Promise<boolean>, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await pred()) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  };

  const arrived = await waitFor(async () => !!(await ledgerRow()), 90_000);
  const first = seen.find((s) => s.status === 200);
  say(seen.length > 0, `Square delivered ${seen.length} webhook(s): ${seen.map((s) => `${s.type}→${s.status}`).join(', ') || 'none'}`);
  say(!!first, `a real Square signature was accepted by the platform's handler (${first?.outcome ?? 'no accepted delivery'})`);
  const row = await ledgerRow();
  say(arrived && row?.total_cents === 4321, `the sale is in the ledger from the webhook alone (no poll ran): ${row ? `${row.status} ${row.total_cents}c` : 'missing'}`);
  say(!!row && !/fingerprint|payment_account_reference/.test(JSON.stringify(row.raw)), 'the stored payload holds no card identifier');

  if (first) {
    const before = await t.db.selectFrom('transactions').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', org.orgId).executeTakeFirstOrThrow();
    const replay = await ledger.handlePosWebhook(t.app, { plugKey: 'square', rawBody: first.raw, headers: first.headers, url: hookUrl });
    const after = await t.db.selectFrom('transactions').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', org.orgId).executeTakeFirstOrThrow();
    say(replay.status === 'duplicate' && Number(before.n) === Number(after.n), `replaying Square's exact delivery is a no-op (${replay.status})`);
    const forged = await ledger.handlePosWebhook(t.app, { plugKey: 'square', rawBody: first.raw.replace('4321', '1'), headers: first.headers, url: hookUrl }).then(() => 'ACCEPTED', (e) => (isAppError(e) ? e.code : 'error'));
    say(forged === 'unauthenticated', `the same delivery with an altered body is refused (${forged})`);
    const wrongUrl = await ledger.handlePosWebhook(t.app, { plugKey: 'square', rawBody: first.raw, headers: { ...first.headers }, url: 'https://attacker.example/webhooks/pos/square' }).then((r) => r.status, (e) => (isAppError(e) ? e.code : 'error'));
    say(wrongUrl === 'duplicate' || wrongUrl === 'unauthenticated', `the signed URL is pinned on the connection, not taken from the request (${wrongUrl})`);
  }

  const n = seen.length;
  const refund = await sqApi('POST', '/v2/refunds', { idempotency_key: `hook-refund-${run}`, payment_id: paymentId, amount_money: { amount: 1000, currency: 'AUD' }, reason: 'webhook check' });
  say(refund.status === 200, `refunded $10.00 of it at Square (${refund.json.refund?.status ?? refund.status})`);
  const refunded = await waitFor(async () => ((await ledgerRow())?.refunded_cents ?? 0) === 1000, 120_000);
  const r2 = await ledgerRow();
  say(refunded, `the refund reached the ledger by webhook: ${r2?.status} refunded ${r2?.refunded_cents}c (${seen.slice(n).map((s) => `${s.type}→${s.status}`).join(', ') || 'no further deliveries'})`);

  clearInterval(tick);
  server.close();
  await t.close();
} catch (e) {
  say(false, `run error: ${(e as Error).message}`);
} finally {
  if (subscriptionId) {
    const del = await sqApi('DELETE', `/v2/webhooks/subscriptions/${subscriptionId}`);
    say(del.status === 200, `deleted the test subscription (${del.status})`);
  }
  await pg.stop();
}
console.log(`\nSquare sandbox webhooks\n\n${lines.join('\n')}`);
process.exit(lines.some((l) => l.startsWith('FAIL')) ? 1 : 0);
