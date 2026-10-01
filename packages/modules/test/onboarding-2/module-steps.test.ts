import { beforeAll, describe, expect, it } from 'vitest';
import { type PlatformPrincipal, connect, drainJobs, tickSchedules } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { auth, loyalty, onboarding, website } from '@ros/modules';

/**
 * The modules' provisioning steps and go-live checks (onboarding/module-steps.ts), run through
 * the real provisioning job: what each makes is read back, the steps that wait on the venue say
 * why, a second run changes nothing, and the poll finishes what the venue has since done.
 */
const JOBS = { kinds: ['onboarding.provision', 'onboarding.poll', 'onboarding.menu_import', 'comms.send'] };
const HOURS = [2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, opensAt: '17:00', closesAt: '22:00', serviceType: 'dinner' }));
const MENU_TEXT = 'Entrees\nGarlic bread $12\nMains\nLamb shoulder $42\n';

// Dine-in venues also run loyalty here, declared the way a module declares it.
onboarding.declareServiceModule('dine-in', 'loyalty');

function intake(slug: string, over: Record<string, unknown> = {}) {
  return {
    identity: { legalName: 'Osteria Pty Ltd', tradingName: 'Osteria Nove', slug, gstRegistered: true, primaryContact: { firstName: 'Nina', lastName: 'Nove', email: `nina@${slug}.test` } },
    brand: { skeleton: 'editorial', tokens: { colour: { primary: '#14532D' } } },
    venues: { venues: [{ name: 'Osteria Nove', addressLine1: '9 Lygon St', suburb: 'Carlton', state: 'VIC', postcode: '3053', timezone: 'Australia/Melbourne', hours: HOURS }] },
    services: { services: ['dine-in', 'pickup'] },
    operations: { existingPos: 'Square', pacing: { ordersPerSlot: 9, slotMinutes: 20 } },
    menu: { source: 'text', sourceText: MENU_TEXT },
    floorPlan: { areas: [{ name: 'Dining room', tables: [{ label: 'T1', minSeats: 2, maxSeats: 4 }, { label: 'T2', minSeats: 2, maxSeats: 4 }, { label: 'Bar 1', minSeats: 1, maxSeats: 2 }] }] },
    comms: { smsSenderId: 'OSTERIA' },
    content: { about: 'Pasta in Carlton since last week.' },
    migration: {},
    ...over,
  } as Record<string, unknown>;
}

