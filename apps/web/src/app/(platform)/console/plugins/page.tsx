import Link from 'next/link';
import { tenancy } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { formSpecFromJson, type JS } from '@/lib/console-schema-form';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { ModuleSettingsForm } from '@/components/console/settings-form';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { Badge, Card, LinkButton, PageHeader } from '@/ui';
import { savePluginOptions, setPluginEnabled } from './actions';

export const metadata = { title: 'Plugins · Pipedline' };

const CATEGORY: Record<string, { title: string; blurb: string }> = {
  channels: { title: 'Channels', blurb: 'Where guests find and buy from the venue.' },
  selling: { title: 'Selling', blurb: 'The menu, specials and offers.' },
  guests: { title: 'Guests', blurb: 'Who your guests are, loyalty, reviews.' },
  marketing: { title: 'Marketing', blurb: 'Campaigns, flows and messages.' },
  insight: { title: 'Insight', blurb: 'Numbers and the definitions behind them.' },
  setup: { title: 'Setup', blurb: 'The venue, the team and going live.' },
  integration: { title: 'Connected services', blurb: 'Services somebody else runs, connected by you.' },
};
const ORDER = ['channels', 'selling', 'guests', 'marketing', 'insight', 'setup', 'integration'];

/**
 * Plugins (docs/CONSOLE_IA.md section 4): the catalogue, generated from the module manifests
 * through tenancy.pluginCatalogueForVenue, never hand-written. Each card: name, purpose, what it
 * needs, what it reads and writes, consent, on/off, and a Configure form generated from the
 * module's own config schema and its descriptions. A plug connects through Connected services.
 */
