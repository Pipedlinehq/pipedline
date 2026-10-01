import { atLeast, getConsole } from '@/lib/console';
import { SegmentForm } from '@/components/console/segment-form';
import { NotForYourRole } from '@/components/console/states';
import { Card } from '@/ui';
import { previewRuleAction, saveSegmentAction } from '../../actions';
import { CampaignsFrame } from '../../shared';

export const metadata = { title: 'New segment · Campaigns · Pipedline' };

export default async function NewSegmentPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="New segment">A manager defines segments.</NotForYourRole>;
  return (
    <CampaignsFrame c={c} current="/console/campaigns/segments" title="New segment" description="Describe the guests by conditions. Count them before you save.">
      <Card>
        <SegmentForm save={saveSegmentAction} preview={previewRuleAction} venues={c.venues.map((v) => ({ id: v.id, name: v.name }))} />
      </Card>
    </CampaignsFrame>
  );
}
