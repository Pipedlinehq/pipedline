import {
  type App,
  type CanonicalTransaction,
  type ConnectionHandle,
  type PosWebhookEvent,
  AppError,
  claimWebhookEvent,
  finishWebhookEvent,
  getPlug,
  isUniqueViolation,
  markConnectionHealth,
  notFound,
  releaseWebhookEvent,
  resolveConnection,
  sha256Hex,
} from '@ros/core';
import { type PosConnection, type SaleOutcome, findPosConnectionsByAccount, loadPosConnection, recordPosSale } from './ingest';

const WORKER = { kind: 'worker' as const, job: 'ledger.pos_webhook' };

export interface PosWebhookArgs {
  /** Which plug's endpoint was called, from the route: 'square', 'sim-pos'. Never from the body. */
  plugKey: string;
  /** The body exactly as received. The signature is over these bytes. */
  rawBody: string;
  headers: Record<string, string | undefined>;
  /** The public URL the provider called. Some providers sign it together with the body. */
  url: string;
}

export interface PosWebhookResult {
  /** 'duplicate': seen before, nothing done. 'ignored': genuine, but nothing in it for the ledger. */
  status: 'processed' | 'duplicate' | 'ignored';
  created: number;
  changed: number;
  unchanged: number;
  skipped: number;
}

/**
 * A POS says something changed. Nothing in the body is believed:
 *
 *   1. the account it names is used only to find whose signature to expect
 *   2. the signature is checked, on the raw body, with that connection's own secret
 *   3. the event is claimed, so a replay has no second effect
 *   4. every sale it names is fetched again from the provider, with the connection's own
 *      credentials, and what the provider returns is what gets recorded
 *
 * A sale lands in the org and venue of the connection that fetched it and nowhere else. An
 * unknown account, a missing signature and a wrong one all get the same answer, so the
 * endpoint cannot be used to find out which accounts are connected. If anything fails after
 * the claim, the claim is released and the error rethrown, so the provider's retry is handled
 * afresh (the web route must answer non-2xx for a thrown error).
 */
export async function handlePosWebhook(app: App, args: PosWebhookArgs): Promise<PosWebhookResult> {
  const denied = () => new AppError('unauthenticated', 'Signature check failed.');

  let adapterKey: string | undefined;
  try {
    adapterKey = getPlug(args.plugKey).adapters.pos;
  } catch {
    adapterKey = undefined;
  }
  if (!adapterKey || !app.adapters.has('pos', adapterKey)) throw notFound('Not found');
  const adapter = app.adapters.get('pos', adapterKey);

  let event: PosWebhookEvent | null = null;
  try {
    event = adapter.parseWebhook(args.rawBody);
  } catch {
    event = null;
  }
  if (!event || !event.accountRef || !event.eventId) throw denied();

  const verified: Array<{ conn: PosConnection; handle: ConnectionHandle }> = [];
  for (const conn of await findPosConnectionsByAccount(app, args.plugKey, event.accountRef)) {
    let handle: ConnectionHandle;
    try {
      handle = await resolveConnection(app, conn.row);
    } catch {
      continue;
    }
    const secret = handle.credentials.webhookSecret;
    if (!secret) continue;
    // Behind a proxy the URL we see may not be the one the provider signed; a connection can pin it.
    const url = typeof handle.config.webhookUrl === 'string' ? handle.config.webhookUrl : args.url;
    if (adapter.verifyWebhook({ rawBody: args.rawBody, headers: args.headers, url, signingSecret: secret })) verified.push({ conn, handle });
  }
  if (!verified.length) throw denied();

  // Scoped by account, so one account's event ids can never shadow another's.
  const claim = await claimWebhookEvent(app, {
    provider: `pos:${args.plugKey}`,
    eventId: `${event.accountRef}:${event.eventId}`,
    eventType: event.type,
    payloadDigest: sha256Hex(args.rawBody),
  });
  const result: PosWebhookResult = { status: 'ignored', created: 0, changed: 0, unchanged: 0, skipped: 0 };
  if (!claim) return { ...result, status: 'duplicate' };

  // The same merchant account can legitimately be connected by more than one org (each with
  // its own credentials). Each org is handled on its own: fetched with its token, written in its tenant.
  const byOrg = new Map<string, Array<{ conn: PosConnection; handle: ConnectionHandle }>>();
  for (const v of verified) byOrg.set(v.conn.orgId, [...(byOrg.get(v.conn.orgId) ?? []), v]);

  try {
    for (const ref of new Set(event.transactionRefs)) {
      for (const [orgId, conns] of byOrg) {
        const fetcher = conns.find((c) => c.conn.locationRef === event.locationRef) ?? conns[0]!;
        let txn: CanonicalTransaction | null;
        try {
          txn = await adapter.getTransaction(fetcher.handle, ref);
        } catch (e) {
          await markConnectionHealth(app, fetcher.conn.id, { ok: false, error: ((e as Error)?.message ?? 'unknown error').slice(0, 300) });
          throw new AppError('provider_error', 'The point of sale could not be reached. It will be tried again shortly.');
        }
        if (fetcher.conn.row.status === 'unhealthy') await markConnectionHealth(app, fetcher.conn.id, { ok: true });
        if (!txn) {
          result.skipped++;
          continue;
        }
        // The venue is the one whose connection maps the sale's location, as the provider reports it.
        const location = txn.locationRef;
        const target = location ? conns.find((c) => c.conn.locationRef === location) : conns.length === 1 ? conns[0] : undefined;
        if (!target) {
          result.skipped++;
          continue;
        }
        const fetched = txn;
        const write = (): Promise<SaleOutcome> =>
          app.tenant(orgId, WORKER, async (ctx) => {
            // Read again inside the tenant: the connection must still be live, and this org's.
            const live = await loadPosConnection(ctx, target.conn.id);
            if (!live) return 'skipped';
            return recordPosSale(ctx, live, adapter.source, fetched);
          });
        let outcome: SaleOutcome;
        try {
          outcome = await write();
        } catch (e) {
          // The poll recorded the same sale at the same moment and won. Look again: it is there now.
          if (!isUniqueViolation(e)) throw e;
          outcome = await write();
        }
        result[outcome]++;
      }
    }
  } catch (e) {
    await releaseWebhookEvent(app, claim);
    throw e;
  }

  const acted = result.created + result.changed + result.unchanged > 0;
  result.status = acted ? 'processed' : 'ignored';
  const only = byOrg.size === 1 ? verified[0]! : null;
  await finishWebhookEvent(app, claim, { status: result.status, orgId: only?.conn.orgId ?? null, connectionId: verified.length === 1 ? verified[0]!.conn.id : null });
  return result;
}
