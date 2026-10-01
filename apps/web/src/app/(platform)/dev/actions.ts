'use server';

import { revalidatePath } from 'next/cache';
import { runAction } from '@/lib/actions';
import { requireSim } from '@/lib/dev';
import * as dev from '@/lib/ops-dev';
import { money } from '@/ui/format';
import type { FormState } from '@/ui/client';

/** Server actions for the /dev control page. Each is a thin form wrapper over lib/ops-dev. Development only. */

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
};
const cents = (f: FormData, k: string) => {
  const v = str(f, k);
  return v ? Math.round(Number(v) * 100) : undefined;
};

async function act(fn: () => Promise<string>): Promise<FormState> {
  requireSim();
  const r = await runAction(fn);
  revalidatePath('/dev');
  return r.ok ? { ok: true, message: r.data } : { ok: false, error: r.error };
}

const delivered = (d: dev.Delivery | null) => (d ? ` Webhook answered HTTP ${d.status}: ${JSON.stringify(d.body)}` : '');

export async function saleAction(_p: FormState, f: FormData): Promise<FormState> {
  return act(async () => {
    const r = await dev.ringUpSale({
      venueId: String(f.get('venueId')),
      customerEmail: str(f, 'customerEmail'),
      customerName: str(f, 'customerName'),
      card: f.get('tender') !== 'cash',
      cardName: str(f, 'cardName'),
      discountCode: str(f, 'discountCode'),
      discountCents: cents(f, 'discount'),
      deliver: (str(f, 'deliver') as 'signed' | 'forged' | 'none' | undefined) ?? 'signed',
    });
    return `Rang up ${money(r.totalCents)} as ${r.paymentId}.${delivered(r.delivery)}`;
  });
}

export async function replayAction(_p: FormState, f: FormData): Promise<FormState> {
  return act(async () => {
    const d = await dev.replayPosWebhook({ eventId: str(f, 'eventId') });
    return `Delivered the last webhook again.${delivered(d)}`;
  });
}

export async function refundAction(_p: FormState, f: FormData): Promise<FormState> {
  return act(async () => {
    const r = await dev.refundSale({ paymentId: String(f.get('paymentId')), amountCents: cents(f, 'amount') });
    return `Refunded ${money(r.refundedCents)} of ${r.paymentId}.${delivered(r.delivery)}`;
  });
}

export async function posHealthAction(_p: FormState, f: FormData): Promise<FormState> {
  return act(async () => {
    const r = await dev.setPosHealth({ venueId: String(f.get('venueId')), ok: f.get('ok') === 'yes', failNext: Number(str(f, 'failNext') ?? 0) });
    return `POS connection is now ${r.status}.`;
  });
}

export async function messageEventAction(_p: FormState, f: FormData): Promise<FormState> {
  return act(async () => {
    const d = await dev.deliverMessageEvent({ providerMessageId: String(f.get('providerMessageId')), event: String(f.get('event')) as 'delivered' });
    return `Sent "${String(f.get('event'))}" for ${d.providerMessageId}.${delivered(d)}`;
  });
}

export async function verifyDomainAction(_p: FormState, f: FormData): Promise<FormState> {
  return act(async () => {
    const r = dev.verifyDomain({ kind: String(f.get('kind')) as 'hosting', name: String(f.get('name')) });
    return `${r.name} will be found verified on the provider's next check. Retry the blocked step on the onboarding board, or wait for the ten-minute poll.`;
  });
}

export async function criotaAction(_p: FormState, f: FormData): Promise<FormState> {
  return act(async () => {
    const action = String(f.get('action'));
    const r =
      action === 'connect'
        ? await dev.criota({ action: 'connect', orgId: String(f.get('orgId')) })
        : action === 'describe'
          ? await dev.criota({ action: 'describe', tool: String(f.get('tool')), description: String(f.get('description')) })
          : action === 'add'
            ? await dev.criota({ action: 'add', tool: String(f.get('tool')), description: String(f.get('description')) })
            : await dev.criota({ action: 'reset' });
    return `Done: ${JSON.stringify(r)}`;
  });
}

export async function pairingAction(_p: FormState, f: FormData): Promise<FormState> {
  return act(async () => {
    const r = await dev.kitchenPairingCode({ venueId: String(f.get('venueId')) });
    return `Pairing code for ${r.venueName}: ${r.code} (valid 15 minutes). Open /kitchen on the screen and type it.`;
  });
}

export async function orderAction(_p: FormState, f: FormData): Promise<FormState> {
  return act(async () => {
    const r = await dev.placeDevOrder({ venueId: String(f.get('venueId')), table: f.get('table') === 'on', guestName: str(f, 'guestName'), note: str(f, 'note') });
    return `Order ${r.reference} placed and paid (${r.status}). It is on the kitchen screen.`;
  });
}
