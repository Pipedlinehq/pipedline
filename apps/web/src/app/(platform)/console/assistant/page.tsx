import Link from 'next/link';
import { getModule, listAuditLog } from '@ros/core';
import { approvals, auth, hub, tenancy } from '@ros/modules';
import { app } from '@/lib/runtime';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { formSpec } from '@/lib/console-schema-form';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { DecideButtons, REQUESTER } from '@/components/console/approval-bits';
import { ModuleSettingsForm } from '@/components/console/settings-form';
import { CopyField, CreateKeyForm } from '@/components/console/settings-once';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { Badge, Card, EmptyState, Field, Input, LinkButton, PageHeader, Table, Td, Th, dateTime } from '@/ui';
import { saveFeatureOptions } from '../settings/features/actions';
import { decideFromHome } from '../home-actions';
import { createKey, revokeKey, setKeyCanWrite } from './actions';

export const metadata = { title: 'Assistant · Pipedline' };

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

const MODE_WORDS: Record<hub.AgentMode, { label: string; tone: 'neutral' | 'accent' | 'warn' | 'good'; words: string }> = {
  off: { label: 'Off', tone: 'neutral', words: 'Does nothing here.' },
  shadow: { label: 'Shadow', tone: 'accent', words: 'Works out what it would do and records it. Nothing leaves, nothing changes.' },
  supervised: { label: 'Supervised', tone: 'warn', words: 'Queues each thing it would do for your yes under Approvals.' },
  autonomous: { label: 'Autonomous', tone: 'good', words: 'Acts on its own, within its own ceiling. Anything that sends or moves money still asks.' },
};

/**
 * Assistant (docs/CONSOLE_IA.md section 5): the connection(s) and how to add one, the per-tool
 * approval reminder, what the assistant did (every call, and each change with its before and
 * after), what is waiting for a yes, and the hosted agents with their modes.
 */
