'use server';

import { redirect } from 'next/navigation';
import { campaigns } from '@ros/modules';
import type { ParseState } from '@/components/console/list-builder';
import { act, nullableText, optText, text } from '@/lib/console-actions';
import { runAction } from '@/lib/actions';
import type { FormState } from '@/ui/client';
import { describeQuery } from './rows';

/** Guest lists' server actions. The services parse the rule; nothing here trusts the text. */

/** The text a person typed, parsed by the grammar: back as canonical text, words and (when flat) rows. */
export async function parseListTextAction(_prev: ParseState, fd: FormData): Promise<ParseState> {
  const raw = text(fd, 'text') || text(fd, 'query');
  if (!raw.trim()) return { ok: false, error: 'Write the rule first.' };
  const r = await runAction(async () => describeQuery(raw));
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error };
}

export async function saveListAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = optText(fd, 'id');
  const query = text(fd, 'query') || text(fd, 'text');
  if (!query.trim()) return { ok: false, error: 'Fill in at least one condition.' };
  const r = await act((ctx) => campaigns.saveSegment(ctx, { id, name: text(fd, 'name'), description: nullableText(fd, 'description'), query }), {
    revalidate: ['/console/customers/lists', '/console/customers', ...(id ? [`/console/customers/lists/${id}`] : [])],
  });
  if (!r.ok) return r;
  if (!id) redirect(`/console/customers/lists/${r.data!.id}?created=1`);
  return { ok: true, message: 'List saved.' };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** How many guests the rule holds now, at the venue being looked at and across the organisation. Counts only. */
export async function previewListAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const query = text(fd, 'query') || text(fd, 'text');
  if (!query.trim()) return { ok: false, error: 'Fill in at least one condition first.' };
  return act(
    async (ctx, c) => {
      const here = await campaigns.previewSegment(ctx, { query, venueId: c.venue.id });
      const all = await campaigns.previewSegment(ctx, { query });
      return { here, all, venue: c.venue.name };
    },
    {
      success: ({ here, all, venue }) =>
        `${all.count.toLocaleString('en-AU')} guests match across the organisation, ${here.count.toLocaleString('en-AU')} of them calling ${venue} home. ${all.email.reachable.toLocaleString('en-AU')} can be emailed (${pct(all.email.share)}) and ${all.sms.reachable.toLocaleString('en-AU')} can be sent a text (${pct(all.sms.share)}); the rest have not said yes to hearing from you that way.`,
    },
  );
}

export async function deleteListAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const r = await act((ctx) => campaigns.deleteSegment(ctx, text(fd, 'id')), { revalidate: ['/console/customers/lists', '/console/customers'] });
  if (!r.ok) return r;
  redirect('/console/customers/lists?deleted=1');
}
