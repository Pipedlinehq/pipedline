'use server';

import { auth } from '@ros/modules';
import { act, text, type DataFormState } from '@/lib/console-actions';
import { dateTime } from '@/ui/format';
import type { FormState } from '@/ui/client';

export async function pairScreen(_prev: DataFormState<{ code: string; name: string; expiresAt: string }>, fd: FormData): Promise<DataFormState<{ code: string; name: string; expiresAt: string }>> {
  const name = text(fd, 'name');
  const purpose = text(fd, 'purpose') === 'counter' ? 'counter' : 'kitchen';
  const r = await act(async (ctx, c) => {
    const made = await auth.createDevicePairing(ctx, { venueId: c.venue.id, name, purpose });
    return { code: made.code, name, expiresAt: dateTime(made.expiresAt, c.venue.timezone, { date: false }) };
  }, { revalidate: '/console/settings/screens' });
  return r;
}

export async function revokeScreen(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = text(fd, 'deviceId');
  return act((ctx) => auth.revokeDevice(ctx, id), { success: 'Screen revoked. It is signed out and cannot reconnect without a new code.', revalidate: '/console/settings/screens' });
}
