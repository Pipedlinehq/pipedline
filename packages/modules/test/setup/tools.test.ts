import { beforeAll, describe, expect, it } from 'vitest';
import { type PlatformPrincipal, type StaffPrincipal, drainJobs, getTool } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { auth, onboarding, tenancy } from '@ros/modules';
import { connectModern, issueKey, roomForKeys } from '../hub/helpers';

/**
 * The parts of self-serve start and the setup tools that the end-to-end script
 * (./self-serve.test.ts) does not reach: a plugin switched on later is set up, a venue the
 * platform team is onboarding is not its owner's to take live, the quota is ours to set, the
 * tools in a group, and what "start" means for someone who already belongs somewhere.
 */
const codeFrom = (body: string) => body.match(/\b(\d{6})\b/)![1]!;

describe('setup: self-serve start and the setup tools, the other cases', () => {
  const t = useTestEnv();
  let admin: PlatformPrincipal;

  async function signInAs(email: string, ip: string) {
    await auth.requestOpenLogin(t.app, email, { ip });
    const login = await auth.verifyOpenLogin(t.app, email, codeFrom(t.sim.email.lastTo(email)!.body), { ip });
    return { login, who: (await auth.authenticate(t.app, login.token))! };
  }

  /** A person starts a venue, and is given back as its owner. */
  async function start(email: string, venueName: string, ip: string) {
    const { login, who } = await signInAs(email, ip);
    const made = await onboarding.selfServeStart(t.app, who.principal, { venueName }, { ip });
    const owner = (await auth.selectOrg(t.app, login.token, made.orgId)).principal as StaffPrincipal;
    return { ...made, venueId: made.venueId!, owner };
  }

  const steps = async (orgId: string) => Object.fromEntries((await t.db.selectFrom('provisioning_steps').select(['step', 'status']).where('org_id', '=', orgId).execute()).map((r) => [r.step, r.status]));

  beforeAll(async () => {
    await roomForKeys(t.app, t.fixture);
    const u = await t.db.selectFrom('users').select('id').where('email', '=', 'admin@rosplatform.test').executeTakeFirstOrThrow();
    admin = { kind: 'platform', adminUserId: u.id, reason: 'test' };
  });

  it('a plugin switched on after the start is set up then: the website gets its pages, loyalty its programme', async () => {
    const v = await start('lena@trattoria-lena.example', 'Trattoria Lena', '198.51.100.21');
    expect(await steps(v.orgId)).toMatchObject({ pages: 'skipped', loyalty_defaults: 'skipped', hours: 'skipped', modules: 'done' });
    expect(await t.db.selectFrom('pages').select('id').where('org_id', '=', v.orgId).execute()).toEqual([]);

    await t.app.tenant(v.orgId, v.owner, (ctx) => tenancy.enablePlugin(ctx, { venueId: v.venueId, plugin: 'website' }));
    expect((await steps(v.orgId)).pages).toBe('pending');
    await drainJobs(t.app, { kinds: ['onboarding.provision'] });
    expect((await steps(v.orgId)).pages).toBe('done');
    const pages = await t.db.selectFrom('pages').select(['slug', 'status']).where('org_id', '=', v.orgId).execute();
    expect(pages.map((p) => p.slug)).toContain('home');
    expect(pages.every((p) => p.status === 'published')).toBe(true);

    await t.app.tenant(v.orgId, v.owner, (ctx) => tenancy.enablePlugin(ctx, { venueId: v.venueId, plugin: 'loyalty' }));
    await drainJobs(t.app, { kinds: ['onboarding.provision'] });
    expect((await steps(v.orgId)).loyalty_defaults).toBe('done');
    expect(await t.db.selectFrom('loyalty_programs').select('name').where('org_id', '=', v.orgId).execute()).toEqual([{ name: 'Trattoria Lena Rewards' }]);

    // Switching it on a second time is refused, and nothing runs twice.
    await expect(t.app.tenant(v.orgId, v.owner, (ctx) => tenancy.enablePlugin(ctx, { venueId: v.venueId, plugin: 'website' }))).rejects.toMatchObject({ code: 'invalid', message: 'Website is already switched on here.' });
    const pageCount = pages.length;
    await drainJobs(t.app, { kinds: ['onboarding.provision'] });
    expect(await t.db.selectFrom('pages').select('id').where('org_id', '=', v.orgId).execute()).toHaveLength(pageCount);
    // With the website on, the go-live checks that were not applicable now ask for what the site needs.
    const checklist = await t.app.tenant(v.orgId, v.owner, (ctx) => onboarding.getOwnGoLiveChecklist(ctx));
    const by = Object.fromEntries(checklist.items.map((i) => [i.key, i]));
    expect(by.pages_published!.status).toBe('pass');
    expect(by.structured_data_valid).toMatchObject({ status: 'fail', fix: { tool: 'venue_update' } });
    expect(by.structured_data_valid!.reason).toContain('street address');
  });

  it('a venue the platform team is onboarding is not its owner\'s to take live; one they started is, once the checks pass', async () => {
    const v = await start('ugo@da-ugo.example', 'Da Ugo', '198.51.100.22');
    const goLive = getTool('go_live')!;
    if (goLive.effect !== 'write') throw new Error('go_live is a write');
    // Their own, with the checks failing: refused for that reason, by the tool and by the function behind it.
    await expect(t.app.tenant(v.orgId, v.owner, (ctx) => goLive.propose({ ctx, venueId: null }, {}))).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/^Not ready to go live\./) });
    await expect(t.app.tenant(v.orgId, v.owner, (ctx) => onboarding.goLiveAsOwner(ctx))).rejects.toMatchObject({ code: 'conflict' });
    // Nobody inside a platform or worker context stands in for the owner.
    await expect(t.app.tenant(v.orgId, { kind: 'worker', job: 'test' }, (ctx) => onboarding.goLiveAsOwner(ctx))).rejects.toMatchObject({ code: 'forbidden' });

    // The same organisation, had the platform team opened its onboarding.
    await t.db.updateTable('onboardings').set({ origin: 'platform' }).where('org_id', '=', v.orgId).execute();
    await expect(t.app.tenant(v.orgId, v.owner, (ctx) => goLive.propose({ ctx, venueId: null }, {}))).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('platform team') });
    await expect(t.app.tenant(v.orgId, v.owner, (ctx) => onboarding.goLiveAsOwner(ctx))).rejects.toMatchObject({ code: 'forbidden' });
    expect((await t.db.selectFrom('orgs').select('status').where('id', '=', v.orgId).executeTakeFirstOrThrow()).status).toBe('onboarding');

    // The fixture diner was onboarded by the platform and is live: setup_status says so, and there is nothing to do.
    const diner = t.fixture.diner;
    const s = await t.app.tenant(diner.orgId, await diner.as('owner'), (ctx) => onboarding.getSetupStatus(ctx, diner.venueId));
    expect(s).toMatchObject({ complete: true, next: null });
    // A manager is not shown the organisation's setup.
    await expect(t.app.tenant(diner.orgId, await diner.as('manager'), (ctx) => onboarding.getSetupStatus(ctx, diner.venueId))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('the quota is the platform\'s to set: it stops a further venue, and a platform admin raises it', async () => {
    const v = await start('ines@casa-ines.example', 'Casa Ines', '198.51.100.23');
    const venues = () => t.db.selectFrom('venues').select('slug').where('org_id', '=', v.orgId).orderBy('created_at').execute();
    await expect(onboarding.setOrgQuota(t.app, v.owner, { orgId: v.orgId, quota: { max_venues: 50 } })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await onboarding.setOrgQuota(t.app, admin, { orgId: v.orgId, quota: { max_venues: 2 } })).toEqual({ max_venues: 2 });
    expect(((await t.db.selectFrom('orgs').select('settings').where('id', '=', v.orgId).executeTakeFirstOrThrow()).settings as Record<string, unknown>).quota).toEqual({ max_venues: 2 });
    const audit = await t.db.selectFrom('audit_log').select(['actor_kind', 'actor_id', 'before', 'after']).where('org_id', '=', v.orgId).where('action', '=', 'org.quota_set').where('actor_id', 'is not', null).executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ actor_kind: 'platform', actor_id: admin.adminUserId, before: { max_venues: 5 }, after: { max_venues: 2 } });

    await t.app.tenant(v.orgId, v.owner, (ctx) => tenancy.createVenue(ctx, { slug: 'second', name: 'Casa Ines Due' }));
    await expect(t.app.tenant(v.orgId, v.owner, (ctx) => tenancy.createVenue(ctx, { slug: 'third', name: 'Casa Ines Tre' }))).rejects.toMatchObject({ code: 'conflict', message: 'This organisation can have up to 2 venues. Contact us to add more.' });
    expect((await venues()).map((x) => x.slug)).toEqual(['main', 'second']);
    // An organisation with no quota on record (every one made before this) is held to the default.
    expect(await t.app.tenant(t.fixture.group.orgId, await t.fixture.group.as('owner'), (ctx) => tenancy.getOrgQuota(ctx))).toEqual({ max_venues: 5 });
    await expect(onboarding.setOrgQuota(t.app, admin, { orgId: v.orgId, quota: { max_venues: 0 } })).rejects.toThrow();
  });

  it('someone who already belongs somewhere is returned to it; only the owner of a live organisation may start another, one draft at a time', async () => {
    const diner = t.fixture.diner;
    const count = async () => Number((await t.db.selectFrom('orgs').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n);
    const before = await count();

    // A manager of the diner: returned to the diner, whatever they ask for.
    const m = await signInAs('manager@oak-diner.test', '198.51.100.24');
    expect(m.login).toMatchObject({ newUser: false, activeOrgId: diner.orgId });
    expect(await onboarding.selfServeStart(t.app, m.who.principal, { venueName: 'Morgan\'s Place' }, { ip: '198.51.100.24' })).toMatchObject({ created: false, orgId: diner.orgId });
    expect(await onboarding.selfServeStart(t.app, m.who.principal, { venueName: 'Morgan\'s Place', another: true }, { ip: '198.51.100.24' })).toMatchObject({ created: false, orgId: diner.orgId });
    expect(await count()).toBe(before);

    // Its owner: returned to it by default; "another" makes one draft, and asking again returns that draft.
    const o = await signInAs('owner@oak-diner.test', '198.51.100.25');
    expect(await onboarding.selfServeStart(t.app, o.who.principal, { venueName: 'Oak Diner Two' }, { ip: '198.51.100.25' })).toMatchObject({ created: false, orgId: diner.orgId });
    const second = await onboarding.selfServeStart(t.app, o.who.principal, { venueName: 'Oak Diner Two', another: true }, { ip: '198.51.100.25' });
    expect(second.created).toBe(true);
    expect(second.orgId).not.toBe(diner.orgId);
    expect(await t.db.selectFrom('orgs').select(['trading_name', 'status']).where('id', '=', second.orgId).executeTakeFirstOrThrow()).toEqual({ trading_name: 'Oak Diner Two', status: 'onboarding' });
    const third = await onboarding.selfServeStart(t.app, o.who.principal, { venueName: 'Oak Diner Three', another: true }, { ip: '198.51.100.25' });
    expect(third).toMatchObject({ created: false, orgId: second.orgId });
    expect(await count()).toBe(before + 1);
    // The person now belongs to two organisations and chooses which their session acts for.
    expect((await auth.membershipsOf(t.app, o.who.session.userId!)).map((x) => x.orgId).sort()).toEqual([diner.orgId, second.orgId].sort());

    // Two venues with the same name get different addresses.
    const twin = await start('twin@example.com', 'Oak Diner Two', '198.51.100.26');
    const slugs = await t.db.selectFrom('orgs').select('slug').where('id', 'in', [second.orgId, twin.orgId]).execute();
    expect(new Set(slugs.map((s) => s.slug)).size).toBe(2);
    expect(slugs.map((s) => s.slug).sort()[0]).toBe('oak-diner-two');
  });

  it('in a group the tools act on one named venue; a manager is offered the plugin tools and not the owner\'s', async () => {
    const group = t.fixture.group;
    const manager = await group.as('manager');
    const scopes = ['setup:read', 'setup:write', 'plugins:read', 'plugins:write', 'venue:read', 'venue:write', 'connections:read', 'connections:write', 'team:write'];
    // A manager's key reads; an owner must allow changes. This one reads.
    const key = await issueKey(t.app, group.orgId, manager, { scopes });
    const s = await connectModern(t.app, key.key);
    const names = await s.names();
    expect(names).toEqual(expect.arrayContaining(['plugins_list', 'venue_describe', 'connections_list']));
    for (const tool of ['setup_status', 'go_live_check', 'go_live', 'plugin_enable', 'venue_update', 'connection_start', 'team_invite']) expect(names).not.toContain(tool);
    expect((await s.tools()).find((x) => x.name === 'plugins_list')!.inputProperties).toContain('venue');

    const cbd = (await s.call('plugins_list', { venue: 'cbd', only: 'on' })).structured as { venue: string; plugins: Array<{ plugin: string; on: boolean }> };
    expect(cbd.venue).toBe('Oak Group CBD');
    expect(cbd.plugins.every((p) => p.on)).toBe(true);
    expect(cbd.plugins.map((p) => p.plugin)).toEqual(expect.arrayContaining(['hub', 'analytics', 'ordering']));
    // A venue this person has no role at is not one of the choices.
    expect(await s.call('plugins_list', { venue: 'bondi' })).toMatchObject({ isError: true, text: expect.stringContaining('Venue not found') });
    expect((await s.call('plugins_list', {})).isError).toBe(true);
    await s.close();

    // With changes allowed (the owner's key), a setting changed at one venue leaves the other venue's alone.
    const owner = await group.as('owner');
    const ownerKey = await issueKey(t.app, group.orgId, owner, { scopes, canWrite: true });
    const o = await connectModern(t.app, ownerKey.key, { answer: () => 'yes' });
    const config = async (slug: string) => (await t.db.selectFrom('venue_modules').select('config').where('venue_id', '=', group.venues[slug]!.id).where('module_key', '=', 'ordering').executeTakeFirstOrThrow()).config as Record<string, unknown>;
    const newtownBefore = await config('newtown');
    const done = await o.call('plugin_configure', { venue: 'cbd', plugin: 'ordering', settings: { max_orders_per_slot: 11 } });
    expect(done.isError).toBe(false);
    expect(o.asked.at(-1)).toMatch(/^Change the settings of Online ordering at Oak Group CBD\? Settings: max_orders_per_slot: \d+ to 11\.$/);
    expect((await config('cbd')).max_orders_per_slot).toBe(11);
    expect(await config('newtown')).toEqual(newtownBefore);
    // The group is live: setup is complete, for its owner.
    expect((await o.call('setup_status', { venue: 'cbd' })).structured).toMatchObject({ complete: true, next: null });
    await o.close();
  });
});
