import { campaigns, offers } from '@ros/modules';
import { atLeast, getConsole, type ConsoleContext } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { Facts, NotForYourRole, ReadError } from '@/components/console/states';
import { ActionForm, Badge, Card, Field, Input, Select, SubmitButton, Textarea, dateTime } from '@/ui';
import { pinFlowTemplateAction, runFlowNowAction, setFlowModeAction, updateFlowAction } from '../actions';
import { CampaignsFrame, modeInfo } from '../shared';

export const metadata = { title: 'Flows · Campaigns · Pipedline' };

const ABOUT: Record<campaigns.FlowKey, string> = {
  welcome: 'A hello to a guest shortly after they agree to hear from you.',
  post_purchase: 'A nudge some days after a first order, to bring a new guest back for a second.',
  winback: 'A note to a guest who used to come and has gone quiet.',
  vip: 'A thank-you when a guest reaches a number of orders.',
  birthday: 'A message shortly before a guest’s birthday.',
};
const RANK = { off: 0, shadow: 1, supervised: 2, autonomous: 3 } as const;
type Mode = keyof typeof RANK;
const TIMING: Record<campaigns.FlowKey, Array<{ name: keyof campaigns.FlowConfig; label: string; min: number; max: number }>> = {
  welcome: [{ name: 'welcomeDelayMinutes', label: 'Minutes after they agree', min: 0, max: 10080 }],
  post_purchase: [{ name: 'postPurchaseDays', label: 'Days after the first order', min: 1, max: 180 }],
  winback: [
    { name: 'winbackLapsedDays', label: 'Days away before writing', min: 14, max: 730 },
    { name: 'winbackMaxLapsedDays', label: 'Do not write after (days away)', min: 30, max: 1825 },
    { name: 'winbackCooldownDays', label: 'Days before writing again', min: 30, max: 730 },
  ],
  vip: [{ name: 'vipOrders', label: 'Orders to count as a VIP', min: 2, max: 500 }],
  birthday: [{ name: 'birthdayDaysBefore', label: 'Days before the birthday', min: 0, max: 31 }],
};

/** The five lifecycle flows: what each is set to, what it really runs at, and what it has done. */
export default async function FlowsPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Flows">A manager sets how far each flow may go.</NotForYourRole>;
  return (
    <CampaignsFrame
      c={c}
      current="/console/campaigns/flows"
      title="Flows"
      description="Messages that follow a guest’s own timeline. They apply across the organisation. A flow sends to guests only when it is supervised (each batch waits in Approvals) or autonomous."
    >
      <Flows c={c} />
    </CampaignsFrame>
  );
}

