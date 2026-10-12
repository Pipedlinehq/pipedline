import Link from 'next/link';
import { tenancy } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { Badge, Card, EmptyState, PageHeader } from '@/ui';
import { setPluginEnabled } from '../plugins/actions';

export const metadata = { title: 'Channels · Pipedline' };

/**
 * Where a channel's own screen is, for the Open link. Everything else on a card comes from the
 * module's manifest through the catalogue (tenancy.pluginCatalogueForVenue), never from here.
 */
const OPEN: Record<string, { href: string; label: string }> = {
  website: { href: '/console/website', label: 'Pages and brand' },
  qr: { href: '/console/qr', label: 'QR codes' },
  ordering: { href: '/console/orders', label: 'Orders' },
  delivery: { href: '/console/delivery', label: 'Delivery' },
  bookings: { href: '/console/bookings', label: 'The book' },
};

/** Channels (docs/CONSOLE_IA.md section 3): every place guests find and buy from the venue, each with on/off, status, its public address and Configure. */
export default async function ChannelsPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Channels" />;
  const catalogue = await read((ctx) => tenancy.pluginCatalogueForVenue(ctx, c.venue.id));
  const venueLive = c.venue.status === 'live';

  return (
    <>
      <PageHeader
        title="Channels"
        description={`Every place guests find and buy from ${c.venue.name}. Switch one on or off here; its settings live under Plugins. A channel that is off keeps its data.`}
      />
      {!catalogue.ok ? (
        <ReadError message={catalogue.error} />
      ) : (
        (() => {
          const channels = catalogue.data.plugins.filter((p) => p.kind === 'channel');
          if (!channels.length) return <EmptyState title="No channels in this deployment">Nothing in the catalogue is marked as a channel.</EmptyState>;
          return (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {channels.map((p) => {
                const status = !p.on ? { label: 'Off', tone: 'neutral' as const } : venueLive ? { label: 'Live', tone: 'good' as const } : { label: 'Needs setup', tone: 'warn' as const };
                const open = OPEN[p.key];
                const guests = p.key === 'guest-plugin';
                return (
                  <Card
                    key={p.key}
                    id={`channel-${p.key}`}
                    title={guests ? 'Inside assistants' : p.name}
                    description={p.purpose}
                    actions={
                      <div className="flex items-center gap-2" data-testid={`channel-${p.key}`}>
                        <Badge tone={status.tone}>{status.label}</Badge>
                        {p.on ? (
                          <ConfirmAction trigger="Switch off" title={`Switch off ${p.name}?`} action={setPluginEnabled} hidden={{ module: p.key, enabled: 'false', name: p.name }} confirmLabel="Switch it off" testId={`channel-off-${p.key}`}>
                            <p>
                              {p.name} stops at <strong>{c.venue.name}</strong> straight away: guests can no longer reach the venue this way, and its screens leave the console for everyone here.
                            </p>
                            <p className="mt-2">Its data and settings are kept. Switching it back on brings them back.</p>
                          </ConfirmAction>
                        ) : (
                          <InlineAction action={setPluginEnabled} hidden={{ module: p.key, enabled: 'true', name: p.name }} label="Switch on" pendingLabel="Switching on…" variant="primary" testId={`channel-on-${p.key}`} />
                        )}
                      </div>
                    }
                  >
                    <div className="space-y-3 text-sm">
                      {guests ? (
                        <p className="text-ink-2">
                          Guests who use ChatGPT or Claude can ask their assistant to find {c.venue.name}, read the menu and hours, book a table, and start a pickup order that they pay for on your own order page. In Australia no payment is taken inside the chat.
                        </p>
                      ) : null}
                      {p.public_address ? (
                        <div>
                          <p className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">{guests ? 'Guest assistant endpoint' : 'Public address'}</p>
                          <code data-testid={`channel-address-${p.key}`} className="mt-1 block break-all rounded-md border border-line bg-sunken px-3 py-2 font-mono text-sm text-ink">
                            {p.public_address}
                          </code>
                        </div>
                      ) : (
                        <p className="text-ink-3">No public address yet{p.key === 'website' || p.key === 'bookings' || p.key === 'qr' ? ': the venue has no verified site host.' : '.'}</p>
                      )}
                      {!p.on && p.needs.length ? (
                        <p className="text-ink-2">
                          <span className="font-medium text-ink">Needs:</span> {p.needs.join(' ')}
                        </p>
                      ) : null}
                      {status.label === 'Needs setup' ? <p className="text-warn">The venue is not live yet, so guests cannot reach this channel. Finish setup from Home.</p> : null}
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        <Link href={`/console/plugins#plugin-${p.key}`} className="text-accent" data-testid={`channel-configure-${p.key}`}>
                          Configure
                        </Link>
                        {open && p.on ? (
                          <Link href={open.href} className="text-accent">
                            Open {open.label}
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          );
        })()
      )}
    </>
  );
}
