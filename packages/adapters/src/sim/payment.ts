import { createHash } from 'node:crypto';
import { type ConnectionHandle, type PaymentAdapter, type PaymentLookup, type PaymentRequest, type PaymentResult, type RefundRequest, definePlug } from '@ros/core';
import { simVerify } from './signing';

/**
 * Source tokens the simulated processor understands, standing in for what the provider's
 * hosted card fields hand the browser. Anything after a colon names the card, so a test can
 * pay twice with "the same card": `tok_sim_ok:amy` always carries the same fingerprint.
 */
export const SIM_PAY_TOKENS = {
  ok: 'tok_sim_ok',
  decline: 'tok_sim_decline',
  /** The charge goes through at the provider but the call never answers. A retry with the same key finds it. */
  timeout: 'tok_sim_timeout',
  /** The call never answers and nothing was charged: the request was lost on the way. */
  lost: 'tok_sim_lost',
} as const;

export interface SimCharge {
  idempotencyKey: string;
  externalRef: string;
  status: 'completed' | 'failed';
  /** Excludes the tip, as the port defines it. */
  amountCents: number;
  tipCents: number;
  refundedCents: number;
  currency: string;
  reference: string;
  sourceToken: string;
  accountRef: string;
  locationRef: string | null;
  /** The POS order the payment named (PaymentRequest.posOrderRef), if any. */
  posOrderRef: string | null;
  at: Date;
}

export interface SimRefund {
  idempotencyKey: string;
  externalRef: string;
  paymentRef: string;
  amountCents: number;
  reason: string;
  status: 'completed' | 'pending';
  at: Date;
}

export interface SimPaymentAdapter extends PaymentAdapter {
  /** Every payment attempt that reached the processor, declined ones included, in order. */
  readonly charges: SimCharge[];
  readonly refunds: SimRefund[];
  /** Completed charges only: what actually moved money. */
  captured(): SimCharge[];
  /** Make the next n calls (payment or refund) fail as an outage, before anything is charged. */
  failNext(n: number, message?: string): void;
  /** 'pending': refunds are answered PENDING, as a real processor often does, until settleRefunds(). */
  setRefundMode(mode: 'completed' | 'pending'): void;
  /** Complete every pending refund, as the processor eventually does. */
  settleRefunds(): void;
  /** How many times lookupPayment was asked. */
  readonly lookups: PaymentLookup[];
  reset(): void;
}

export const simPayPlug = definePlug({
  key: 'sim-pay',
  name: 'Simulated payments',
  description: 'A card processor that moves no money. For development, tests and the fixture venues.',
  kind: 'adapter',
  tier: 'first_party',
  adapters: { payment: 'sim-pay' },
  auth: 'none',
  scopes: ['payments:write'],
  venueScoped: true,
  simulated: true,
});

const short = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 20);

/**
 * A processor that charges nothing. It honours idempotency keys the way a real one does: the
 * same key returns the same payment and charges once, including after a call that timed out.
 * Its raw payload is shaped like a real provider's and carries a card fingerprint, so the
 * stripping rules (docs/SCHEMA.md section 2a rule 3) are exercised on every payment.
 */
