import { describe, expect, it } from 'vitest';
import { useTestEnv } from '@ros/testkit';
import { auth, tenancy } from '@ros/modules';

const codeFrom = (body: string) => body.match(/\b(\d{6})\b/)![1]!;

describe('sign-in and access', () => {
  const t = useTestEnv();

  it('staff sign in with a one-time code; the session acts for their one org', async () => {
    await auth.requestStaffLogin(t.app, 'Manager@Oak-Diner.test');
    const mail = t.sim.email.lastTo('manager@oak-diner.test')!;
    expect(mail.subject).toMatch(/sign-in code/);
    const login = await auth.verifyStaffLogin(t.app, 'manager@oak-diner.test', codeFrom(mail.body));
    expect(login.activeOrgId).toBe(t.fixture.diner.orgId);

    const who = await auth.authenticate(t.app, login.token);
    expect(who?.orgId).toBe(t.fixture.diner.orgId);
    expect(who?.principal).toMatchObject({ kind: 'staff', isOwner: false, venueRoles: { [t.fixture.diner.venueId]: 'manager' } });

    // The code is single use.
    await expect(auth.verifyStaffLogin(t.app, 'manager@oak-diner.test', codeFrom(mail.body))).rejects.toMatchObject({ code: 'unauthenticated' });

    await auth.revokeSession(t.app, login.token);
    expect(await auth.authenticate(t.app, login.token)).toBeNull();
  });

  it('asking for a code reveals nothing about who has an account', async () => {
    const before = t.sim.email.sent.length;
    await expect(auth.requestStaffLogin(t.app, 'nobody@nowhere.test')).resolves.toBeUndefined();
    expect(t.sim.email.sent.length).toBe(before);
  });

  it('a code stops working after five wrong guesses, and expires', async () => {
    await auth.requestStaffLogin(t.app, 'host@oak-diner.test');
    const good = codeFrom(t.sim.email.lastTo('host@oak-diner.test')!.body);
    const wrong = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await expect(auth.verifyStaffLogin(t.app, 'host@oak-diner.test', wrong)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(auth.verifyStaffLogin(t.app, 'host@oak-diner.test', good)).rejects.toMatchObject({ code: 'unauthenticated' });

    await auth.requestStaffLogin(t.app, 'kitchen@oak-diner.test');
    const late = codeFrom(t.sim.email.lastTo('kitchen@oak-diner.test')!.body);
    t.clock.advanceMinutes(11);
    await expect(auth.verifyStaffLogin(t.app, 'kitchen@oak-diner.test', late)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('code requests are rate limited per address', async () => {
    t.clock.advanceMinutes(30);
    for (let i = 0; i < 5; i++) await auth.requestStaffLogin(t.app, 'owner@oak-diner.test');
    await expect(auth.requestStaffLogin(t.app, 'owner@oak-diner.test')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('a principal built for one org finds nothing in another', async () => {
    const dinerOwner = await t.fixture.diner.as('owner');
    const groupVenue = t.fixture.group.venues.cbd!.id;
    // Even acting inside the other org's transaction, a venue the principal has no role at is not found.
    await expect(t.app.tenant(t.fixture.group.orgId, dinerOwner, (ctx) => tenancy.updateVenue(ctx, groupVenue, { name: 'Mine now' }))).rejects.toMatchObject({ code: 'not_found' });
    // And inside their own org, the other org's venue does not exist at all.
    await expect(t.app.tenant(t.fixture.diner.orgId, dinerOwner, (ctx) => tenancy.getVenue(ctx, groupVenue))).rejects.toMatchObject({ code: 'not_found' });
    // A session cannot be pointed at an org the person does not belong to.
    t.clock.advanceMinutes(30);
    await auth.requestStaffLogin(t.app, 'manager@oak-diner.test');
    const login = await auth.verifyStaffLogin(t.app, 'manager@oak-diner.test', codeFrom(t.sim.email.lastTo('manager@oak-diner.test')!.body));
    await expect(auth.selectOrg(t.app, login.token, t.fixture.group.orgId)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a guest signs in at one venue with a code and is known there only', async () => {
    const { diner, group } = t.fixture;
    const r = await auth.requestGuestLogin(t.app, diner.orgId, '0411 222 333');
    expect(r.channel).toBe('sms');
    const sms = t.sim.sms.lastTo('+61411222333')!;
    expect(sms.body).toContain('Oak Diner');
    const login = await auth.verifyGuestLogin(t.app, diner.orgId, '0411222333', codeFrom(sms.body));
    expect(login.created).toBe(true);

    const who = await auth.authenticate(t.app, login.token);
    expect(who).toMatchObject({ orgId: diner.orgId, principal: { kind: 'guest', customerId: login.customerId } });
    const verified = await t.db.selectFrom('customer_identities').select('verified_at').where('customer_id', '=', login.customerId).executeTakeFirstOrThrow();
    expect(verified.verified_at).not.toBeNull();

    // A code issued for one org does not work at another.
    await auth.requestGuestLogin(t.app, diner.orgId, 'cross@example.com');
    const code = codeFrom(t.sim.email.lastTo('cross@example.com')!.body);
    await expect(auth.verifyGuestLogin(t.app, group.orgId, 'cross@example.com', code)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('a manager can add front-of-house staff but not another manager; an invite is queued, not sent inline', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const invited = await t.app.tenant(diner.orgId, manager, (ctx) =>
      auth.inviteStaff(ctx, { email: 'new.host@oak-diner.test', firstName: 'Nia', roles: [{ venueId: diner.venueId, role: 'front_of_house' }] }),
    );
    expect(invited.status).toBe('invited');
    await expect(
      t.app.tenant(diner.orgId, manager, (ctx) => auth.inviteStaff(ctx, { email: 'new.mgr@oak-diner.test', firstName: 'Max', roles: [{ venueId: diner.venueId, role: 'manager' }] })),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(diner.orgId, manager, (ctx) => auth.inviteStaff(ctx, { email: 'new.owner@oak-diner.test', firstName: 'Ola', isOwner: true }))).rejects.toMatchObject({ code: 'forbidden' });
    const msg = await t.db.selectFrom('messages').select(['status', 'template_key']).where('to_address', '=', 'new.host@oak-diner.test').executeTakeFirstOrThrow();
    expect(msg).toEqual({ status: 'queued', template_key: 'staff.invite' });
  });

  it('removing a person ends their sessions at once', async () => {
    const { diner } = t.fixture;
    t.clock.advanceMinutes(30);
    await auth.requestStaffLogin(t.app, 'kitchen@oak-diner.test');
    const login = await auth.verifyStaffLogin(t.app, 'kitchen@oak-diner.test', codeFrom(t.sim.email.lastTo('kitchen@oak-diner.test')!.body));
    expect(await auth.authenticate(t.app, login.token)).not.toBeNull();
    const owner = await diner.as('owner');
    await t.app.tenant(diner.orgId, owner, (ctx) => auth.disableStaff(ctx, diner.staff.kitchen!.staffId));
    expect(await auth.authenticate(t.app, login.token)).toBeNull();
  });

  it('a kitchen screen pairs with a short code and can then act only for its venue', async () => {
    const { group } = t.fixture;
    const manager = await group.as('manager');
    const pairing = await t.app.tenant(group.orgId, manager, (ctx) => auth.createDevicePairing(ctx, { venueId: group.venues.cbd!.id, name: 'Pass screen', purpose: 'kitchen' }));
    await expect(auth.pairDevice(t.app, 'WRONGCODE')).rejects.toMatchObject({ code: 'unauthenticated' });
    const paired = await auth.pairDevice(t.app, pairing.code.toLowerCase());
    expect(paired.venueId).toBe(group.venues.cbd!.id);
    await expect(auth.pairDevice(t.app, pairing.code)).rejects.toMatchObject({ code: 'unauthenticated' });

    const device = await auth.authenticateDevice(t.app, paired.token);
    expect(device).toMatchObject({ orgId: group.orgId, principal: { kind: 'device', venueId: group.venues.cbd!.id, purpose: 'kitchen' } });

    await t.app.tenant(group.orgId, manager, (ctx) => auth.revokeDevice(ctx, pairing.deviceId));
    expect(await auth.authenticateDevice(t.app, paired.token)).toBeNull();
    // The manager has no role at Bondi, so cannot pair a screen there.
    await expect(t.app.tenant(group.orgId, manager, (ctx) => auth.createDevicePairing(ctx, { venueId: group.venues.bondi!.id, name: 'X', purpose: 'kitchen' }))).rejects.toMatchObject({ code: 'not_found' });
  });
});
