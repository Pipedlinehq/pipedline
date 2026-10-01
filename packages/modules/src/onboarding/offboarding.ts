import { z } from 'zod';
import { type App, type Ctx, type Principal, audit, hookList, invalid, notFound, requireOwner, revokeConnection, track, keyedRegistry, register } from '@ros/core';
import { listSendingIdentities, setSendingIdentityStatus } from '../comms/identities';
import { clearHostCache, listDomains, removeDomain } from '../tenancy/domains';
import { getOrg, setOrgStatus } from '../tenancy/orgs';
import { updateVenue } from '../tenancy/venues';
import { exportWebsiteData } from '../website/export';
import { plainText } from '../website/safe';
import { orgClosed } from './module';
import { requirePlatformAdmin } from './platform';
import { hostingOf } from './steps';

/**
 * Leaving the platform (docs/THREAT_MODEL.md sections 6 and 10): the org gets its data, its
 * custom domains are detached so a lapsed DNS record cannot be pointed at someone else's
 * content, its connections are revoked, and it is closed. Closing hides; it deletes nothing.
 */
export type OrgExportProvider = (ctx: Ctx) => Promise<unknown>;
const providers = keyedRegistry<OrgExportProvider>('onboarding.exportProviders');

/** A module that holds data for an org contributes it to the org's export under its own name. */
export function registerOrgExportProvider(name: string, provider: OrgExportProvider): void {
  register(providers, name, provider, 'Org export provider');
}

registerOrgExportProvider('website', exportWebsiteData);

export interface OrgExport {
  exportedAt: string;
  org: unknown;
  /** Rows per section, so the receiver can check nothing was cut short. */
  counts: Record<string, number>;
  spine: Record<string, unknown[]>;
  /** One entry per module that registered a provider. */
  modules: Record<string, unknown>;
}

/**
 * Everything held for the org this transaction acts for: the spine (venues, hours, team,
 * guests and their consents, suppression list, sales) and what each module adds. Owner or
 * platform only. Card identifiers are never exported: a linked card is shown as the fact of it.
 */
export async function exportOrgData(ctx: Ctx): Promise<OrgExport> {
  requireOwner(ctx);
  const db = ctx.db;
  const identities = await db.selectFrom('customer_identities').select(['customer_id', 'kind', 'value', 'verified_at', 'created_at']).execute();
  const spine: Record<string, unknown[]> = {
    venues: await db.selectFrom('venues').selectAll().orderBy('created_at').execute(),
    domains: await db.selectFrom('domains').select(['host', 'kind', 'venue_id', 'is_primary', 'verified_at']).execute(),
    tradingHours: await db.selectFrom('trading_hours').select(['venue_id', 'day_of_week', 'opens_at', 'closes_at', 'service_type']).execute(),
    hourExceptions: await db.selectFrom('hour_exceptions').select(['venue_id', 'date', 'closed', 'opens_at', 'closes_at', 'reason']).execute(),
    modules: await db.selectFrom('venue_modules').select(['venue_id', 'module_key', 'enabled', 'config']).execute(),
    staff: await db.selectFrom('staff').select(['id', 'first_name', 'last_name', 'email', 'phone', 'is_owner', 'status']).execute(),
    staffRoles: await db.selectFrom('staff_venues').select(['staff_id', 'venue_id', 'role']).execute(),
    connections: await db.selectFrom('connections').select(['plug_key', 'venue_id', 'status', 'external_account_id', 'connected_at']).execute(),
    customers: await db.selectFrom('customers').selectAll().orderBy('created_at').execute(),
    customerIdentities: identities.map((i) => (i.kind.startsWith('card_') ? { customer_id: i.customer_id, kind: i.kind, value: '(linked)', created_at: i.created_at } : i)),
    consents: await db.selectFrom('consents').select(['customer_id', 'purpose', 'status', 'source', 'source_detail', 'wording_version', 'consented_at', 'revoked_at']).execute(),
    suppressions: await db.selectFrom('suppressions').select(['channel', 'value', 'reason', 'created_at']).execute(),
    transactions: await db
      .selectFrom('transactions')
      .select(['id', 'venue_id', 'customer_id', 'source', 'external_ref', 'occurred_at', 'channel', 'status', 'subtotal_cents', 'discount_cents', 'tax_cents', 'tip_cents', 'total_cents', 'refunded_cents', 'currency', 'tender_type', 'table_label'])
      .orderBy('occurred_at')
      .execute(),
    transactionLines: await db.selectFrom('transaction_lines').select(['transaction_id', 'line_no', 'name_snapshot', 'category_snapshot', 'qty', 'unit_price_cents', 'discount_cents', 'tax_cents', 'total_cents', 'modifiers']).execute(),
  };
  const modules: Record<string, unknown> = {};
  for (const [name, provider] of providers) modules[name] = await provider(ctx);
  const counts = Object.fromEntries(Object.entries(spine).map(([k, v]) => [k, v.length]));
  await audit(ctx, { action: 'org.exported', entityType: 'org', entityId: ctx.orgId, after: { counts, modules: Object.keys(modules) } });
  return { exportedAt: ctx.now().toISOString(), org: await getOrg(ctx), counts, spine, modules };
}

