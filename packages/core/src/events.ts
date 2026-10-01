import { z } from 'zod';
import type { Ctx } from './app';
import { json } from './json';
import { keyedRegistry, register } from './registry';

/**
 * The first-party event stream. One append-only table; every event name is declared here with
 * its property shape, so the stream is its own data dictionary (for the console and for an
 * assistant asking "what can I measure?"). docs/SCHEMA.md section 4.
 */
export interface EventDef<P = unknown> {
  name: string;
  module: string;
  description: string;
  properties: z.ZodType<P>;
  /** Marks steps that matter in a funnel, in order, e.g. order funnel step 3. */
  funnel?: { name: string; step: number };
  /** True when a browser may send this event through the collector. Everything else is server-only. */
  client?: boolean;
}

const registry = keyedRegistry<EventDef<any>>('events');

export function defineEvent<P>(def: EventDef<P>): EventDef<P> {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(def.name)) {
    throw new Error(`Event name ${def.name} must look like "noun.verb"`);
  }
  return register(registry, def.name, def, 'Event');
}

export function listEventDefs(): EventDef<any>[] {
  return [...registry.values()];
}

export function getEventDef(name: string): EventDef<any> | undefined {
  return registry.get(name);
}

export interface TrackOptions {
  venueId?: string | null;
  customerId?: string | null;
  sessionId?: string | null;
  occurredAt?: Date;
  source?: 'web' | 'server' | 'pos' | 'comms' | 'agent' | 'import';
  attribution?: {
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
    creatorId?: string | null;
    campaignId?: string | null;
    code?: string | null;
  };
}

/** Record an event in the current transaction. The name must be declared and the properties must match. */
export async function track<P>(ctx: Ctx, def: EventDef<P>, properties: P, opts: TrackOptions = {}): Promise<void> {
  if (!registry.has(def.name)) throw new Error(`Event ${def.name} is not registered`);
  const props = def.properties.parse(properties);
  await ctx.db
    .insertInto('events')
    .values({
      org_id: ctx.orgId,
      venue_id: opts.venueId ?? null,
      customer_id: opts.customerId ?? null,
      session_id: opts.sessionId ?? null,
      name: def.name,
      occurred_at: opts.occurredAt ?? ctx.now(),
      source: opts.source ?? 'server',
      properties: json(props),
      utm_source: opts.attribution?.utmSource ?? null,
      utm_medium: opts.attribution?.utmMedium ?? null,
      utm_campaign: opts.attribution?.utmCampaign ?? null,
      creator_id: opts.attribution?.creatorId ?? null,
      campaign_id: opts.attribution?.campaignId ?? null,
      code: opts.attribution?.code ?? null,
    })
    .execute();
}

export const noProperties = z.object({});
