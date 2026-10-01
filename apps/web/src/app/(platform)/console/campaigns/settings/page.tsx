import { campaigns } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { ActionForm, Card, Field, Input, SubmitButton } from '@/ui';
import { saveCampaignsSettingsAction } from '../actions';
import { CampaignsFrame } from '../shared';

export const metadata = { title: 'Settings · Campaigns · Restaurant OS' };

export default async function CampaignsSettingsPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Campaign settings">A manager sets how campaigns are paced.</NotForYourRole>;
  return (
    <CampaignsFrame c={c} current="/console/campaigns/settings" title="Campaign settings" description="How one-off campaigns are paced and how long a request waits. These apply to the whole organisation.">
      <Form />
    </CampaignsFrame>
  );
}

async function Form() {
  const s = await read((ctx) => campaigns.getCampaignsSettings(ctx));
  if (!s.ok) return <ReadError message={s.error} />;
  return (
    <Card>
      <ActionForm action={saveCampaignsSettingsAction} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Messages per wave (at most)" hint="A list that has not been written to for a while warms up in waves, never one blast.">
            <Input name="campaignWaveSize" type="number" min={10} max={20000} defaultValue={s.data.campaignWaveSize} required />
          </Field>
          <Field label="Minutes between waves">
            <Input name="waveIntervalMinutes" type="number" min={5} max={1440} defaultValue={s.data.waveIntervalMinutes} required />
          </Field>
          <Field label="Hours a request waits for approval" hint="After this it lapses and nothing is sent; the campaign returns to draft.">
            <Input name="approvalTtlHours" type="number" min={1} max={336} defaultValue={s.data.approvalTtlHours} required />
          </Field>
          <Field label="Days an order counts as following a message" hint="An order within this many days of a message is recorded as aligned with it.">
            <Input name="attributionWindowDays" type="number" min={1} max={30} defaultValue={s.data.attributionWindowDays} required />
          </Field>
        </div>
        <SubmitButton>Save settings</SubmitButton>
      </ActionForm>
    </Card>
  );
}
