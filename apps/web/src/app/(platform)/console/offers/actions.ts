'use server';

import { redirect } from 'next/navigation';
import { zonedTimeToUtc as zoned } from '@ros/core';
import { offers } from '@ros/modules';
import type { FormState } from '@/ui/client';
import { act, all, bool, cents, int, nullableText, optText, text } from '@/lib/console-actions';

/** Offers' server actions. The services check the role; nothing here trusts a venue from the form. */

type Kind = 'welcome' | 'comeback' | 'voucher' | 'birthday' | 'creator' | 'manual';
type Channel = 'pickup' | 'delivery' | 'dine-in-qr';

/** "2026-11-30T18:00" from a datetime-local input, in the venue's zone, as an instant; empty for none. */
function when(fd: FormData, name: string, tz: string): Date | null {
  const v = text(fd, name);
  if (!v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(v);
  if (!m) return null;
  // zonedTimeToUtc lives in core; the venue's own clock is what a person means by "6pm on the 30th".
  return zoned(m[1]!, m[2]!, tz);
}

export async function saveOfferAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const discountKind = (text(fd, 'discountKind') || 'fixed') as 'fixed' | 'percent' | 'free_item';
  const venues = all(fd, 'validVenueIds');
  const channels = all(fd, 'channels') as Channel[];
  const days = all(fd, 'days').map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  const services = text(fd, 'services')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const id = optText(fd, 'id');
  const r = await act(
    (ctx, c) =>
      offers.saveOffer(ctx, {
        id,
        kind: (text(fd, 'kind') || 'manual') as Kind,
        name: text(fd, 'name'),
        description: nullableText(fd, 'description'),
        discountKind,
        valueCents: cents(fd, 'value') ?? null,
        percentOff: discountKind === 'percent' ? (int(fd, 'percentOff') ?? null) : null,
        menuItemId: nullableText(fd, 'menuItemId'),
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
        method: (text(fd, 'method') || 'code') as 'code' | 'automatic',
        appliesTo: (text(fd, 'appliesTo') || 'bill') as 'item' | 'category' | 'bill' | 'delivery',
        category: nullableText(fd, 'category'),
        audience: (text(fd, 'audience') || 'everyone') as 'everyone' | 'list' | 'new_guests' | 'loyalty_members',
        segmentId: nullableText(fd, 'segmentId'),
        startsAt: when(fd, 'startsAt', c.venue.timezone),
        endsAt: when(fd, 'endsAt', c.venue.timezone),
        days: days.length ? days : null,
        services: services.length ? services : null,
        timeFrom: nullableText(fd, 'timeFrom'),
        timeTo: nullableText(fd, 'timeTo'),
        combineItem: bool(fd, 'combineItem'),
        combineBill: bool(fd, 'combineBill'),
        combineDelivery: bool(fd, 'combineDelivery'),
        perGuestLimit: int(fd, 'perGuestLimit') ?? null,
        totalLimit: int(fd, 'totalLimit') ?? null,
      }),
    { revalidate: '/console/offers' },
  );
  if (!r.ok) return r;
  if (!id) redirect(`/console/offers/${r.data!.id}?created=1`);
  return { ok: true, message: `Offer saved: ${r.data!.summary}.` };
}

export async function switchOfferAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const offerId = text(fd, 'offerId');
  const on = text(fd, 'on') === '1';
  const r = await act((ctx) => offers.switchOffer(ctx, offerId, on), { revalidate: ['/console/offers', `/console/offers/${offerId}`] });
  if (!r.ok) return r;
  return { ok: true, message: on ? 'Switched on. It applies from now.' : 'Switched off. It no longer applies; codes guests already hold stay good.' };
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

// ── Surcharges ───────────────────────────────────────────────────────────────

export async function saveSurchargeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = optText(fd, 'id');
  const kind = (text(fd, 'kind') || 'public_holiday') as 'public_holiday' | 'sunday' | 'days';
  const days = all(fd, 'days').map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  const dates = text(fd, 'dates')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const percent = Number(text(fd, 'percent').replace('%', ''));
  const r = await act(
    (ctx, c) =>
      offers.saveSurcharge(ctx, {
        id,
        venueId: bool(fd, 'everyVenue') ? null : c.venue.id,
        name: text(fd, 'name'),
        kind,
        percent: Number.isFinite(percent) ? percent : 0,
        days: kind === 'days' && days.length ? days : null,
        dates,
        isActive: bool(fd, 'isActive'),
      }),
    { revalidate: ['/console/offers/surcharges', '/console/offers'] },
  );
  if (!r.ok) return r;
  return { ok: true, message: `Saved. Menus and dockets will say: “${r.data!.notice}”` };
}

export async function deleteSurchargeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const r = await act((ctx) => offers.deleteSurcharge(ctx, text(fd, 'id')), { revalidate: '/console/offers/surcharges' });
  return r.ok ? { ok: true, message: 'Surcharge removed.' } : r;
}
