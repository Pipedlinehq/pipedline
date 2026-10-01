'use server';

import { offers } from '@ros/modules';
import { runAction } from '@/lib/actions';
import { onSite } from '@/lib/site';

export type OfferFormState = { ok: true; code: string; summary: string; expiresAt: string } | { ok: false; error: string } | null;

/** The sign-up page: an email or mobile in, a code out. The offer and its creator come from the offer, not the form. */
export async function requestCode(host: string, offerId: string, venueId: string | null, landingPath: string, _prev: OfferFormState, form: FormData): Promise<OfferFormState> {
  const contact = String(form.get('contact') ?? '').trim();
  const isEmail = contact.includes('@');
  const r = await runAction(() =>
    onSite(host, (ctx) =>
      offers.requestOfferCode(ctx, {
        offerId,
        email: isEmail ? contact : undefined,
        phone: !isEmail && contact ? contact : undefined,
        firstName: String(form.get('firstName') ?? '').trim() || undefined,
        venueId,
        landingPath,
      }),
    ),
  );
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, code: r.data.code, summary: r.data.summary, expiresAt: r.data.expiresAt.toISOString() };
}

/** The claim button: the guest pressed it, so the code is theirs to use. */
export async function claim(host: string, code: string, _prev: OfferFormState, _form: FormData): Promise<OfferFormState> {
  const r = await runAction(() => onSite(host, (ctx) => offers.claimCode(ctx, { code })));
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, code: r.data.code, summary: r.data.summary, expiresAt: r.data.expiresAt.toISOString() };
}
