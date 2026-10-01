import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type Ctx, assertModule, getModule, invalid, isInternal, notFound, rateLimit, sql } from '@ros/core';
import { touchSession, trackInSession } from '../events/sessions';
import { orderingModule } from '../ordering/module';
import { registerTableOrdering } from '../ordering/contract';
import { qrModule, qrScanned } from './module';
import { openTableSession } from './sessions';

const CODE = z.string().trim().toLowerCase().regex(/^[a-z0-9]{6,40}$/);

export const resolveInput = z.object({
  code: z.string().max(60),
  /** The visitor's session, if the browser already has one. One is made when it does not. */
  sessionId: z.string().uuid().nullish(),
  referrer: z.string().max(1000).nullish(),
  deviceClass: z.enum(['mobile', 'tablet', 'desktop']).nullish(),
});

export interface QrResolution {
  code: string;
  kind: 'menu' | 'table' | 'counter' | 'campaign';
  venueId: string;
  /** Where to send the guest, on the venue's own site. */
  targetPath: string;
  /** The table in context. A code reveals its label and nothing else. */
  table: { label: string; area: string | null } | null;
  stage: 'view' | 'order';
  /** True when this code may place an order: stage "order", ordering switched on, and a table where one is required. */
  canOrder: boolean;
  excludeAlcohol: boolean;
  showPrices: boolean;
  tipping: { enabled: boolean; presets: number[] };
  prompts: { receiptEmail: boolean; loyalty: boolean };
  /** A flyer or creator code: what it carries into the visit. */
  campaign: { campaignId: string | null; creatorId: string | null; offerId: string | null } | null;
  /** The visitor session to keep in the browser and send with events and the order. */
  sessionId: string;
}

async function findCode(ctx: Ctx, code: string) {
  const parsed = CODE.safeParse(code);
  // Another org's code is invisible here (row-level security): it is simply not found.
  const row = parsed.success
    ? await ctx.db
        .selectFrom('qr_codes')
        .select(['id', 'venue_id', 'code', 'kind', 'label', 'area', 'target_path', 'campaign_id', 'creator_id', 'offer_id'])
        .where('code', '=', parsed.data)
        .where('is_active', '=', true)
        .executeTakeFirst()
    : undefined;
  if (!row) throw notFound('That code was not found.');
  return row;
}

/**
 * A guest scanned a code: /q/<code> on the venue's host. Public, no role check; the org comes
 * from the host. Counts the scan, starts or refreshes the visitor session (a campaign code puts
 * its creator and campaign on a new session), records `qr.scanned`, and says where to go and
 * which table is in context. A code from another org, a switched-off code, or a venue with the
 * QR module off is not found.
 */
export async function resolveQrCode(ctx: Ctx, raw: z.input<typeof resolveInput>): Promise<QrResolution> {
  const input = resolveInput.parse(raw);
  // A scan is public and counts: a script replaying scans (or guessing codes) is turned away per address, then per venue.
  if (!isInternal(ctx) && ctx.ip) await rateLimit(ctx.app, `qr:ip:${ctx.ip}`, { limit: 60, windowSeconds: 600 }, 'Too many scans from this device. Try again shortly.');
  const row = await findCode(ctx, input.code);
  const cfg = await assertModule(ctx, row.venue_id, qrModule);
  if (!isInternal(ctx)) await rateLimit(ctx.app, `qr:venue:${row.venue_id}`, { limit: 5000, windowSeconds: 600 });
  const ordering = await getModule(ctx, row.venue_id, orderingModule);

  await ctx.db
    .updateTable('qr_codes')
    .set({ scan_count: sql<number>`scan_count + 1`, last_scanned_at: ctx.now() })
    .where('id', '=', row.id)
    .execute();

  const sessionId = input.sessionId ?? (ctx.principal.kind === 'anon' ? ctx.principal.sessionId : undefined) ?? randomUUID();
  await touchSession(ctx, {
    sessionId,
    venueId: row.venue_id,
    landingPath: `/q/${row.code}`,
    referrer: input.referrer,
    utmSource: 'qr',
    utmMedium: row.kind,
    utmCampaign: row.campaign_id,
    creatorId: row.creator_id,
    campaignId: row.campaign_id,
    qrCodeId: row.id,
    deviceClass: input.deviceClass,
  });
  await trackInSession(ctx, qrScanned, { qr_code_id: row.id, kind: row.kind, table_label: row.label, area: row.area }, { venueId: row.venue_id, sessionId, source: 'web' });

  const hasTable = (row.kind === 'table' || row.kind === 'counter') && !!row.label;
  return {
    code: row.code,
    kind: row.kind,
    venueId: row.venue_id,
    targetPath: row.target_path,
    table: hasTable ? { label: row.label!, area: row.area } : null,
    stage: cfg.stage,
    canOrder: cfg.stage === 'order' && ordering.enabled && (hasTable || !cfg.require_table),
    excludeAlcohol: cfg.exclude_alcohol,
    showPrices: cfg.show_prices,
    tipping: { enabled: cfg.tipping_enabled, presets: cfg.tip_presets },
    prompts: { receiptEmail: cfg.receipt_email_prompt, loyalty: cfg.loyalty_prompt },
    campaign: row.kind === 'campaign' || row.campaign_id || row.creator_id || row.offer_id ? { campaignId: row.campaign_id, creatorId: row.creator_id, offerId: row.offer_id } : null,
    sessionId,
  };
}

/**
 * The table's side of a QR order, for ordering (ordering/contract.ts). Ordering never reads the
 * codes or the sessions; it asks here, with the code the guest's phone sent.
 */
registerTableOrdering({
  async resolveForOrder(ctx, { venueId, code }) {
    const row = await findCode(ctx, code);
    if (row.venue_id !== venueId) throw notFound('That code was not found.');
    const qr = await getModule(ctx, venueId, qrModule);
    // QR off, or a view-only QR menu: ordering from a code does not exist at this venue.
    if (!qr.enabled || qr.config.stage !== 'order') throw notFound('Ordering from the table is not available here.');
    const hasTable = (row.kind === 'table' || row.kind === 'counter') && !!row.label;
    if (!hasTable && qr.config.require_table) throw invalid('Scan the code on your table to order.');
    return {
      qrCodeId: row.id,
      tableLabel: hasTable ? row.label : null,
      excludeAlcohol: qr.config.exclude_alcohol,
      tippingEnabled: qr.config.tipping_enabled,
      tipPresets: qr.config.tip_presets,
    };
  },
  async openSession(ctx, args) {
    return openTableSession(ctx, args);
  },
});
