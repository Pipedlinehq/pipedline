import { getModule, getPlug, listConnections, listPlugs, type PlugDef } from '@ros/core';
import { comms, hub, ledger } from '@ros/modules';
import { app } from '@/lib/runtime';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { PosConnectForm } from '@/components/console/settings-connect';
import { ServiceKeyForm } from '@/components/console/settings-once';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { accessOf, signInConfigured, signInPosPlugs } from '@/lib/pos-signin';
import { ActionForm, Badge, Card, EmptyState, Field, FormMessage, Input, PageHeader, Select, SubmitButton, dateTime } from '@/ui';
import {
  checkPlugs,
  connectAdsAccount,
  connectAssistantPlug,
  connectEmailPlatform,
  connectPosLocation,
  createServiceKey,
  disconnectEmailPlatform,
  disconnectPosSignIn,
  fetchHistory,
  findPosLocations,
  revoke,
  startPosSignIn,
  syncEmailPlatform,
} from './actions';

export const metadata = { title: 'Connected services · Pipedline' };

const STATUS: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  connected: { label: 'Connected', tone: 'good' },
  pending: { label: 'Waiting', tone: 'warn' },
  unhealthy: { label: 'Needs attention', tone: 'bad' },
  revoked: { label: 'Disconnected', tone: 'neutral' },
};

const plugName = (key: string) => {
  try {
    return getPlug(key).name;
  } catch {
    return key;
  }
};

