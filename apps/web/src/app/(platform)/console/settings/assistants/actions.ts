'use server';

import { hub } from '@ros/modules';
import { act, all, bool, int, text, type DataFormState } from '@/lib/console-actions';
import { dateTime } from '@/ui/format';
import type { FormState } from '@/ui/client';

type Made = { key: string; name: string; expiresAt: string };

/**
 * Create a key for the signed-in person. The key goes back in this response only, to the one
 * browser that asked; the page never renders it from the server again.
 */
export async function createKey(_prev: DataFormState<Made>, fd: FormData): Promise<DataFormState<Made>> {
  const venues = all(fd, 'venueIds');
  return act(
    async (ctx, c) => {
      // Only the person's own venues can be named; the service refuses anything else as not-found.
      const venueIds = venues.filter((id) => c.venues.some((v) => v.id === id));
      const made = await hub.createAgentKey(ctx, {
        name: text(fd, 'name'),
        scopes: all(fd, 'scopes'),
        venueIds: venueIds.length ? venueIds : null,
        canWrite: bool(fd, 'canWrite'),
        expiresInDays: int(fd, 'expiresInDays') ?? 30,
      });
      return { key: made.key, name: made.view.name, expiresAt: dateTime(made.view.expiresAt, c.venue.timezone, { date: true, time: false }) };
    },
    { revalidate: '/console/settings/assistants' },
  );
}

export async function revokeKey(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = text(fd, 'keyId');
  return act((ctx) => hub.revokeAgentKey(ctx, id), { success: 'Key revoked. Any assistant using it is cut off now.', revalidate: '/console/settings/assistants' });
}

export async function setKeyCanWrite(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = text(fd, 'keyId');
  const canWrite = text(fd, 'canWrite') === 'true';
  return act((ctx) => hub.setAgentKeyCanWrite(ctx, id, canWrite), {
    success: canWrite ? 'This key may now propose changes. Each one still waits for its person to say yes.' : 'This key can read only.',
    revalidate: '/console/settings/assistants',
  });
}
