import { type CanonicalTransaction, type Ctx, type IdentityHint, type TxnStatus, invalid, json, track, hookList, slot } from '@ros/core';
import { linkCard, resolveCustomer } from '../identity/resolve';
import { attributeTransaction } from './attribution';
import { transactionRecorded, transactionRefunded } from './module';
import { stripCardIdentifiers } from './strip';

export interface RecordOptions {
  venueId: string;
  /** Set when the caller already knows the customer (an online order placed by a known guest). */
  customerId?: string | null;
  /** The surface the sale came through, for identity provenance: 'pos', 'online-order' … */
  via?: string;
}

export interface RecordedTransaction {
  id: string;
  venueId: string;
  customerId: string | null;
  source: CanonicalTransaction['source'];
  externalRef: string;
  occurredAt: Date;
  channel: CanonicalTransaction['channel'];
  status: TxnStatus;
  totalCents: number;
  refundedCents: number;
  subtotalCents: number;
  discountCents: number;
  orderId: string | null;
}

export interface RecordResult {
  transaction: RecordedTransaction;
  created: boolean;
  changed: boolean;
}

export interface RecordedInfo {
  created: boolean;
  previousStatus: TxnStatus | null;
  previousCustomerId: string | null;
  hints: IdentityHint[];
  /** Discounts applied at the till, by name and code, so an offer or reward redeemed in venue can be matched to the sale. */
  discounts: NonNullable<CanonicalTransaction['discounts']>;
}

type CatalogResolver = (ctx: Ctx, venueId: string, externalItemIds: string[]) => Promise<Map<string, { menuItemId: string; category: string | null }>>;
const catalogResolver = slot<CatalogResolver>('ledger.catalogResolver');

/** The menu module tells the ledger which menu item a POS catalogue id is. The ledger never reads menu tables. */
export function setCatalogResolver(resolver: CatalogResolver): void {
  catalogResolver.set(resolver);
}

type RecordedHook = (ctx: Ctx, txn: RecordedTransaction, info: RecordedInfo) => Promise<void>;
const hooks = hookList<RecordedHook>('ledger.recorded');

/**
 * Runs in the same transaction as the ledger write, on create and on any change (a refund, a
 * late-resolved customer). Hooks must be idempotent: a replayed webhook reaches them again.
 */
export function onTransactionRecorded(hook: RecordedHook): void {
  hooks.add(hook);
}

/**
 * Write a sale to the ledger, exactly once per (source, externalRef) however many times it is
 * delivered. Re-delivery with a changed status or refund updates the row in place.
 *
 * A spine function for adapters' ingest and for modules that take payment; it has no role
 * check of its own and must not be exposed directly as a route.
 */
