import { getModule } from '@ros/core';
import { auth, hub } from '@ros/modules';
import { app } from '@/lib/runtime';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { formSpec } from '@/lib/console-schema-form';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { ModuleSettingsForm } from '@/components/console/settings-form';
import { CopyField, CreateKeyForm } from '@/components/console/settings-once';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { Badge, Card, EmptyState, Field, Input, LinkButton, PageHeader, Table, Td, Th, dateTime } from '@/ui';
import { saveFeatureOptions } from '../features/actions';
import { createKey, revokeKey, setKeyCanWrite } from './actions';

export const metadata = { title: 'Assistant access · Restaurant OS' };

const OUTCOME_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral' | 'accent'> = {
  answered: 'good',
  confirmed: 'good',
  asked: 'accent',
  declined: 'neutral',
  refused: 'warn',
  invalid: 'warn',
  rate_limited: 'warn',
  failed: 'bad',
  unsure: 'bad',
};

export default async function AssistantsPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Assistant access" />;
  const tz = c.venue.timezone;
  const cfg = app().config;
  const endpoint = `${cfg.scheme}://${cfg.platformHost}/api/mcp`;

  const [state, keys, calls, runs, people] = await Promise.all([
    read((ctx) => getModule(ctx, c.venue.id, hub.hubModule)),
    read((ctx) => hub.listAgentKeys(ctx)),
    read((ctx) => hub.listAgentCalls(ctx, { limit: 25 })),
    read((ctx) => hub.listAgentRuns(ctx, { venueId: c.venue.id, limit: 10 })),
    read((ctx) => auth.listStaff(ctx)),
  ]);
  const scopes = hub.describeScopes(app());
  const personName = new Map(people.ok ? people.data.map((p) => [p.id, [p.firstName, p.lastName].filter(Boolean).join(' ')]) : []);
  const venueName = new Map(c.venues.map((v) => [v.id, v.name]));
  const hubOn = state.ok && state.data.enabled;
  const config = state.ok ? state.data.config : hub.hubModule.defaultConfig;
  const maxDays = config.key_max_lifetime_days;

  return (
    <>
      <PageHeader
        title="Assistant access"
        description="Let your own assistant (Claude, ChatGPT or another that speaks MCP) read the venue's numbers and, if you allow it, propose changes. A key never does more than the person it belongs to, and every change waits for their yes."
      />

      {!hubOn ? (
        <div className="mb-6">
          <EmptyState title={`Assistant access is switched off at ${c.venue.name}`} action={<LinkButton href="/console/settings/features">Go to Features</LinkButton>}>
            Switch on “Assistant access and plugs” for this venue to create keys that can see it. Existing keys cannot reach a venue where it is off.
          </EmptyState>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="min-w-0 space-y-6">
          <Card title="Where your assistant connects" description="Add a custom connector (a remote MCP server) in your assistant with this address, then give it your key.">
            <CopyField value={endpoint} label="MCP server address" testId="mcp-endpoint" />
          </Card>

          <Card title={c.isOwner ? 'Keys' : 'Your keys'} description={c.isOwner ? 'Every key in the organisation. You can allow a key to propose changes.' : 'Keys you created. An owner can allow a key to propose changes.'} padded={false}>
            {!keys.ok ? (
              <div className="p-5">
                <ReadError message={keys.error} />
              </div>
            ) : keys.data.length === 0 ? (
              <div className="p-5">
                <EmptyState title="No keys yet">Create one with the form on this page. It is shown once, when you create it.</EmptyState>
              </div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Key</Th>
                    <Th>Can</Th>
                    <Th>Venues</Th>
                    <Th>Expires</Th>
                    <Th>Last used</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {keys.data.map((k) => (
                    <tr key={k.id} data-testid={`agent-key-${k.name}`}>
                      <Td>
                        <p className="font-medium">{k.name}</p>
                        <p className="font-mono text-xs text-ink-3">{k.prefix}</p>
                        {c.isOwner && k.staffId !== c.session.principal.staffId ? <p className="text-xs text-ink-3">{personName.get(k.staffId) ?? 'Someone else'}</p> : null}
                      </Td>
                      <Td>
                        <p>{k.canWrite ? 'Read and propose changes' : 'Read only'}</p>
                        <p className="text-xs text-ink-3" title={k.scopes.join(', ')}>
                          {k.scopes.length} {k.scopes.length === 1 ? 'permission' : 'permissions'}
                        </p>
                      </Td>
                      <Td>{k.venueIds ? k.venueIds.map((id) => venueName.get(id) ?? 'Another venue').join(', ') : 'All of theirs'}</Td>
                      <Td>{k.status === 'active' ? dateTime(k.expiresAt, tz, { date: true, time: false }) : <Badge>{k.status === 'revoked' ? 'Revoked' : 'Expired'}</Badge>}</Td>
                      <Td>{k.lastUsedAt ? dateTime(k.lastUsedAt, tz) : 'Never'}</Td>
                      <Td align="right">
                        {k.status === 'active' ? (
                          <div className="flex flex-wrap justify-end gap-2">
                            {c.isOwner ? (
                              k.canWrite ? (
                                <InlineAction action={setKeyCanWrite} hidden={{ keyId: k.id, canWrite: 'false' }} label="Make read-only" />
                              ) : (
                                <ConfirmAction trigger="Allow changes" title={`Let “${k.name}” propose changes?`} action={setKeyCanWrite} hidden={{ keyId: k.id, canWrite: 'true' }} confirmLabel="Allow changes" variant="primary">
                                  <p>The assistant using this key may propose changes within its permissions, such as marking an item sold out. Each change is put to its person as a question first and is made only if they say yes.</p>
                                </ConfirmAction>
                              )
                            ) : null}
                            <ConfirmAction trigger="Revoke" title={`Revoke “${k.name}”?`} action={revokeKey} hidden={{ keyId: k.id }} confirmLabel="Revoke key" testId={`revoke-key-${k.name}`}>
                              <p>Any assistant using “{k.name}” is cut off straight away. This cannot be undone; make a new key if you need one.</p>
                            </ConfirmAction>
                          </div>
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card title="Recent assistant activity" description="Which key called which tool, and how it went. Arguments and answers are never kept." padded={false}>
            {!calls.ok ? (
              <div className="p-5">
                <ReadError message={calls.error} />
              </div>
            ) : calls.data.length === 0 ? (
              <div className="p-5">
                <EmptyState title="No activity yet">Once an assistant uses a key, its calls appear here.</EmptyState>
              </div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Key</Th>
                    <Th>Tool</Th>
                    <Th>Outcome</Th>
                  </tr>
                </thead>
                <tbody>
                  {calls.data.map((a) => (
                    <tr key={a.id}>
                      <Td>{dateTime(a.occurredAt, tz)}</Td>
                      <Td>{a.keyName ?? '(deleted key)'}</Td>
                      <Td>
                        <span className="font-mono text-xs">{a.plugKey === 'os' ? a.tool : `${a.plugKey} · ${a.tool}`}</span> <span className="text-xs text-ink-3">{a.effect}</span>
                      </Td>
                      <Td>
                        <Badge tone={OUTCOME_TONE[a.outcome] ?? 'neutral'}>{a.outcome.replace('_', ' ')}</Badge>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card title="Hosted agents" description={`Work our own agents did, or would have done, for ${c.venue.name}.`}>
            {!runs.ok ? (
              <ReadError message={runs.error} />
            ) : runs.data.length === 0 ? (
              <p className="text-sm text-ink-3">No hosted agent has run here.</p>
            ) : (
              <ul className="divide-y divide-line">
                {runs.data.map((r) => (
                  <li key={r.id} className="py-2 text-sm">
                    <p className="font-medium">
                      {r.agentName} <Badge>{r.mode}</Badge> <Badge tone={r.status === 'failed' ? 'bad' : 'neutral'}>{r.status}</Badge>
                    </p>
                    <p className="text-ink-2">{r.summary ?? r.error ?? '–'}</p>
                    <p className="text-xs text-ink-3">{dateTime(r.startedAt, tz)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          <Card title="Create a key" description="For you, signed in now. It is shown once.">
            <CreateKeyForm action={createKey}>
              <Field label="Name" hint="So you can tell your keys apart, e.g. “Claude on my laptop”.">
                <Input name="name" required maxLength={80} />
              </Field>
              <Field label="Lasts (days)" hint={`At most ${maxDays} days here.`}>
                <Input name="expiresInDays" type="number" min={1} max={maxDays} defaultValue={Math.min(30, maxDays)} required />
              </Field>
              <fieldset>
                <legend className="mb-1 text-sm font-medium text-ink">What it may do</legend>
                <p className="mb-2 text-xs text-ink-3">Reading is safe to grant. A “change” permission only lets the assistant propose; you still confirm each change.</p>
                <div className="max-h-72 space-y-1.5 overflow-auto rounded-md border border-line p-3">
                  {scopes.map((s) => (
                    <label key={s.scope} className="flex items-start gap-2 text-sm">
                      <input type="checkbox" name="scopes" value={s.scope} defaultChecked={s.effect === 'read' && !s.guestLevel && !s.plug} className="mt-0.5 size-4 accent-ink" />
                      <span>
                        <span className="font-mono text-xs text-ink">{s.scope}</span>
                        {s.guestLevel ? <span className="ml-1 text-xs text-warn">individual guests</span> : null}
                        <span className="block text-xs text-ink-3">{s.plug ? `${s.plug} tools` : s.tools.map((t) => t.title).join(', ') || '—'}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {c.venues.length > 1 ? (
                <fieldset>
                  <legend className="mb-1 text-sm font-medium text-ink">Venues</legend>
                  <p className="mb-2 text-xs text-ink-3">Leave all unticked for every venue you can see, now and later.</p>
                  {c.venues.map((v) => (
                    <label key={v.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="venueIds" value={v.id} className="size-4 accent-ink" />
                      {v.name}
                    </label>
                  ))}
                </fieldset>
              ) : null}
              {c.isOwner ? (
                <label className="flex items-start gap-3 text-sm">
                  <input type="checkbox" name="canWrite" className="mt-0.5 size-4 accent-ink" />
                  <span>
                    Can propose changes
                    <span className="block text-xs text-ink-3">Only an owner can allow this. Each change is still a question you answer.</span>
                  </span>
                </label>
              ) : null}
            </CreateKeyForm>
          </Card>

          <Card title={`Settings at ${c.venue.name}`} description="What assistants may do at this venue, whoever's key they use.">
            {state.ok ? (
              <details>
                <summary className="cursor-pointer text-sm font-medium text-accent">Show settings</summary>
                <div className="mt-4">
                  <ModuleSettingsForm moduleKey="hub" fields={formSpec(hub.hubModule.configSchema, config)} action={saveFeatureOptions} disabled={!hubOn} />
                  {!hubOn ? <p className="mt-2 text-xs text-ink-3">Switch assistant access on to change these.</p> : null}
                </div>
              </details>
            ) : (
              <ReadError message={state.error} />
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