async function Flows({ c }: { c: ConsoleContext }) {
  const offersOn = await moduleOn('offers');
  const [flows, offerList] = await Promise.all([read((ctx) => campaigns.listFlows(ctx)), offersOn ? read((ctx) => offers.listOffers(ctx, { includeInactive: true })) : Promise.resolve(null)]);
  if (!flows.ok) return <ReadError message={flows.error} />;
  const tz = c.venue.timezone;
  const allOffers = offerList?.ok ? offerList.data : [];
  return (
    <div className="space-y-6">
      {flows.data.map((f) => {
        const set = modeInfo(f.mode);
        const real = modeInfo(f.effectiveMode);
        const offer = allOffers.find((o) => o.id === f.offerId);
        const modes = (Object.keys(RANK) as Mode[]).filter((m) => m !== f.mode && RANK[m] <= RANK[f.ceiling as Mode] && (RANK[m] < RANK.supervised || c.isOwner));
        return (
          <Card
            key={f.id}
            title={f.name}
            description={ABOUT[f.key]}
            actions={<InlineAction action={runFlowNowAction} hidden={{ flowKey: f.key }} label="Run now" pendingLabel="Queuing…" testId={`run-${f.key}`} />}
          >
            <div data-testid={`flow-${f.key}`} className="space-y-4">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-ink-2">Set to</span>
                <Badge tone={set.tone}>{set.label}</Badge>
                {f.effectiveMode !== f.mode ? (
                  <>
                    <span className="text-ink-2">but runs as</span>
                    <Badge tone={real.tone}>{real.label}</Badge>
                    <span className="text-xs text-ink-3">{f.offerId ? 'A flow that gives away an offer never goes past supervised.' : `This flow can go no further than ${f.ceiling}.`}</span>
                  </>
                ) : null}
              </p>
              <p className="text-sm text-ink-2">{real.meaning}</p>
              <div className="flex flex-wrap gap-2">
                {modes.map((m) => {
                  const info = modeInfo(m);
                  const up = RANK[m] >= RANK.supervised;
                  return (
                    <ConfirmAction
                      key={m}
                      trigger={`Set to ${info.label.toLowerCase()}`}
                      title={`Set ${f.name} to ${info.label.toLowerCase()}?`}
                      action={setFlowModeAction}
                      hidden={{ flowKey: f.key, mode: m }}
                      confirmLabel={`Set to ${info.label.toLowerCase()}`}
                      variant={up ? 'danger' : 'primary'}
                      testId={`mode-${f.key}-${m}`}
                    >
                      <p>{info.meaning}</p>
                      <p className="mt-2">
                        {m === 'autonomous'
                          ? `From the next run it writes to guests across every venue with campaigns on, up to ${f.config.dailyCap} messages per venue per day, without anyone approving them.`
                          : m === 'supervised'
                            ? `From the next run it prepares batches of up to ${f.config.waveSize} guests per venue and puts each one in Approvals. Guests are written to only when a manager approves a batch.`
                            : m === 'shadow'
                              ? 'Batches already waiting in Approvals can still be approved; no new ones are made.'
                              : 'Batches already waiting in Approvals can still be approved; nothing new is prepared or recorded.'}
                      </p>
                      <p className="mt-2 text-ink-3">{f.enrolments.active} guests are in this flow now; {f.enrolments.dueNow} are due a message.</p>
                    </ConfirmAction>
                  );
                })}
                {!c.isOwner && RANK[f.ceiling as Mode] >= RANK.supervised && RANK[f.mode as Mode] < RANK.supervised ? <span className="self-center text-xs text-ink-3">Only an owner can let a flow send to guests.</span> : null}
              </div>
              <Facts
                items={[
                  ['Guests in the flow', `${f.enrolments.active} active, ${f.enrolments.dueNow} due now`],
                  ['Finished', `${f.enrolments.completed} completed, ${f.enrolments.exited} left early`],
                  ['Channel', f.config.channel === 'sms' ? 'SMS' : 'Email'],
                  ['Offer', offer ? `${offer.name} (${offer.summary})` : f.offerId ? 'An offer' : 'None'],
                  ['Template', `Version ${f.templateVersion}: ${f.steps} ${f.steps === 1 ? 'message' : 'messages'}`],
                  ['Last run', f.lastRun ? `${dateTime(f.lastRun.at, tz)} as ${f.lastRun.mode}: ${f.lastRun.summary ?? f.lastRun.status}` : 'Not yet'],
                ]}
              />
              {c.isOwner ? (
                <details className="rounded-md border border-line">
                  <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-ink-2">Timing, wording, offer and version</summary>
                  <div className="space-y-5 border-t border-line p-4">
                    <ActionForm action={updateFlowAction} className="space-y-4">
                      <input type="hidden" name="flowKey" value={f.key} />
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        <Field label="Channel">
                          <Select name="channel" defaultValue={f.config.channel}>
                            <option value="email">Email</option>
                            <option value="sms">SMS</option>
                          </Select>
                        </Field>
                        {TIMING[f.key].map((t) => (
                          <Field key={t.name} label={t.label}>
                            <Input name={t.name} type="number" min={t.min} max={t.max} defaultValue={Number(f.config[t.name])} required />
                          </Field>
                        ))}
                        <Field label="Guests per venue per run (at most)">
                          <Input name="waveSize" type="number" min={1} max={5000} defaultValue={f.config.waveSize} required />
                        </Field>
                        <Field label="Messages per venue per day when autonomous">
                          <Input name="dailyCap" type="number" min={1} max={50000} defaultValue={f.config.dailyCap} required />
                        </Field>
                        <Field label="Drop a message this many days overdue">
                          <Input name="staleAfterDays" type="number" min={1} max={90} defaultValue={f.config.staleAfterDays} required />
                        </Field>
                        {offersOn ? (
                          <Field label="Offer" hint="Each guest gets their own code. With an offer the flow stays supervised.">
                            <Select name="offerId" defaultValue={f.offerId ?? ''}>
                              <option value="">No offer</option>
                              {allOffers
                                .filter((o) => o.isActive || o.id === f.offerId)
                                .map((o) => (
                                  <option key={o.id} value={o.id}>
                                    {o.name} ({o.summary})
                                  </option>
                                ))}
                            </Select>
                          </Field>
                        ) : (
                          <input type="hidden" name="offerId" value={f.offerId ?? ''} />
                        )}
                      </div>
                      <Field label="Subject, in your own words (optional)" hint="Leave blank to use the standard wording.">
                        <Input name="copySubject" maxLength={200} defaultValue={f.config.copy.subject ?? ''} />
                      </Field>
                      <Field label="First message, in your own words (optional)" hint="{{first_name}}, {{venue_name}} and {{offer_line}} are filled in for each guest.">
                        <Textarea name="copyBody" maxLength={2000} defaultValue={f.config.copy.body ?? ''} />
                      </Field>
                      <SubmitButton size="sm">Save {f.name.toLowerCase()} settings</SubmitButton>
                    </ActionForm>
                    {f.availableVersions.length > 1 ? (
                      <ActionForm action={pinFlowTemplateAction} className="flex flex-wrap items-end gap-3">
                        <input type="hidden" name="flowKey" value={f.key} />
                        <Field label="Template version" hint="Moving up or rolling back takes effect from the next run.">
                          <Select name="version" defaultValue={f.templateVersion}>
                            {f.availableVersions.map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <SubmitButton size="sm" variant="secondary">
                          Use this version
                        </SubmitButton>
                      </ActionForm>
                    ) : null}
                  </div>
                </details>
              ) : null}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