/**
 * Runs inside the transaction that closes an org, after its connections are revoked. A module
 * whose tables hold access to the org (the hub's assistant keys and sign-ins) ends it here.
 */
export type OrgClosingHook = (ctx: Ctx, info: { orgId: string; reason: string }) => Promise<void>;
const closingHooks = hookList<OrgClosingHook>('onboarding.orgClosing');
export function onOrgClosing(fn: OrgClosingHook): void {
  closingHooks.add(fn);
}

export const closeOrgInput = z.object({ orgId: z.string().uuid(), reason: plainText(500, { min: 5 }) });

export interface CloseOrgResult {
  orgId: string;
  domainsRemoved: string[];
  connectionsRevoked: number;
  sendingIdentitiesSuspended: number;
  status: 'closed';
}

/**
 * Close an org. Custom domains are detached at the web host first (between transactions, and
 * safe to repeat), then removed here; every connection is revoked and its stored credentials
 * destroyed; marketing identities are suspended; the org and its venues are marked closed.
 * Run it again after a provider error and it picks up where it stopped.
 */
export async function closeOrg(app: App, actor: Principal, raw: z.input<typeof closeOrgInput>): Promise<CloseOrgResult> {
  const { adminUserId } = await requirePlatformAdmin(app, actor);
  const parsed = closeOrgInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'Give the organisation and the reason.', { issues: parsed.error.issues });
  const { orgId, reason } = parsed.data;
  const principal = { kind: 'platform' as const, adminUserId, reason: `offboarding: ${reason}` };
  const org = await app.db.selectFrom('orgs').select('id').where('id', '=', orgId).executeTakeFirst();
  if (!org) throw notFound('Organisation not found');

  const custom = await app.tenant(orgId, principal, async (ctx) => {
    const providerIds = new Map((await ctx.db.selectFrom('domains').select(['id', 'provider_domain_id']).where('kind', '=', 'custom').execute()).map((d) => [d.id, d.provider_domain_id]));
    return (await listDomains(ctx)).filter((d) => d.kind === 'custom').map((d) => ({ id: d.id, host: d.host, providerDomainId: providerIds.get(d.id) ?? null }));
  });

  // Detach at the provider before forgetting the domain here: if this fails we still know what to detach.
  if (custom.length) {
    const hosting = hostingOf(app);
    for (const d of custom) await hosting.removeDomain({ host: d.host, providerDomainId: d.providerDomainId });
  }

  return app.tenant(orgId, principal, async (ctx) => {
    for (const d of custom) await removeDomain(ctx, d.id);

    const connections = await ctx.db.selectFrom('connections').select('id').where('status', '!=', 'revoked').execute();
    for (const c of connections) await revokeConnection(ctx, c.id);

    for (const hook of closingHooks.all()) await hook(ctx, { orgId, reason });

    const identities = (await listSendingIdentities(ctx)).filter((i) => i.status !== 'suspended');
    for (const i of identities) await setSendingIdentityStatus(ctx, i.id, 'suspended');

    const venues = await ctx.db.selectFrom('venues').select('id').where('status', '!=', 'closed').execute();
    for (const v of venues) await updateVenue(ctx, v.id, { status: 'closed' });
    await setOrgStatus({ app, db: ctx.db, reason: principal.reason, now: ctx.now }, orgId, 'closed');

    await audit(ctx, {
      action: 'org.closed',
      entityType: 'org',
      entityId: orgId,
      after: { reason, domainsRemoved: custom.map((d) => d.host), connectionsRevoked: connections.length, sendingIdentitiesSuspended: identities.length },
    });
    await track(ctx, orgClosed, { domains_removed: custom.length, connections_revoked: connections.length });
    ctx.afterCommit(clearHostCache);
    return { orgId, domainsRemoved: custom.map((d) => d.host), connectionsRevoked: connections.length, sendingIdentitiesSuspended: identities.length, status: 'closed' as const };
  });
}
