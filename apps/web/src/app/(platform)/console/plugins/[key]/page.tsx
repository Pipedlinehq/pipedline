import Link from 'next/link';
import { notFound } from 'next/navigation';
import { hub } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { formSpecFromJson, type JS } from '@/lib/console-schema-form';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { ModuleSettingsForm } from '@/components/console/settings-form';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { Badge, Card, EmptyState, LinkButton, PageHeader, Table, Td, Th, dateTime } from '@/ui';
import { savePluginOptions, setPluginEnabled } from '../actions';
import { disconnectFromDetail } from './actions';

const STATUS: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  connected: { label: 'Connected', tone: 'good' },
  pending: { label: 'Waiting', tone: 'warn' },
  unhealthy: { label: 'Needs attention', tone: 'bad' },
  revoked: { label: 'Disconnected', tone: 'neutral' },
};
const OUTCOME_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral' | 'accent'> = { answered: 'good', confirmed: 'good', asked: 'accent', declined: 'neutral', refused: 'warn', invalid: 'warn', rate_limited: 'warn', failed: 'bad', unsure: 'bad' };

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return { title: `${key} · Plugins · Pipedline` };
}

/**
 * A plugin's page (docs/CONSOLE_IA.md section 9, pattern 14): what it reads and writes, the tools
 * it adds and when each was last used, its connection and health, a note when a connected service
 * has done nothing for 30 days, Configure (the generated form), and for a service somebody else
 * runs, what leaves the venue in plain words, with Connect, Disconnect and Revoke.
 */
