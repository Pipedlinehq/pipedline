'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { getConsole, VENUE_COOKIE } from '@/lib/console';

export async function selectVenue(form: FormData): Promise<void> {
  const c = await getConsole();
  const id = String(form.get('venueId') ?? '');
  // Only a venue the person has a role at can be selected.
  if (!c.venues.some((v) => v.id === id)) return;
  (await cookies()).set(VENUE_COOKIE, id, { httpOnly: true, sameSite: 'lax', path: '/console', maxAge: 180 * 86_400 });
  revalidatePath('/console', 'layout');
}
