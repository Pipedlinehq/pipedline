import type { ReactNode } from 'react';
import { atLeast, getConsole } from '@/lib/console';
import { moduleStates } from '@/lib/console-modules';
import { GUEST_FACING_ROLES } from '@ros/core';
import { Button } from '@/ui';
import { FlashRegion } from '@/components/console/flash';
import { signOut } from '../login/actions';
import { selectVenue } from './actions';
import { ConsoleNav, VenueSelect, type NavGroup } from './nav';

export const dynamic = 'force-dynamic';

/**
 * The console frame. Navigation shows what the person's role at the selected venue can use;
 * that is a courtesy, not the control: every page and action checks the role again on the server.
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const c = await getConsole();
  const manager = atLeast(c.role, 'manager');
  const guestFacing = manager || GUEST_FACING_ROLES.includes(c.role);
  // A switched-off module's screens leave the navigation; its services refuse whatever is typed.
  const on = await moduleStates();
  const groups: NavGroup[] = [
    {
      label: 'Today',
      items: [
        { href: '/console', label: 'Overview' },
        ...(on.ordering ? [{ href: '/console/orders', label: 'Orders' }] : []),
        ...(manager ? [{ href: '/console/approvals', label: 'Approvals' }] : []),
      ],
    },
    {
      label: 'Guests',
      items: [
        ...(guestFacing ? [{ href: '/console/customers', label: 'Customers' }] : []),
        ...(on.loyalty ? [{ href: '/console/loyalty', label: 'Loyalty' }] : []),
        ...(on.offers ? [{ href: '/console/offers', label: 'Offers' }] : []),
        ...(manager && on.campaigns ? [{ href: '/console/campaigns', label: 'Campaigns' }] : []),
        ...(on.reviews ? [{ href: '/console/reviews', label: 'Reviews' }] : []),
      ],
    },
    {
      label: 'Venue',
      items: [
        { href: '/console/menu', label: 'Menu' },
        ...(on.qr ? [{ href: '/console/qr', label: 'QR codes' }] : []),
        ...(on.delivery ? [{ href: '/console/delivery', label: 'Delivery' }] : []),
        ...(manager && on.website ? [{ href: '/console/website', label: 'Website' }] : []),
        ...(manager ? [{ href: '/console/hours', label: 'Hours' }] : []),
      ],
    },
    {
      label: 'Insight',
      items: [
        { href: '/console/analytics', label: 'Analytics' },
        { href: '/console/analytics/marketing', label: 'Marketing' },
        { href: '/console/analytics/menu', label: 'Menu performance' },
        { href: '/console/analytics/customers', label: 'Customer insight' },
        { href: '/console/analytics/digest', label: 'Weekly digest' },
        { href: '/console/analytics/dictionary', label: 'Data dictionary' },
      ],
    },
    ...(manager
      ? [
          {
            label: 'Settings',
            items: [
              { href: '/console/settings/features', label: 'Features' },
              { href: '/console/settings/connections', label: 'Connected services' },
              { href: '/console/settings/assistants', label: 'Assistant access' },
              { href: '/console/settings/team', label: 'Team' },
              { href: '/console/settings/screens', label: 'Kitchen screens' },
              ...(c.isOwner ? [{ href: '/console/settings/privacy', label: 'Privacy and records' }] : []),
            ],
          },
        ]
      : []),
  ];

  return (
    <div className="grid min-h-dvh grid-cols-1 md:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="border-b border-line bg-surface px-3 py-4 md:border-b-0 md:border-r">
        <div className="px-3">
          <p className="truncate text-sm font-semibold text-ink">{c.org.tradingName}</p>
          <div className="mt-2">
            <VenueSelect venues={c.venues.map((v) => ({ id: v.id, name: v.name }))} selected={c.venue.id} action={selectVenue} />
          </div>
        </div>
        <div className="mt-5">
          <ConsoleNav groups={groups} />
        </div>
        <form action={signOut} className="mt-6 px-3">
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>
      </aside>
      <main className="min-w-0 px-5 py-6 md:px-8 md:py-8">{children}</main>
      <FlashRegion />
    </div>
  );
}