export default async function AssistantPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Assistant" />;
  const tz = c.venue.timezone;
  const endpoint = `${tenancy.platformOrigin(app())}${tenancy.ASSISTANT_ENDPOINT_PATH}`;

  const [state, keys, calls, runs, people, waiting, changes] = await Promise.all([
    read((ctx) => getModule(ctx, c.venue.id, hub.hubModule)),
    read((ctx) => hub.listAgentKeys(ctx)),
    read((ctx) => hub.listAgentCalls(ctx, { limit: 25 })),
    read((ctx) => hub.listAgentRuns(ctx, { venueId: c.venue.id, limit: 10 })),
    read((ctx) => auth.listStaff(ctx)),
    read((ctx) => approvals.listApprovals(ctx, { status: 'pending' })),
    c.isOwner ? read((ctx) => listAuditLog(ctx, { limit: 200 })) : null,
  ]);
  const scopes = hub.describeScopes(app());
  const personName = new Map(people.ok ? people.data.map((p) => [p.id, [p.firstName, p.lastName].filter(Boolean).join(' ')]) : []);
  const venueName = new Map(c.venues.map((v) => [v.id, v.name]));
  const hubOn = state.ok && state.data.enabled;
  const config = state.ok ? state.data.config : hub.hubModule.defaultConfig;
  const maxDays = config.key_max_lifetime_days;
  // Approvals an assistant or a hosted agent asked for; the rest (campaign sends) are under Marketing.
  const fromAssistants = waiting.ok ? waiting.data.filter((a) => a.requestedByKind === 'agent' || a.kind === hub.HOSTED_ACTION_APPROVAL) : [];
  const agentChanges = changes?.ok ? changes.data.filter((e) => e.actorKind === 'agent').slice(0, 15) : [];
  const agents = hub.listHostedAgents();
  const modes = await read(async (ctx) => {
    const out: Array<{ key: string; name: string; description: string; ceiling: string; mode: hub.AgentMode }> = [];
    for (const a of agents) out.push({ key: a.key, name: a.name, description: a.description, ceiling: a.ceiling, mode: await hub.agentMode(ctx, c.venue.id, a) });
    return out;
  });

  return (
    <>
      <PageHeader
        title="Assistant"
        description="Your own assistant (Claude, ChatGPT or another that speaks MCP) connected to the venue. It reads the numbers and, if you allow it, proposes changes. It never does more than the person it belongs to, and every change waits for their yes."
      />

      {!hubOn ? (
        <div className="mb-6">
          <EmptyState title={`Assistant access is switched off at ${c.venue.name}`} action={<LinkButton href="/console/plugins#plugin-hub">Open Plugins</LinkButton>}>
            Switch on “Assistant access and plugs” for this venue so an assistant can see it. Existing connections cannot reach a venue where it is off.
          </EmptyState>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="min-w-0 space-y-6">
          <Card title="Where your assistant connects" description="Two ways in. Either way the assistant gets your role and nothing more, and each tool asks before it changes anything.">
            <CopyField value={endpoint} label="MCP server address" testId="mcp-endpoint" />
            <ol className="mt-4 space-y-3 text-sm text-ink-2">
              <li>
                <span className="font-medium text-ink">1. Sign in from the assistant.</span> Add a custom connector in Claude (Customize → Connectors → Add custom connector) or ChatGPT (developer mode) with the address above. The assistant sends you to Pipedline to sign in and you choose what it may do. Nothing to paste.
              </li>
              <li>
                <span className="font-medium text-ink">2. Paste a key.</span> Create a key on this page (shown once) and give it to an assistant that cannot sign in. Revoke it here at any time.
              </li>
            </ol>
            <p className="mt-4 rounded-md bg-sunken px-3 py-2 text-xs text-ink-2">
              <span className="font-medium text-ink">Per-tool approval.</span> Most assistants let you set each tool to “always allow”, “ask first” or “blocked”. Leave every tool that changes something on “ask first”: Pipedline also asks, with the exact change in plain words, and makes it only when you say yes.
            </p>
          </Card>

          <Card title="Waiting for your yes" description="Changes an assistant or a hosted agent has proposed. Each one says exactly what will happen." padded={false}>
            {!waiting.ok ? (
              <div className="p-5">
                <ReadError message={waiting.error} />
              </div>
            ) : fromAssistants.length === 0 ? (
              <div className="p-5">
                <EmptyState title="Nothing from an assistant is waiting">When your assistant proposes a change it cannot ask you about in the chat, or a hosted agent wants to act, it appears here.</EmptyState>
              </div>
            ) : (
              <ul className="divide-y divide-line" data-testid="assistant-approvals">
                {fromAssistants.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                    <div className="min-w-0 flex-1 basis-72">
                      <Link href={`/console/approvals/${a.id}`} className="font-medium text-accent">
                        {a.summary}
                      </Link>
                      <p className="mt-0.5 text-xs text-ink-3">
                        {REQUESTER[a.requestedByKind] ?? a.requestedByKind} · {a.venueId ? (venueName.get(a.venueId) ?? 'Another venue') : 'Whole organisation'} · asked {dateTime(a.createdAt, tz)}
                      </p>
                    </div>
                    {!a.venueId || atLeast(c.session.principal.venueRoles[a.venueId] ?? 'read_only', 'manager') ? <DecideButtons id={a.id} summary={a.summary} action={decideFromHome} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={c.isOwner ? 'Connections' : 'Your connections'} description={c.isOwner ? 'Every key and signed-in assistant in the organisation. You can allow one to propose changes.' : 'Keys and sign-ins you made. An owner can allow one to propose changes.'} padded={false}>
            {!keys.ok ? (
              <div className="p-5">
                <ReadError message={keys.error} />
              </div>
            ) : keys.data.length === 0 ? (
              <div className="p-5">
                <EmptyState title="No connections yet">Sign in from your assistant with the address above, or create a key with the form on this page.</EmptyState>
              </div>
            ) : (
              <Table label="Connections">
                <thead>
                  <tr>
                    <Th>Connection</Th>
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
                        <p className="text-xs text-ink-3">
                          {k.label} · <span className="font-mono">{k.prefix}</span>
                        </p>
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
                            {c.isOwner && k.audience === 'assistant' ? (
                              k.canWrite ? (
                                <InlineAction action={setKeyCanWrite} hidden={{ keyId: k.id, canWrite: 'false' }} label="Make read-only" />
                              ) : (
                                <ConfirmAction trigger="Allow changes" title={`Let “${k.name}” propose changes?`} action={setKeyCanWrite} hidden={{ keyId: k.id, canWrite: 'true' }} confirmLabel="Allow changes" variant="primary">
                                  <p>The assistant using this connection may propose changes within its permissions, such as marking an item sold out. Each change is put to its person as a question first and is made only if they say yes.</p>
                                </ConfirmAction>
                              )
                            ) : null}
                            <ConfirmAction trigger="Revoke" title={`Revoke “${k.name}”?`} action={revokeKey} hidden={{ keyId: k.id }} confirmLabel="Revoke key" testId={`revoke-key-${k.name}`}>
                              <p>Any assistant using “{k.name}” is cut off straight away. This cannot be undone; connect again if you need to.</p>
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

          <Card title="What your assistant did" description="Which connection called which tool, and how it went. Arguments and answers are never kept." padded={false}>
            {!calls.ok ? (
              <div className="p-5">
                <ReadError message={calls.error} />
              </div>
            ) : calls.data.length === 0 ? (
              <div className="p-5">
                <EmptyState title="No activity yet">Once an assistant uses a connection, its calls appear here.</EmptyState>
              </div>
            ) : (
              <Table label="Assistant calls">
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Connection</Th>
                    <Th>Tool</Th>
                    <Th>Outcome</Th>
                  </tr>
                </thead>
                <tbody>
                  {calls.data.map((a) => (
                    <tr key={a.id} data-testid="agent-call" data-tool={a.tool} data-outcome={a.outcome}>
                      <Td className="whitespace-nowrap">{dateTime(a.occurredAt, tz)}</Td>
                      <Td>{a.keyName ?? '(deleted key)'}</Td>
                      <Td>
                        <span className="font-mono text-xs">{a.plugKey === 'os' ? a.tool : `${a.plugKey} · ${a.tool}`}</span> <span className="text-xs text-ink-3">{a.effect === 'write' ? 'change' : 'read'}</span>
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

          {c.isOwner ? (
            <Card title="Changes made after a yes" description="Every change an assistant made, with what it was before and after, from the audit log. Owners only: it covers the whole organisation." padded={false}>
              {!changes?.ok ? (
                <div className="p-5">
                  <ReadError message={changes?.error ?? 'Could not read the audit log.'} />
                </div>
              ) : agentChanges.length === 0 ? (
                <div className="p-5">
                  <EmptyState title="No changes by an assistant yet">When an assistant changes something after your yes, the before and after appear here.</EmptyState>
                </div>
              ) : (
                <ul className="divide-y divide-line">
                  {agentChanges.map((e) => (
                    <li key={e.id} className="px-5 py-3 text-sm" data-testid="agent-change">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">{e.action.replace(/[._]/g, ' ')}</span>
                        <span className="text-xs text-ink-3">
                          {e.entityType}
                          {e.venueId ? ` · ${venueName.get(e.venueId) ?? 'Another venue'}` : ''} · {dateTime(e.occurredAt, tz)}
                        </span>
                      </p>
                      <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <pre className="max-h-32 overflow-auto rounded-md bg-sunken px-3 py-2 text-xs text-ink-2">Before: {e.before === null || e.before === undefined ? '–' : JSON.stringify(e.before, null, 1)}</pre>
                        <pre className="max-h-32 overflow-auto rounded-md bg-sunken px-3 py-2 text-xs text-ink-2">After: {e.after === null || e.after === undefined ? '–' : JSON.stringify(e.after, null, 1)}</pre>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}

          <Card title="Hosted agents" description={`Agents Pipedline runs for ${c.venue.name} on a schedule. Each has a mode here, and never goes above its own ceiling.`}>
            {!modes.ok ? (
              <ReadError message={modes.error} />
            ) : modes.data.length === 0 ? (
              <p className="text-sm text-ink-3">No hosted agents are defined in this deployment.</p>
            ) : (
              <ul className="divide-y divide-line" data-testid="hosted-agents">
                {modes.data.map((a) => {
                  const m = MODE_WORDS[a.mode];
                  return (
                    <li key={a.key} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm" data-testid={`hosted-agent-${a.key}`}>
                      <div className="min-w-0 flex-1 basis-72">
                        <p className="font-medium text-ink">{a.name}</p>
                        <p className="text-ink-2">{a.description}</p>
                        <p className="mt-1 text-xs text-ink-3">
                          {m.words} Ceiling: {a.ceiling}.
                        </p>
                      </div>
                      <Badge tone={m.tone}>{m.label}</Badge>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mt-3 text-xs text-ink-3">Change a mode under “Settings at this venue” (hosted agents and how far each may go).</p>
            {runs.ok && runs.data.length ? (
              <div className="mt-4 border-t border-line pt-3">
                <p className="mb-2 text-sm font-medium text-ink">Recent runs</p>
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
              </div>
            ) : runs.ok ? (
              <p className="mt-3 text-sm text-ink-3">No hosted agent has run here yet.</p>
            ) : (
              <ReadError message={runs.error} />
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
                      <input type="checkbox" name="scopes" value={s.scope} defaultChecked={s.effect === 'read' && !s.guestLevel && !s.plug} className="mt-0.5 size-4 rounded accent-accent" />
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
                      <input type="checkbox" name="venueIds" value={v.id} className="size-4 rounded accent-accent" />
                      {v.name}
                    </label>
                  ))}
                </fieldset>
              ) : null}
              {c.isOwner ? (
                <label className="flex items-start gap-3 text-sm">
                  <input type="checkbox" name="canWrite" className="mt-0.5 size-4 rounded accent-accent" />
                  <span>
                    Can propose changes
                    <span className="block text-xs text-ink-3">Only an owner can allow this. Each change is still a question you answer.</span>
                  </span>
                </label>
              ) : null}
            </CreateKeyForm>
          </Card>

          <Card title={`Settings at ${c.venue.name}`} description="What assistants may do at this venue, whoever's connection they use. Only a person changes these; an assistant never widens its own access.">
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
