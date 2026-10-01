import { type Ctx, audit, invalid, notFound, requireStaff, isInternal, track, hookList } from '@ros/core';
import { customerMerged } from './module';

type MergeHandler = (ctx: Ctx, args: { winnerId: string; loserId: string }) => Promise<void>;
const handlers = hookList<MergeHandler>('identity.mergeHandlers');

/**
 * A module that stores customer_id in its own tables registers here to re-point them when two
 * records merge. The identity module never reaches into another module's tables.
 */
export function onCustomerMerge(handler: MergeHandler): void {
  handlers.add(handler);
}

/**
 * Fold `loserId` into `winnerId`. The loser row stays (status 'merged') so history that names
 * it, including the append-only event and consent trails, can still be followed to the winner.
 */
export async function mergeCustomers(ctx: Ctx, args: { winnerId: string; loserId: string; reason: string }): Promise<void> {
  if (!isInternal(ctx)) requireStaff(ctx, { minRole: 'manager' });
  await mergeCustomersUnchecked(ctx, args);
}

/**
 * The merge itself, with no role check. For identity resolution, which merges automatically
 * when one guest action proves two records are the same person. Never call this from a route.
 */
export async function mergeCustomersUnchecked(ctx: Ctx, args: { winnerId: string; loserId: string; reason: string }): Promise<void> {
  const { winnerId, loserId, reason } = args;
  if (winnerId === loserId) throw invalid('A customer cannot be merged into itself.');
  const rows = await ctx.db.selectFrom('customers').selectAll().where('id', 'in', [winnerId, loserId]).forUpdate().execute();
  const winner = rows.find((r) => r.id === winnerId);
  const loser = rows.find((r) => r.id === loserId);
  if (!winner || !loser || winner.status !== 'active' || loser.status !== 'active') throw notFound('Customer not found');

  // Identities: move what the winner lacks, drop the rest.
  const loserIdentities = await ctx.db.selectFrom('customer_identities').select(['id']).where('customer_id', '=', loserId).execute();
  if (loserIdentities.length) {
    await ctx.db.updateTable('customer_identities').set({ customer_id: winnerId }).where('customer_id', '=', loserId).execute();
  }

  // Consents: per purpose, the most recent decision by either record stands.
  const consents = await ctx.db.selectFrom('consents').selectAll().where('customer_id', 'in', [winnerId, loserId]).execute();
  const decidedAt = (c: (typeof consents)[number]) => (c.status === 'granted' ? c.consented_at : c.revoked_at)?.getTime() ?? 0;
  for (const lc of consents.filter((c) => c.customer_id === loserId)) {
    const wc = consents.find((c) => c.customer_id === winnerId && c.purpose === lc.purpose);
    if (!wc) {
      await ctx.db.updateTable('consents').set({ customer_id: winnerId }).where('id', '=', lc.id).execute();
    } else {
      if (decidedAt(lc) > decidedAt(wc)) {
        await ctx.db
          .updateTable('consents')
          .set({
            status: lc.status,
            wording_version: lc.wording_version,
            source: lc.source,
            source_detail: lc.source_detail,
            consented_at: lc.consented_at,
            revoked_at: lc.revoked_at,
          })
          .where('id', '=', wc.id)
          .execute();
      }
      await ctx.db.deleteFrom('consents').where('id', '=', lc.id).execute();
    }
  }
  // Card links survive only with the winner's standing card consent.
  const cardOk = await ctx.db
    .selectFrom('consents')
    .select('status')
    .where('customer_id', '=', winnerId)
    .where('purpose', '=', 'card_recognition')
    .executeTakeFirst();
  if (cardOk?.status !== 'granted') {
    await ctx.db
      .deleteFrom('customer_identities')
      .where('customer_id', '=', winnerId)
      .where('kind', 'in', ['card_fingerprint', 'card_par'])
      .execute();
  }

  await ctx.db.updateTable('transactions').set({ customer_id: winnerId }).where('customer_id', '=', loserId).execute();
  await ctx.db.updateTable('transaction_attributions').set({ customer_id: winnerId }).where('customer_id', '=', loserId).execute();
  await ctx.db.updateTable('visitor_sessions').set({ customer_id: winnerId }).where('customer_id', '=', loserId).execute();

  // Fill the winner's blanks from the loser; never overwrite, and never touch acquisition.
  await ctx.db
    .updateTable('customers')
    .set({
      primary_email: winner.primary_email ?? loser.primary_email,
      primary_phone: winner.primary_phone ?? loser.primary_phone,
      first_name: winner.first_name ?? loser.first_name,
      last_name: winner.last_name ?? loser.last_name,
      birthday: winner.birthday ?? loser.birthday,
      allergy_notes: [winner.allergy_notes, loser.allergy_notes].filter(Boolean).join(' · ') || null,
      notes: [winner.notes, loser.notes].filter(Boolean).join('\n') || null,
    })
    .where('id', '=', winnerId)
    .execute();

  for (const h of handlers.all()) await h(ctx, { winnerId, loserId });

  await ctx.db
    .updateTable('customers')
    .set({ status: 'merged', merged_into_id: winnerId, primary_email: null, primary_phone: null })
    .where('id', '=', loserId)
    .execute();
  await ctx.db
    .insertInto('customer_merges')
    .values({
      org_id: ctx.orgId,
      winner_customer_id: winnerId,
      loser_customer_id: loserId,
      merged_at: ctx.now(),
      merged_by: ctx.principal.kind,
      reason,
    })
    .execute();
  await audit(ctx, { action: 'customer.merged', entityType: 'customer', entityId: winnerId, after: { loserId, reason } });
  await track(ctx, customerMerged, { loser_customer_id: loserId, reason }, { customerId: winnerId });
}
