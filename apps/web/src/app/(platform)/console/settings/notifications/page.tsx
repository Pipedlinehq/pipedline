import { comms } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleStates } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { ActionForm, Badge, Card, Checkbox, Field, Input, PageHeader, Select, SubmitButton } from '@/ui';
import { removeAlertRuleAction, saveAlertSettingsAction, sendTestAlertAction, setAlertRuleAction, toggleAlertRuleAction } from './actions';

export const metadata = { title: 'Notifications · Pipedline' };

/**
 * Alerts to the team (docs/CONSOLE_IA.md section 9, pattern 13): per event, who is told and how,
 * each rule on or off with "Send a test", and the quiet hours. Recipients are the venue's own
 * team by name or by role; a guest can never be one.
 */
export default async function NotificationsPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Notifications" />;
  const on = await moduleStates();
  const cat = await read((ctx) => comms.listAlertRules(ctx, { venueId: c.venue.id }));
  const moduleOn = (key: string | null) => key === null || (on as Record<string, boolean>)[key] !== false;

  return (
    <>
      <PageHeader
        title="Notifications"
        description={`Who at ${c.venue.name} is told when something happens, and how. Alerts go to your team by email or text, never to guests. Your assistant sees the same rules as alerts_summary and can set one after your yes.`}
      />
      {!cat.ok ? (
        <ReadError message={cat.error} />
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-4" data-testid="alert-events">
            {cat.data.events.map((e) => {
              const rules = cat.data.rules.filter((r) => r.event === e.key);
              const available = moduleOn(e.module);
              return (
                <Card key={e.key} id={`alert-${e.key.replace('.', '-')}`} title={e.label} description={`${e.description}${e.urgent ? ' Goes at once, whatever the quiet hours.' : ''}${available ? '' : ' That part of the product is switched off at this venue, so this cannot happen yet.'}`} padded={false}>
                  <div data-testid={`alert-event-${e.key}`}>
                    {rules.length ? (
                      <ul className="divide-y divide-line">
                        {rules.map((r) => (
                          <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3" data-testid={`alert-rule-${r.id}`}>
                            <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                              <Badge tone={r.channel === 'sms' ? 'accent' : 'neutral'}>{r.channel === 'sms' ? 'Text' : 'Email'}</Badge>
                              <span className="text-ink">{r.recipient.kind === 'staff' ? r.recipient.name : `Every ${comms.ROLE_WORDS[r.recipient.role].toLowerCase()} at the venue`}</span>
                              {r.recipient.kind === 'staff' && r.channel === 'sms' && !r.recipient.hasPhone ? <span className="text-xs text-warn">No phone number on the team page</span> : null}
                              <Badge tone={r.enabled ? 'good' : 'neutral'}>{r.enabled ? 'On' : 'Off'}</Badge>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <InlineAction
                                action={toggleAlertRuleAction}
                                hidden={{ event: r.event, channel: r.channel, recipientKind: r.recipient.kind, recipient: r.recipient.kind === 'staff' ? r.recipient.staffId : r.recipient.role, enabled: r.enabled ? 'false' : 'true' }}
                                label={r.enabled ? 'Switch off' : 'Switch on'}
                                testId={`alert-toggle-${r.id}`}
                              />
                              <InlineAction action={sendTestAlertAction} hidden={{ id: r.id }} label="Send a test" pendingLabel="Sending…" testId={`alert-test-${r.id}`} />
                              <ConfirmAction trigger="Remove" title="Remove this alert?" action={removeAlertRuleAction} hidden={{ id: r.id }} confirmLabel="Remove the alert" testId={`alert-remove-${r.id}`}>
                                Nobody is told about “{e.label.toLowerCase()}” this way any more. You can add it again at any time.
                              </ConfirmAction>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="px-5 py-3 text-sm text-ink-3">Nobody is told yet.</p>
                    )}
                    <ActionForm action={setAlertRuleAction} className="flex flex-wrap items-end gap-3 border-t border-line px-5 py-3" resetOnSuccess>
                      <input type="hidden" name="event" value={e.key} />
                      <Field label="Tell" className="min-w-56">
                        <Select name="recipient" defaultValue="" data-testid={`alert-recipient-${e.key}`}>
                          <option value="">Choose…</option>
                          <optgroup label="Everyone with a role">
                            {cat.data.roles.map((role) => (
                              <option key={role.role} value={`role:${role.role}`}>
                                {role.label} ({role.count})
                              </option>
                            ))}
                          </optgroup>
                          <optgroup label="One person">
                            {cat.data.people.map((p) => (
                              <option key={p.staffId} value={`staff:${p.staffId}`}>
                                {p.name} · {comms.ROLE_WORDS[p.role]}
                              </option>
                            ))}
                          </optgroup>
                        </Select>
                      </Field>
                      <Field label="By">
                        <Select name="channel" defaultValue="email" data-testid={`alert-channel-${e.key}`}>
                          <option value="email">Email</option>
                          <option value="sms">Text</option>
                        </Select>
                      </Field>
                      <SubmitButton size="sm" variant="secondary" pendingLabel="Adding…">
                        Add
                      </SubmitButton>
                    </ActionForm>
                  </div>
                </Card>
              );
            })}
          </div>
          <div className="space-y-6">
            <Card title="Quiet hours" description="Alerts that are not urgent wait until the quiet hours end, in the venue's own time. A new order and a delivery problem always go at once.">
              <ActionForm action={saveAlertSettingsAction} className="space-y-3">
                <Checkbox name="quietOn" value="1" defaultChecked={!!cat.data.settings.quietHours} label="Keep quiet overnight" data-testid="quiet-on" />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="From">
                    <Input name="quietStart" type="time" defaultValue={cat.data.settings.quietHours?.start ?? '22:00'} required />
                  </Field>
                  <Field label="Until">
                    <Input name="quietEnd" type="time" defaultValue={cat.data.settings.quietHours?.end ?? '07:00'} required />
                  </Field>
                </div>
                <Field label="Daily digest goes at" hint="The hour, venue time, the daily digest is sent to whoever is listed for it.">
                  <Select name="dailyDigestHour" defaultValue={String(cat.data.settings.dailyDigestHour)}>
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>
                        {String(h).padStart(2, '0')}:00
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="flex justify-end">
                  <SubmitButton size="sm" pendingLabel="Saving…">
                    Save
                  </SubmitButton>
                </div>
              </ActionForm>
            </Card>
            <Card title="How it works">
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-2">
                <li>An alert is a plain message to a team member: what happened and a link to where to act. It never carries what a guest wrote.</li>
                <li>A text needs the person to have a phone number on the Team page.</li>
                <li>The weekly digest goes to whoever is listed for it; with nobody listed, to the owners.</li>
                <li>Send a test to see exactly what arrives.</li>
              </ul>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
