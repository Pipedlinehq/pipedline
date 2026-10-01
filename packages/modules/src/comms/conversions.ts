import { z } from 'zod';
import {
  type AdsConversion,
  type ConnectionRow,
  type Ctx,
  adapterFor,
  connect,
  defineEvent,
  defineJob,
  definePlug,
  enqueue,
  findConnectionFor,
  getPlug,
  invalid,
  once,
  requireOwner,
  requireStaff,
  resolveConnection,
  sha256Hex,
  track,
} from '@ros/core';
import { hasConsent } from '../identity/consents';
import { normaliseEmail, normalisePhone } from '../identity/normalise';
import { onTransactionRecorded } from '../ledger/record';

/**
 * Server-side purchase conversions to an ad platform:
 * only for a guest who holds the `ad_platform_sharing` consent, only hashed email and phone plus
 * the value, never a card identifier. A refund sends nothing further. A guest who withdraws the
 * consent is never sent again, including for a sale already queued.
 */

export const simAdsPlug = definePlug({
  key: 'sim-ads',
  name: 'Simulated ad platform',
  description: 'An ad platform\'s conversions endpoint held in memory. For development and tests.',
  kind: 'adapter',
  tier: 'first_party',
  adapters: { ads: 'sim-ads' },
  auth: 'api_key',
  scopes: ['conversions:write'],
  venueScoped: false,
  simulated: true,
});

export const metaCapiPlug = definePlug({
  key: 'meta-capi',
  name: 'Meta Conversions API',
  description: 'Tell Meta about purchases by guests who agreed to it, so ads are measured on real sales. Hashed email and phone and the amount only.',
  kind: 'adapter',
  tier: 'curated',
  adapters: { ads: 'meta-capi' },
  auth: 'api_key',
  scopes: ['conversions:write'],
  venueScoped: false,
});

export const adConversionSent = defineEvent({
  name: 'ad_conversion.sent',
  module: 'comms',
  description: 'A purchase by a guest who agreed to ad-platform sharing was reported to the venue\'s ad platform.',
  properties: z.object({ conversion_id: z.string(), transaction_id: z.string(), source: z.enum(['website', 'physical_store']), value_cents: z.number().int() }),
});

const WORKER = { kind: 'worker' as const, job: 'comms.ad_conversion' };
const CONN_COLS = ['id', 'org_id', 'venue_id', 'plug_key', 'status', 'scopes', 'secret_ref', 'external_account_id', 'config', 'connected_at', 'last_ok_at', 'last_error', 'expires_at'] as const;

/** SHA-256 hex of an email as ad platforms want it: trimmed and lower-cased. */
export function hashEmailForAds(raw: string): string | null {
  const v = normaliseEmail(raw);
  return v ? sha256Hex(v) : null;
}

/** SHA-256 hex of a phone as ad platforms want it: digits only, with the country code, no plus. */
export function hashPhoneForAds(raw: string): string | null {
  const v = normalisePhone(raw);
  return v ? sha256Hex(v.replace(/^\+/, '')) : null;
}

/** Stable across retries and matching what a browser pixel would send for the same order. */
export function conversionEventId(txn: { id: string; orderId: string | null }): string {
  return txn.orderId ? `order_${txn.orderId}` : `txn_${txn.id}`;
}

// ── Console ─────────────────────────────────────────────────────────────────

export const connectAdsAccountInput = z.object({
  plugKey: z.string().min(1),
  /** One venue's account, or omit for the whole organisation. */
  venueId: z.string().uuid().nullish(),
  /** The dataset or pixel id. */
  externalAccountId: z.string().min(1).max(200),
  credentials: z.record(z.string(), z.string()),
  config: z.record(z.string(), z.unknown()).optional(),
});

