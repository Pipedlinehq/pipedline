import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assertModule, defineJob, defineModule, drainJobs, enqueue, getModule, once, setModule } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { tenancy } from '@ros/modules';

const WORKER = { kind: 'worker' as const, job: 'test' };

const demoModule = defineModule({
  key: 'test_demo',
  name: 'Demo',
  description: 'test-only module',
  dependsOn: [],
  tables: [],
  configSchema: z.object({ slotMinutes: z.number().int().min(5).max(60), greeting: z.string().max(40) }),
  configVersion: 1,
  defaultConfig: { slotMinutes: 15, greeting: 'Welcome' },
});
const dependentModule = defineModule({
  key: 'test_dependent',
  name: 'Dependent',
  description: 'test-only module',
  dependsOn: ['test_demo'],
  tables: [],
  configSchema: z.object({}),
  configVersion: 1,
  defaultConfig: {},
});

let flaky = 0;
const flakyJob = defineJob({
  kind: 'test.flaky',
  schema: z.object({ failTimes: z.number() }),
  maxAttempts: 3,
  async handler(_app, job) {
    flaky++;
    if (job.attempt <= job.payload.failTimes) throw new Error('not yet');
  },
});

describe('tenancy, modules and infrastructure', () => {
  const t = useTestEnv();

  it('resolves a host to its org from the domains table, and only verified hosts', async () => {
    const { diner } = t.fixture;
    expect(await tenancy.resolveHost(t.app, 'Oak-Diner.tables.test:3000')).toMatchObject({ orgId: diner.orgId, venueId: null, primaryHost: 'oak-diner.tables.test' });
    expect(await tenancy.resolveHost(t.app, 'unknown.tables.test')).toBeNull();
    expect(await tenancy.resolveHost(t.app, 'evil.com/../oak-diner.tables.test')).toBeNull();

    const owner = await diner.as('owner');
    const d = await t.app.tenant(diner.orgId, owner, (ctx) => tenancy.addCustomDomain(ctx, { host: 'oakdiner.example.com.au' }));
    expect(await tenancy.resolveHost(t.app, 'oakdiner.example.com.au')).toBeNull();
    await t.app.tenant(diner.orgId, WORKER, (ctx) => tenancy.markDomainVerified(ctx, d.id));
    expect(await tenancy.resolveHost(t.app, 'oakdiner.example.com.au')).toMatchObject({ orgId: diner.orgId, primaryHost: 'oakdiner.example.com.au' });
    // The subdomain keeps working and now points at the custom domain.
    expect(await tenancy.resolveHost(t.app, 'oak-diner.tables.test')).toMatchObject({ primaryHost: 'oakdiner.example.com.au' });
    // Another org cannot claim a domain that is already registered, nor one of the platform's.
    const other = await t.fixture.group.as('owner');
    await expect(t.app.tenant(t.fixture.group.orgId, other, (ctx) => tenancy.addCustomDomain(ctx, { host: 'oakdiner.example.com.au' }))).rejects.toMatchObject({ code: 'conflict' });
    await expect(t.app.tenant(t.fixture.group.orgId, other, (ctx) => tenancy.addCustomDomain(ctx, { host: 'phish.tables.test' }))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('knows when a venue is open, including exceptions and the venue\'s own time zone', async () => {
    const { diner } = t.fixture;
    const at = (iso: string) => t.app.tenant(diner.orgId, { kind: 'anon' }, (ctx) => tenancy.isOpenAt(ctx, diner.venueId, new Date(iso)));
    expect(await at('2026-09-30T02:30:00Z')).toBe(true); // Wed 12:30 Sydney: lunch
    expect(await at('2026-09-30T06:00:00Z')).toBe(false); // Wed 16:00: between services
    expect(await at('2026-09-30T09:00:00Z')).toBe(true); // Wed 19:00: dinner
    expect(await at('2026-09-28T02:30:00Z')).toBe(false); // Monday: closed
    // Daylight saving starts 4 October 2026: 12:30 local is now 01:30Z, not 02:30Z.
    expect(await at('2026-10-06T01:30:00Z')).toBe(true);
    expect(await at('2026-10-06T04:30:00Z')).toBe(false);
    // The seeded public-holiday closure, five days after "today".
    expect(await at('2026-10-05T01:30:00Z')).toBe(false);

    const manager = await diner.as('manager');
    await t.app.tenant(diner.orgId, manager, (ctx) => tenancy.setHourException(ctx, diner.venueId, { date: '2026-10-07', closed: false, opensAt: '15:00', closesAt: '16:00', reason: 'Private event' }));
    expect(await at('2026-10-07T01:30:00Z')).toBe(false);
    expect(await at('2026-10-07T04:30:00Z')).toBe(true);
    const host = await diner.as('host');
    await expect(t.app.tenant(diner.orgId, host, (ctx) => tenancy.setHourException(ctx, diner.venueId, { date: '2026-10-08', closed: true }))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a module is off until switched on, validates its config, and hides rather than deletes when switched off', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const run = <T>(fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(diner.orgId, manager, fn);

    await expect(run((ctx) => assertModule(ctx, diner.venueId, demoModule))).rejects.toMatchObject({ code: 'module_disabled', status: 404 });
    await expect(run((ctx) => setModule(ctx, demoModule, { venueId: diner.venueId, enabled: true, config: { slotMinutes: 3 } }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(run((ctx) => setModule(ctx, dependentModule, { venueId: diner.venueId, enabled: true }))).rejects.toMatchObject({ code: 'invalid' });

    await run((ctx) => setModule(ctx, demoModule, { venueId: diner.venueId, enabled: true, config: { slotMinutes: 20 } }));
    expect(await run((ctx) => assertModule(ctx, diner.venueId, demoModule))).toEqual({ slotMinutes: 20, greeting: 'Welcome' });
    await run((ctx) => setModule(ctx, dependentModule, { venueId: diner.venueId, enabled: true }));

    await run((ctx) => setModule(ctx, demoModule, { venueId: diner.venueId, enabled: false }));
    await expect(run((ctx) => assertModule(ctx, diner.venueId, demoModule))).rejects.toMatchObject({ code: 'module_disabled' });
    // A module whose dependency went off is unavailable too.
    await expect(run((ctx) => assertModule(ctx, diner.venueId, dependentModule))).rejects.toMatchObject({ code: 'module_disabled' });
    // The config survives being switched off.
    expect((await run((ctx) => getModule(ctx, diner.venueId, demoModule))).config.slotMinutes).toBe(20);
    const audited = await t.db
      .selectFrom('audit_log')
      .select('entity_id')
      .where('org_id', '=', diner.orgId)
      .where('action', '=', 'module.set')
      .where('entity_id', 'like', '%:test_%')
      .execute();
    expect(audited.length).toBe(3);
  });

  it('a failing job is retried with backoff and then parked as dead', async () => {
    flaky = 0;
    await t.app.tenant(t.fixture.diner.orgId, WORKER, (ctx) => enqueue(ctx, flakyJob, { failTimes: 1 }, { key: 'once' }));
    await t.app.tenant(t.fixture.diner.orgId, WORKER, (ctx) => enqueue(ctx, flakyJob, { failTimes: 1 }, { key: 'once' }));
    expect((await drainJobs(t.app, { kinds: ['test.flaky'] })).failed).toBe(1);
    expect((await drainJobs(t.app, { kinds: ['test.flaky'] })).ran).toBe(0); // not due yet
    t.clock.advanceMinutes(2);
    expect((await drainJobs(t.app, { kinds: ['test.flaky'] })).succeeded).toBe(1);
    expect(flaky).toBe(2);

    await t.app.tenant(t.fixture.diner.orgId, WORKER, (ctx) => enqueue(ctx, flakyJob, { failTimes: 99 }));
    for (let i = 0; i < 4; i++) {
      await drainJobs(t.app, { kinds: ['test.flaky'] });
      t.clock.advanceMinutes(60);
    }
    const dead = await t.db.selectFrom('jobs').select(['status', 'attempts']).where('kind', '=', 'test.flaky').where('status', '=', 'dead').execute();
    expect(dead).toEqual([{ status: 'dead', attempts: 3 }]);
  });

  it('a job left running by a worker that died is queued again', async () => {
    flaky = 0;
    await t.app.tenant(t.fixture.diner.orgId, WORKER, (ctx) => enqueue(ctx, flakyJob, { failTimes: 0 }, { key: 'orphan' }));
    // Simulate a worker that claimed the job and then died.
    await t.db.updateTable('jobs').set({ status: 'running', locked_at: t.clock(), locked_by: 'dead-worker', attempts: 1 }).where('idempotency_key', '=', 'orphan').execute();
    expect((await drainJobs(t.app, { kinds: ['test.flaky'] })).ran).toBe(0);
    t.clock.advanceMinutes(11);
    expect((await drainJobs(t.app, { kinds: ['test.flaky'] })).succeeded).toBe(1);
    expect(flaky).toBe(1);
  });

  it('once() runs an outward action one time and replays the stored result', async () => {
    let calls = 0;
    const act = () => once(t.app, { orgId: t.fixture.diner.orgId, key: 'charge:abc', kind: 'test' }, async () => ({ ref: `r${++calls}` }));
    expect(await act()).toEqual({ result: { ref: 'r1' }, replayed: false });
    expect(await act()).toEqual({ result: { ref: 'r1' }, replayed: true });
    expect(calls).toBe(1);

    let attempts = 0;
    const flakyAct = () =>
      once(t.app, { orgId: t.fixture.diner.orgId, key: 'charge:flaky', kind: 'test' }, async () => {
        if (++attempts === 1) throw new Error('timeout');
        return 'ok';
      });
    await expect(flakyAct()).rejects.toMatchObject({ code: 'provider_error' });
    expect(await flakyAct()).toEqual({ result: 'ok', replayed: false });
  });

  it('connections seal their credentials; a tenant never sees them', async () => {
    const { definePlug, connect, listConnections, resolveConnection } = await import('@ros/core');
    definePlug({ key: 'test_plug', name: 'Test plug', description: 'x', kind: 'adapter', tier: 'curated', adapters: {}, auth: 'api_key', scopes: ['read'], venueScoped: true, simulated: true });
    const { diner, group } = t.fixture;
    const manager = await diner.as('manager');
    const row = await t.app.tenant(diner.orgId, manager, (ctx) => connect(ctx, { plugKey: 'test_plug', venueId: diner.venueId, externalAccountId: 'acct_1', credentials: { apiKey: 'sk_very_secret' } }));
    const listed = await t.app.tenant(diner.orgId, manager, (ctx) => listConnections(ctx, { venueId: diner.venueId }));
    expect(JSON.stringify(listed)).not.toContain('sk_very_secret');
    const stored = await t.db.selectFrom('secrets').select('ciphertext').where('id', '=', row.secret_ref!).executeTakeFirstOrThrow();
    expect(stored.ciphertext.toString('utf8')).not.toContain('sk_very_secret');
    expect((await resolveConnection(t.app, row)).credentials).toEqual({ apiKey: 'sk_very_secret' });
    // A secret reference is only good for the org that owns it.
    await expect(t.app.secrets.get(group.orgId, row.secret_ref!)).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(diner.orgId, manager, (ctx) => connect(ctx, { plugKey: 'test_plug', venueId: diner.venueId, externalAccountId: 'acct_2', scopes: ['admin'], credentials: {} }))).rejects.toMatchObject({ code: 'invalid' });
  });
});
