/**
 * Exercises the Square adapter against a Square SANDBOX account, end to end, and reports each
 * step. Sandbox only: it refuses any other environment. It creates test orders, payments and a
 * refund in the sandbox account using Square's documented test card tokens.
 *
 *   SQUARE_SMOKE_ACCESS_TOKEN=… pnpm tsx scripts/square-sandbox-check.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import type { ConnectionHandle } from '@ros/core';
import { createSquareAdapter } from '@ros/adapters';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
  }
}
const token = process.env.SQUARE_SMOKE_ACCESS_TOKEN;
if (!token) throw new Error('Set SQUARE_SMOKE_ACCESS_TOKEN to a sandbox access token.');

const sq = createSquareAdapter();
const base: ConnectionHandle = { id: 'check', orgId: 'check', venueId: null, plugKey: 'square', externalAccountId: '', scopes: [], config: { environment: 'sandbox', currency: 'AUD', ...(process.env.SQUARE_APPLICATION_ID ? { applicationId: process.env.SQUARE_APPLICATION_ID } : {}) }, credentials: { accessToken: token } };
const results: Array<{ step: string; ok: boolean; note: string }> = [];
async function step<T>(name: string, fn: () => Promise<T>, note: (v: T) => string): Promise<T | null> {
  try {
    const v = await fn();
    results.push({ step: name, ok: true, note: note(v) });
    return v;
  } catch (e) {
    results.push({ step: name, ok: false, note: (e as Error).message.slice(0, 300) });
    return null;
  }
}

const started = new Date(Date.now() - 60_000);
const locations = await step('list locations', () => sq.listLocations(base), (l) => `${l.length} location(s): ${l.map((x) => x.name).join(', ')}`);
const loc = locations?.[0]?.ref;
if (!loc) {
  console.table(results);
  process.exit(1);
}
const conn: ConnectionHandle = { ...base, config: { ...base.config, locationRef: loc } };
const run = randomUUID().slice(0, 8);

// 1. Push an order first (Square shows an order on the till once a payment naming it completes).
const pushed = await step(
  'push order (before payment)',
  () =>
    sq.pushOrder!(conn, {
      idempotencyKey: `ros-check-order-${run}`,
      reference: `CHK-${run}`,
      locationRef: loc,
      channel: 'pickup',
      customerName: 'Sandbox Check',
      readyAt: new Date(Date.now() + 20 * 60_000),
      lines: [
        { name: 'Wagyu rump 250g', qty: 1, unitPriceCents: 4800, modifiers: [{ name: 'Medium rare', priceCents: 0 }] },
        { name: 'Fries, aioli', qty: 2, unitPriceCents: 1100, modifiers: [] },
      ],
      totalCents: 7000,
      currency: 'AUD',
    }),
  (r) => `order ${r.posOrderRef}`,
);

// 2. Pay for it with Square's sandbox "ok" card token.
const payKey = `ros-check-pay-${run}`;
const paid = await step(
  'create payment naming the order',
  () => sq.createPayment(conn, { idempotencyKey: payKey, amountCents: 7000, tipCents: 0, currency: 'AUD', sourceToken: 'cnon:card-nonce-ok', reference: `CHK-${run}`, locationRef: loc, posOrderRef: pushed?.posOrderRef ?? null }),
  (r) => `${r.status} ${r.externalRef} ${r.cardBrand ?? ''} ••${r.cardLast4 ?? ''}; raw has card identifier: ${/fingerprint|payment_account_reference/.test(JSON.stringify(r.raw ?? {}))}; hints: ${(r.identityHints ?? []).map((h) => h.kind).join(',') || 'none'}`,
);
await step('same payment again (idempotent)', () => sq.createPayment(conn, { idempotencyKey: payKey, amountCents: 7000, tipCents: 0, currency: 'AUD', sourceToken: 'cnon:card-nonce-ok', reference: `CHK-${run}`, locationRef: loc, posOrderRef: pushed?.posOrderRef ?? null }), (r) => `${r.status}; same payment: ${r.externalRef === paid?.externalRef}`);

// 3. A declined card must come back as a decline, not an exception.
await step('declined card', () => sq.createPayment(conn, { idempotencyKey: `ros-check-decl-${run}`, amountCents: 500, tipCents: 0, currency: 'AUD', sourceToken: 'cnon:card-nonce-declined', reference: `CHKD-${run}`, locationRef: loc }), (r) => `${r.status} (${r.failureReason ?? 'no reason'})`);

// 4. Read it back the way ingest does.
if (paid?.externalRef) {
  await step('get transaction', () => sq.getTransaction(conn, paid.externalRef), (t) => (t ? `${t.status} total ${t.totalCents} lines ${t.lines.length} [${t.lines.map((l) => `${l.qty}x ${l.name}`).join('; ')}] originatedHere=${t.originatedHere ?? 'unset'} hints=${t.identityHints.map((h) => h.kind).join(',')}` : 'NOT FOUND'));
}
const listed = await step('list transactions (updated-at window, as ingest pages)', () => sq.listTransactions(conn, { locationRef: loc, since: started, limit: 50 }), (r) => `${r.items.length} in window; includes ours: ${r.items.some((i) => i.externalRef === paid?.externalRef)}; next cursor: ${r.nextCursor ? 'yes' : 'no'}`);
void listed;
if (sq.lookupPayment) {
  // Square's list can show a just-made payment as APPROVED for a moment; the adapter then says
  // "still pending" and the reconcile job tries again later. So this check waits and retries too.
  const look = () => sq.lookupPayment!(conn, { idempotencyKey: payKey, reference: `CHK-${run}`, amountCents: 7000, tipCents: 0, currency: 'AUD', locationRef: loc, attemptedAt: new Date() });
  let first = 'completed at once';
  await step(
    'lookup payment by reference (reconcile)',
    async () => {
      try {
        return await look();
      } catch (e) {
        first = `first answer "${(e as Error).message}", then`;
        await new Promise((r) => setTimeout(r, 6000));
        return look();
      }
    },
    (r) => (r ? `${first} ${r.status}; same payment: ${r.externalRef === paid?.externalRef}` : 'null (not found)'),
  );
}

if (sq.lookupPayment) {
  await step('lookup of a payment that never happened', () => sq.lookupPayment!(conn, { idempotencyKey: `ros-check-none-${run}`, reference: `NONE-${run}`, amountCents: 12345, tipCents: 0, currency: 'AUD', locationRef: loc, attemptedAt: new Date() }), (r) => (r === null ? 'null, as it should be' : `UNEXPECTED ${r.status}`));
}

// 5. Refund part of it, then see the refund on the transaction.
if (paid?.externalRef) {
  const refund = await step('partial refund', () => sq.refund(conn, { idempotencyKey: `ros-check-refund-${run}`, paymentRef: paid.externalRef, amountCents: 1100, currency: 'AUD', reason: 'Sandbox check' }), (r) => `${r.status} ${r.externalRef}`);
  if (refund && sq.getRefund) await step('get refund', () => sq.getRefund!(conn, refund.externalRef), (r) => JSON.stringify(r));
  await new Promise((r) => setTimeout(r, 4000));
  await step('transaction after refund', () => sq.getTransaction(conn, paid.externalRef), (t) => (t ? `${t.status} refunded ${t.refundedCents}` : 'NOT FOUND'));
}

console.log('\nSquare sandbox check\n');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step}\n      ${r.note}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