/** Connect an ads account. Guest data leaves for it, so an owner does this. */
export async function connectAdsAccount(ctx: Ctx, raw: z.input<typeof connectAdsAccountInput>): Promise<{ connectionId: string }> {
  const input = connectAdsAccountInput.parse(raw);
  requireOwner(ctx);
  const plug = getPlug(input.plugKey);
  if (!plug.adapters.ads) throw invalid(`${plug.name} is not an ad platform.`);
  const row = await connect(ctx, { plugKey: plug.key, venueId: input.venueId ?? null, externalAccountId: input.externalAccountId, credentials: input.credentials, config: input.config ?? {} });
  return { connectionId: row.id };
}

export interface AdsConnectionStatus {
  connectionId: string;
  plugKey: string;
  name: string;
  venueId: string | null;
  status: ConnectionRow['status'];
  lastOkAt: Date | null;
  lastError: string | null;
  counts: { queued: number; sent: number; skipped: number; failed: number };
  lastSentAt: Date | null;
}

/** Ads connections and how their conversions are going. Counts only, no guest data. */
export async function adsConversionStatus(ctx: Ctx, filter: { venueId?: string } = {}): Promise<AdsConnectionStatus[]> {
  requireStaff(ctx, { venueId: filter.venueId, minRole: 'manager' });
  const keys = ['sim-ads', 'meta-capi'];
  let q = ctx.db.selectFrom('connections').select(CONN_COLS).where('plug_key', 'in', keys).where('status', '!=', 'revoked');
  if (filter.venueId) q = q.where((eb) => eb.or([eb('venue_id', '=', filter.venueId!), eb('venue_id', 'is', null)]));
  const rows = await q.execute();
  const out: AdsConnectionStatus[] = [];
  for (const r of rows) {
    const c = await ctx.db
      .selectFrom('ad_conversions')
      .select(['status', (eb) => eb.fn.countAll<number>().as('n'), (eb) => eb.fn.max('sent_at').as('last')])
      .where('connection_id', '=', r.id)
      .groupBy('status')
      .execute();
    const n = (s: string) => Number(c.find((x) => x.status === s)?.n ?? 0);
    const last = c.map((x) => x.last).filter((d): d is Date => !!d);
    out.push({
      connectionId: r.id,
      plugKey: r.plug_key,
      name: getPlug(r.plug_key).name,
      venueId: r.venue_id,
      status: r.status,
      lastOkAt: r.last_ok_at,
      lastError: r.last_error,
      counts: { queued: n('queued'), sent: n('sent'), skipped: n('skipped'), failed: n('failed') },
      lastSentAt: last.length ? new Date(Math.max(...last.map((d) => new Date(d).getTime()))) : null,
    });
  }
  return out;
}

// ── From the ledger ─────────────────────────────────────────────────────────