export async function recordTransaction(ctx: Ctx, txn: CanonicalTransaction, opts: RecordOptions): Promise<RecordResult> {
  for (const k of ['subtotalCents', 'discountCents', 'taxCents', 'tipCents', 'totalCents', 'refundedCents'] as const) {
    if (!Number.isInteger(txn[k])) throw invalid(`Transaction ${k} must be a whole number of cents.`);
  }
  if (!txn.externalRef) throw invalid('Transaction needs an external reference.');

  const existing = await ctx.db
    .selectFrom('transactions')
    .select(['id', 'status', 'customer_id', 'refunded_cents', 'total_cents'])
    .where('source', '=', txn.source)
    .where('external_ref', '=', txn.externalRef)
    .forUpdate()
    .executeTakeFirst();

  let customerId = opts.customerId ?? existing?.customer_id ?? null;
  if (!customerId && txn.identityHints.length) {
    const resolved = await resolveCustomer(ctx, { hints: txn.identityHints, via: opts.via ?? 'pos', venueId: opts.venueId });
    customerId = resolved.customerId;
  }
  // A consenting guest's card is linked so their later anonymous taps are recognised.
  if (customerId) await linkCard(ctx, customerId, txn.identityHints, opts.via ?? 'pos');

  const raw = txn.raw === undefined ? null : json(stripCardIdentifiers(txn.raw));
  let id: string;
  let created = false;
  let changed = false;

  if (!existing) {
    const row = await ctx.db
      .insertInto('transactions')
      .values({
        org_id: ctx.orgId,
        venue_id: opts.venueId,
        occurred_at: txn.occurredAt,
        source: txn.source,
        external_ref: txn.externalRef,
        customer_id: customerId,
        channel: txn.channel,
        subtotal_cents: txn.subtotalCents,
        discount_cents: txn.discountCents,
        tax_cents: txn.taxCents,
        tip_cents: txn.tipCents,
        total_cents: txn.totalCents,
        refunded_cents: txn.refundedCents,
        currency: txn.currency,
        tender_type: txn.tenderType ?? null,
        staff_ref: txn.staffRef ?? null,
        table_label: txn.tableLabel ?? null,
        order_id: txn.orderId ?? null,
        status: txn.status,
        raw,
        ingested_at: ctx.now(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    id = row.id;
    created = true;
    await writeLines(ctx, id, opts.venueId, txn);
  } else {
    id = existing.id;
    changed =
      existing.status !== txn.status ||
      existing.refunded_cents !== txn.refundedCents ||
      existing.total_cents !== txn.totalCents ||
      existing.customer_id !== customerId;
    if (changed) {
      await ctx.db
        .updateTable('transactions')
        .set({
          status: txn.status,
          refunded_cents: txn.refundedCents,
          total_cents: txn.totalCents,
          subtotal_cents: txn.subtotalCents,
          discount_cents: txn.discountCents,
          tax_cents: txn.taxCents,
          tip_cents: txn.tipCents,
          customer_id: customerId,
          raw,
        })
        .where('id', '=', id)
        .execute();
      if (existing.total_cents !== txn.totalCents) {
        await ctx.db.deleteFrom('transaction_lines').where('transaction_id', '=', id).execute();
        await writeLines(ctx, id, opts.venueId, txn);
      }
    }
  }

  const recorded: RecordedTransaction = {
    id,
    venueId: opts.venueId,
    customerId,
    source: txn.source,
    externalRef: txn.externalRef,
    occurredAt: txn.occurredAt,
    channel: txn.channel,
    status: txn.status,
    totalCents: txn.totalCents,
    refundedCents: txn.refundedCents,
    subtotalCents: txn.subtotalCents,
    discountCents: txn.discountCents,
    orderId: txn.orderId ?? null,
  };

  if (created || changed) {
    if (customerId) await attributeTransaction(ctx, { id, customerId, occurredAt: txn.occurredAt });
    if (created) {
      await track(
        ctx,
        transactionRecorded,
        { transaction_id: id, source: txn.source, channel: txn.channel, total_cents: txn.totalCents, identified: customerId !== null },
        { venueId: opts.venueId, customerId, occurredAt: txn.occurredAt, source: txn.source === 'online-order' ? 'server' : 'pos' },
      );
    } else if (existing && txn.refundedCents > existing.refunded_cents) {
      await track(
        ctx,
        transactionRefunded,
        { transaction_id: id, refunded_cents: txn.refundedCents, full: txn.refundedCents >= txn.totalCents },
        { venueId: opts.venueId, customerId },
      );
    }
    for (const hook of hooks.all()) {
      await hook(ctx, recorded, {
        created,
        previousStatus: existing?.status ?? null,
        previousCustomerId: existing?.customer_id ?? null,
        hints: txn.identityHints,
        discounts: txn.discounts ?? [],
      });
    }
  }

  return { transaction: recorded, created, changed };
}

async function writeLines(ctx: Ctx, transactionId: string, venueId: string, txn: CanonicalTransaction): Promise<void> {
  if (!txn.lines.length) return;
  const externalIds = [...new Set(txn.lines.map((l) => l.externalItemId).filter((v): v is string => !!v))];
  const resolve = catalogResolver.get();
  const catalog = resolve && externalIds.length ? await resolve(ctx, venueId, externalIds) : new Map();
  await ctx.db
    .insertInto('transaction_lines')
    .values(
      txn.lines.map((l) => {
        const hit = l.externalItemId ? catalog.get(l.externalItemId) : undefined;
        return {
          org_id: ctx.orgId,
          transaction_id: transactionId,
          line_no: l.lineNo,
          menu_item_id: hit?.menuItemId ?? null,
          name_snapshot: l.name,
          category_snapshot: l.category ?? hit?.category ?? null,
          qty: l.qty,
          unit_price_cents: l.unitPriceCents,
          modifiers: json(l.modifiers),
          discount_cents: l.discountCents,
          tax_cents: l.taxCents,
          total_cents: l.totalCents,
        };
      }),
    )
    .execute();
}