export function createSimPaymentAdapter(opts: { clock?: () => Date; onCaptured?: (charge: SimCharge) => void } = {}): SimPaymentAdapter {
  const charges: SimCharge[] = [];
  const refunds: SimRefund[] = [];
  const lookups: PaymentLookup[] = [];
  const results = new Map<string, PaymentResult>();
  const refundResults = new Map<string, { externalRef: string; status: 'completed' | 'pending' }>();
  let refundMode: 'completed' | 'pending' = 'completed';
  let failures = 0;
  let failureMessage = 'simulated processor outage';
  const now = () => (opts.clock ? opts.clock() : new Date());

  const outage = () => {
    if (failures > 0) {
      failures--;
      throw new Error(failureMessage);
    }
  };

  return {
    key: 'sim-pay',
    charges,
    refunds,
    lookups,

    clientConfig(conn: ConnectionHandle) {
      return {
        provider: 'sim',
        applicationId: 'sim-app',
        locationRef: String(conn.config.locationRef ?? conn.externalAccountId),
        environment: 'sandbox' as const,
      };
    },

    async createPayment(conn: ConnectionHandle, req: PaymentRequest): Promise<PaymentResult> {
      outage();
      const prior = results.get(req.idempotencyKey);
      if (prior) return prior;
      if (!Number.isInteger(req.amountCents) || req.amountCents < 0 || !Number.isInteger(req.tipCents) || req.tipCents < 0) {
        throw new Error('sim-pay: amounts must be whole cents');
      }

      const [kind, card = 'default'] = req.sourceToken.split(':') as [string, string?];
      if (kind === SIM_PAY_TOKENS.lost) throw new Error('sim-pay: request timed out');
      if (kind !== SIM_PAY_TOKENS.ok && kind !== SIM_PAY_TOKENS.decline && kind !== SIM_PAY_TOKENS.timeout) {
        throw new Error('sim-pay: unknown source token');
      }
      const declined = kind === SIM_PAY_TOKENS.decline;
      const externalRef = `simpay_${short(`${conn.externalAccountId}:${req.idempotencyKey}`)}`;
      const fingerprint = `sim-fp-${card}`;
      const last4 = String(parseInt(short(card).slice(0, 6), 16) % 10_000).padStart(4, '0');
      const result: PaymentResult = {
        externalRef,
        status: declined ? 'failed' : 'completed',
        cardBrand: 'VISA',
        cardLast4: last4,
        failureReason: declined ? 'card_declined' : null,
        raw: {
          id: externalRef,
          status: declined ? 'FAILED' : 'COMPLETED',
          location_id: req.locationRef ?? null,
          reference_id: req.reference,
          amount_money: { amount: req.amountCents, currency: req.currency },
          tip_money: { amount: req.tipCents, currency: req.currency },
          card_details: {
            status: declined ? 'FAILED' : 'CAPTURED',
            card: { card_brand: 'VISA', last_4: last4, fingerprint, payment_account_reference: `sim-par-${card}` },
          },
        },
        identityHints: declined ? [] : [{ kind: 'card_fingerprint', value: fingerprint }],
      };
      results.set(req.idempotencyKey, result);
      charges.push({
        idempotencyKey: req.idempotencyKey,
        externalRef,
        status: result.status,
        amountCents: req.amountCents,
        tipCents: req.tipCents,
        refundedCents: 0,
        currency: req.currency,
        reference: req.reference,
        sourceToken: req.sourceToken,
        accountRef: conn.externalAccountId,
        locationRef: req.locationRef ?? null,
        posOrderRef: req.posOrderRef ?? null,
        at: now(),
      });
      if (!declined) opts.onCaptured?.(charges[charges.length - 1]!);
      // The money moved, but the caller never hears back.
      if (kind === SIM_PAY_TOKENS.timeout) throw new Error('sim-pay: request timed out');
      return result;
    },

    async refund(_conn: ConnectionHandle, req: RefundRequest) {
      outage();
      const prior = refundResults.get(req.idempotencyKey);
      if (prior) return prior;
      const charge = charges.find((c) => c.externalRef === req.paymentRef && c.status === 'completed');
      // A payment this simulator issued in another process (the fixture seeder, or before a
      // restart) is not in memory, but a real processor would still know it. Accept the refund;
      // the platform has already bounded the amount by its own payments row.
      if (!charge && !req.paymentRef.startsWith('simpay_')) throw new Error('sim-pay: no such payment');
      if (!Number.isInteger(req.amountCents) || req.amountCents <= 0) throw new Error('sim-pay: refund amount must be positive whole cents');
      if (charge && charge.refundedCents + req.amountCents > charge.amountCents + charge.tipCents) throw new Error('sim-pay: refund exceeds the payment');
      if (charge) charge.refundedCents += req.amountCents;
      const result = { externalRef: `simrf_${short(`${req.paymentRef}:${req.idempotencyKey}`)}`, status: refundMode };
      refundResults.set(req.idempotencyKey, result);
      refunds.push({ idempotencyKey: req.idempotencyKey, externalRef: result.externalRef, paymentRef: req.paymentRef, amountCents: req.amountCents, reason: req.reason, status: refundMode, at: now() });
      return { ...result };
    },

    async lookupPayment(_conn: ConnectionHandle, req: PaymentLookup) {
      outage();
      lookups.push({ ...req });
      // The processor holds every attempt it received under its key; a lost request never arrived.
      return results.get(req.idempotencyKey) ?? null;
    },

    async getRefund(_conn: ConnectionHandle, refundRef: string) {
      outage();
      const r = refunds.find((x) => x.externalRef === refundRef);
      return r ? { externalRef: r.externalRef, status: r.status } : null;
    },

    setRefundMode(mode) {
      refundMode = mode;
    },

    settleRefunds() {
      for (const r of refunds) r.status = 'completed';
      for (const v of refundResults.values()) v.status = 'completed';
    },

    verifyWebhook: simVerify,

    captured() {
      return charges.filter((c) => c.status === 'completed');
    },

    failNext(n, message) {
      failures = n;
      if (message) failureMessage = message;
    },

    reset() {
      charges.length = 0;
      refunds.length = 0;
      results.clear();
      refundResults.clear();
      lookups.length = 0;
      refundMode = 'completed';
      failures = 0;
    },
  };
}
