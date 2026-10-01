import { campaigns, offers } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { CampaignForm } from '@/components/console/campaign-form';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { Card } from '@/ui';
import { audienceAction, saveCampaignAction, suggestCopyAction } from '../actions';
import { CampaignsFrame } from '../shared';

export const metadata = { title: 'New campaign · Pipedline' };

export default async function NewCampaignPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="New campaign">A manager drafts campaigns and sends them for approval.</NotForYourRole>;
  return (
    <CampaignsFrame c={c} current="/console/campaigns" title="New campaign" description={`A draft for ${c.venue.name}. Nothing is sent from a draft.`}>
      <Form venueName={c.venue.name} />
    </CampaignsFrame>
  );
}

async function Form({ venueName }: { venueName: string }) {
  const offersOn = await moduleOn('offers');
  const [segments, offerList] = await Promise.all([read((ctx) => campaigns.listSegments(ctx)), offersOn ? read((ctx) => offers.listOffers(ctx)) : Promise.resolve(null)]);
  if (!segments.ok) return <ReadError message={segments.error} />;
  return (
    <Card>
      <CampaignForm
        save={saveCampaignAction}
        audience={audienceAction}
        suggest={suggestCopyAction}
        venueName={venueName}
        segments={segments.data.map((s) => ({ id: s.id, name: s.name, description: s.description }))}
        offers={offerList?.ok ? offerList.data.map((o) => ({ id: o.id, label: `${o.name} (${o.summary})` })) : []}
      />
    </Card>
  );
}
