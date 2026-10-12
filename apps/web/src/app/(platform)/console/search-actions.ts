'use server';

import { GUEST_FACING_ROLES } from '@ros/core';
import { bookings, identity, menu, ordering } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { CHANNEL_LABEL } from '@/components/console/order-bits';
import { BOOKING_STATUS } from '@/components/console/booking-bits';
import { money } from '@/ui/format';

/**
 * Global search (docs/CONSOLE_IA.md section 1 "nice to have"; section 9, wave 1; pattern 15):
 * orders by reference, guests by name, email or phone, menu items by name, bookings by name or
 * reference, at the venue the console is looking at. Every group goes through the same service
 * function its page uses, so a role that cannot see guests gets no guests and another org's
 * records never appear. Results are links.
 */
export type SearchCategory = 'all' | 'orders' | 'guests' | 'menu' | 'bookings';

export interface SearchHit {
  href: string;
  title: string;
  detail: string;
}

export interface SearchGroup {
  key: Exclude<SearchCategory, 'all'>;
  label: string;
  hits: SearchHit[];
}

const CATEGORIES: SearchCategory[] = ['all', 'orders', 'guests', 'menu', 'bookings'];

export async function searchConsole(rawQ: string, rawCategory: string): Promise<{ q: string; groups: SearchGroup[] }> {
  const q = (typeof rawQ === 'string' ? rawQ : '').trim().slice(0, 100);
  const category: SearchCategory = CATEGORIES.includes(rawCategory as SearchCategory) ? (rawCategory as SearchCategory) : 'all';
  if (q.length < 2) return { q, groups: [] };
  const c = await getConsole();
  const manager = atLeast(c.role, 'manager');
  const seesGuests = manager || GUEST_FACING_ROLES.includes(c.role);
  const want = (k: Exclude<SearchCategory, 'all'>) => category === 'all' || category === k;
  const tz = c.venue.timezone;
  const [ordersOn, bookingsOn] = await Promise.all([moduleOn('ordering'), moduleOn('bookings')]);
  const [orders, guests, items, booked] = await Promise.all([
    want('orders') && ordersOn ? read((ctx) => ordering.listOrders(ctx, { venueId: c.venue.id, reference: q, limit: 7 })) : null,
    want('guests') && seesGuests ? read((ctx) => identity.searchCustomers(ctx, { q, limit: 7 })) : null,
    want('menu') ? read((ctx) => menu.getMenuEditor(ctx, c.venue.id, { q })) : null,
    want('bookings') && bookingsOn && seesGuests ? read((ctx) => bookings.searchBookings(ctx, { venueId: c.venue.id, q, limit: 7 })) : null,
  ]);
  const groups: SearchGroup[] = [];
  if (orders?.ok && orders.data.length) {
    groups.push({
      key: 'orders',
      label: 'Orders',
      hits: orders.data.map((o) => ({ href: `/console/orders/${o.id}`, title: `Order ${o.reference}`, detail: `${CHANNEL_LABEL[o.channel] ?? o.channel} · ${money(o.totalCents, o.currency)} · ${o.status.replace(/_/g, ' ')} · ${when(o.placedAt ?? o.createdAt, tz)}` })),
    });
  }
  if (guests?.ok && guests.data.length) {
    groups.push({ key: 'guests', label: 'Guests', hits: guests.data.map((g) => ({ href: `/console/customers/${g.id}`, title: g.name, detail: [g.email, g.phone].filter(Boolean).join(' · ') || 'No contact details' })) });
  }
  if (items?.ok) {
    const hits = items.data.menus.flatMap((m) => m.sections.flatMap((s) => s.items.map((i) => ({ href: manager ? `/console/menu/items/${i.id}` : `/console/menu?view=all&f=1&q=${encodeURIComponent(i.name)}`, title: i.name, detail: `${m.name} · ${s.name} · ${money(i.priceCents)}${i.isAvailable ? '' : " · 86'd"}` })))).slice(0, 7);
    if (hits.length) groups.push({ key: 'menu', label: 'Menu items', hits });
  }
  if (booked?.ok && booked.data.length) {
    groups.push({
      key: 'bookings',
      label: 'Bookings',
      hits: booked.data.map((b) => ({ href: `/console/bookings/${b.id}`, title: `${b.guestName ?? 'Booking'} · ${b.reference}`, detail: `${b.partySize} ${b.partySize === 1 ? 'guest' : 'guests'} · ${b.date} ${b.time} · ${BOOKING_STATUS[b.status]?.label ?? b.status}` })),
    });
  }
  return { q, groups };
}

function when(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: tz, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(at);
}