export default async function PluginsPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Plugins" />;
  const catalogue = await read((ctx) => tenancy.pluginCatalogueForVenue(ctx, c.venue.id));

  return (
    <>
      <PageHeader
        title="Plugins"
        description={`Everything ${c.venue.name} can switch on, what each piece needs, and what it reads and writes. Your assistant sees the same list as plugins_list and can switch things on for you after a yes.`}
        actions={
          <>
            <LinkButton href="/console/settings/connections" size="sm">
              Connected services
            </LinkButton>
            <LinkButton href="/console/settings/features" size="sm">
              Features
            </LinkButton>
          </>
        }
      />
      {!catalogue.ok ? (
        <ReadError message={catalogue.error} />
      ) : (
        <div className="space-y-10">
          <p className="text-xs text-ink-3">
            Catalogue generated {new Date(catalogue.data.generated_at).toISOString().slice(0, 10)} from the module definitions. Public copy at{' '}
            <a href={`${catalogue.data.platform}/plugins.json`} className="text-accent">
              /plugins.json
            </a>
            .
          </p>
          {ORDER.filter((cat) => catalogue.data.plugins.some((p) => p.category === cat)).map((cat) => {
            const words = CATEGORY[cat] ?? { title: cat, blurb: '' };
            const entries = catalogue.data.plugins.filter((p) => p.category === cat);
            return (
              <section key={cat} aria-labelledby={`cat-${cat}`}>
                <div className="mb-3">
                  <h2 id={`cat-${cat}`} className="text-lg font-semibold text-ink">
                    {words.title}
                  </h2>
                  {words.blurb ? <p className="text-sm text-ink-2">{words.blurb}</p> : null}
                </div>
                <div className="space-y-4">
                  {entries.map((p) => {
                    const isPlug = p.kind === 'plug';
                    const fields = p.config_schema ? formSpecFromJson(p.config_schema as JS, p.config ?? {}) : [];
                    return (
                      <Card
                        key={p.key}
                        id={`plugin-${p.key}`}
                        title={p.name}
                        description={p.purpose}
                        actions={
                          <div className="flex items-center gap-2" data-testid={`plugin-${p.key}`}>
                            {p.kind === 'channel' ? <Badge tone="accent">Channel</Badge> : null}
                            {p.always_on ? (
                              <Badge tone="good">Always on</Badge>
                            ) : isPlug ? (
                              <>
                                <Badge tone={p.on ? 'good' : 'neutral'}>{p.on ? 'Connected' : 'Not connected'}</Badge>
                                <LinkButton href={`/console/settings/connections#plug-${p.key}`} size="sm" variant={p.on ? 'secondary' : 'primary'}>
                                  {p.on ? 'Manage' : 'Connect'}
                                </LinkButton>
                              </>
                            ) : (
                              <>
                                <Badge tone={p.on ? 'good' : 'neutral'}>{p.on ? 'On' : 'Off'}</Badge>
                                {p.on ? (
                                  <ConfirmAction trigger="Switch off" title={`Switch off ${p.name}?`} action={setPluginEnabled} hidden={{ module: p.key, enabled: 'false', name: p.name }} confirmLabel="Switch it off" testId={`plugin-off-${p.key}`}>
                                    <p>
                                      {p.name} stops at <strong>{c.venue.name}</strong> straight away, and its screens leave the console for everyone at this venue.
                                    </p>
                                    <p className="mt-2">Its data and settings are kept. Switching it back on brings them back.</p>
                                  </ConfirmAction>
                                ) : (
                                  <InlineAction action={setPluginEnabled} hidden={{ module: p.key, enabled: 'true', name: p.name }} label="Switch on" pendingLabel="Switching on…" variant="primary" testId={`plugin-on-${p.key}`} />
                                )}
                              </>
                            )}
                          </div>
                        }
                      >
                        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                          <div>
                            <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">Needs</dt>
                            <dd className="mt-0.5 text-ink-2">{p.needs.join(' ') || 'Nothing.'}</dd>
                          </div>
                          <div>
                            <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">Reads and writes</dt>
                            <dd className="mt-0.5 text-ink-2">
                              Reads {p.reads.join(', ')}. Writes {p.writes.join(', ')}.
                            </dd>
                          </div>
                          {p.consent ? (
                            <div className="sm:col-span-2">
                              <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">Guests' consent</dt>
                              <dd className="mt-0.5 text-ink-2">{p.consent}</dd>
                            </div>
                          ) : null}
                          {p.public_address ? (
                            <div className="sm:col-span-2">
                              <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">Public address</dt>
                              <dd className="mt-0.5 break-all font-mono text-xs text-ink">{p.public_address}</dd>
                            </div>
                          ) : null}
                          {p.tools.length ? (
                            <div className="sm:col-span-2">
                              <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">Tools it gives your assistant</dt>
                              <dd className="mt-0.5 text-ink-2">
                                {p.tools.map((t) => (
                                  <span key={t.name} className="mr-2 inline-block">
                                    <span className="font-mono text-xs text-ink">{t.name}</span>
                                    <span className="text-xs text-ink-3"> ({t.effect === 'write' ? 'asks first' : 'reads'})</span>
                                  </span>
                                ))}
                              </dd>
                            </div>
                          ) : null}
                        </dl>
                        {fields.length ? (
                          <details className="mt-4 group">
                            <summary className="cursor-pointer text-sm font-medium text-accent" data-testid={`plugin-configure-${p.key}`}>
                              Configure{p.config_scope === 'organisation' ? ' (whole organisation)' : ''}
                            </summary>
                            <div className="mt-4">
                              <ModuleSettingsForm moduleKey={p.key} fields={fields} action={savePluginOptions} disabled={!p.on} submitLabel="Save settings" />
                              {!p.on ? <p className="mt-2 text-xs text-ink-3">Switch it on to change these.</p> : null}
                            </div>
                          </details>
                        ) : !isPlug ? (
                          <p className="mt-4 text-sm text-ink-3">No settings to set.</p>
                        ) : null}
                        <p className="mt-3 flex flex-wrap gap-3 text-xs text-ink-3">
                          <Link href={`/console/plugins/${encodeURIComponent(p.key)}`} className="text-accent" data-testid={`plugin-detail-${p.key}`}>
                            Details: tools, last used, what leaves the venue
                          </Link>
                          {p.docs ? (
                            <Link href={p.docs} className="text-accent">
                              How it works
                            </Link>
                          ) : null}
                        </p>
                      </Card>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
