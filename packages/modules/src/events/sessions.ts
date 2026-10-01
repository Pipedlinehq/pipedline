import { z } from 'zod';
import { type Ctx, type EventDef, getEventDef, invalid, json, listEventDefs, track, type TrackOptions } from '@ros/core';
import { sessionStarted } from './module';

export const sessionInput = z.object({
  sessionId: z.string().uuid(),
  venueId: z.string().uuid().nullish(),
  landingPath: z.string().max(500).default('/'),
  referrer: z.string().max(1000).nullish(),
  utmSource: z.string().max(100).nullish(),
  utmMedium: z.string().max(100).nullish(),
  utmCampaign: z.string().max(200).nullish(),
  utmContent: z.string().max(200).nullish(),
  creatorId: z.string().max(100).nullish(),
  campaignId: z.string().max(100).nullish(),
  code: z.string().max(60).nullish(),
  qrCodeId: z.string().uuid().nullish(),
  deviceClass: z.enum(['mobile', 'tablet', 'desktop']).nullish(),
});

export interface SessionAttribution {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  creatorId: string | null;
  campaignId: string | null;
  code: string | null;
  qrCodeId: string | null;
  landingPath: string | null;
  customerId: string | null;
  venueId: string | null;
}

/**
 * Start or refresh a visitor session. The first-touch fields (landing page, referrer, campaign,
 * creator) are written once, when the session is first seen, and never overwritten.
 */
