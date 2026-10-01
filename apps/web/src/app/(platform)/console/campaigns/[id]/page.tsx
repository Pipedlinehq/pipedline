import Link from 'next/link';
import { campaigns, offers } from '@ros/modules';
import { atLeast, getConsole, type ConsoleContext } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { CampaignForm } from '@/components/console/campaign-form';
import { ConfirmAction } from '@/components/console/confirm';
import { NotHere } from '@/components/console/not-here';
import { Facts, ReadError } from '@/components/console/states';
import { Card, FormMessage, LinkButton, StatTile, dateTime, money, percent } from '@/ui';
import { audienceAction, cancelCampaignAction, saveCampaignAction, submitCampaignAction, suggestCopyAction } from '../actions';
import { CampaignStatusBadge, CampaignsFrame, channelWord, guests } from '../shared';

export const metadata = { title: 'Campaign · Restaurant OS' };

export default async function CampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const { id } = await params;
  const { created } = await searchParams;
  const c = await getConsole();
  return (
    <CampaignsFrame c={c} current="/console/campaigns" title="Campaign" actions={<LinkButton href="/console/campaigns">All campaigns</LinkButton>}>
      <Detail id={id} c={c} created={!!created} />
    </CampaignsFrame>
  );
}

async function Detail({ id, c, created }: { id: string; c: ConsoleContext; created: boolean }) {
  const r = await read((ctx) => campaigns.getCampaign(ctx, id));
  if (!r.ok) return r.code === 'not_found' || r.code === 'module_disabled' ? <NotHere back="/console/campaigns" label="Back to campaigns" /> : <ReadError message={r.error} />;
  const x = r.data;
  const tz = c.venue.timezone;
  const venue = c.venues.find((v) => v.id === x.venueId);
  // Changes are made with the campaign's own venue selected, so the counts shown and the venue acted on agree.
  const here = x.venueId === c.venue.id;
  const manager = here && atLeast(c.session.principal.venueRoles[x.venueId] ?? 'read_only', 'manager');
  const draft = x.status === 'draft';
  const live = x.status !== 'draft' && x.status !== 'cancelled' && x.status !== 'pending_approval';
  const offersOn = await moduleOn('offers');

  const [audience, results, segments, offerList, settings] = await Promise.all([
    manager && x.segmentId && (draft || x.status === 'pending_approval') ? read((ctx) => campaigns.previewSegment(ctx, { segmentId: x.segmentId!, venueId: x.venueId })) : Promise.resolve(null),
    live ? read((ctx) => campaigns.getCampaignResults(ctx, { campaignId: x.id })) : Promise.resolve(null),
    manager && draft ? read((ctx) => campaigns.listSegments(ctx)) : Promise.resolve(null),
    offersOn ? read((ctx) => offers.listOffers(ctx, { includeInactive: true })) : Promise.resolve(null),
    manager && draft ? read((ctx) => campaigns.getCampaignsSettings(ctx)) : Promise.resolve(null),
  ]);
  const offer = x.offerId && offerList?.ok ? offerList.data.find((o) => o.id === x.offerId) : null;
  const reach = audience?.ok ? (x.channel === 'email' ? audience.data.email : audience.data.sms) : null;
  const waves = reach && settings?.ok ? Math.ceil(reach.reachable / settings.data.campaignWaveSize) : null;

  return (
    <div className="space-y-6">
      {created ? <FormMessage tone="success">Draft created. Nothing has been sent.</FormMessage> : null}
      {!here ? <FormMessage tone="info">This campaign belongs to {venue?.name ?? 'another venue'}. Select that venue to change or send it.</FormMessage> : null}
      <Card
        title={x.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <CampaignStatusBadge status={x.status} />
            <span>
              By {channelWord(x.channel)} from {venue?.name ?? 'another venue'}
            </span>
          </span>
        }
        actions={
          manager && x.status !== 'sent' && x.status !== 'cancelled' ? (
            <ConfirmAction trigger={draft ? 'Discard' : 'Stop'} title={draft ? 'Discard this draft?' : 'Stop this campaign?'} action={cancelCampaignAction} hidden={{ campaignId: x.id }} confirmLabel={draft ? 'Discard the draft' : 'Stop the campaign'} testId="cancel-campaign">
              {x.status === 'draft'
                ? 'The draft is marked cancelled and kept for the record. Nothing was sent, and nothing will be.'
                : x.status === 'pending_approval'
                  ? 'The campaign is cancelled. The request waiting in Approvals can no longer send anything, even if someone approves it.'
                  : 'No more messages will be queued. Messages already queued or sent in earlier waves are not taken back.'}
            </ConfirmAction>
          ) : undefined
        }
      >
        <Facts
          items={[
            ['To', x.segmentName ?? '–'],
            ['Guests who can receive it', x.audienceCount === null ? '–' : `${guests(x.audienceCount)} (counted ${draft ? 'when the draft was last saved' : 'when it was submitted or sent'})`],
            ['Offer', offer ? `${offer.name} (${offer.summary})` : x.offerId ? 'An offer' : 'None'],
            ['Drafted by', x.createdByKind === 'agent' ? 'An assistant' : 'Staff'],
            ['Created', dateTime(x.createdAt, tz)],
            ['Sent', x.sentAt ? dateTime(x.sentAt, tz) : '–'],
          ]}
        />
        {x.status === 'pending_approval' ? (
          <p className="mt-4 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
            Waiting for a manager in{' '}
            <Link href="/console/approvals" className="underline">
              Approvals
            </Link>
            . Nothing goes to guests until it is approved; if it is rejected or lapses, it comes back here as a draft.
          </p>
        ) : null}
      </Card>

      {audience ? (
        <Card title="Audience now" description="Counted afresh. The same count is taken again when the first wave goes.">
          {audience.ok ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="audience-now">
              <StatTile label="In the segment at this venue" value={audience.data.count.toLocaleString('en-AU')} hint="Guests whose home venue this is" />
              <StatTile label="Can be emailed" value={audience.data.email.reachable.toLocaleString('en-AU')} hint={`${percent(audience.data.email.share)} have agreed and are not suppressed`} />
              <StatTile label="Can be sent an SMS" value={audience.data.sms.reachable.toLocaleString('en-AU')} hint={`${percent(audience.data.sms.share)} have agreed and are not suppressed`} />
            </div>
          ) : (
            <ReadError message={audience.error} />
          )}
        </Card>
      ) : null}

      {manager && draft ? (
        <>
          <Card title="Edit the draft">
            {segments?.ok ? (
              <CampaignForm
                save={saveCampaignAction}
                audience={audienceAction}
                suggest={suggestCopyAction}
                venueName={venue?.name ?? c.venue.name}
                segments={segments.data.map((s) => ({ id: s.id, name: s.name, description: s.description }))}
                offers={offerList?.ok ? offerList.data.filter((o) => o.isActive || o.id === x.offerId).map((o) => ({ id: o.id, label: `${o.name} (${o.summary})` })) : []}
                initial={{ id: x.id, name: x.name, channel: x.channel, segmentId: x.segmentId, subject: x.subject, body: x.body, offerId: x.offerId }}
              />
            ) : (
              <ReadError message={segments?.error ?? 'The segments could not be read.'} />
            )}
          </Card>
          <Card title="Send for approval" description="A manager reads exactly what will go and to how many, then approves or rejects it.">
            {reach && reach.reachable > 0 ? (
              <ConfirmAction trigger="Send for approval" triggerVariant="primary" triggerSize="md" title="Send this campaign for approval?" action={submitCampaignAction} hidden={{ campaignId: x.id }} confirmLabel="Send for approval" pendingLabel="Sending for approval…" variant="primary" testId="submit-campaign">
                <p>
                  If it is approved, <strong className="text-ink">{guests(reach.reachable)}</strong> in “{x.segmentName}” will be sent this {channelWord(x.channel)} from {venue?.name}
                  {offer ? `, each with their own code (${offer.summary})` : ''}
                  {waves && waves > 1 && settings?.ok ? `, in ${waves} waves of up to ${settings.data.campaignWaveSize}, ${settings.data.waveIntervalMinutes} minutes apart` : ''}.
                </p>
                <p className="mt-2">
                  Nothing goes until a manager approves it in Approvals. The audience is counted again at that moment, and anyone who opts out before their message goes is skipped. Once submitted, the draft is locked.
                </p>
              </ConfirmAction>
            ) : (
              <p className="text-sm text-ink-2">
                {reach
                  ? `Nobody in “${x.segmentName}” at this venue has agreed to hear from you by ${channelWord(x.channel)} yet, so there is nobody to send to. That is a consent gap, not an empty segment.`
                  : 'Choose a segment and save the draft first.'}
              </p>
            )}
          </Card>
        </>
      ) : (
        <Card title="The message" description="Exactly what goes, before each guest's first name is filled in.">
          {x.subject ? (
            <p className="text-sm">
              <span className="text-ink-3">Subject: </span>
              <span className="font-medium text-ink">{x.subject}</span>
            </p>
          ) : null}
          <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-sunken px-3 py-2 text-sm text-ink">{x.body}</p>
        </Card>
      )}

      {results ? (
        <Card title="Results" description="Totals only. No guest is listed.">
          {results.ok ? (
            <div className="space-y-4" data-testid="campaign-results">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatTile label="Queued" value={String(results.data.messages.queued)} hint={`${results.data.messages.suppressed} skipped: opted out or suppressed`} />
                <StatTile label="Sent" value={String(results.data.messages.sent)} hint={`${results.data.messages.bounced} bounced`} />
                <StatTile label="Delivered" value={String(results.data.messages.delivered)} hint={results.data.messages.sent ? `${percent(results.data.messages.delivered / results.data.messages.sent)} of sent` : undefined} />
                <StatTile label="Opened" value={String(results.data.messages.opened)} hint={results.data.messages.delivered ? `${percent(results.data.messages.opened / results.data.messages.delivered)} of delivered` : undefined} />
                <StatTile label="Clicked" value={String(results.data.messages.clicked)} hint={results.data.messages.delivered ? `${percent(results.data.messages.clicked / results.data.messages.delivered)} of delivered` : undefined} />
                <StatTile label="Unsubscribed" value={String(results.data.messages.unsubscribed)} hint="They will not be written to again" />
                <StatTile label="Codes issued" value={String(results.data.codes.issued)} hint={`${results.data.codes.redeemed} used`} />
                <StatTile label="Orders aligned with it" value={String(results.data.attributed.orders)} hint={`${guests(results.data.attributed.guests)}, ${money(results.data.attributed.revenueCents)} after refunds`} />
              </div>
              <ul className="list-disc space-y-1 rounded-md bg-sunken px-3 py-2 pl-7 text-xs text-ink-2">
                <li>Orders are aligned with the campaign, not proof it caused them: they are sales whose last touch was this campaign, or that used a code it issued.</li>
                <li>Opens are counted for email only, and mail apps that load images by themselves inflate them.</li>
                <li>Counts rise while waves are still going and for a few days after.</li>
              </ul>
            </div>
          ) : (
            <ReadError message={results.error} />
          )}
        </Card>
      ) : null}
    </div>
  );
}
