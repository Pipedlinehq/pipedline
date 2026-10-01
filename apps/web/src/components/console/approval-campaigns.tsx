import Link from 'next/link';
import { Card } from '@/ui';
import { Facts } from './states';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const channelWord = (v: unknown) => (v === 'sms' ? 'SMS' : 'Email');
const FLOW_NAMES: Record<string, string> = { welcome: 'Welcome', post_purchase: 'Post-purchase', winback: 'Win-back', vip: 'VIP', birthday: 'Birthday' };

/** The words that would be sent, as text. They may have been drafted by an assistant. */
function Message({ subject, body }: { subject: string | null; body: string | null }) {
  return (
    <div className="rounded-md bg-sunken px-3 py-2 text-sm">
      {subject ? (
        <p>
          <span className="text-ink-3">Subject: </span>
          <span className="font-medium text-ink">{subject}</span>
        </p>
      ) : null}
      <p className="mt-1 whitespace-pre-wrap break-words text-ink">{body ?? '–'}</p>
    </div>
  );
}

/**
 * A campaign send or a flow batch waiting for approval, in words: what will be sent, to how
 * many, on which channel. Returns null for any other kind of approval.
 */
export function CampaignApprovalDetails({ approval }: { approval: { kind: string; payload: unknown; subjectId: string } }) {
  const p = (approval.payload ?? {}) as Record<string, unknown>;
  if (approval.kind === 'campaigns.campaign_send') {
    const campaignId = str(p.campaignId) ?? approval.subjectId;
    return (
      <Card title="The campaign" description="Read the message as a guest will. {{first_name}} is filled in for each guest." actions={<Link href={`/console/campaigns/${campaignId}`} className="text-sm text-accent hover:underline">Open the campaign</Link>}>
        <div className="space-y-4" data-testid="approval-campaign">
          <Facts
            items={[
              ['Channel', channelWord(p.channel)],
              ['To', str(p.segment) ?? '–'],
              ['Guests who will be sent it', num(p.audienceCount)?.toLocaleString('en-AU') ?? '–'],
              ['Offer', str(p.offer) ?? 'None'],
            ]}
          />
          <Message subject={str(p.subject)} body={str(p.body)} />
          <p className="text-xs text-ink-3">The audience is counted again when the first wave goes; anyone who has opted out by then is skipped.</p>
        </div>
      </Card>
    );
  }
  if (approval.kind === 'campaigns.flow_batch') {
    const sample = Array.isArray(p.sample) ? (p.sample as Array<Record<string, unknown>>) : [];
    return (
      <Card title="The batch" description="A flow prepared these messages and is waiting for a yes." actions={<Link href="/console/campaigns/flows" className="text-sm text-accent hover:underline">Open flows</Link>}>
        <div className="space-y-4" data-testid="approval-flow-batch">
          <Facts
            items={[
              ['Flow', FLOW_NAMES[String(p.flowKey)] ?? str(p.flowKey) ?? '–'],
              ['Channel', channelWord(p.channel)],
              ['Guests in this batch', num(p.count)?.toLocaleString('en-AU') ?? '–'],
              ['With an offer code', p.withOffer ? 'Yes, each guest gets their own' : 'No'],
              ['Template version', str(p.templateVersion) ?? '–'],
            ]}
          />
          {sample.length ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-ink">What the first {sample.length === 1 ? 'guest' : `${sample.length} guests`} would receive (first names only)</p>
              {sample.map((s, i) => (
                <div key={i}>
                  <p className="mb-1 text-xs text-ink-3">To {str(s.firstName) ?? 'a guest'}</p>
                  <Message subject={str(s.subject)} body={str(s.body)} />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </Card>
    );
  }
  return null;
}
