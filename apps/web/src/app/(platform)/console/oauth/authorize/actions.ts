'use server';

import { redirect } from 'next/navigation';
import { hub } from '@ros/modules';
import type { FormState } from '@/ui/client';
import { runAction } from '@/lib/actions';
import { inConsole } from '@/lib/console';
import { all, bool, int, text } from '@/lib/console-actions';

/**
 * The person's answer on the consent page. The request travels as the query string it arrived
 * with and is validated again by the hub on the way in, so nothing typed into this form can
 * change which assistant is connected or where the person is sent afterwards. The connection is
 * made for the person signed in, in their session's organisation.
 */
export async function decideOAuthAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const query = new URLSearchParams(text(fd, 'request'));
  const allow = text(fd, 'answer') === 'allow';
  const offered = all(fd, 'offeredVenue');
  const picked = all(fd, 'venue');
  const r = await runAction(() =>
    inConsole((ctx) =>
      hub.decideOAuthRequest(ctx, query, {
        allow,
        allowChanges: bool(fd, 'allowChanges'),
        // Every venue ticked means "all of mine, now and later"; fewer is that exact list.
        venueIds: allow && picked.length < offered.length ? picked : undefined,
        lastsDays: int(fd, 'lastsDays'),
      }),
    ),
  );
  if (!r.ok) return { ok: false, error: r.error };
  redirect(r.data.redirectTo);
}
