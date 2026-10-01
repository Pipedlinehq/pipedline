import Link from 'next/link';
import { listAuditLog } from '@ros/core';
import { comms, identity, onboarding, tenancy } from '@ros/modules';
import { getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { formSpec } from '@/lib/console-schema-form';
import { ModuleSettingsForm } from '@/components/console/settings-form';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { ActionForm, Badge, Card, EmptyState, Field, Input, PageHeader, SubmitButton, Table, Td, Th, buttonClass, dateTime } from '@/ui';
import { addIdentity, saveCommsSettings } from './actions';

export const metadata = { title: 'Privacy and records · Pipedline' };

const PURPOSE: Record<string, string> = {
  card_recognition: 'Recognising a guest by their card',
  marketing_email: 'Marketing email',
  marketing_sms: 'Marketing SMS',
  ad_platform_sharing: 'Sharing with advertising platforms',
};

const ACTOR: Record<string, string> = { staff: 'Staff', agent: 'Assistant', worker: 'Scheduled work', platform: 'Platform support', guest: 'Guest', device: 'Screen', anon: 'Visitor' };

type SP = Record<string, string | string[] | undefined>;
const one = (sp: SP, k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));

export default async function PrivacyPage({ searchParams }: { searchParams: Promise<SP> }) {
  const c = await getConsole();
  if (!c.isOwner) return <NotForYourRole title="Privacy and records">Only an owner can see the organisation&apos;s records, exports and message identities.</NotForYourRole>;
  const sp = await searchParams;
  const action = one(sp, 'action')?.trim() || undefined;
  const entityType = one(sp, 'entity')?.trim() || undefined;
  const beforeRaw = one(sp, 'before');
  const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw) : undefined;
  const tz = c.org.timezone;

  const [log, support, identities, wordings, settings] = await Promise.all([
    read((ctx) => listAuditLog(ctx, { limit: 25, action, entityType, before })),
    read((ctx) => onboarding.listSupportAccess(ctx)),
    read((ctx) => comms.listSendingIdentities(ctx)),
    read((ctx) => identity.currentWordings(ctx)),
    read((ctx) => tenancy.getOrgSettings(ctx, 'comms', comms.commsSettings, comms.defaultCommsSettings)),
  ]);
  const venueName = new Map(c.venues.map((v) => [v.id, v.name]));
  const last = log.ok ? log.data.at(-1) : undefined;
  const keep = (extra: Record<string, string>) => {
    const q = new URLSearchParams();
    if (action) q.set('action', action);
    if (entityType) q.set('entity', entityType);
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    return `?${q.toString()}`;
  };

  return (
    <>
      <PageHeader title="Privacy and records" description={`Everything that changed in ${c.org.tradingName}, who changed it, and when; our own access to your account; your data to take away; and how marketing messages are sent.`} />
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card title="Our access to your account" description="Each time our support team worked inside your account, and why.">
            {!support.ok ? (
              <ReadError message={support.error} />
            ) : support.data.length === 0 ? (
              <p className="text-sm text-ink-3">We have never accessed your account.</p>
            ) : (
              <ul className="divide-y divide-line">
                {support.data.map((s) => (
                  <li key={s.id} className="py-2 text-sm">
                    <p>
                      <span className="font-medium">{s.by}</span> · {dateTime(s.startedAt, tz)} to {s.endedAt ? dateTime(s.endedAt, tz) : <Badge tone="warn">still open</Badge>}
                    </p>
                    <p className="text-ink-2">{s.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Take your data" description="Everything held for the organisation as one file: venues, team, guests and their consents, sales, and what each feature stores. Card details are never included.">
            <form method="post" action="/console/settings/privacy/export">
              <button type="submit" className={buttonClass('primary', 'md')} data-testid="export-org">
                Download everything (JSON)
              </button>
            </form>
            <p className="mt-2 text-xs text-ink-3">The export is recorded under Records, below.</p>
          </Card>
        </div>

        <Card title="Consent wordings in force" description="The exact words a guest agrees to. Staff can record a guest withdrawing consent, never giving it.">
          {!wordings.ok ? (
            <ReadError message={wordings.error} />
          ) : (
            <dl className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {wordings.data.map((w) => (
                <div key={w.purpose} className="rounded-md border border-line p-3">
                  <dt className="text-sm font-medium text-ink">
                    {PURPOSE[w.purpose] ?? w.purpose} <span className="text-xs font-normal text-ink-3">version {w.version}</span>
                  </dt>
                  <dd className="mt-1 text-sm text-ink-2">{w.body}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card title="How marketing messages are sent" description="Limits and the sender details every marketing message carries.">
            {settings.ok ? <ModuleSettingsForm moduleKey="comms" fields={formSpec(comms.commsSettings, settings.data)} action={saveCommsSettings} /> : <ReadError message={settings.error} />}
          </Card>
          <Card title="Sending identities" description="Your own domain or SMS sender for marketing. Order and sign-in messages always come from the platform.">
            {!identities.ok ? (
              <ReadError message={identities.error} />
            ) : identities.data.length === 0 ? (
              <p className="mb-4 text-sm text-ink-3">None yet: marketing is sent from the platform&apos;s address.</p>
            ) : (
              <ul className="mb-4 divide-y divide-line">
                {identities.data.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span>
                      {i.channel === 'email' ? `${i.fromName ?? ''} <${i.fromEmail}>` : `SMS sender “${i.smsSenderId}”`}
                      <span className="block text-xs text-ink-3">{i.kind}</span>
                    </span>
                    <Badge tone={i.status === 'verified' ? 'good' : i.status === 'pending' ? 'warn' : 'bad'}>{i.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
            <details>
              <summary className="cursor-pointer text-sm font-medium text-accent">Add an identity</summary>
              <div className="mt-3 grid grid-cols-1 gap-4">
                <ActionForm action={addIdentity} className="space-y-3" resetOnSuccess>
                  <input type="hidden" name="channel" value="email" />
                  <p className="text-sm font-medium">Email domain</p>
                  <Field label="Domain">
                    <Input name="domain" required placeholder="mail.yourvenue.com.au" />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Address before the @">
                      <Input name="fromLocalPart" placeholder="hello" />
                    </Field>
                    <Field label="From name">
                      <Input name="fromName" required maxLength={100} />
                    </Field>
                  </div>
                  <SubmitButton size="sm" variant="secondary">
                    Add email domain
                  </SubmitButton>
                </ActionForm>
                <ActionForm action={addIdentity} className="space-y-3 border-t border-line pt-3" resetOnSuccess>
                  <input type="hidden" name="channel" value="sms" />
                  <Field label="SMS sender ID" hint="3 to 11 letters or numbers, e.g. your venue's name.">
                    <Input name="smsSenderId" required minLength={3} maxLength={15} />
                  </Field>
                  <SubmitButton size="sm" variant="secondary">
                    Add SMS sender
                  </SubmitButton>
                </ActionForm>
              </div>
            </details>
          </Card>
        </div>
        <Card title="Records" description="Every change someone could dispute, newest first. The log cannot be edited, by you or by us." padded={false}>
          <form method="get" className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
              Action
              <input name="action" defaultValue={action ?? ''} placeholder="e.g. order.refunded" className="h-9 w-52 rounded-md border border-line-strong bg-surface px-2 text-sm" />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
              About
              <input name="entity" defaultValue={entityType ?? ''} placeholder="e.g. order" className="h-9 w-40 rounded-md border border-line-strong bg-surface px-2 text-sm" />
            </label>
            <button type="submit" className={buttonClass('secondary', 'sm')}>
              Filter
            </button>
            {action || entityType || before ? (
              <Link href="/console/settings/privacy" className="text-sm text-accent hover:underline">
                Clear
              </Link>
            ) : null}
          </form>
          {!log.ok ? (
            <div className="p-5">
              <ReadError message={log.error} />
            </div>
          ) : log.data.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No records match">Try a different filter.</EmptyState>
            </div>
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Who</Th>
                    <Th>What</Th>
                    <Th>Where</Th>
                    <Th>Detail</Th>
                  </tr>
                </thead>
                <tbody>
                  {log.data.map((e) => (
                    <tr key={e.id} data-testid="audit-row">
                      <Td className="whitespace-nowrap">{dateTime(e.occurredAt, tz)}</Td>
                      <Td>
                        {e.actorName ?? ACTOR[e.actorKind] ?? e.actorKind}
                      </Td>
                      <Td>
                        <span className="font-mono text-xs">{e.action}</span>
                        <span className="block text-xs text-ink-3">
                          {e.entityType}
                          {e.entityId ? ` ${e.entityId.slice(0, 8)}` : ''}
                        </span>
                      </Td>
                      <Td>{e.venueId ? (venueName.get(e.venueId) ?? 'A venue') : 'Organisation'}</Td>
                      <Td>
                        {e.before !== null || e.after !== null ? (
                          <details>
                            <summary className="cursor-pointer text-xs text-accent">Show</summary>
                            <pre className="mt-1 max-h-48 max-w-md overflow-auto whitespace-pre-wrap break-words rounded bg-sunken p-2 text-xs text-ink-2">
                              {e.before !== null ? `Before: ${JSON.stringify(e.before, null, 1)}\n` : ''}
                              {e.after !== null ? `After: ${JSON.stringify(e.after, null, 1)}` : ''}
                            </pre>
                          </details>
                        ) : (
                          <span className="text-xs text-ink-3">–</span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <div className="flex gap-4 px-5 py-3 text-sm">
                {before ? (
                  <Link href={keep({})} className="text-accent hover:underline">
                    Newest
                  </Link>
                ) : null}
                {last && log.data.length === 25 ? (
                  <Link href={keep({ before: last.occurredAt.toISOString() })} className="text-accent hover:underline">
                    Older
                  </Link>
                ) : null}
              </div>
            </>
          )}
        </Card>

      </div>
    </>
  );
}
