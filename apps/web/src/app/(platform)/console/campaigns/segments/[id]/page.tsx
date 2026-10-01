import { campaigns } from '@ros/modules';
import { atLeast, getConsole, type ConsoleContext } from '@/lib/console';
import { read } from '@/lib/console-read';
import { ConfirmAction } from '@/components/console/confirm';
import { NotHere } from '@/components/console/not-here';
import { SegmentForm } from '@/components/console/segment-form';
import { type Rule, ruleWords, toRows } from '@/components/console/segment-words';
import { ReadError } from '@/components/console/states';
import { Badge, Card, FormMessage, LinkButton, StatTile, percent } from '@/ui';
import { deleteSegmentAction, previewRuleAction, saveSegmentAction } from '../../actions';
import { CampaignsFrame } from '../../shared';

export const metadata = { title: 'Segment · Campaigns · Restaurant OS' };

export default async function SegmentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const { id } = await params;
  const { created } = await searchParams;
  const c = await getConsole();
  return (
    <CampaignsFrame c={c} current="/console/campaigns/segments" title="Segment" actions={<LinkButton href="/console/campaigns/segments">All segments</LinkButton>}>
      <Detail id={id} c={c} created={!!created} />
    </CampaignsFrame>
  );
}

async function Detail({ id, c, created }: { id: string; c: ConsoleContext; created: boolean }) {
  const manager = atLeast(c.role, 'manager');
  const r = await read((ctx) => campaigns.getSegment(ctx, id));
  if (!r.ok) return r.code === 'not_found' || r.code === 'module_disabled' ? <NotHere back="/console/campaigns/segments" label="Back to segments" /> : <ReadError message={r.error} />;
  const s = r.data;
  const count = manager ? await read((ctx) => campaigns.previewSegment(ctx, { segmentId: s.id, venueId: c.venue.id })) : null;
  const venueName = (v: string) => c.venues.find((x) => x.id === v)?.name ?? 'another venue';
  const rows = toRows(s.definition as Rule);
  const venues = c.venues.map((v) => ({ id: v.id, name: v.name }));

  return (
    <div className="space-y-6">
      {created ? <FormMessage tone="success">Segment created.</FormMessage> : null}
      <Card
        title={s.name}
        description={s.description ?? undefined}
        actions={
          <>
            {s.isSystem ? <Badge>Built in</Badge> : null}
            {manager && !s.isSystem ? (
              <ConfirmAction trigger="Delete" title={`Delete “${s.name}”?`} action={deleteSegmentAction} hidden={{ id: s.id }} confirmLabel="Delete the segment" testId="delete-segment">
                The rule is removed for everyone at the organisation. No guest record is changed and no message is affected. A segment that a campaign has used is kept for the record and cannot be deleted.
              </ConfirmAction>
            ) : null}
          </>
        }
      >
        <p className="text-sm text-ink">Rule: {ruleWords(s.definition as Rule, venueName)}.</p>
        {count ? (
          count.ok ? (
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="segment-preview">
              <StatTile label={`At ${c.venue.name}`} value={count.data.count.toLocaleString('en-AU')} hint="Guests whose home venue this is" />
              <StatTile label="Can be emailed" value={count.data.email.reachable.toLocaleString('en-AU')} hint={`${percent(count.data.email.share)} of them`} />
              <StatTile label="Can be sent an SMS" value={count.data.sms.reachable.toLocaleString('en-AU')} hint={`${percent(count.data.sms.share)} of them`} />
            </div>
          ) : (
            <div className="mt-4">
              <ReadError message={count.error} />
            </div>
          )
        ) : null}
        <p className="mt-3 text-xs text-ink-3">Counts only. Order history comes from sales tied to a known guest; guests the venue cannot identify are in no segment.</p>
      </Card>

      {manager ? (
        s.isSystem ? (
          <Card title="Save a copy to change it" description="A built-in segment cannot be changed. Start from its rule and save it under a new name.">
            {rows ? (
              <SegmentForm save={saveSegmentAction} preview={previewRuleAction} venues={venues} initial={{ name: `${s.name} (copy)`, description: s.description, join: rows.join, rows: rows.rows }} />
            ) : (
              <p className="text-sm text-ink-2">This rule nests conditions more deeply than the form here can edit. It can still be used in a campaign as it is.</p>
            )}
          </Card>
        ) : (
          <Card title="Change the rule">
            {rows ? (
              <SegmentForm save={saveSegmentAction} preview={previewRuleAction} venues={venues} initial={{ id: s.id, name: s.name, description: s.description, join: rows.join, rows: rows.rows }} />
            ) : (
              <p className="text-sm text-ink-2">This rule nests conditions more deeply than the form here can edit (it was probably made by an assistant). It still works; to change it, make a new segment.</p>
            )}
          </Card>
        )
      ) : null}
    </div>
  );
}