export default async function PluginDetailPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Plugin" />;
  const d = await read((ctx) => hub.plugDetail(ctx, { venueId: c.venue.id, key }));
  if (!d.ok) {
    if (d.code === 'not_found') notFound();
    return (
      <>
        <PageHeader title="Plugin" />
        <ReadError message={d.error} />
      </>
    );
  }
  const { entry, tools, connections, lastUsedAt, idleNote, dataLeaves, offeredToAssistantsHere } = d.data;
  const isPlug = entry.kind === 'plug';
  const tz = c.venue.timezone;
  const fields = entry.config_schema ? formSpecFromJson(entry.config_schema as JS, entry.config ?? {}) : [];
  const live = connections.filter((x) => x.status !== 'revoked');
  const venueName = (id: string | null) => (id ? (c.venues.find((v) => v.id === id)?.name ?? 'Another venue') : 'Whole organisation');
  const used = (at: Date | null) => (at ? dateTime(at, tz) : 'Not yet');

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/console/plugins" className="text-accent">
            Plugins
          </Link>
        }
        title={entry.name}
        description={entry.purpose}
        actions={
          <div className="flex items-center gap-2" data-testid="plugin-detail-actions">
            {entry.kind === 'channel' ? <Badge tone="accent">Channel</Badge> : null}
            {entry.always_on ? (
              <Badge tone="good">Always on</Badge>
            ) : isPlug ? (
              <>
                <Badge tone={entry.on ? 'good' : 'neutral'}>{entry.on ? 'Connected' : 'Not connected'}</Badge>
                <LinkButton href={`/console/settings/connections#plug-${entry.key}`} size="sm" variant={entry.on ? 'secondary' : 'primary'}>
                  {entry.on ? 'Manage connection' : 'Connect'}
                </LinkButton>
              </>
            ) : (
              <>
                <Badge tone={entry.on ? 'good' : 'neutral'}>{entry.on ? 'On' : 'Off'}</Badge>
                {entry.on ? (
                  <ConfirmAction trigger="Switch off" title={`Switch off ${entry.name}?`} action={setPluginEnabled} hidden={{ module: entry.key, enabled: 'false', name: entry.name }} confirmLabel="Switch it off" testId={`plugin-off-${entry.key}`}>
                    <p>
                      {entry.name} stops at <strong>{c.venue.name}</strong> straight away, and its screens leave the console for everyone at this venue. Its data and settings are kept.
                    </p>
                  </ConfirmAction>
                ) : (
                  <InlineAction action={setPluginEnabled} hidden={{ module: entry.key, enabled: 'true', name: entry.name }} label="Switch on" pendingLabel="Switching on…" variant="primary" testId={`plugin-on-${entry.key}`} />
                )}
              </>
            )}
          </div>
        }
      />
      {idleNote ? (
        <p role="status" data-testid="plugin-idle-note" className="mb-4 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
          {idleNote}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-6">
          <Card title="What it reads and writes" description="In plain words, from the plugin's own manifest: the same words your assistant reads in plugins_list.">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2" data-testid="plugin-reads-writes">
              <div>
                <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">Reads</dt>
                <dd className="mt-0.5 text-ink-2">{entry.reads.join('; ')}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">Writes</dt>
                <dd className="mt-0.5 text-ink-2">{entry.writes.join('; ')}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">Needs</dt>
                <dd className="mt-0.5 text-ink-2">{entry.needs.join(' ') || 'Nothing.'}</dd>
              </div>
              {entry.consent ? (
                <div>
                  <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">Guests' consent</dt>
                  <dd className="mt-0.5 text-ink-2">{entry.consent}</dd>
                </div>
              ) : null}
              {entry.public_address ? (
                <div className="sm:col-span-2">
                  <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">Public address</dt>
                  <dd className="mt-0.5 break-all font-mono text-xs text-ink">{entry.public_address}</dd>
                </div>
              ) : null}
            </dl>
          </Card>
          {isPlug ? (
            <Card title="What leaves the venue" description={`What ${entry.name} is sent, and what it is never sent.`}>
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-2" data-testid="plugin-data-leaves">
                {dataLeaves.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {offeredToAssistantsHere !== null ? (
                <p className="mt-3 text-sm text-ink-2">
                  Its tools are {offeredToAssistantsHere ? '' : 'not '}offered to assistants at {c.venue.name}.{' '}
                  <Link href="/console/assistant" className="text-accent">
                    Change that under Assistant.
                  </Link>
                </p>
              ) : null}
            </Card>
          ) : null}
          <Card title={isPlug ? 'Tools used through it' : 'Tools it gives your assistant'} description={lastUsedAt ? `Last used ${dateTime(lastUsedAt, tz)}.` : 'Not used by an assistant yet.'} padded={false}>
            {tools.length === 0 ? (
              <div className="p-5">
                <EmptyState title={isPlug ? 'No calls yet' : 'No tools'}>{isPlug ? 'When an assistant uses one of its tools, the tool and the time appear here. Never what was said.' : 'This plugin adds no tools of its own.'}</EmptyState>
              </div>
            ) : (
              <Table label="Tools">
                <thead>
                  <tr>
                    <Th>Tool</Th>
                    <Th>Does</Th>
                    <Th>Last used</Th>
                    <Th align="right">Last 30 days</Th>
                  </tr>
                </thead>
                <tbody data-testid="plugin-tools">
                  {tools.map((t) => (
                    <tr key={t.name} data-testid={`plugin-tool-${t.name}`}>
                      <Td>
                        <span className="font-mono text-xs text-ink">{t.name}</span>
                        <span className="ml-2 text-xs text-ink-3">{t.effect === 'write' ? 'asks first' : 'reads'}</span>
                      </Td>
                      <Td className="max-w-md text-ink-2">{t.description.length > 140 ? `${t.description.slice(0, 140)}…` : t.description}</Td>
                      <Td>
                        <span data-testid="tool-last-used">{used(t.lastUsedAt)}</span>
                        {t.lastOutcome ? (
                          <span className="ml-2">
                            <Badge tone={OUTCOME_TONE[t.lastOutcome] ?? 'neutral'}>{t.lastOutcome}</Badge>
                          </span>
                        ) : null}
                      </Td>
                      <Td numeric>{t.calls30d}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          {fields.length ? (
            <Card title={`Configure${entry.config_scope === 'organisation' ? ' (whole organisation)' : ''}`} description="A form built from the plugin's own settings and their descriptions.">
              <ModuleSettingsForm moduleKey={entry.key} fields={fields} action={savePluginOptions} disabled={!entry.on} submitLabel="Save settings" />
              {!entry.on ? <p className="mt-2 text-xs text-ink-3">Switch it on to change these.</p> : null}
            </Card>
          ) : null}
        </div>
        <div className="space-y-6">
          {isPlug ? (
            <Card title="Connection and health" padded={false}>
              {live.length === 0 ? (
                <div className="p-5">
                  <EmptyState title="Not connected" action={<LinkButton href={`/console/settings/connections#plug-${entry.key}`} size="sm">Connect</LinkButton>}>
                    {entry.connect ?? entry.needs.join(' ')}
                  </EmptyState>
                </div>
              ) : (
                <ul className="divide-y divide-line" data-testid="plugin-connections">
                  {live.map((x) => {
                    const s = STATUS[x.status] ?? STATUS.pending!;
                    return (
                      <li key={x.id} className="space-y-2 px-5 py-4" data-testid={`plugin-connection-${x.id}`}>
                        <p className="flex flex-wrap items-center gap-2 text-sm">
                          <Badge tone={s.tone}>{s.label}</Badge>
                          <span className="text-ink-3">{venueName(x.venueId)}</span>
                        </p>
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                          <dt className="text-ink-3">Account</dt>
                          <dd className="font-mono text-ink-2">{x.account}</dd>
                          <dt className="text-ink-3">Connected</dt>
                          <dd className="text-ink-2">{used(x.connectedAt)}</dd>
                          <dt className="text-ink-3">Last worked</dt>
                          <dd className="text-ink-2">{used(x.lastOkAt)}</dd>
                          {x.expiresAt ? (
                            <>
                              <dt className="text-ink-3">Access expires</dt>
                              <dd className="text-ink-2">{dateTime(x.expiresAt, tz)}</dd>
                            </>
                          ) : null}
                          {x.scopes.length ? (
                            <>
                              <dt className="text-ink-3">Allowed to</dt>
                              <dd className="text-ink-2">{x.scopes.join(', ')}</dd>
                            </>
                          ) : null}
                        </dl>
                        {x.lastError ? <p className="text-xs text-bad">{x.lastError}</p> : null}
                        <div className="flex flex-wrap gap-2 pt-1">
                          <LinkButton href={`/console/settings/connections#plug-${entry.key}`} size="sm" variant="secondary">
                            Reconnect
                          </LinkButton>
                          <ConfirmAction trigger="Disconnect" title={`Disconnect ${entry.name}?`} action={disconnectFromDetail} hidden={{ connectionId: x.id, key: entry.key }} confirmLabel={`Disconnect ${entry.name}`} testId={`plugin-disconnect-${x.id}`}>
                            <p>Its stored access is destroyed and its tools are withdrawn from every assistant straight away. Nothing already in the venue's records is removed.</p>
                          </ConfirmAction>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          ) : null}
          <Card title="About">
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">Kind</dt>
                <dd className="mt-0.5 text-ink-2">{entry.kind === 'plug' ? 'A service somebody else runs, connected by you' : entry.kind === 'channel' ? 'A channel guests meet' : 'Part of the engine'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">Category</dt>
                <dd className="mt-0.5 text-ink-2">{entry.category}</dd>
              </div>
              {entry.docs ? (
                <div>
                  <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">How it works</dt>
                  <dd className="mt-0.5">
                    <a href={entry.docs} className="text-accent">
                      The spec on GitHub
                    </a>
                  </dd>
                </div>
              ) : null}
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}
