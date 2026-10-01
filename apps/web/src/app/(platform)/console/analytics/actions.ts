'use server';

import { analytics } from '@ros/modules';
import type { FormState } from '@/ui/client';
import { act, bool, int, optText, text } from '@/lib/console-actions';

/** Analytics changes. The services make every role check; the venue comes from the console. */

export async function buildDigestAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const period = text(fd, 'period') as 'day' | 'week' | 'month';
  const scope = text(fd, 'scope');
  return act(
    async (ctx, c) => {
      const venueId = scope === 'venue' && c.venues.length > 1 ? c.venue.id : undefined;
      return analytics.buildDigest(ctx, { period, venueId });
    },
    { success: (d) => `Written: ${d.summary.slice(0, 140)}${d.summary.length > 140 ? '…' : ''}`, revalidate: '/console/analytics/digest' },
  );
}

export async function saveViewAction(_prev: FormState, fd: FormData): Promise<FormState> {
  let query: unknown;
  try {
    query = JSON.parse(text(fd, 'query'));
  } catch {
    return { ok: false, error: 'That question could not be read. Run it again, then save.' };
  }
  return act((ctx) => analytics.saveView(ctx, { name: text(fd, 'name'), description: optText(fd, 'description') ?? null, query: query as analytics.MetricQuery, pinned: bool(fd, 'pinned') }), {
    success: (v) => `Saved as “${v.name}”${v.pinned ? ' and pinned to the overview' : ''}.`,
    revalidate: ['/console/analytics/views', '/console'],
  });
}

export async function pinViewAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const pinned = text(fd, 'pinned') === 'true';
  return act((ctx) => analytics.pinView(ctx, { id: text(fd, 'id'), pinned }), { success: pinned ? 'Pinned to the overview.' : 'Unpinned.', revalidate: ['/console/analytics/views', '/console'] });
}

export async function deleteViewAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx) => analytics.deleteView(ctx, { id: text(fd, 'id') }), { success: 'Deleted. The data it asked about is untouched.', revalidate: ['/console/analytics/views', '/console'] });
}

export async function saveAnalyticsSettingsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const dayparts: Array<{ key: string; fromHour: number; toHour: number }> = [];
  for (let i = 0; i < 8; i++) {
    const key = text(fd, `daypart_${i}_key`);
    if (!key) continue;
    dayparts.push({ key, fromHour: int(fd, `daypart_${i}_from`) ?? 0, toHour: int(fd, `daypart_${i}_to`) ?? 0 });
  }
  return act(
    (ctx) =>
      analytics.setAnalyticsSettings(ctx, {
        minCohort: int(fd, 'minCohort'),
        campaignQuietDays: int(fd, 'campaignQuietDays'),
        dayparts,
        segments: {
          newWindowDays: int(fd, 'newWindowDays')!,
          atRiskDays: int(fd, 'atRiskDays')!,
          lapsedDays: int(fd, 'lapsedDays')!,
          frequentOrders: int(fd, 'frequentOrders')!,
          loyalOrders: int(fd, 'loyalOrders')!,
        },
        digest: {
          baselinePeriods: int(fd, 'baselinePeriods')!,
          notableSd: Number(text(fd, 'notableSd')),
          strongSd: Number(text(fd, 'strongSd')),
          minChangeRatio: Number(text(fd, 'minChangePct')) / 100,
          topMovers: int(fd, 'topMovers')!,
        },
      }),
    { success: 'Saved. Numbers that depend on these settings are worked out again the next time they are asked for.', revalidate: '/console' },
  );
}