describe('onboarding-2: module provisioning steps and go-live checks', () => {
  const t = useTestEnv();
  let admin: PlatformPrincipal;
  let onboardingId: string;
  let orgId: string;
  let venueId: string;

  const steps = async () => Object.fromEntries((await t.db.selectFrom('provisioning_steps').select(['step', 'status', 'attempts', 'blocked_on', 'result']).where('onboarding_id', '=', onboardingId).execute()).map((r) => [r.step, r]));
  const owner = async () => {
    const s = await t.db.selectFrom('staff').select('user_id').where('org_id', '=', orgId).where('is_owner', '=', true).executeTakeFirstOrThrow();
    return (await auth.staffPrincipal(t.app, s.user_id, orgId))!;
  };
  const footprint = async () => {
    const n = async (table: 'qr_codes' | 'loyalty_programs' | 'menu_imports' | 'venue_modules' | 'menu_items') => Number((await t.db.selectFrom(table).select((eb) => eb.fn.countAll<string>().as('n')).where('org_id', '=', orgId).executeTakeFirstOrThrow()).n);
    return { qr: await n('qr_codes'), programmes: await n('loyalty_programs'), imports: await n('menu_imports'), modules: await n('venue_modules'), items: await n('menu_items') };
  };
  const poll = async () => {
    t.clock.advanceMinutes(10);
    await tickSchedules(t.app, { only: ['onboarding.poll'] });
    await drainJobs(t.app, JOBS);
  };

  beforeAll(async () => {
    const u = await t.db.selectFrom('users').select('id').where('email', '=', 'admin@rosplatform.test').executeTakeFirstOrThrow();
    admin = { kind: 'platform', adminUserId: u.id, reason: 'test' };
    t.sim.llm.respond(onboarding.MENU_EXTRACT_PURPOSE, () => ({
      sections: [
        { name: 'Entrees', description: null, items: [{ name: 'Garlic bread', description: null, price_cents: 1200, dietary_tags: [], allergens: ['gluten'], modifiers: [] }] },
        { name: 'Mains', description: null, items: [{ name: 'Lamb shoulder', description: null, price_cents: 4200, dietary_tags: [], allergens: [], modifiers: [] }] },
      ],
    }));
    const started = await onboarding.startOnboarding(t.app, admin, { tradingName: 'Osteria Nove' });
    onboardingId = started.onboardingId;
    for (const [section, data] of Object.entries(intake('osteria-nove'))) {
      await onboarding.saveIntakeSection(t.app, admin, { onboardingId, section: section as onboarding.IntakeSectionKey, data });
    }
    await onboarding.startProvisioning(t.app, admin, { onboardingId });
    await drainJobs(t.app, JOBS);
    orgId = (await t.db.selectFrom('onboardings').select('org_id').where('id', '=', onboardingId).executeTakeFirstOrThrow()).org_id!;
    venueId = (await t.db.selectFrom('venues').select('id').where('org_id', '=', orgId).executeTakeFirstOrThrow()).id;
  });

  it('runs every module step: what it could do is done and read back; what waits on the venue says why', async () => {
    const s = await steps();
    expect(Object.fromEntries(Object.entries(s).filter(([k]) => (onboarding.MODULE_PROVISIONING_STEPS as readonly string[]).includes(k)).map(([k, v]) => [k, v.status]))).toEqual({
      menu_import: 'blocked',
      sms_sender: 'blocked',
      ordering_defaults: 'done',
      payments_connect: 'blocked',
      qr_tables: 'done',
      loyalty_defaults: 'done',
      pos_connect: 'blocked',
    });
    expect(s.payments_connect!.blocked_on).toBe('Connect your payment account in the console (Settings, Payments) so guests can pay online at Osteria Nove.');
    expect(s.pos_connect!.blocked_on).toBe('Connect your point of sale in the console (Settings, Connections) so sales at Osteria Nove reach the platform.');
    expect(s.sms_sender!.blocked_on).toMatch(/^Registering the SMS sender id "OSTERIA" cannot be started automatically: no SMS provisioning provider is set up\./);
    // The menu was read by its job during the same drain: now it waits for the owner's review.
    expect(s.menu_import!.blocked_on).toMatch(/The menu is being read|Review the imported menu: 2 items wait/);
    // Waiting is not failing: none of these counted as an attempt.
    for (const k of ['payments_connect', 'pos_connect', 'sms_sender']) expect(s[k]!.attempts, k).toBe(0);

    // Read back what the done steps made.
    const ordering = await t.db.selectFrom('venue_modules').select('config').where('venue_id', '=', venueId).where('module_key', '=', 'ordering').executeTakeFirstOrThrow();
    expect(ordering.config).toMatchObject({ max_orders_per_slot: 9, slot_minutes: 20 });
    const codes = await t.db.selectFrom('qr_codes').select(['label', 'kind', 'area', 'is_active']).where('org_id', '=', orgId).orderBy('label').execute();
    expect(codes).toEqual([
      { label: 'Bar 1', kind: 'table', area: 'Dining room', is_active: true },
      { label: 'T1', kind: 'table', area: 'Dining room', is_active: true },
      { label: 'T2', kind: 'table', area: 'Dining room', is_active: true },
    ]);
    const programme = await t.db.selectFrom('loyalty_programs').select(['name', 'is_active']).where('org_id', '=', orgId).executeTakeFirstOrThrow();
    expect(programme).toEqual({ name: 'Osteria Nove Rewards', is_active: true });
    // The menu is a proposal: nothing on the menu yet.
    expect((await footprint()).items).toBe(0);

    // The status board says what the venue has to do.
    const board = (await onboarding.listOnboardings(t.app, admin)).find((b) => b.onboardingId === onboardingId)!;
    expect(board.status).toBe('review');
    expect(board.blockedOn).toEqual(expect.arrayContaining([s.payments_connect!.blocked_on, s.pos_connect!.blocked_on, s.sms_sender!.blocked_on]));
  });

  it('running again changes nothing', async () => {
    await poll();
    const before = { f: await footprint(), s: await steps() };
    await onboarding.runProvisioning(t.app, onboardingId);
    await onboarding.startProvisioning(t.app, admin, { onboardingId });
    await drainJobs(t.app, JOBS);
    expect(await footprint()).toEqual(before.f);
    const after = await steps();
    for (const k of onboarding.MODULE_PROVISIONING_STEPS) expect({ k, status: after[k]!.status, attempts: after[k]!.attempts }).toEqual({ k, status: before.s[k]!.status, attempts: before.s[k]!.attempts });
    expect(after.menu_import!.result).toEqual(before.s.menu_import!.result);
  });

  it('once the venue acts, the poll finishes the blocked steps: menu reviewed, payments and POS connected', async () => {
    expect((await steps()).menu_import!.blocked_on).toBe('Review the imported menu: 2 items wait for a yes or a no, allergens included.');
    const o = await owner();
    const importId = (await steps()).menu_import!.result as { imports: Record<string, string> };
    const id = importId.imports[venueId]!;
    await t.app.tenant(orgId, o, async (ctx) => {
      await onboarding.confirmImportItem(ctx, { importId: id, itemKey: 's1i1', allergensChecked: true });
      await onboarding.discardImportItem(ctx, { importId: id, itemKey: 's2i1' });
      await connect(ctx, { plugKey: 'sim-pay', venueId, externalAccountId: 'osteria-pay', credentials: { accessToken: 'sim' } });
      await connect(ctx, { plugKey: 'sim-pos', venueId, externalAccountId: 'osteria-pos', credentials: { accessToken: 'sim' } });
    });
    await poll();
    const s = await steps();
    expect([s.menu_import!.status, s.payments_connect!.status, s.pos_connect!.status, s.sms_sender!.status]).toEqual(['done', 'done', 'done', 'blocked']);
    expect(await t.db.selectFrom('menu_items').select(['name', 'price_cents']).where('org_id', '=', orgId).execute()).toEqual([{ name: 'Garlic bread', price_cents: 1200 }]);
  });

  it('go-live: the new checks gate, say why, and pass on the facts', async () => {
    const byKey = async () => Object.fromEntries((await onboarding.runGoLiveChecks(t.app, admin, { onboardingId })).items.map((i) => [i.key, i]));
    let c = await byKey();
    expect(c.menu_confirmed).toMatchObject({ status: 'fail', reason: 'The menu is in place, but the owner has not confirmed it yet.' });
    expect(c.payment_ready).toMatchObject({ status: 'fail', reason: 'no test payment has been taken at Osteria Nove.' });
    expect(c.kitchen_test_order).toMatchObject({ status: 'fail', reason: 'No paid test order has been accepted on the kitchen screen at Osteria Nove.' });
    expect(c.loyalty_enrolment_tested).toMatchObject({ status: 'fail', reason: 'Nobody has joined the loyalty programme yet. Join it once as a test guest.' });
    expect(c.redirects_mapped).toMatchObject({ status: 'not_applicable' });
    await expect(onboarding.goLive(t.app, admin, { onboardingId })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('Menu confirmed by the owner') });

    const o = await owner();
    await t.app.tenant(orgId, o, (ctx) => onboarding.confirmGoLiveItem(ctx, { key: 'menu_confirmed' }));
    await t.app.tenant(orgId, o, (ctx) => loyalty.enrolAtCounter(ctx, { venueId, email: 'test.guest@osteria.test', firstName: 'Test' }));
    c = await byKey();
    expect(c.menu_confirmed!.status).toBe('pass');
    expect(c.loyalty_enrolment_tested).toMatchObject({ status: 'pass', reason: '1 member has joined the programme.' });

    // Against a venue that has taken real orders (the fixture diner), the payment and kitchen checks pass on its facts.
    const diner = await t.db.selectFrom('onboardings').select('id').where('org_id', '=', t.fixture.diner.orgId).executeTakeFirstOrThrow();
    const dc = Object.fromEntries((await onboarding.runGoLiveChecks(t.app, admin, { onboardingId: diner.id })).items.map((i) => [i.key, i.status]));
    expect(dc.payment_ready).toBe('pass');
    expect(dc.kitchen_test_order).toBe('pass');
  });

  it('steps with nothing to do are skipped with a reason; redirects pass when every old address is mapped and fail naming the ones that are not', async () => {
    const started = await onboarding.startOnboarding(t.app, admin, { tradingName: 'Trattoria Due' });
    for (const [section, data] of Object.entries(intake('trattoria-due', { menu: {}, floorPlan: {}, comms: {}, operations: {}, services: { services: ['dine-in'] }, migration: { existingSiteUrl: 'http://old.due.example', redirects: [{ from: '/menu.html', to: '/menu' }] } }))) {
      await onboarding.saveIntakeSection(t.app, admin, { onboardingId: started.onboardingId, section: section as onboarding.IntakeSectionKey, data });
    }
    await onboarding.startProvisioning(t.app, admin, { onboardingId: started.onboardingId });
    await drainJobs(t.app, JOBS);
    const s = Object.fromEntries((await t.db.selectFrom('provisioning_steps').select(['step', 'status', 'result']).where('onboarding_id', '=', started.onboardingId).execute()).map((r) => [r.step, r]));
    // Nothing was asked for, so nothing waits: skipped, each with its reason.
    expect([s.menu_import!.status, s.sms_sender!.status, s.pos_connect!.status, s.qr_tables!.status, s.payments_connect!.status, s.ordering_defaults!.status]).toEqual(['skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(s.payments_connect!.result).toEqual({ reason: 'No venue takes payment online.' });
    const checks = Object.fromEntries((await onboarding.runGoLiveChecks(t.app, admin, { onboardingId: started.onboardingId })).items.map((i) => [i.key, i]));
    expect(checks.redirects_mapped).toMatchObject({ status: 'pass', reason: 'All 1 old addresses are redirected.' });
    expect(checks.payment_ready!.status).toBe('not_applicable');
    expect(checks.menu_confirmed).toMatchObject({ status: 'fail', reason: 'Osteria Nove has no menu items.' });
    // The redirect is removed: the check names the old address that now leads nowhere.
    const dueOrg = (await t.db.selectFrom('onboardings').select('org_id').where('id', '=', started.onboardingId).executeTakeFirstOrThrow()).org_id!;
    const r = await t.db.selectFrom('redirects').select('id').where('org_id', '=', dueOrg).executeTakeFirstOrThrow();
    await t.app.tenant(dueOrg, onboarding.PROVISIONER, (ctx) => website.removeRedirect(ctx, { redirectId: r.id }));
    const after = (await onboarding.runGoLiveChecks(t.app, admin, { onboardingId: started.onboardingId })).items.find((i) => i.key === 'redirects_mapped')!;
    expect(after).toMatchObject({ status: 'fail', reason: '1 old address has no redirect: /menu.html.' });
  });
});
