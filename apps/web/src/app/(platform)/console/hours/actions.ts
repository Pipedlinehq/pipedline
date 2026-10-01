'use server';

import { tenancy } from '@ros/modules';
import { act, int, nullableText, text } from '@/lib/console-actions';
import type { FormState } from '@/ui/client';

const ok = (r: FormState & { data?: unknown }): FormState => (r && r.ok ? { ok: true, message: r.message } : r);

/** The weekly hours arrive as parallel lists, one entry per row; a row with no opening time is dropped. */
export async function saveTradingHours(_: FormState, fd: FormData): Promise<FormState> {
  const day = fd.getAll('day').map(String);
  const opens = fd.getAll('opensAt').map(String);
  const closes = fd.getAll('closesAt').map(String);
  const service = fd.getAll('serviceType').map(String);
  const rows: Array<{ dayOfWeek: number; opensAt: string; closesAt: string; serviceType: string }> = [];
  for (let i = 0; i < day.length; i++) {
    const o = opens[i]?.trim() ?? '';
    const cl = closes[i]?.trim() ?? '';
    if (!o && !cl) continue;
    if (!o || !cl) return { ok: false, error: 'Each period needs both an opening and a closing time.' };
    rows.push({ dayOfWeek: Number(day[i]), opensAt: o, closesAt: cl, serviceType: service[i]?.trim() || 'all' });
  }
  return ok(
    await act((ctx, c) => tenancy.setTradingHours(ctx, c.venue.id, rows), {
      success: (h) => `Weekly hours saved: ${h.length} ${h.length === 1 ? 'period' : 'periods'}.`,
      revalidate: '/console/hours',
    }),
  );
}

export async function addException(_: FormState, fd: FormData): Promise<FormState> {
  const closed = text(fd, 'mode') !== 'open';
  return ok(
    await act(
      (ctx, c) =>
        tenancy.setHourException(ctx, c.venue.id, {
          date: text(fd, 'date'),
          closed,
          opensAt: closed ? null : nullableText(fd, 'opensAt'),
          closesAt: closed ? null : nullableText(fd, 'closesAt'),
          reason: nullableText(fd, 'reason'),
        }),
      { success: (e) => `${e.date}: ${e.closed ? 'closed' : `open ${e.opensAt?.slice(0, 5)}–${e.closesAt?.slice(0, 5)}`}.`, revalidate: '/console/hours' },
    ),
  );
}

export async function removeException(_: FormState, fd: FormData): Promise<FormState> {
  return ok(await act((ctx, c) => tenancy.removeHourException(ctx, c.venue.id, text(fd, 'date')), { success: 'Removed. The weekly hours apply that day.', revalidate: '/console/hours' }));
}

export async function saveVenue(_: FormState, fd: FormData): Promise<FormState> {
  const capacity = int(fd, 'capacity');
  const priceBand = int(fd, 'priceBand');
  if (Number.isNaN(capacity) || Number.isNaN(priceBand)) return { ok: false, error: 'Capacity and price band are whole numbers.' };
  return ok(
    await act(
      (ctx, c) =>
        tenancy.updateVenue(ctx, c.venue.id, {
          name: text(fd, 'name'),
          phone: nullableText(fd, 'phone'),
          email: nullableText(fd, 'email'),
          addressLine1: nullableText(fd, 'addressLine1'),
          addressLine2: nullableText(fd, 'addressLine2'),
          suburb: nullableText(fd, 'suburb'),
          state: nullableText(fd, 'state'),
          postcode: nullableText(fd, 'postcode'),
          capacity: capacity ?? null,
          priceBand: priceBand ?? null,
        }),
      { success: 'Venue details saved.', revalidate: '/console' },
    ),
  );
}
