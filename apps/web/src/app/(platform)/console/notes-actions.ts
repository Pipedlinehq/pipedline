'use server';

import { events } from '@ros/modules';
import { act, text } from '@/lib/console-actions';
import type { FormState } from '@/ui/client';

/**
 * Staff notes on a record (docs/CONSOLE_IA.md section 9, wave 1). The venue comes from the page
 * (the record's own venue), and the service checks the person's role there; an id from another
 * venue or org is not found.
 */
const ENTITIES = ['order', 'booking', 'customer'] as const;
type Entity = (typeof ENTITIES)[number];
const isEntity = (v: string): v is Entity => (ENTITIES as readonly string[]).includes(v);

const pathFor = (entity: Entity, id: string) => (entity === 'order' ? `/console/orders/${id}` : entity === 'booking' ? `/console/bookings/${id}` : `/console/customers/${id}`);

export async function addNote(_prev: FormState, fd: FormData): Promise<FormState> {
  const entityType = text(fd, 'entityType');
  const entityId = text(fd, 'entityId');
  if (!isEntity(entityType)) return { ok: false, error: 'Notes go on an order, a booking or a guest.' };
  const r = await act((ctx) => events.addStaffNote(ctx, { venueId: text(fd, 'venueId'), entityType, entityId, body: text(fd, 'body') }), {
    success: (n) => (n.mentions.length ? `Note left. ${n.mentions.length === 1 ? 'One person was' : `${n.mentions.length} people were`} mentioned.` : 'Note left for the team.'),
    revalidate: pathFor(entityType, entityId),
  });
  return r.ok ? { ok: true, message: r.message } : r;
}

export async function removeNote(_prev: FormState, fd: FormData): Promise<FormState> {
  const entityType = text(fd, 'entityType');
  const entityId = text(fd, 'entityId');
  const r = await act((ctx) => events.deleteStaffNote(ctx, text(fd, 'noteId')), { success: 'Note removed.', revalidate: isEntity(entityType) ? pathFor(entityType, entityId) : '/console' });
  return r.ok ? { ok: true, message: r.message } : r;
}
