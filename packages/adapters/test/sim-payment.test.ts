import { describe, expect, it } from 'vitest';
import { createSimPaymentAdapter, SIM_PAY_TOKENS } from '../src/sim/payment';

const conn = { externalAccountId: 'sim-acct', config: {} } as never;

describe('sim-pay refunds', () => {
  it('refunds a payment it issued in another process (fixtures, a restart), and still refuses a reference it never issued', async () => {
    const first = createSimPaymentAdapter();
    const paid = await first.createPayment(conn, { idempotencyKey: 'k1', amountCents: 1000, tipCents: 0, currency: 'AUD', reference: 'R1', sourceToken: SIM_PAY_TOKENS.ok } as never);

    const later = createSimPaymentAdapter();
    const r = await later.refund(conn, { idempotencyKey: 'rf1', paymentRef: paid.externalRef, amountCents: 400, currency: 'AUD', reason: 'Missing item' });
    expect(r.status).toBe('completed');
    expect(later.refunds.map((x) => [x.paymentRef, x.amountCents])).toEqual([[paid.externalRef, 400]]);
    // Same key, same answer, one refund.
    expect(await later.refund(conn, { idempotencyKey: 'rf1', paymentRef: paid.externalRef, amountCents: 400, currency: 'AUD', reason: 'Missing item' })).toEqual(r);
    expect(later.refunds).toHaveLength(1);

    await expect(later.refund(conn, { idempotencyKey: 'rf2', paymentRef: 'sq_other', amountCents: 100, currency: 'AUD', reason: 'x' })).rejects.toThrow(/no such payment/);
    // A payment it holds in memory is still bounded by what was charged.
    await expect(first.refund(conn, { idempotencyKey: 'rf3', paymentRef: paid.externalRef, amountCents: 1001, currency: 'AUD', reason: 'x' })).rejects.toThrow(/exceeds/);
  });
});
