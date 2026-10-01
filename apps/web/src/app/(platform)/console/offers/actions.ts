'use server';

import { redirect } from 'next/navigation';
import { offers } from '@ros/modules';
import type { FormState } from '@/ui/client';
import { act, all, bool, cents, int, nullableText, optText, text } from '@/lib/console-actions';

/** Offers' server actions. The services check the role; nothing here trusts a venue from the form. */

type Kind = 'welcome' | 'comeback' | 'voucher' | 'birthday' | 'creator' | 'manual';
type Channel = 'pickup' | 'delivery' | 'dine-in-qr';

export async function saveOfferAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const discountKind = (text(fd, 'discountKind') || 'fixed') as 'fixed' | 'percent' | 'free_item';
  const venues = all(fd, 'validVenueIds');
  const channels = all(fd, 'channels') as Channel[];
  const id = optText(fd, 'id');
  const r = await act((ctx) =>
    offers.saveOffer(ctx, {
      id,
      kind: (text(fd, 'kind') || 'manual') as Kind,
      name: text(fd, 'name'),
      description: nullableText(fd, 'description'),
      discountKind,
      valueCents: cents(fd, 'value') ?? null,
      percentOff: discountKind === 'percent' ? (int(fd, 'percentOff') ?? null) : null,
      priceCents: cents(fd, 'price') ?? 0,
      minSpendCents: cents(fd, 'minSpend') ?? 0,
      validityDays: int(fd, 'validityDays') ?? 30,
      requiresClaim: bool(fd, 'requiresClaim'),
      channels: channels.length ? channels : undefined,
      validVenueIds: venues.length ? venues : null,
      maxCodes: int(fd, 'maxCodes') ?? null,
      codePrefix: optText(fd, 'codePrefix'),
      campaignId: nullableText(fd, 'campaignId'),
      creatorId: nullableText(fd, 'creatorId'),
      isActive: bool(fd, 'isActive'),
    }),
    { revalidate: '/console/offers' },
  );
  if (!r.ok) return r;
  if (!id) redirect(`/console/offers/${r.data!.id}?created=1`);
  return { ok: true, message: 'Offer saved.' };
}

export async function issueCodeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const offerId = text(fd, 'offerId');
  const r = await act((ctx) => offers.issueCode(ctx, { offerId, source: 'staff' }), { revalidate: `/console/offers/${offerId}` });
  if (!r.ok) return r;
  return { ok: true, message: `Code ${r.data!.code.code} issued: ${r.data!.code.summary}. It is not tied to a guest until someone claims or uses it.` };
}

export async function voidCodeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const r = await act((ctx) => offers.voidCode(ctx, { codeId: text(fd, 'codeId'), reason: text(fd, 'reason') }), { revalidate: `/console/offers/${text(fd, 'offerId')}` });
  return r.ok ? { ok: true, message: 'Code cancelled. It can no longer be used.' } : r;
}
