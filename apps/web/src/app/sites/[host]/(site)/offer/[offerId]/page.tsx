import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { offers } from '@ros/modules';
import { pageMetadata } from '@/components/site/site-pages';
import { loadScope, siteCall } from '@/lib/site-scope';
import { requestCode } from '../../offer-actions';
import { SignupForm } from '../../offer-forms';

type Params = Promise<{ host: string; offerId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { host, offerId } = await params;
  const scope = await loadScope(host);
  const offer = await siteCall(host, (ctx) => offers.getPublicOffer(ctx, offerId));
  return pageMetadata(scope, { title: `${offer.name} | ${scope.view.org.name}`, description: offer.summary, path: `/offer/${offer.id}`, noindex: true });
}

/**
 * The sign-up landing for a welcome or creator offer. The creator and campaign ride on the
 * address, so the visitor session (started by the beacon) is stamped with them.
 */
export default async function OfferPage({ params, searchParams }: { params: Params; searchParams: Promise<Record<string, string | undefined>> }) {
  const { host, offerId } = await params;
  const sp = await searchParams;
  const scope = await loadScope(host);
  const offer = await siteCall(host, (ctx) => offers.getPublicOffer(ctx, offerId));
  if (offer.creatorId && (sp.creator !== offer.creatorId || (offer.campaignId && sp.campaign !== offer.campaignId))) {
    const q = new URLSearchParams({ ...(sp as Record<string, string>), creator: offer.creatorId, ...(offer.campaignId ? { campaign: offer.campaignId } : {}) });
    redirect(`/offer/${offer.id}?${q}`);
  }
  const orderable = scope.venue ? scope.view.enabledModules.includes('ordering') : scope.view.venues.length > 0;
  return (
    <div className="mx-auto max-w-lg space-y-6 px-4 py-14 sm:px-6">
      <div className="space-y-3">
        <p className="text-sm tracking-[0.15em] uppercase">{scope.view.org.name}</p>
        <h1 className="s-heading">{offer.name}</h1>
        <p className="text-xl">{offer.summary}.</p>
        {offer.description ? <p>{offer.description}</p> : null}
        <p className="text-sm">
          One per guest. Valid for {offer.validityDays} days once you have it{offer.channels.length ? ', on orders and at the counter' : ''}.
        </p>
      </div>
      {offer.signupOpen ? (
        <SignupForm action={requestCode.bind(null, host, offer.id, scope.venue?.id ?? null, `/offer/${offer.id}`)} orderHref={orderable ? '/order' : null} />
      ) : (
        <p className="s-notice">This offer is sent to guests directly. Look for it in your email or messages.</p>
      )}
    </div>
  );
}
