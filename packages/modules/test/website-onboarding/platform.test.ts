import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type PlatformPrincipal, connect, defineJob, definePlug, drainJobs, enqueue, markConnectionHealth } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { auth, comms, onboarding, tenancy } from '@ros/modules';

const ANON = { kind: 'anon' as const };
const WORKER = { kind: 'worker' as const, job: 'test' };

definePlug({ key: 'test_booking_feed', name: 'Test booking feed', description: 'test-only plug', kind: 'adapter', tier: 'curated', adapters: {}, auth: 'api_key', scopes: ['read'], venueScoped: true, simulated: true });

const doomedJob = defineJob({
  kind: 'test.doomed',
  schema: z.object({}),
  maxAttempts: 1,
  async handler() {
    throw new Error('this job never works');
  },
});

describe('the platform\'s view of its tenants', () => {
  const t = useTestEnv();

  let admin: PlatformPrincipal;
  const getAdmin = async () => {
    if (!admin) {
      const u = await t.db.selectFrom('users').select('id').where('email', '=', 'admin@rosplatform.test').executeTakeFirstOrThrow();
      admin = { kind: 'platform', adminUserId: u.id, reason: 'test' };
    }
    return admin;
  };

  it('tenant health: connections, the comms queue, dead jobs and failed provisioning steps, per org', async () => {
    const a = await getAdmin();
    const { diner, group } = t.fixture;
    const manager = await diner.as('manager');

    // A connection that last synced fine.
    const conn = await t.app.tenant(diner.orgId, manager, (ctx) => connect(ctx, { plugKey: 'test_booking_feed', venueId: diner.venueId, externalAccountId: 'feed-1', credentials: { apiKey: 'k' } }));
    const start = await onboarding.getTenantHealth(t.app, a, { orgId: diner.orgId });
    expect(start).toMatchObject({ orgId: diner.orgId, slug: 'oak-diner', name: 'Oak Diner', status: 'live' });
    const connected = await t.db.selectFrom('connections').select(['id', 'last_ok_at']).where('org_id', '=', diner.orgId).where('status', '!=', 'revoked').execute();
    expect(start.connections).toHaveLength(connected.length);
    expect(start.connections.find((c) => c.id === conn.id)).toMatchObject({ plugKey: 'test_booking_feed', venueId: diner.venueId, status: 'connected', lastOkAt: t.clock(), lastError: null });
    // The credentials are not part of any health view.
    expect(JSON.stringify(start)).not.toContain('apiKey');

    // 1. The connection stops working.
    t.clock.advanceMinutes(5);
    await markConnectionHealth(t.app, conn.id, { ok: false, error: 'token expired' });
    // 2. A message is queued and no worker picks it up for twenty minutes.
    await t.app.tenant(diner.orgId, WORKER, (ctx) => comms.queueMessage(ctx, { templateKey: 'generic.notice', channel: 'email', to: 'stuck@example.com', idempotencyKey: 'health:stuck', variables: { subject: 'Hello', body: 'Waiting.' } }));
    // A message scheduled for tomorrow is not a backlog.
    await t.app.tenant(diner.orgId, WORKER, (ctx) =>
      comms.queueMessage(ctx, { templateKey: 'generic.notice', channel: 'email', to: 'later@example.com', idempotencyKey: 'health:later', variables: { subject: 'Hello', body: 'Tomorrow.' }, sendAt: new Date(t.clock().getTime() + 86_400_000) }),
    );
    // 3. A background job runs out of attempts.
    await t.app.tenant(diner.orgId, WORKER, (ctx) => enqueue(ctx, doomedJob, {}));
    await drainJobs(t.app, { kinds: ['test.doomed'] });
    // 4. A provisioning step has failed.
    const ob = await t.db.selectFrom('onboardings').select('id').where('org_id', '=', diner.orgId).executeTakeFirstOrThrow();
    await t.db.insertInto('provisioning_steps').values({ org_id: diner.orgId, onboarding_id: ob.id, step: 'custom_domain', status: 'failed', attempts: 3, error: 'hosting API timed out' }).execute();
    t.clock.advanceMinutes(20);

    const h = await onboarding.getTenantHealth(t.app, a, { orgId: diner.orgId });
    expect(h.connections.find((c) => c.id === conn.id)).toMatchObject({ status: 'unhealthy', lastError: 'token expired', lastOkAt: start.connections.find((c) => c.id === conn.id)!.lastOkAt });
    // Due and unsent, read back from the table: the stuck message counts, the one scheduled for tomorrow does not.
    const due = await t.db
      .selectFrom('messages')
      .select(['to_address'])
      .where('org_id', '=', diner.orgId)
      .where('status', 'in', ['queued', 'sending'])
      .where('next_attempt_at', '<=', t.clock())
      .execute();
    expect(due.map((m) => m.to_address)).toContain('stuck@example.com');
    expect(due.map((m) => m.to_address)).not.toContain('later@example.com');
    expect(h.queue.depth).toBe(due.length);
    expect(h.queue.oldestAgeMinutes).toBeGreaterThanOrEqual(20);
    expect(h.deadJobs.count).toBe(start.deadJobs.count + 1);
    expect(h.deadJobs.kinds).toContain('test.doomed');
    expect(h.failedProvisioningSteps).toEqual([{ step: 'custom_domain', error: 'hosting API timed out', attempts: 3 }]);
    expect(h.healthy).toBe(false);
    expect(h.problems).toEqual(
      expect.arrayContaining([
        'test_booking_feed is unhealthy: token expired.',
        expect.stringMatching(/messages are waiting; the oldest has waited \d+ minutes\./),
        expect.stringMatching(/background job(s have| has) failed for good \(.*test\.doomed.*\)\./),
        'Provisioning step "custom_domain" failed: hosting API timed out.',
      ]),
    );

    // Across orgs: each org's numbers are its own.
    const all = await onboarding.listTenantHealth(t.app, a);
    expect(all.map((x) => x.slug).sort()).toEqual(['oak-diner', 'oak-group']);
    const g = all.find((x) => x.orgId === group.orgId)!;
    expect(g.failedProvisioningSteps).toEqual([]);
    expect(g.deadJobs.kinds).not.toContain('test.doomed');
    expect(g.connections.map((c) => c.id)).not.toContain(conn.id);
    expect((await onboarding.listTenantHealth(t.app, a, { onlyUnhealthy: true })).map((x) => x.slug)).toContain('oak-diner');

    // Recovery shows too.
    await markConnectionHealth(t.app, conn.id, { ok: true });
    await drainJobs(t.app, { kinds: ['comms.send'] });
    const later = await onboarding.getTenantHealth(t.app, a, { orgId: diner.orgId });
    expect(later.connections.find((c) => c.id === conn.id)).toMatchObject({ status: 'connected', lastOkAt: t.clock() });
    expect(t.sim.email.lastTo('stuck@example.com')).toBeDefined();
    expect(later.queue.depth).toBeLessThan(h.queue.depth);

    // Platform admins only, and an unknown org is not found.
    await expect(onboarding.getTenantHealth(t.app, await diner.as('owner'), { orgId: diner.orgId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(onboarding.listTenantHealth(t.app, ANON)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(onboarding.listTenantHealth(t.app, { kind: 'platform', adminUserId: randomUUID(), reason: 'forged' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(onboarding.getTenantHealth(t.app, a, { orgId: randomUUID() })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('support access is opened only by a platform admin, with a reason, where the owner can read it', async () => {
    const a = await getAdmin();
    const { diner, group } = t.fixture;
    const owner = await diner.as('owner');
    const reason = 'Investigating a failed menu import reported by the owner';

    // Nobody inside a tenant can open it, however senior; nor a platform principal that names no real admin.
    await expect(onboarding.openSupportAccess(t.app, owner, { orgId: diner.orgId, reason })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(onboarding.openSupportAccess(t.app, await diner.as('manager'), { orgId: diner.orgId, reason })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(onboarding.openSupportAccess(t.app, WORKER, { orgId: diner.orgId, reason })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(onboarding.openSupportAccess(t.app, ANON, { orgId: diner.orgId, reason })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(onboarding.openSupportAccess(t.app, { kind: 'platform', adminUserId: owner.userId, reason: 'an owner posing as platform' }, { orgId: diner.orgId, reason })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(onboarding.openSupportAccess(t.app, { kind: 'platform', reason: 'no admin' }, { orgId: diner.orgId, reason })).rejects.toMatchObject({ code: 'forbidden' });
    // A reason is required, and must say something.
    await expect(onboarding.openSupportAccess(t.app, a, { orgId: diner.orgId, reason: 'x' })).rejects.toThrow();
    await expect(onboarding.openSupportAccess(t.app, a, { orgId: randomUUID(), reason })).rejects.toMatchObject({ code: 'not_found' });
    expect(await t.db.selectFrom('support_access').select('id').execute()).toEqual([]);
    // With no access open, the platform has no principal to act as inside the org.
    await expect(onboarding.supportPrincipal(t.app, a, { orgId: diner.orgId })).rejects.toMatchObject({ code: 'forbidden' });

    const grant = await onboarding.openSupportAccess(t.app, a, { orgId: diner.orgId, reason });
    expect(grant.principal).toEqual({ kind: 'platform', adminUserId: a.adminUserId, reason: `support: ${reason}` });
    const row = await t.db.selectFrom('support_access').selectAll().where('id', '=', grant.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ org_id: diner.orgId, admin_user_id: a.adminUserId, reason, started_at: t.clock(), ended_at: null });
    const opened = await t.db.selectFrom('audit_log').select(['actor_kind', 'actor_id', 'after']).where('org_id', '=', diner.orgId).where('action', '=', 'support.access_opened').executeTakeFirstOrThrow();
    expect(opened).toEqual({ actor_kind: 'platform', actor_id: a.adminUserId, after: { reason } });
    await expect(onboarding.openSupportAccess(t.app, a, { orgId: diner.orgId, reason })).rejects.toMatchObject({ code: 'conflict' });
    expect(await onboarding.supportPrincipal(t.app, a, { orgId: diner.orgId })).toMatchObject({ kind: 'platform', adminUserId: a.adminUserId });
    await expect(onboarding.supportPrincipal(t.app, a, { orgId: group.orgId })).rejects.toMatchObject({ code: 'forbidden' });

    // The owner reads it; a manager does not; another org's owner sees nothing of it.
    const seen = await t.app.tenant(diner.orgId, owner, (ctx) => onboarding.listSupportAccess(ctx));
    expect(seen).toEqual([{ id: grant.id, by: 'Platform Admin', reason, startedAt: row.started_at, endedAt: null }]);
    await expect(t.app.tenant(diner.orgId, await diner.as('manager'), (ctx) => onboarding.listSupportAccess(ctx))).rejects.toMatchObject({ code: 'forbidden' });
    expect(await t.app.tenant(group.orgId, await group.as('owner'), (ctx) => onboarding.listSupportAccess(ctx))).toEqual([]);
    // The record cannot be edited or removed from inside the tenant.
    await expect(t.app.tenant(diner.orgId, owner, (ctx) => ctx.db.updateTable('support_access').set({ reason: 'nothing to see' }).execute())).rejects.toThrow(/permission denied/);
    await expect(t.app.tenant(diner.orgId, owner, (ctx) => ctx.db.deleteFrom('support_access').execute())).rejects.toThrow(/permission denied/);

    t.clock.advanceMinutes(45);
    await expect(onboarding.closeSupportAccess(t.app, owner, { accessId: grant.id })).rejects.toMatchObject({ code: 'forbidden' });
    await onboarding.closeSupportAccess(t.app, a, { accessId: grant.id });
    const closed = await t.app.tenant(diner.orgId, owner, (ctx) => onboarding.listSupportAccess(ctx));
    expect(closed[0]).toMatchObject({ reason, endedAt: t.clock() });
    await expect(onboarding.supportPrincipal(t.app, a, { orgId: diner.orgId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(onboarding.closeSupportAccess(t.app, a, { accessId: grant.id })).rejects.toMatchObject({ code: 'not_found' });
    const actions = await t.db.selectFrom('audit_log').select('action').where('org_id', '=', diner.orgId).where('entity_id', '=', grant.id).orderBy('occurred_at').execute();
    expect(actions.map((x) => x.action)).toEqual(['support.access_opened', 'support.access_closed']);
  });

  it('an org leaving gets its data, then its custom domains are removed, its connections revoked and it is closed', async () => {
    const a = await getAdmin();
    const { group } = t.fixture;
    const owner = await group.as('owner');
    const host = 'oakgroup.example.com.au';

    // The group has a verified custom domain, a connection holding credentials, and a verified sending domain.
    const domain = await t.app.tenant(group.orgId, owner, (ctx) => tenancy.addCustomDomain(ctx, { host }));
    const registration = await t.sim.hosting.addDomain({ host, idempotencyKey: 'test:group-domain' });
    t.sim.hosting.verify(host);
    await t.app.tenant(group.orgId, WORKER, (ctx) => tenancy.markDomainVerified(ctx, domain.id, registration.providerDomainId));
    expect(await tenancy.resolveHost(t.app, host)).toMatchObject({ orgId: group.orgId });
    const conn = await t.app.tenant(group.orgId, owner, (ctx) => connect(ctx, { plugKey: 'test_booking_feed', venueId: group.venues.cbd!.id, externalAccountId: 'feed-group', credentials: { apiKey: 'sk_group_secret' } }));
    const identity = await t.app.tenant(group.orgId, owner, (ctx) => comms.addSendingIdentity(ctx, { channel: 'email', domain: 'mail.oak-group.example', fromName: 'Oak Group' }, { key: 'sim-email' }));
    await t.app.tenant(group.orgId, WORKER, (ctx) => comms.setSendingIdentityStatus(ctx, identity.id, 'verified'));
    const activeIdentities = (await t.db.selectFrom('sending_identities').select('id').where('org_id', '=', group.orgId).where('status', '!=', 'suspended').execute()).length;
    const liveConnections = await t.db.selectFrom('connections').select(['id', 'secret_ref']).where('org_id', '=', group.orgId).where('status', '!=', 'revoked').execute();
    expect(liveConnections.length).toBeGreaterThanOrEqual(1);
    const customers = Number((await t.db.selectFrom('customers').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', group.orgId).executeTakeFirstOrThrow()).n);

    // The export: owner or platform, never a manager.
    await expect(t.app.tenant(group.orgId, await group.as('manager'), (ctx) => onboarding.exportOrgData(ctx))).rejects.toMatchObject({ code: 'forbidden' });
    const exported = await t.app.tenant(group.orgId, owner, (ctx) => onboarding.exportOrgData(ctx));
    expect(exported.counts).toMatchObject({ venues: 3, customers });
    expect(exported.counts.transactions).toBeGreaterThan(500);
    expect(exported.spine.domains).toEqual(expect.arrayContaining([expect.objectContaining({ host })]));
    const web = exported.modules.website as { pages: unknown[]; brands: unknown[]; redirects: unknown[] };
    expect(web.pages.length).toBeGreaterThan(3);
    expect(web.brands).toHaveLength(2);
    expect(web.redirects).toHaveLength(3);
    // No secret and no card identifier leaves in an export.
    const text = JSON.stringify(exported);
    expect(text).not.toContain('sk_group_secret');
    const cards = (exported.spine.customerIdentities as Array<{ kind: string; value: string }>).filter((i) => i.kind.startsWith('card_'));
    expect(cards.length).toBeGreaterThan(0);
    expect(new Set(cards.map((c) => c.value))).toEqual(new Set(['(linked)']));
    expect((await t.db.selectFrom('audit_log').select('action').where('org_id', '=', group.orgId).where('action', '=', 'org.exported').execute()).length).toBe(1);

    // Closing is the platform's act.
    await expect(onboarding.closeOrg(t.app, owner, { orgId: group.orgId, reason: 'Trying to close myself' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(onboarding.closeOrg(t.app, a, { orgId: group.orgId, reason: '' })).rejects.toMatchObject({ code: 'invalid' });

    // If the web host cannot be reached, nothing is changed here: we still know what to detach.
    t.sim.hosting.failNext(1);
    await expect(onboarding.closeOrg(t.app, a, { orgId: group.orgId, reason: 'Venue sold; contract ended' })).rejects.toThrow('simulated provider outage');
    expect((await t.db.selectFrom('orgs').select('status').where('id', '=', group.orgId).executeTakeFirstOrThrow()).status).toBe('live');
    expect(await t.db.selectFrom('domains').select('host').where('org_id', '=', group.orgId).where('kind', '=', 'custom').execute()).toEqual([{ host }]);

    const result = await onboarding.closeOrg(t.app, a, { orgId: group.orgId, reason: 'Venue sold; contract ended' });
    expect(result).toEqual({ orgId: group.orgId, domainsRemoved: [host], connectionsRevoked: liveConnections.length, sendingIdentitiesSuspended: activeIdentities, status: 'closed' });

    // Custom domain: gone from our table and detached at the host, so a lapsed DNS record points at nothing of ours.
    expect(await t.db.selectFrom('domains').select(['host', 'kind', 'is_primary']).where('org_id', '=', group.orgId).execute()).toEqual([{ host: 'oak-group.tables.test', kind: 'subdomain', is_primary: true }]);
    expect(t.sim.hosting.has(host)).toBe(false);
    expect(await tenancy.resolveHost(t.app, host)).toBeNull();
    // Connections: revoked, and the stored credentials destroyed.
    const after = await t.db.selectFrom('connections').select(['status', 'secret_ref']).where('org_id', '=', group.orgId).execute();
    expect(after.length).toBeGreaterThanOrEqual(liveConnections.length);
    for (const c of after) expect(c).toEqual({ status: 'revoked', secret_ref: null });
    const refs = liveConnections.map((c) => c.secret_ref).filter((r): r is string => r !== null);
    expect(refs).toContain(conn.secret_ref);
    expect(await t.db.selectFrom('secrets').select('id').where('id', 'in', refs).execute()).toEqual([]);
    // Marketing can no longer go out in its name.
    expect((await t.db.selectFrom('sending_identities').select('status').where('id', '=', identity.id).executeTakeFirstOrThrow()).status).toBe('suspended');
    // Closed, not deleted.
    expect((await t.db.selectFrom('orgs').select('status').where('id', '=', group.orgId).executeTakeFirstOrThrow()).status).toBe('closed');
    expect((await t.db.selectFrom('venues').select('status').where('org_id', '=', group.orgId).execute()).map((v) => v.status)).toEqual(['closed', 'closed', 'closed']);
    expect(Number((await t.db.selectFrom('customers').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', group.orgId).executeTakeFirstOrThrow()).n)).toBe(customers);
    expect(await tenancy.resolveHost(t.app, 'oak-group.tables.test')).toMatchObject({ orgStatus: 'closed' });
    // Its staff can no longer choose it at sign-in.
    expect((await auth.membershipsOf(t.app, owner.userId)).map((m) => m.orgId)).not.toContain(group.orgId);

    const closed = await t.db.selectFrom('audit_log').select(['actor_kind', 'after']).where('org_id', '=', group.orgId).where('action', '=', 'org.closed').executeTakeFirstOrThrow();
    expect(closed).toMatchObject({ actor_kind: 'platform', after: { reason: 'Venue sold; contract ended', domainsRemoved: [host], connectionsRevoked: liveConnections.length } });
    const event = await t.db.selectFrom('events').select('properties').where('org_id', '=', group.orgId).where('name', '=', 'org.closed').executeTakeFirstOrThrow();
    expect(event.properties).toEqual({ domains_removed: 1, connections_revoked: liveConnections.length });

    // Closing again finds nothing left to do; the other org is untouched.
    expect(await onboarding.closeOrg(t.app, a, { orgId: group.orgId, reason: 'Venue sold; contract ended' })).toMatchObject({ domainsRemoved: [], connectionsRevoked: 0, sendingIdentitiesSuspended: 0 });
    expect((await t.db.selectFrom('orgs').select('status').where('id', '=', t.fixture.diner.orgId).executeTakeFirstOrThrow()).status).toBe('live');
    expect((await onboarding.listTenantHealth(t.app, a)).map((x) => x.slug)).toEqual(['oak-diner']);
  });
});
