import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { offers } from '@ros/modules';
import { dateTimeIn } from '@/components/site/format';
import { loadScope, optional, siteCall } from '@/lib/site-scope';
import { claim } from '../../offer-actions';
import { ClaimForm } from '../../offer-forms';

export const metadata: Metadata = { title: 'Your offer', robots: { index: false, follow: false } };

const STATUS: Record<string, string> = {
  issued: 'Ready to claim',
  claimed: 'Claimed: ready to use',
  redeemed: 'Already used',
  expired: 'Expired',
  voided: 'No longer valid',
};

/**
 * Preview, then claim with one tap. The preview only reads, so a mail scanner following the link
 * claims nothing. A creator or campaign offer puts its creator and campaign into the visit.
 */
export default async function ClaimPage({ params, searchParams }: { params: Promise<{ host: string; code: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { host, code: raw } = await params;
  const sp = await searchParams;
  const code = decodeURIComponent(raw);
  const scope = await loadScope(host);
  const { view, offer } = await siteCall(host, async (ctx) => {
    const v = await offers.previewCode(ctx, { code });
    return { view: v, offer: await optional(offers.getPublicOffer(ctx, v.offerId)) };
  });
  if (offer?.creatorId && sp.creator !== offer.creatorId) {
    const q = new URLSearchParams({ ...(sp as Record<string, string>), creator: offer.creatorId, ...(offer.campaignId ? { campaign: offer.campaignId } : {}), code: view.code });
    redirect(`/claim/${encodeURIComponent(view.code)}?${q}`);
  }
  const tz = scope.venue?.timezone ?? scope.view.venues[0]?.timezone ?? 'Australia/Sydney';
  const usable = view.status === 'issued' || view.status === 'claimed';
  const orderable = scope.venue ? scope.view.enabledModules.includes('ordering') : scope.view.venues.length > 0;
  return (
    <div className="mx-auto max-w-lg space-y-6 px-4 py-14 sm:px-6">
      <div className="space-y-3">
        <p className="text-sm tracking-[0.15em] uppercase">{scope.view.org.name}</p>
        <h1 className="s-heading">{view.offerName}</h1>
        <p className="text-xl">{view.summary}.</p>
        <p className="s-tabular text-2xl font-semibold tracking-widest">{view.code}</p>
        <p data-code-status={view.status}>
          <strong>{STATUS[view.status] ?? view.status}.</strong> {usable ? `Use it by ${dateTimeIn(view.expiresAt, tz)}.` : ''}
        </p>
      </div>
      {view.status === 'issued' ? <ClaimForm action={claim.bind(null, host, view.code)} orderHref={orderable ? '/order' : null} /> : null}
      {view.status === 'claimed' && orderable ? (
        <a href={`/order?code=${encodeURIComponent(view.code)}`} className="s-btn">
          Use it on an order
        </a>
      ) : null}
      {usable ? <p className="text-sm">At the counter, show this code before you pay.</p> : null}
    </div>
  );
}