export const sendConversionJob = defineJob({
  kind: 'comms.ad_conversion',
  schema: z.object({ conversionId: z.string().uuid() }),
  maxAttempts: 6,
  async handler(app, job) {
    const orgId = job.orgId;
    if (!orgId) throw new Error('comms.ad_conversion is an org job');
    const { conversionId } = job.payload;

    // Read and decide. Consent is checked again here: a guest may have withdrawn since the sale.
    const plan = await app.tenant(orgId, WORKER, async (ctx) => {
      const row = await ctx.db.selectFrom('ad_conversions').selectAll().where('id', '=', conversionId).forUpdate().executeTakeFirst();
      if (!row || row.status === 'sent' || row.status === 'skipped') return null;
      const skip = async (reason: string) => {
        await ctx.db.updateTable('ad_conversions').set({ status: 'skipped', reason }).where('id', '=', row.id).execute();
        return null;
      };
      if (!row.customer_id || !(await hasConsent(ctx, row.customer_id, 'ad_platform_sharing'))) return skip('no_consent');
      const txn = await ctx.db.selectFrom('transactions').select(['status', 'occurred_at', 'order_id']).where('id', '=', row.transaction_id).executeTakeFirst();
      if (!txn || txn.status === 'refunded' || txn.status === 'voided') return skip('refunded');
      const c = await ctx.db.selectFrom('customers').select(['primary_email', 'primary_phone', 'status']).where('id', '=', row.customer_id).executeTakeFirst();
      if (!c || c.status !== 'active') return skip('no_customer');
      const hashedEmail = c.primary_email ? hashEmailForAds(c.primary_email) : null;
      const hashedPhone = c.primary_phone ? hashPhoneForAds(c.primary_phone) : null;
      if (!hashedEmail && !hashedPhone) return skip('no_identifier');
      const conn = await ctx.db.selectFrom('connections').select(CONN_COLS).where('id', '=', row.connection_id).executeTakeFirst();
      if (!conn || conn.status === 'revoked') return skip('disconnected');
      const conversion: AdsConversion = {
        eventId: row.event_id,
        eventName: 'Purchase',
        occurredAt: txn.occurred_at,
        valueCents: row.value_cents,
        currency: row.currency,
        hashedEmail,
        hashedPhone,
        source: row.source as AdsConversion['source'],
        orderId: txn.order_id ?? row.transaction_id,
      };
      return { row, conn: conn as ConnectionRow, conversion };
    });
    if (!plan) return;

    try {
      const handle = await resolveConnection(app, plan.conn);
      const adapter = adapterFor(app, 'ads', plan.conn);
      await once(app, { orgId, key: `adconv:${plan.row.id}`, kind: 'ad_conversion' }, () => adapter.sendConversions(handle, [plan.conversion]));
    } catch (e) {
      if (job.attempt >= 6) {
        await app.tenant(orgId, WORKER, (ctx) => ctx.db.updateTable('ad_conversions').set({ status: 'failed', reason: (e as Error).message.slice(0, 300) }).where('id', '=', plan.row.id).execute());
        return;
      }
      throw e;
    }
    await app.tenant(orgId, WORKER, async (ctx) => {
      await ctx.db.updateTable('ad_conversions').set({ status: 'sent', sent_at: ctx.now(), reason: null }).where('id', '=', plan.row.id).execute();
      await track(
        ctx,
        adConversionSent,
        { conversion_id: plan.row.id, transaction_id: plan.row.transaction_id, source: plan.conversion.source, value_cents: plan.row.value_cents },
        { venueId: plan.row.venue_id, customerId: plan.row.customer_id },
      );
    });
  },
});

// A completed sale by a consenting guest, at a venue with an ads connection, is queued once.
onTransactionRecorded(async (ctx, txn, info) => {
  if (txn.status !== 'completed' || !txn.customerId) return;
  // Only the moment a sale becomes a completed, identified sale; a refund or other change sends nothing further.
  const becameReportable = info.created || info.previousStatus === 'pending' || (!info.previousCustomerId && !!txn.customerId);
  if (!becameReportable) return;
  if (!(await hasConsent(ctx, txn.customerId, 'ad_platform_sharing'))) return;
  const conn = await findConnectionFor(ctx, 'ads', txn.venueId);
  if (!conn) return;
  const t = await ctx.db.selectFrom('transactions').select(['currency']).where('id', '=', txn.id).executeTakeFirstOrThrow();
  const inserted = await ctx.db
    .insertInto('ad_conversions')
    .values({
      org_id: ctx.orgId,
      venue_id: txn.venueId,
      connection_id: conn.id,
      transaction_id: txn.id,
      customer_id: txn.customerId,
      event_id: conversionEventId({ id: txn.id, orderId: txn.orderId }),
      source: txn.source === 'online-order' ? 'website' : 'physical_store',
      value_cents: txn.totalCents,
      currency: t.currency,
    })
    .onConflict((oc) => oc.columns(['org_id', 'connection_id', 'transaction_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted) await enqueue(ctx, sendConversionJob, { conversionId: inserted.id }, { key: inserted.id });
});