const ACCESS_WORDS = { read: 'reads sales only', write: 'reads sales, and sends online orders and payments' } as const;
const HISTORY_MONTHS = [0, 3, 6, 12, 24, 36];
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Connected services" />;
  const tz = c.venue.timezone;
  const [connections, pos, esp, ads, keys, hubState] = await Promise.all([
    read((ctx) => listConnections(ctx, { venueId: c.venue.id })),
    read((ctx) => ledger.listPosConnections(ctx, { venueId: c.venue.id })),
    read((ctx) => comms.emailPlatformStatus(ctx)),
    read((ctx) => comms.adsConversionStatus(ctx, { venueId: c.venue.id })),
    c.isOwner ? read((ctx) => hub.listAgentKeys(ctx)) : null,
    read((ctx) => getModule(ctx, c.venue.id, hub.hubModule)),
  ]);
  const posById = new Map(pos.ok ? pos.data.map((p) => [p.id, p]) : []);
  const production = app().config.env === 'production';
  const offered = (p: PlugDef) => !(p.simulated && production);
  const posPlugs = listPlugs().filter((p) => p.adapters.pos && offered(p));
  const directPos = posPlugs.filter((p) => p.auth !== 'oauth').map((p) => ({ key: p.key, name: p.name, needsToken: p.auth === 'api_key' }));
  // Points of sale connected by signing in at the provider. `configured` says whether this
  // deployment holds the provider's application credentials: without them there is nothing to press.
  const signInPos = signInPosPlugs().map((p) => ({ plug: p, configured: signInConfigured(p.key) }));
  const signIn = (key: string) => signInPos.find((s) => s.plug.key === key);
  const mcp = hub.mcpPlugs(app());
  const isMcp = (key: string) => mcp.some((p) => p.key === key);
  const isEsp = (key: string) => listPlugs().some((p) => p.key === key && !!p.adapters.esp);
  const espPlugs = listPlugs().filter((p) => p.adapters.esp && offered(p));
  const adsPlugs = listPlugs().filter((p) => p.adapters.ads && offered(p));
  const serviceKeys = keys?.ok ? keys.data.filter((k) => k.connectionId && k.status === 'active') : [];
  const keyMaxDays = hubState.ok ? hubState.data.config.key_max_lifetime_days : 30;
  const venueName = (id: string | null) => (id ? (c.venues.find((v) => v.id === id)?.name ?? 'Another venue') : 'Whole organisation');
  const live = connections.ok ? connections.data.filter((r) => r.status !== 'revoked') : [];
  const past = connections.ok ? connections.data.filter((r) => r.status === 'revoked') : [];
  // What the sign-in callback sends the person back with. Only a flag: the words are made here.
  const justConnected = signIn(one(query.connected))?.plug;
  const justConnectedRow = justConnected ? live.find((r) => r.plug_key === justConnected.key && r.venue_id === c.venue.id) : undefined;
  const leftSignIn = signIn(one(query.left))?.plug;

  return (
    <>
      <PageHeader title="Connected services" description={`The point of sale, payments and other services ${c.venue.name} is connected to, and whether each is healthy. Credentials are sealed; nobody can read them back, including us.`} />
      <div className="space-y-6">
        {justConnected && justConnectedRow ? (
          <div data-testid="signin-notice">
            <FormMessage tone="success">
              {justConnected.name} is connected to {c.venue.name}. Sales from now on reach the ledger
              {posById.get(justConnectedRow.id)?.backfillingFrom || posById.get(justConnectedRow.id)?.historyFrom ? '; past sales are being fetched in the background' : ''}.
            </FormMessage>
          </div>
        ) : leftSignIn ? (
          <div data-testid="signin-notice">
            <FormMessage tone="info">You left before choosing a location, so nothing was connected and the sign-in at {leftSignIn.name} was discarded.</FormMessage>
          </div>
        ) : null}
        <Card
          title={`Connected at ${c.venue.name}`}
          description="Including services connected once for the whole organisation."
          padded={false}
          actions={mcp.length ? <InlineAction action={checkPlugs} label="Check assistant plugs now" pendingLabel="Checking…" /> : undefined}
        >
          {!connections.ok ? (
            <div className="p-5">
              <ReadError message={connections.error} />
            </div>
          ) : live.length === 0 ? (
            <div className="p-5">
              <EmptyState title="Nothing connected yet">Connect the point of sale below so sales reach the ledger.</EmptyState>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {live.map((r) => {
                const s = STATUS[r.status] ?? STATUS.pending!;
                const p = posById.get(r.id);
                const viaSignIn = signIn(r.plug_key);
                const access = viaSignIn ? accessOf(r.plug_key, r.scopes) : null;
                // The ledger words a refused sign-in as "... sign-in ..." (pos-oauth.ts); an outage reads differently and needs no reconnecting.
                const needsSignIn = !!viaSignIn?.configured && r.status === 'unhealthy' && /sign-in/i.test(r.last_error ?? '');
                return (
                  <li key={r.id} data-testid={`connection-${r.plug_key}`} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-5 py-4">
                    <div className="min-w-0 flex-1 basis-72 space-y-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">{plugName(r.plug_key)}</span>
                        <Badge tone={s.tone}>{s.label}</Badge>
                        <span className="text-xs text-ink-3">{r.venue_id ? 'This venue' : 'Whole organisation'}</span>
                      </p>
                      <p className="break-words text-xs text-ink-3">
                        Account <span className="font-mono">{r.external_account_id}</span>
                        {p?.locationRef ? (
                          <>
                            {' '}
                            · location <span className="font-mono">{p.locationRef}</span>
                          </>
                        ) : null}
                      </p>
                      {access ? <p className="text-xs text-ink-3">Access: {ACCESS_WORDS[access]}.</p> : null}
                      {r.last_error ? <p className="text-xs text-bad">{r.last_error}</p> : null}
                      {viaSignIn?.configured ? (
                        r.status === 'connected' ? (
                          <p className="text-xs text-ink-3">The sign-in renews automatically. There is nothing to do.</p>
                        ) : null
                      ) : r.expires_at ? (
                        <p className="text-xs text-ink-3">Access expires {dateTime(r.expires_at, tz)}</p>
                      ) : null}
                    </div>
                    <dl className="grid min-w-0 basis-60 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                      <dt className="text-ink-3">Last worked</dt>
                      <dd className="text-ink-2">{r.last_ok_at ? dateTime(r.last_ok_at, tz) : 'Not yet'}</dd>
                      {p ? (
                        <>
                          <dt className="text-ink-3">Last sync</dt>
                          <dd className="text-ink-2">{p.lastRunAt ? dateTime(p.lastRunAt, tz) : 'Not yet'}</dd>
                          <dt className="text-ink-3">Sales up to</dt>
                          <dd className="text-ink-2">{p.syncedThrough ? dateTime(p.syncedThrough, tz) : 'Not yet synced'}</dd>
                          {p.backfillingFrom ? (
                            <>
                              <dt className="text-ink-3">Fetching from</dt>
                              <dd className="text-ink-2">{dateTime(p.backfillingFrom, tz, { date: true, time: false })}</dd>
                            </>
                          ) : null}
                          {p.historyFrom ? (
                            <>
                              <dt className="text-ink-3">History back to</dt>
                              <dd className="text-ink-2">{dateTime(p.historyFrom, tz, { date: true, time: false })}</dd>
                            </>
                          ) : null}
                        </>
                      ) : null}
                    </dl>
                    {c.isOwner && isMcp(r.plug_key) && r.status === 'connected' ? (
                      <div className="basis-full rounded-md border border-line p-3" data-testid={`service-keys-${r.plug_key}`}>
                        <p className="text-sm font-medium text-ink">Let {plugName(r.plug_key)} read campaign outcomes</p>
                        <p className="mb-3 mt-0.5 text-xs text-ink-2">
                          A key of {plugName(r.plug_key)}’s own, which can read outcome totals for venues that have switched sharing on, and nothing else. It can never change anything.
                          {serviceKeys.filter((k) => k.connectionId === r.id).length ? ` Live now: ${serviceKeys.filter((k) => k.connectionId === r.id).map((k) => `${k.name} (${k.prefix}…)`).join(', ')}. Revoke one under Assistant access.` : ''}
                        </p>
                        <ServiceKeyForm action={createServiceKey} connectionId={r.id} service={plugName(r.plug_key)} maxDays={keyMaxDays} />
                      </div>
                    ) : null}
                    {needsSignIn && viaSignIn ? (
                      <div className="basis-full rounded-md border border-line p-3" data-testid={`reconnect-${r.plug_key}`}>
                        <p className="text-sm font-medium text-ink">{viaSignIn.plug.name} needs connecting again</p>
                        <p className="mb-3 mt-0.5 text-xs text-ink-2">
                          {viaSignIn.plug.name} has stopped accepting the sign-in saved for {c.venue.name}, so sales are not arriving. Sign in at {viaSignIn.plug.name} again to bring them back; sales made in the meantime are fetched once it is connected.
                        </p>
                        <ActionForm action={startPosSignIn}>
                          <input type="hidden" name="plugKey" value={r.plug_key} />
                          <input type="hidden" name="access" value={access ?? 'read'} />
                          <input type="hidden" name="historyMonths" value="0" />
                          <SubmitButton size="sm" pendingLabel={`Opening ${viaSignIn.plug.name}…`}>
                            Reconnect {viaSignIn.plug.name}
                          </SubmitButton>
                        </ActionForm>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      {p ? (
                        <ConfirmAction
                          trigger="Fetch history"
                          title={`Fetch past sales from ${plugName(r.plug_key)}`}
                          action={fetchHistory}
                          hidden={{ connectionId: r.id }}
                          confirmLabel="Fetch history"
                          variant="primary"
                          fields={
                            <Field label="How far back">
                              <Select name="months" defaultValue="3">
                                {[1, 3, 6, 12, 24, 36].map((m) => (
                                  <option key={m} value={m}>
                                    {m} {m === 1 ? 'month' : 'months'}
                                  </option>
                                ))}
                              </Select>
                            </Field>
                          }
                        >
                          <p>Past sales are read from the point of sale in the background. Sales already in the ledger are not counted twice.</p>
                        </ConfirmAction>
                      ) : null}
                      {isEsp(r.plug_key) ? (
                        // Disconnecting an email platform also hands marketing email back to us: it has its own action, below.
                        <span className="self-center text-xs text-ink-2">Managed under “Your email platform”.</span>
                      ) : viaSignIn ? (
                        // Also ends the access at the provider, which a plain revoke does not.
                        <ConfirmAction
                          trigger={<>Disconnect<span className="sr-only"> {plugName(r.plug_key)}</span></>}
                          title={`Disconnect ${plugName(r.plug_key)}?`}
                          action={disconnectPosSignIn}
                          hidden={{ connectionId: r.id, plugKey: r.plug_key }}
                          confirmLabel="Disconnect"
                          testId={`revoke-${r.plug_key}`}
                        >
                          <p>
                            Sales stop arriving from {plugName(r.plug_key)} at {c.venue.name} straight away, and online orders can no longer be paid through it. The stored sign-in is destroyed and the access you gave us at {plugName(r.plug_key)} is ended.
                          </p>
                          <p className="mt-2">Sales already in the ledger stay. To use it again, connect it again.</p>
                        </ConfirmAction>
                      ) : r.venue_id || c.isOwner ? (
                        <ConfirmAction trigger={<>Disconnect<span className="sr-only"> {plugName(r.plug_key)}</span></>} title={`Disconnect ${plugName(r.plug_key)}?`} action={revoke} hidden={{ connectionId: r.id }} confirmLabel="Disconnect" testId={`revoke-${r.plug_key}`}>
                          <p>
                            {plugName(r.plug_key)} stops {p ? `sending ${c.venue.name}'s sales to the ledger` : 'working'} straight away, and its stored credentials are destroyed. To use it again, connect it again.
                          </p>
                          {!r.venue_id ? <p className="mt-2">It is connected for the whole organisation, so every venue loses it.</p> : null}
                        </ConfirmAction>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {past.length ? <p className="border-t border-line px-5 py-3 text-xs text-ink-3">Disconnected earlier: {past.map((r) => plugName(r.plug_key)).join(', ')}.</p> : null}
        </Card>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card title="Connect the point of sale" description={`Sales from it are recorded against ${c.venue.name}.`}>
            <div className="space-y-5">
              {signInPos.map(({ plug: p, configured }) => {
                const connected = live.some((r) => r.plug_key === p.key && r.venue_id === c.venue.id);
                return (
                  <section key={p.key} aria-label={p.name} data-testid={`signin-${p.key}`}>
                    <h3 className="text-sm font-semibold text-ink">{p.name}</h3>
                    {!configured ? (
                      <p className="mt-1 text-sm text-ink-2">{p.name} sign-in is not configured on this deployment, so {p.name} cannot be connected from here yet.</p>
                    ) : connected ? (
                      <p className="mt-1 text-sm text-ink-2">
                        {p.name} is connected to {c.venue.name} (see above). To change the account, the location or what it may do, disconnect it and connect it again.
                      </p>
                    ) : (
                      <ActionForm action={startPosSignIn} className="mt-2 space-y-3">
                        <input type="hidden" name="plugKey" value={p.key} />
                        <p className="text-sm text-ink-2">
                          You sign in at {p.name} and choose what to allow. We never see your {p.name} password, and you can end the access at any time, here or in your {p.name} account.
                        </p>
                        <fieldset className="space-y-2">
                          <legend className="mb-1 text-sm font-medium text-ink">What {p.name} lets us do</legend>
                          <label className="flex items-start gap-3 text-sm">
                            <input type="radio" name="access" value="read" defaultChecked className="mt-0.5 size-4 accent-ink" />
                            <span>
                              <span className="text-ink">Read sales only</span>
                              <span className="block text-xs text-ink-2">We read your sales, what was on them and refunds. We cannot change or charge anything at {p.name}.</span>
                            </span>
                          </label>
                          <label className="flex items-start gap-3 text-sm">
                            <input type="radio" name="access" value="write" className="mt-0.5 size-4 accent-ink" />
                            <span>
                              <span className="text-ink">Read sales, and send online orders and payments</span>
                              <span className="block text-xs text-ink-2">
                                Needed for online ordering: an order placed on your website appears on the {p.name} till and is paid through {p.name}. Choose this only if you take orders online.
                              </span>
                            </span>
                          </label>
                        </fieldset>
                        <Field label="Past sales to bring in" hint="Fetched in the background after connecting. You can ask for more later.">
                          <Select name="historyMonths" defaultValue="3">
                            {HISTORY_MONTHS.map((m) => (
                              <option key={m} value={m}>
                                {m === 0 ? 'No history, from now on' : `The last ${m} months`}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <SubmitButton size="sm" pendingLabel={`Opening ${p.name}…`}>
                          Connect {p.name}
                        </SubmitButton>
                      </ActionForm>
                    )}
                  </section>
                );
              })}
              {directPos.length ? (
                <div className={signInPos.length ? 'border-t border-line pt-4' : undefined}>
                  <PosConnectForm plugs={directPos} findLocations={findPosLocations} connect={connectPosLocation} venueName={c.venue.name} />
                </div>
              ) : signInPos.length === 0 ? (
                <p className="text-sm text-ink-3">No point of sale can be connected from here.</p>
              ) : null}
            </div>
          </Card>
          <Card title="Connect a service for assistants" description="A service with its own assistant tools (such as Criota). Its tools reach your assistants only after you switch them on for a venue.">
            {mcp.length === 0 ? (
              <p className="text-sm text-ink-3">No such services are available.</p>
            ) : (
              <ActionForm action={connectAssistantPlug} className="space-y-3" resetOnSuccess>
                <Field label="Service">
                  <Select name="plugKey">
                    {mcp.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Access key" hint="Created in the service's own settings and shown there once. It is sealed here and never shown again.">
                  <Input name="accessKey" type="password" autoComplete="off" required minLength={8} />
                </Field>
                <Field label="Account name" hint="Only to tell two accounts apart. Optional.">
                  <Input name="account" maxLength={120} placeholder="default" />
                </Field>
                <SubmitButton size="sm">Connect</SubmitButton>
              </ActionForm>
            )}
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card title="Your email platform" description="Keep your own email platform’s list in step with your guests and their consent. Connected for the whole organisation.">
            {!esp.ok ? (
              <ReadError message={esp.error} />
            ) : esp.data.length === 0 ? (
              <p className="mb-4 text-sm text-ink-2">None connected: marketing email is sent by us.</p>
            ) : (
              <ul className="mb-4 divide-y divide-line">
                {esp.data.map((e) => {
                  const st = STATUS[e.status] ?? STATUS.pending!;
                  return (
                    <li key={e.connectionId} className="space-y-2 py-3" data-testid={`esp-${e.plugKey}`}>
                      <p className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-medium text-ink">{e.name}</span>
                        <Badge tone={st.tone}>{st.label}</Badge>
                        <span className="text-xs text-ink-2">{e.tier === 'connected' ? 'It sends your marketing email' : 'We send your marketing email; it is kept in step'}</span>
                      </p>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                        <dt className="text-ink-2">Account</dt>
                        <dd className="break-all font-mono text-ink">{e.externalAccountId}</dd>
                        <dt className="text-ink-2">Last sync</dt>
                        <dd className="text-ink" data-testid="esp-last-sync">{e.lastRunAt ? dateTime(e.lastRunAt, tz) : 'Not yet'}</dd>
                        <dt className="text-ink-2">On its list</dt>
                        <dd className="text-ink">
                          {e.profilesSubscribed.toLocaleString('en-AU')} subscribed, {e.profilesSuppressed.toLocaleString('en-AU')} held back
                        </dd>
                      </dl>
                      {e.lastError ? <p className="text-xs text-bad">{e.lastError}</p> : null}
                      <div className="flex flex-wrap gap-2">
                        <InlineAction action={syncEmailPlatform} hidden={{ connectionId: e.connectionId }} label="Sync now" pendingLabel="Queuing…" testId={`esp-sync-${e.plugKey}`} />
                        {c.isOwner ? (
                          <ConfirmAction trigger={<>Disconnect<span className="sr-only"> {e.name}</span></>} title={`Disconnect ${e.name}?`} action={disconnectEmailPlatform} hidden={{ connectionId: e.connectionId }} confirmLabel="Disconnect" testId={`esp-disconnect-${e.plugKey}`}>
                            {e.name} stops being kept in step with your guests, its stored key is destroyed, and marketing email is sent by us again. Its own copy of your list is not deleted: do that in {e.name}.
                          </ConfirmAction>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {c.isOwner ? (
              espPlugs.length === 0 ? (
                <p className="text-sm text-ink-2">No email platform can be connected from here.</p>
              ) : (
                <ActionForm action={connectEmailPlatform} className="space-y-3 border-t border-line pt-4" resetOnSuccess>
                  <Field label="Email platform">
                    <Select name="plugKey">
                      {espPlugs.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Account ID" hint="The platform’s own id for your account (for Klaviyo, the public site ID).">
                    <Input name="externalAccountId" required maxLength={200} autoComplete="off" />
                  </Field>
                  <Field label="API key" hint="Sealed here and never shown again.">
                    <Input name="apiKey" type="password" required autoComplete="off" />
                  </Field>
                  <Field label="Who sends marketing email">
                    <Select name="tier" defaultValue="connected">
                      <option value="connected">The email platform sends it</option>
                      <option value="native">We keep sending it; only keep the platform in step</option>
                    </Select>
                  </Field>
                  <SubmitButton size="sm">Connect email platform</SubmitButton>
                </ActionForm>
              )
            ) : (
              <p className="text-xs text-ink-2">Only an owner can connect or disconnect it: the whole guest list is involved.</p>
            )}
          </Card>

          <Card title="Ad platform conversions" description="Report purchases to your ad platform so ads are measured on real sales. Only for guests who agreed to it; only a hashed email and phone and the amount.">
            {!ads.ok ? (
              <ReadError message={ads.error} />
            ) : ads.data.length === 0 ? (
              <p className="mb-4 text-sm text-ink-2">None connected: nothing is reported to an ad platform.</p>
            ) : (
              <ul className="mb-4 divide-y divide-line">
                {ads.data.map((a) => {
                  const st = STATUS[a.status] ?? STATUS.pending!;
                  return (
                    <li key={a.connectionId} className="space-y-1 py-3" data-testid={`ads-${a.plugKey}`}>
                      <p className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-medium text-ink">{a.name}</span>
                        <Badge tone={st.tone}>{st.label}</Badge>
                        <span className="text-xs text-ink-2">{venueName(a.venueId)}</span>
                      </p>
                      <p className="text-xs text-ink-2" data-testid="ads-counts">
                        {a.counts.sent.toLocaleString('en-AU')} reported, {a.counts.queued.toLocaleString('en-AU')} waiting, {a.counts.skipped.toLocaleString('en-AU')} left out (no consent, or refunded), {a.counts.failed.toLocaleString('en-AU')} failed
                        {a.lastSentAt ? `. Last reported ${dateTime(a.lastSentAt, tz)}.` : '.'}
                      </p>
                      {a.lastError ? <p className="text-xs text-bad">{a.lastError}</p> : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {c.isOwner ? (
              adsPlugs.length === 0 ? (
                <p className="text-sm text-ink-2">No ad platform can be connected from here.</p>
              ) : (
                <ActionForm action={connectAdsAccount} className="space-y-3 border-t border-line pt-4" resetOnSuccess>
                  <Field label="Ad platform">
                    <Select name="plugKey">
                      {adsPlugs.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Dataset or pixel ID">
                    <Input name="externalAccountId" required maxLength={200} autoComplete="off" />
                  </Field>
                  <Field label="Access token" hint="Sealed here and never shown again.">
                    <Input name="accessToken" type="password" required autoComplete="off" />
                  </Field>
                  <Field label="Report sales from">
                    <Select name="scope" defaultValue="venue">
                      <option value="venue">{c.venue.name} only</option>
                      <option value="org">Every venue in {c.org.tradingName}</option>
                    </Select>
                  </Field>
                  <SubmitButton size="sm">Connect ad platform</SubmitButton>
                </ActionForm>
              )
            ) : (
              <p className="text-xs text-ink-2">Only an owner can connect an ad platform: guest data leaves for it.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