export async function touchSession(ctx: Ctx, raw: z.input<typeof sessionInput>): Promise<{ created: boolean }> {
  const input = sessionInput.parse(raw);
  const now = ctx.now();
  const inserted = await ctx.db
    .insertInto('visitor_sessions')
    .values({
      id: input.sessionId,
      org_id: ctx.orgId,
      venue_id: input.venueId ?? null,
      first_seen_at: now,
      last_seen_at: now,
      landing_path: input.landingPath,
      referrer: input.referrer ?? null,
      utm_source: input.utmSource ?? null,
      utm_medium: input.utmMedium ?? null,
      utm_campaign: input.utmCampaign ?? null,
      utm_content: input.utmContent ?? null,
      creator_id: input.creatorId ?? null,
      campaign_id: input.campaignId ?? null,
      code: input.code ?? null,
      qr_code_id: input.qrCodeId ?? null,
      device_class: input.deviceClass ?? null,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .returning('id')
    .executeTakeFirst();

  if (!inserted) {
    // The id exists. If it belongs to another org, row-level security hides it and this updates nothing.
    await ctx.db.updateTable('visitor_sessions').set({ last_seen_at: now }).where('id', '=', input.sessionId).execute();
    return { created: false };
  }

  let referrerHost: string | null = null;
  try {
    referrerHost = input.referrer ? new URL(input.referrer).host.slice(0, 200) : null;
  } catch {
    referrerHost = null;
  }
  await track(ctx, sessionStarted, { landing_path: input.landingPath, referrer_host: referrerHost, device_class: input.deviceClass ?? null }, {
    venueId: input.venueId ?? null,
    sessionId: input.sessionId,
    source: 'web',
    attribution: {
      utmSource: input.utmSource,
      utmMedium: input.utmMedium,
      utmCampaign: input.utmCampaign,
      creatorId: input.creatorId,
      campaignId: input.campaignId,
      code: input.code,
    },
  });
  return { created: true };
}

export async function getSessionAttribution(ctx: Ctx, sessionId: string | null | undefined): Promise<SessionAttribution | null> {
  if (!sessionId) return null;
  const r = await ctx.db
    .selectFrom('visitor_sessions')
    .select(['utm_source', 'utm_medium', 'utm_campaign', 'creator_id', 'campaign_id', 'code', 'qr_code_id', 'landing_path', 'customer_id', 'venue_id'])
    .where('id', '=', sessionId)
    .executeTakeFirst();
  if (!r) return null;
  return {
    utmSource: r.utm_source,
    utmMedium: r.utm_medium,
    utmCampaign: r.utm_campaign,
    creatorId: r.creator_id,
    campaignId: r.campaign_id,
    code: r.code,
    qrCodeId: r.qr_code_id,
    landingPath: r.landing_path,
    customerId: r.customer_id,
    venueId: r.venue_id,
  };
}

/** Once a visitor becomes a known customer (an order, a sign-in), later events carry who they are. */
export async function linkSessionToCustomer(ctx: Ctx, sessionId: string | null | undefined, customerId: string): Promise<void> {
  if (!sessionId) return;
  await ctx.db.updateTable('visitor_sessions').set({ customer_id: customerId }).where('id', '=', sessionId).where('customer_id', 'is', null).execute();
}

/**
 * track(), with the session's campaign and creator copied onto the event so every step of a
 * visit can be grouped by what brought the visitor in. Modules use this for anything a guest does.
 */
export async function trackInSession<P>(
  ctx: Ctx,
  def: EventDef<P>,
  properties: P,
  opts: Omit<TrackOptions, 'attribution'> & { sessionId?: string | null },
): Promise<void> {
  const s = await getSessionAttribution(ctx, opts.sessionId);
  await track(ctx, def, properties, {
    ...opts,
    venueId: opts.venueId ?? s?.venueId ?? null,
    customerId: opts.customerId ?? s?.customerId ?? null,
    attribution: s
      ? { utmSource: s.utmSource, utmMedium: s.utmMedium, utmCampaign: s.utmCampaign, creatorId: s.creatorId, campaignId: s.campaignId, code: s.code }
      : undefined,
  });
}

export const collectInput = z.object({
  sessionId: z.string().uuid(),
  venueId: z.string().uuid().nullish(),
  events: z
    .array(z.object({ name: z.string().max(80), properties: z.record(z.string(), z.unknown()).default({}), at: z.string().datetime().optional() }))
    .min(1)
    .max(20),
});

/**
 * The browser beacon. Only events declared with `client: true` are accepted, their properties
 * are validated against the declared shape, and a client-supplied time may trail the server's
 * by at most ten minutes. Anything else in the batch is dropped, not stored.
 */
export async function collect(ctx: Ctx, raw: z.input<typeof collectInput>): Promise<{ accepted: number; dropped: number }> {
  const input = collectInput.parse(raw);
  const session = await getSessionAttribution(ctx, input.sessionId);
  if (!session) throw invalid('Unknown session.');
  const now = ctx.now();
  let accepted = 0;
  let dropped = 0;
  const rows = [];
  for (const e of input.events) {
    const def = getEventDef(e.name);
    const parsed = def?.client ? def.properties.safeParse(e.properties) : null;
    if (!def || !parsed?.success) {
      dropped++;
      continue;
    }
    let at = now;
    if (e.at) {
      const t = new Date(e.at);
      if (t <= now && now.getTime() - t.getTime() <= 600_000) at = t;
    }
    rows.push({
      org_id: ctx.orgId,
      venue_id: input.venueId ?? session.venueId,
      customer_id: session.customerId,
      session_id: input.sessionId,
      name: def.name,
      occurred_at: at,
      source: 'web' as const,
      properties: json(parsed.data),
      utm_source: session.utmSource,
      utm_medium: session.utmMedium,
      utm_campaign: session.utmCampaign,
      creator_id: session.creatorId,
      campaign_id: session.campaignId,
      code: session.code,
    });
    accepted++;
  }
  if (rows.length) await ctx.db.insertInto('events').values(rows).execute();
  await ctx.db.updateTable('visitor_sessions').set({ last_seen_at: now }).where('id', '=', input.sessionId).execute();
  return { accepted, dropped };
}

export interface EventDictionaryEntry {
  name: string;
  module: string;
  description: string;
  sent_by: 'browser' | 'server';
  funnel: { name: string; step: number } | null;
  properties: unknown;
}

/** The stream's data dictionary: every event that can occur, what it means, and its properties. */
export function eventDictionary(): EventDictionaryEntry[] {
  return listEventDefs()
    .map((d) => ({
      name: d.name,
      module: d.module,
      description: d.description,
      sent_by: (d.client ? 'browser' : 'server') as 'browser' | 'server',
      funnel: d.funnel ?? null,
      properties: z.toJSONSchema(d.properties),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
