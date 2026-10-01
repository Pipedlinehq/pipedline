'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from './api';
import { type CardChoice, CardPicker, type PaymentConfig } from './card-picker';

/** Pay for an order that is waiting for payment (the guest came back to its link), or cancel it. */
export function PayPanel({ trackingToken, totalLabel, payment }: { trackingToken: string; totalLabel: string; payment: PaymentConfig | null }) {
  const router = useRouter();
  const [card, setCard] = useState<CardChoice>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; retry?: boolean } | null>(null);

  const pay = async () => {
    if (!card) {
      setMsg({ text: 'Choose a card to pay with.' });
      return;
    }
    setBusy(true);
    const r = await api<{ status: 'paid' | 'declined' | 'retry'; message?: string }>('/api/pay', { body: { trackingToken, sourceToken: card.token } });
    setBusy(false);
    if (!r.ok) return setMsg({ text: r.error.message });
    if (r.data.status === 'paid') {
      setMsg(null);
      router.refresh();
      return;
    }
    if (r.data.status === 'declined') setCard(null);
    setMsg({ text: r.data.message ?? 'The payment did not go through.', retry: r.data.status === 'retry' });
  };

  const cancel = async () => {
    setBusy(true);
    const r = await api('/api/order/cancel', { body: { trackingToken } });
    setBusy(false);
    if (!r.ok) return setMsg({ text: r.error.message });
    router.refresh();
  };

  return (
    <section aria-labelledby="pay-h" className="s-card space-y-4 p-5">
      <h2 id="pay-h" className="s-heading text-xl">
        Pay {totalLabel}
      </h2>
      <p className="text-sm">Nothing goes to the kitchen until this is paid.</p>
      <CardPicker payment={payment} value={card} onChange={setCard} disabled={busy} />
      {msg ? (
        <p role="alert" className="s-notice" data-tone="error">
          {msg.text}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <button type="button" className="s-btn" onClick={pay} disabled={busy || !payment} aria-busy={busy}>
          {busy ? 'Working…' : msg?.retry ? 'Try the same card again' : `Pay ${totalLabel}`}
        </button>
        <button type="button" className="s-btn-quiet" onClick={cancel} disabled={busy}>
          Cancel this order
        </button>
      </div>
    </section>
  );
}
