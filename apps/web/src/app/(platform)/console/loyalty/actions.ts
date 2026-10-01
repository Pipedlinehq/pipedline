'use server';

import { redirect } from 'next/navigation';
import { loyalty, offers } from '@ros/modules';
import type { FormState } from '@/ui/client';
import { timeOnly } from '@/ui/format';
import { act, all, bool, cents, int, nullableText, optText, text } from '@/lib/console-actions';

/**
 * Loyalty's server actions. Every one runs the service as the signed-in staff member; the
 * service makes the role check. The venue always comes from the console context, never the form.
 */
const LOYALTY = '/console/loyalty';

/** Only the outcome goes back to the browser, never the data the service returned. */
async function plain(p: Promise<FormState>): Promise<FormState> {
  const r = await p;
  return r?.ok ? { ok: true, message: r.message } : r;
}

const num = (fd: FormData, name: string): number | undefined => {
  const v = text(fd, name);
  if (v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
};

export async function saveProgramAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const expiryPolicy = (text(fd, 'expiryPolicy') || 'none') as 'none' | 'rolling' | 'fixed';
  return plain(act(
    (ctx) =>
      loyalty.saveProgram(ctx, {
        name: text(fd, 'name'),
        isActive: bool(fd, 'isActive'),
        earnModel: (text(fd, 'earnModel') || 'points_per_dollar') as 'points_per_dollar' | 'visits' | 'stamps',
        pointsPerDollar: num(fd, 'pointsPerDollar') ?? 1,
        pointsRounding: (text(fd, 'pointsRounding') || 'floor') as 'floor' | 'round' | 'ceil',
        pointValueCents: num(fd, 'pointValueCents') ?? 0,
        expiryPolicy,
        expiryMonths: expiryPolicy === 'none' ? null : (int(fd, 'expiryMonths') ?? null),
        enrolmentBonus: int(fd, 'enrolmentBonus') ?? 0,
        birthdayBonus: int(fd, 'birthdayBonus') ?? 0,
        termsUrl: nullableText(fd, 'termsUrl'),
      }),
    { success: 'Programme saved.', revalidate: LOYALTY },
  ));
}

export async function saveTierAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return plain(act(
    (ctx) =>
      loyalty.saveTier(ctx, {
        id: optText(fd, 'id'),
        name: text(fd, 'name'),
        thresholdPoints: int(fd, 'thresholdPoints') ?? 0,
        windowMonths: int(fd, 'windowMonths') ?? 12,
        multiplier: num(fd, 'multiplier') ?? 1,
        perks: text(fd, 'perks')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        sortOrder: int(fd, 'sortOrder') ?? 0,
      }),
    { success: (t) => `Tier "${t.name}" saved.`, revalidate: `${LOYALTY}/program` },
  ));
}

export async function deleteTierAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return plain(act((ctx) => loyalty.deleteTier(ctx, text(fd, 'tierId')), { success: 'Tier removed. Its members are re-tiered on their next sale or overnight.', revalidate: `${LOYALTY}/program` }));
}

export async function saveRewardAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const kind = (text(fd, 'kind') || 'fixed') as 'fixed' | 'percent' | 'free_item';
  const days = all(fd, 'validDays').map(Number);
  const venues = all(fd, 'validVenueIds');
  return plain(act(
    (ctx) =>
      loyalty.saveReward(ctx, {
        id: optText(fd, 'id'),
        name: text(fd, 'name'),
        description: nullableText(fd, 'description'),
        costPoints: int(fd, 'costPoints') ?? 0,
        kind,
        valueCents: cents(fd, 'value') ?? null,
        percentOff: kind === 'percent' ? (int(fd, 'percentOff') ?? null) : null,
        minSpendCents: cents(fd, 'minSpend') ?? 0,
        validDays: days.length && days.length < 7 ? days : null,
        validVenueIds: venues.length ? venues : null,
        maxRedemptionsPerCustomer: int(fd, 'maxPerCustomer') ?? null,
        isActive: bool(fd, 'isActive'),
      }),
    { success: (r) => `Reward "${r.name}" saved.`, revalidate: `${LOYALTY}/rewards` },
  ));
}

