import 'server-only';
import { GUEST_FACING_ROLES } from '@ros/core';
import { atLeast, type ConsoleContext } from './console';
import { moduleStates } from './console-modules';

/**
 * The console's twelve sections, in the order docs/CONSOLE_IA.md section 1 gives them. A section
 * is a link to its first page and the pages it holds. What a person is shown follows their role
 * at the selected venue and which modules are on there; that is a courtesy, not the control:
 * every page and action checks the role again on the server, and a switched-off module's
 * services answer as not-found whatever the navigation shows.
 */
export interface NavLink {
  href: string;
  label: string;
}

export interface NavSection {
  key: string;
  label: string;
  /** Where the section's item leads: its first page. */
  href: string;
  /** The pages inside it, shown when the section is the current one. */
  items: NavLink[];
  /** On the phone bar: Home, Orders, Bookings, Menu. The rest sit behind "More". */
  phone?: boolean;
}

export const SECTION_ORDER = ['home', 'orders', 'bookings', 'menu', 'customers', 'marketing', 'offers', 'website', 'analytics', 'channels', 'plugins', 'assistant', 'settings'] as const;

export async function consoleSections(c: ConsoleContext): Promise<NavSection[]> {
  const manager = atLeast(c.role, 'manager');
  const guestFacing = manager || GUEST_FACING_ROLES.includes(c.role);
  const on = await moduleStates();

  const section = (key: string, label: string, items: NavLink[], phone = false): NavSection | null => (items.length ? { key, label, href: items[0]!.href, items, phone } : null);

  const sections: Array<NavSection | null> = [
    section('home', 'Home', [{ href: '/console', label: 'Home' }], true),
    section(
      'orders',
      'Orders',
      [
        ...(on.ordering ? [{ href: '/console/orders', label: 'Orders' }] : []),
        ...(on.delivery ? [{ href: '/console/delivery', label: 'Delivery' }] : []),
        ...(manager ? [{ href: '/console/settings/screens', label: 'Kitchen screens' }] : []),
      ],
      true,
    ),
    section(
      'bookings',
      'Bookings',
      on.bookings && guestFacing ? [{ href: '/console/bookings', label: 'The book' }, ...(manager ? [{ href: '/console/bookings/settings', label: 'Booking rules' }] : [])] : [],
      true,
    ),
    section('menu', 'Menu', [{ href: '/console/menu', label: 'Menus and items' }, ...(manager ? [{ href: '/console/menu/import', label: 'Menu import' }] : [])], true),
    section('customers', 'Customers', [
      ...(guestFacing ? [{ href: '/console/customers', label: 'Guests' }] : []),
      ...(manager && on.campaigns ? [{ href: '/console/customers/lists', label: 'Guest lists' }] : []),
      ...(on.loyalty ? [{ href: '/console/loyalty', label: 'Loyalty' }] : []),
      ...(on.reviews ? [{ href: '/console/reviews', label: 'Reviews' }] : []),
    ]),
    section('marketing', 'Marketing', manager ? [...(on.campaigns ? [{ href: '/console/campaigns', label: 'Campaigns' }, { href: '/console/campaigns/flows', label: 'Lifecycle flows' }] : []), { href: '/console/approvals', label: 'Approvals' }] : []),
    section('offers', 'Offers', [
      ...(on.offers ? [{ href: '/console/offers', label: 'Offers and vouchers' }] : []),
      ...(on.offers && manager ? [{ href: '/console/offers/surcharges', label: 'Surcharges' }] : []),
      ...(on.loyalty && manager ? [{ href: '/console/loyalty/program', label: 'Loyalty rules' }] : []),
    ]),
    section('website', 'Website', [
      ...(manager && on.website ? [{ href: '/console/website', label: 'Pages and brand' }] : []),
      ...(manager ? [{ href: '/console/hours', label: 'Hours' }] : []),
      ...(on.qr ? [{ href: '/console/qr', label: 'QR codes' }] : []),
    ]),
    section('analytics', 'Analytics', [
      { href: '/console/analytics', label: 'Sales' },
      { href: '/console/analytics/reports', label: 'Reports' },
      { href: '/console/analytics/overview', label: 'Overview' },
      { href: '/console/analytics/menu', label: 'Menu performance' },
      { href: '/console/analytics/customers', label: 'Customer insight' },
      { href: '/console/analytics/marketing', label: 'Marketing' },
      { href: '/console/analytics/views', label: 'Saved views' },
      { href: '/console/analytics/digest', label: 'Weekly digest' },
      { href: '/console/analytics/dictionary', label: 'Data dictionary' },
    ]),
    section('channels', 'Channels', manager ? [{ href: '/console/channels', label: 'Channels' }] : []),
    section('plugins', 'Plugins', manager ? [{ href: '/console/plugins', label: 'Catalogue' }, { href: '/console/settings/features', label: 'Features' }, { href: '/console/settings/connections', label: 'Connected services' }] : []),
    section('assistant', 'Assistant', manager ? [{ href: '/console/assistant', label: 'Assistant' }] : []),
    section(
      'settings',
      'Settings',
      manager ? [{ href: '/console/settings/team', label: 'Team' }, { href: '/console/settings/notifications', label: 'Notifications' }, { href: '/console/settings/screens', label: 'Kitchen screens' }, { href: '/console/activity', label: 'Activity' }, ...(c.isOwner ? [{ href: '/console/settings/privacy', label: 'Privacy and records' }] : [])] : [],
    ),
  ];
  return sections.filter((s): s is NavSection => s !== null);
}
