import { analytics } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { ActionForm, Card, Field, Input, PageHeader, SubmitButton } from '@/ui';
import { AnalyticsTabs } from '@/components/console/analytics/tabs';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { saveAnalyticsSettingsAction } from '../actions';

export const metadata = { title: 'Analytics settings · Pipedline' };

/** The organisation's analytics settings: dayparts, segment thresholds, the privacy floor and digest sensitivity. */
export default async function AnalyticsSettingsPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Analytics settings" />;
  const s = await read((ctx) => analytics.getAnalyticsSettings(ctx));
  if (!s.ok) return <ReadError message={s.error} />;
  const v = s.data;
  const rows = [...v.dayparts, ...Array.from({ length: Math.max(0, 6 - v.dayparts.length) }, () => ({ key: '', fromHour: 0, toHour: 0 }))];
  return (
    <div className="space-y-6">
      <PageHeader title="Analytics settings" description="These apply to the whole organisation. They change how numbers are grouped and when a change is called out; they never change the ledger." />
      <AnalyticsTabs current="/console/analytics/settings" manager />
      <ActionForm action={saveAnalyticsSettingsAction} className="space-y-6">
        <Card title="Dayparts" description="Venue-local hours. The end hour is not included; an end at or before the start runs past midnight. Leave a name blank to remove a row.">
          <div className="space-y-2">
            {rows.map((p, i) => (
              <div key={i} className="grid grid-cols-3 gap-3 sm:max-w-xl">
                <Field label={i === 0 ? 'Name' : ' '}>
                  <Input name={`daypart_${i}_key`} defaultValue={p.key} pattern="[a-z][a-z0-9_]{1,30}" aria-label={`Daypart ${i + 1} name`} />
                </Field>
                <Field label={i === 0 ? 'From hour' : ' '}>
                  <Input name={`daypart_${i}_from`} type="number" min={0} max={23} defaultValue={p.key ? p.fromHour : ''} aria-label={`Daypart ${i + 1} from hour`} />
                </Field>
                <Field label={i === 0 ? 'To hour' : ' '}>
                  <Input name={`daypart_${i}_to`} type="number" min={0} max={24} defaultValue={p.key ? p.toHour : ''} aria-label={`Daypart ${i + 1} to hour`} />
                </Field>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Customer segments">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="A one-order guest is “new” for (days)">
              <Input name="newWindowDays" type="number" min={1} max={365} defaultValue={v.segments.newWindowDays} required />
            </Field>
            <Field label="A repeat guest is “at risk” after (days away)">
              <Input name="atRiskDays" type="number" min={1} max={730} defaultValue={v.segments.atRiskDays} required />
            </Field>
            <Field label="… and “lapsed” after (days away)">
              <Input name="lapsedDays" type="number" min={2} max={1095} defaultValue={v.segments.lapsedDays} required />
            </Field>
            <Field label="“Frequent” from (orders)">
              <Input name="frequentOrders" type="number" min={3} max={100} defaultValue={v.segments.frequentOrders} required />
            </Field>
            <Field label="“Loyal” from (orders)">
              <Input name="loyalOrders" type="number" min={4} max={500} defaultValue={v.segments.loyalOrders} required />
            </Field>
          </div>
        </Card>
        <Card title="Campaigns and creators" description="The platform floor is 5 guests and 7 days. You can raise them, never lower them.">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Smallest group a result may describe (guests)">
              <Input name="minCohort" type="number" min={5} max={1000} defaultValue={v.minCohort} required />
            </Field>
            <Field label="Days before a campaign's first result">
              <Input name="campaignQuietDays" type="number" min={7} max={90} defaultValue={v.campaignQuietDays} required />
            </Field>
          </div>
        </Card>
        <Card title="Digest sensitivity" description="A change is called out only when it is outside normal variation and large enough to matter.">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Earlier periods in the baseline" hint="4 to 26">
              <Input name="baselinePeriods" type="number" min={4} max={26} defaultValue={v.digest.baselinePeriods} required />
            </Field>
            <Field label="“Outside normal” beyond (standard deviations)">
              <Input name="notableSd" type="number" step="0.1" min={1} max={5} defaultValue={v.digest.notableSd} required />
            </Field>
            <Field label="“Well outside” beyond (standard deviations)">
              <Input name="strongSd" type="number" step="0.1" min={1.5} max={8} defaultValue={v.digest.strongSd} required />
            </Field>
            <Field label="Smallest change worth mentioning (%)">
              <Input name="minChangePct" type="number" step="1" min={0} max={100} defaultValue={Math.round(v.digest.minChangeRatio * 100)} required />
            </Field>
            <Field label="Top movers listed per split">
              <Input name="topMovers" type="number" min={1} max={10} defaultValue={v.digest.topMovers} required />
            </Field>
          </div>
        </Card>
        <SubmitButton>Save settings</SubmitButton>
      </ActionForm>
    </div>
  );
}