export async function adjustPointsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const direction = text(fd, 'direction') === 'remove' ? -1 : 1;
  const amount = int(fd, 'points');
  return plain(act(
    (ctx, c) =>
      loyalty.adjustPoints(ctx, {
        venueId: c.venue.id,
        accountId: text(fd, 'accountId'),
        points: amount === undefined || Number.isNaN(amount) ? 0 : direction * Math.abs(amount),
        reason: text(fd, 'reason'),
        requestKey: optText(fd, 'requestKey'),
      }),
    { success: (r) => (r.applied ? `Done. The balance is now ${r.balance.toLocaleString('en-AU')} points.` : `That adjustment was already made. The balance is ${r.balance.toLocaleString('en-AU')} points.`), revalidate: `${LOYALTY}/members` },
  ));
}

export async function setMemberStatusAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const status = text(fd, 'status') === 'suspended' ? 'suspended' : 'active';
  return plain(act((ctx) => loyalty.setMemberStatus(ctx, { accountId: text(fd, 'accountId'), status, reason: text(fd, 'reason') }), {
    success: status === 'suspended' ? 'Membership suspended. Points are kept.' : 'Suspension lifted.',
    revalidate: `${LOYALTY}/members`,
  }));
}

// ── The counter ─────────────────────────────────────────────────────────────

/** Look a guest up by what they hand over. The result goes in the URL as the account id, never the phone or email. */
export async function lookupAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const by = text(fd, 'by');
  const value = text(fd, 'value');
  if (!value) return { ok: false, error: 'Type what the guest gave you.' };
  const r = await act((ctx, c) =>
    loyalty.lookupMember(ctx, { venueId: c.venue.id, ...(by === 'email' ? { email: value } : by === 'code' ? { memberCode: value } : { phone: value }) }),
  );
  if (!r.ok) return r;
  if (!r.data?.member) {
    return { ok: false, error: r.data?.customerId ? 'The venue knows this guest, but they are not a member yet. You can enrol them below.' : 'No member found. You can enrol them below.' };
  }
  redirect(`${LOYALTY}/counter?member=${r.data.member.accountId}`);
}

export async function enrolAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const r = await act((ctx, c) =>
    loyalty.enrolAtCounter(ctx, {
      venueId: c.venue.id,
      phone: optText(fd, 'phone'),
      email: optText(fd, 'email'),
      firstName: optText(fd, 'firstName'),
      lastName: optText(fd, 'lastName'),
    }),
  );
  if (!r.ok) return r;
  redirect(`${LOYALTY}/counter?member=${r.data!.accountId}&${r.data!.created ? 'joined=1' : 'already=1'}`);
}

export async function issueRedemptionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const res = await act(async (ctx, c) => ({ r: await loyalty.issueRedemption(ctx, { venueId: c.venue.id, accountId: text(fd, 'accountId'), rewardId: text(fd, 'rewardId') }), tz: c.venue.timezone }), {
    success: ({ r, tz }) => `Code ${r.code} issued for ${r.rewardName}. Apply ${r.rewardSummary} at the till before ${timeOnly(r.expiresAt, tz)}.`,
    revalidate: `${LOYALTY}/counter`,
  });
  return res.ok ? { ok: true, message: res.message } : res;
}

export async function voidRedemptionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return plain(act((ctx) => loyalty.voidRedemption(ctx, { redemptionId: text(fd, 'redemptionId'), reason: optText(fd, 'reason') }), {
    success: 'Code cancelled. The points are free again.',
    revalidate: `${LOYALTY}/counter`,
  }));
}

export async function forceConfirmAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return plain(act((ctx, c) => loyalty.forceConfirmRedemption(ctx, { venueId: c.venue.id, redemptionId: text(fd, 'redemptionId'), reason: text(fd, 'reason') }), {
    success: (r) => `Confirmed by hand. ${r.points.toLocaleString('en-AU')} points were spent.`,
    revalidate: `${LOYALTY}/counter`,
  }));
}

export async function redeemCodeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return plain(act((ctx, c) => offers.redeemCodeAtCounter(ctx, { venueId: c.venue.id, code: text(fd, 'code') }), {
    success: (r) => `Code ${r.code} marked as used: ${r.summary}.`,
    revalidate: `${LOYALTY}/counter`,
  }));
}
