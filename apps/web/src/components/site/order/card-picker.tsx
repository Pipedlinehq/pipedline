'use client';

import { useId } from 'react';

export interface PaymentConfig {
  provider: string;
  applicationId: string;
  locationRef: string;
  environment: 'sandbox' | 'production';
}

/** What the card fields hand back: a single-use token for this card, never a card number. */
export type CardChoice = { token: string; label: string } | null;

/** The simulated processor's tokens (packages/adapters/src/sim/payment.ts, SIM_PAY_TOKENS). */
const SIM_CARDS: Array<{ token: string; label: string; hint: string }> = [
  { token: 'tok_sim_ok:guest-visa', label: 'Test card A', hint: 'Approved' },
  { token: 'tok_sim_ok:guest-mastercard', label: 'Test card B', hint: 'Approved' },
  { token: 'tok_sim_decline:guest-declined', label: 'Test card that is declined', hint: 'The bank says no' },
  { token: 'tok_sim_timeout:guest-timeout', label: 'Test card whose payment goes through but the processor does not answer', hint: 'Try again with the same card' },
];

/**
 * Card entry. The card never touches our servers: a processor's hosted fields turn it into a
 * single-use token in the browser, and only that token is sent to /api/pay.
 *
 * With simulated payments (development and tests) this offers the simulated tokens. A real
 * processor mounts its hosted fields at the seam below instead.
 */
export function CardPicker({ payment, value, onChange, disabled }: { payment: PaymentConfig | null; value: CardChoice; onChange: (c: CardChoice) => void; disabled?: boolean }) {
  const name = useId();
  if (!payment) {
    return (
      <p className="s-notice" data-tone="error">
        Card payments are not set up at this venue yet, so orders cannot be paid online.
      </p>
    );
  }
  if (payment.provider === 'sim') {
    return (
      <fieldset disabled={disabled} className="space-y-2" data-card-picker="sim">
        <legend className="mb-1 font-semibold">Card</legend>
        <p className="text-sm">Development mode: no money moves. Choose a test card.</p>
        {SIM_CARDS.map((c) => (
          <label key={c.token} className="s-card flex cursor-pointer items-start gap-3 p-3 has-[:checked]:border-[var(--brand-color-text)] has-[:checked]:border-2">
            <input
              type="radio"
              name={name}
              value={c.token}
              className="s-check"
              checked={value?.token === c.token}
              onChange={() => onChange({ token: c.token, label: c.label })}
            />
            <span>
              <span className="block font-medium">{c.label}</span>
              <span className="block text-sm">{c.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
    );
  }
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="mb-1 font-semibold">Card</legend>
      {/*
        SEAM: a real processor's hosted card fields mount here (e.g. Square Web Payments SDK
        `payments.card().attach('#card-fields')`, using payment.applicationId and
        payment.locationRef), and their tokenize() result is passed to onChange as
        { token, label }. Loading a provider's script is not built yet.
      */}
      <div id="card-fields" data-provider={payment.provider} data-environment={payment.environment} className="s-card min-h-24 p-4 text-sm">
        Card entry is not available in this browser yet. Please pay at the venue.
      </div>
    </fieldset>
  );
}
