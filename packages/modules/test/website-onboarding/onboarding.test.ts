import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type PlatformPrincipal, drainJobs, tickSchedules } from '@ros/core';
import { SIM_WEBHOOK_SECRET } from '@ros/adapters';
import { useTestEnv } from '@ros/testkit';
import { auth, comms, onboarding, tenancy, website } from '@ros/modules';

const ANON = { kind: 'anon' as const };
const JOBS = { kinds: ['onboarding.provision', 'onboarding.poll', 'comms.send'] };

// This file is about the spine's and the website's own steps and checks. The other modules'
// (onboarding/module-steps.ts: menu import, payments, POS, QR, loyalty, SMS) are exercised in
// test/onboarding-2, so they are set aside here.
for (const key of onboarding.MODULE_PROVISIONING_STEPS) onboarding.unregisterProvisioningStep(key);
for (const key of onboarding.MODULE_GO_LIVE_CHECKS) onboarding.unregisterGoLiveCheck(key);

// A step from "another module", to prove the registry: it runs in order, after what it depends on.
onboarding.registerProvisioningStep({
  key: 'test_marker',
  order: 55,
  label: 'Test marker',
  blockedOn: ['pages'],
  run: async (_app, s) => ({ status: 'done', result: { finishedBefore: Object.keys(s.results).sort() } }),
});

const HOURS = [2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, opensAt: '17:00', closesAt: '22:00', serviceType: 'dinner' }));

function intakeFor(slug: string, opts: { customDomain?: string | null; sendingDomain?: string | null; staff?: boolean } = {}) {
  return {
    identity: {
      legalName: 'Bella Trattoria Pty Ltd',
      tradingName: 'Bella Trattoria',
      slug,
      abn: '12 345 678 901',
      gstRegistered: true,
      primaryContact: { firstName: 'Bella', lastName: 'Rossi', role: 'Owner', mobile: '0412 000 111', email: `bella@${slug}.test` },
    },
    brand: {
      skeleton: 'editorial',
      tokens: { colour: { primary: '#14532D', accent: '#B45309' }, typography: { heading: { family: 'Cormorant Garamond', weights: [400, 700] } } },
      toneOfVoice: 'Warm and unhurried. We talk like family.',
      adjectives: ['warm', 'generous'],
      photography: { hero: 'https://assets.example.com/bella/hero.jpg', food: ['https://assets.example.com/bella/pasta.jpg'], room: [], team: [] },
    },
    venues: {
      venues: [
        {
          name: 'Bella Trattoria',
          addressLine1: '12 Norton Street',
          suburb: 'Carlton',
          state: 'VIC',
          postcode: '3053',
          lat: -37.8,
          lng: 144.967,
          phone: '03 5550 1234',
          email: 'ciao@bella.example',
          timezone: 'Australia/Melbourne',
          hours: HOURS,
          exceptions: [{ date: '2026-12-25', closed: true, reason: 'Christmas Day' }],
          capacity: 48,
          cuisineTags: ['italian'],
          priceBand: 2,
          licensed: true,
        },
      ],
    },
    services: { services: ['dine-in', 'pickup'] },
    content: {
      tagline: 'Pasta made this morning.',
      about: 'A family room in Carlton since 1987.\n\nNonna still makes the gnocchi on Thursdays.',
      faq: [{ question: 'BYO?', answer: 'Wine only, Monday to Wednesday.' }],
    },
    comms: opts.sendingDomain === null ? {} : { sendingDomain: opts.sendingDomain ?? `mail.${slug}.example`, fromName: 'Bella Trattoria' },
    integrations: { socialLinks: { instagram: 'https://www.instagram.com/bellatrattoria' } },
    migration: {
      existingSiteUrl: 'http://old.bella.example',
      sitemapUrls: ['http://old.bella.example/', 'http://old.bella.example/our-menu.html', 'http://old.bella.example/the-family/', 'http://old.bella.example/bookings.php', 'http://old.bella.example/news/2019/reopening'],
      ...(opts.customDomain === null ? {} : { customDomain: opts.customDomain ?? `${slug}.example.com.au` }),
    },
    team:
      opts.staff === false
        ? {}
        : {
            staff: [
              { email: `marco@${slug}.test`, firstName: 'Marco', role: 'manager' },
              { email: `gia@${slug}.test`, firstName: 'Gia', lastName: 'Floor', role: 'front_of_house', venueSlugs: ['main'] },
            ],
          },
  } as Record<string, unknown>;
}

describe('onboarding: intake, provisioning, go-live', () => {
  const t = useTestEnv();

  let admin: PlatformPrincipal;
  const getAdmin = async () => {
    if (!admin) {
      const u = await t.db.selectFrom('users').select('id').where('email', '=', 'admin@rosplatform.test').executeTakeFirstOrThrow();
      admin = { kind: 'platform', adminUserId: u.id, reason: 'test' };
    }
    return admin;
  };

  /** A complete intake saved section by section, ready to provision. */
  async function soldAndFilledIn(slug: string, opts: Parameters<typeof intakeFor>[1] = {}): Promise<string> {
    const a = await getAdmin();
    const started = await onboarding.startOnboarding(t.app, a, { tradingName: 'Bella Trattoria' });
    for (const [section, data] of Object.entries(intakeFor(slug, opts))) {
      await onboarding.saveIntakeSection(t.app, a, { onboardingId: started.onboardingId, section: section as onboarding.IntakeSectionKey, data });
    }
    return started.onboardingId;
  }

  const steps = async (onboardingId: string) => {
    const rows = await t.db.selectFrom('provisioning_steps').select(['step', 'status', 'attempts', 'blocked_on', 'error', 'result']).where('onboarding_id', '=', onboardingId).execute();
    return Object.fromEntries(rows.map((r) => [r.step, r]));
  };
  const statuses = async (onboardingId: string) => Object.fromEntries(Object.entries(await steps(onboardingId)).map(([k, v]) => [k, v.status]));
  const orgOf = async (onboardingId: string) => (await t.db.selectFrom('onboardings').select(['org_id', 'status', 'live_at', 'manual_touch_minutes']).where('id', '=', onboardingId).executeTakeFirstOrThrow());
  const ownerOf = async (orgId: string) => {
    const s = await t.db.selectFrom('staff').select(['user_id', 'email']).where('org_id', '=', orgId).where('is_owner', '=', true).executeTakeFirstOrThrow();
    return { email: s.email, principal: (await auth.staffPrincipal(t.app, s.user_id, orgId))! };
  };

  /** What provisioning makes, counted. Used to show a second run adds nothing. */
  async function footprint(orgId: string) {
    const count = async (table: 'venues' | 'staff' | 'pages' | 'brands' | 'domains' | 'trading_hours' | 'hour_exceptions' | 'redirects' | 'venue_modules' | 'messages' | 'sending_identities') =>
      Number((await t.db.selectFrom(table).select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', orgId).executeTakeFirstOrThrow()).n);
    return {
      venues: await count('venues'),
      staff: await count('staff'),
      pages: await count('pages'),
      brands: await count('brands'),
      domains: await count('domains'),
      tradingHours: await count('trading_hours'),
      hourExceptions: await count('hour_exceptions'),
      redirects: await count('redirects'),
      modules: await count('venue_modules'),
      messages: await count('messages'),
      sendingIdentities: await count('sending_identities'),
    };
  }

  let bella: { onboardingId: string; orgId: string };

  it('the intake is saved a section at a time, reports what is still missing, and refuses what is wrong', async () => {
    const a = await getAdmin();
    // Only the platform team runs onboarding.
    const dinerOwner = await t.fixture.diner.as('owner');
    await expect(onboarding.startOnboarding(t.app, dinerOwner, { tradingName: 'Sneaky' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(onboarding.startOnboarding(t.app, ANON, { tradingName: 'Sneaky' })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(onboarding.startOnboarding(t.app, { kind: 'platform', adminUserId: randomUUID(), reason: 'forged' }, { tradingName: 'Sneaky' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(onboarding.startOnboarding(t.app, { kind: 'platform', reason: 'no admin named' }, { tradingName: 'Sneaky' })).rejects.toMatchObject({ code: 'forbidden' });

    const started = await onboarding.startOnboarding(t.app, a, { tradingName: 'Bella Trattoria', contactEmail: 'Bella@Bella-Trattoria.test' });
    expect(started).toMatchObject({ status: 'intake', orgId: null, version: onboarding.INTAKE_VERSION, complete: false, percentComplete: 0 });
    expect(started.sections.map((s) => s.key)).toEqual(['identity', 'brand', 'venues', 'services', 'operations', 'menu', 'floorPlan', 'comms', 'integrations', 'content', 'migration', 'criota', 'team']);
    const identity = started.sections.find((s) => s.key === 'identity')!;
    expect(identity.status).toBe('in_progress');
    expect(identity.missing).toEqual(expect.arrayContaining(['legalName', 'slug', 'primaryContact.firstName']));
    expect(identity.missing).not.toContain('primaryContact.email');
    expect(started.stillNeeded.map((s) => s.section)).toEqual(['identity', 'brand', 'venues', 'services', 'content']);
    const id = started.onboardingId;
    const save = (section: onboarding.IntakeSectionKey, data: unknown) => onboarding.saveIntakeSection(t.app, a, { onboardingId: id, section, data });
    const full = intakeFor('bella-trattoria');

    // Half a section is fine: it is saved, and what is missing is named.
    const half = await save('brand', { tokens: { colour: { primary: '#14532D' } } });
    expect(half.sections.find((s) => s.key === 'brand')).toMatchObject({ status: 'in_progress', missing: ['skeleton'] });
    const halfVenue = await save('venues', { venues: [{ name: 'Bella Trattoria', suburb: 'Carlton' }] });
    expect(halfVenue.sections.find((s) => s.key === 'venues')!.missing).toEqual(expect.arrayContaining(['venues.0.addressLine1', 'venues.0.postcode', 'venues.0.hours']));

    // What is present must be right. None of these is saved.
    const before = await t.db.selectFrom('onboardings').select(['intake', 'intake_progress']).where('id', '=', id).executeTakeFirstOrThrow();
    await expect(save('identity', { ...(full.identity as object), primaryContact: { firstName: 'Bella', email: 'not-an-email' } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(save('identity', { ...(full.identity as object), slug: 'Has Spaces' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(save('content', { about: 'We are <b>the best</b><script>alert(1)</script>' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(save('brand', { skeleton: 'editorial', tokens: { colour: { text: '#FFFFFF' } } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(save('brand', { skeleton: 'brutalist' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(save('migration', { customDomain: 'javascript:alert(1)' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(save('migration', { redirects: [{ from: '/a', to: '/b', statusCode: 307 }] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(save('integrations', { socialLinks: { instagram: 'https://evil.example/insta' } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(save('venues', { venues: [{ ...(full.venues as { venues: object[] }).venues[0], timezone: 'Mars/Olympus' }] })).rejects.toMatchObject({ code: 'invalid' });
    expect(await t.db.selectFrom('onboardings').select(['intake', 'intake_progress']).where('id', '=', id).executeTakeFirstOrThrow()).toEqual(before);

    // Provisioning will not start on an unfinished intake, and says what is missing.
    await expect(onboarding.startProvisioning(t.app, a, { onboardingId: id })).rejects.toMatchObject({ code: 'invalid', details: { stillNeeded: expect.arrayContaining([expect.objectContaining({ section: 'venues' })]) } });

    let view = started;
    for (const [section, data] of Object.entries(full)) view = await save(section as onboarding.IntakeSectionKey, data);
    expect(view).toMatchObject({ complete: true, percentComplete: 100, stillNeeded: [] });
    // Resumable: a later session reads back exactly what was saved, with its progress.
    const resumed = await onboarding.getIntake(t.app, a, { onboardingId: id });
    expect(resumed.data.identity).toEqual(full.identity);
    expect(resumed.sections.find((s) => s.key === 'operations')).toMatchObject({ status: 'empty', required: false });
    const stored = await t.db.selectFrom('onboardings').select(['intake', 'intake_progress', 'org_id', 'status']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ org_id: null, status: 'intake', intake_progress: { identity: { status: 'complete', missing: [] }, venues: { status: 'complete' }, menu: { status: 'empty' } } });
    await expect(onboarding.getIntake(t.app, dinerOwner, { onboardingId: id })).rejects.toMatchObject({ code: 'forbidden' });
    bella = { onboardingId: id, orgId: '' };
  });

  it('provisioning creates a working org from the intake and reports what is waiting on the venue', async () => {
    const a = await getAdmin();
    const { onboardingId } = bella;
    const orgsBefore = Number((await t.db.selectFrom('orgs').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    await expect(onboarding.startProvisioning(t.app, await t.fixture.diner.as('owner'), { onboardingId })).rejects.toMatchObject({ code: 'forbidden' });

    expect(await onboarding.startProvisioning(t.app, a, { onboardingId })).toEqual({ onboardingId, status: 'provisioning' });
    // Nothing is created in the request: a job does it.
    expect(Number((await t.db.selectFrom('orgs').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)).toBe(orgsBefore);
    await drainJobs(t.app, JOBS);

    const o = await orgOf(onboardingId);
    expect(o.status).toBe('review');
    const orgId = o.org_id!;
    bella.orgId = orgId;

    expect(await statuses(onboardingId)).toMatchObject({
      org: 'done',
      brand: 'done',
      hours: 'done',
      modules: 'done',
      pages: 'done',
      test_marker: 'done',
      redirects: 'done',
      subdomain: 'done',
      custom_domain: 'blocked',
      sending_domain: 'blocked',
      staff: 'done',
    });
    const s = await steps(onboardingId);
    const finishedBefore = (s.test_marker!.result as { finishedBefore: string[] }).finishedBefore;
    expect(finishedBefore).toEqual(expect.arrayContaining(['brand', 'hours', 'modules', 'org', 'pages']));
    expect(finishedBefore).not.toContain('redirects');
    expect(s.custom_domain!.blocked_on).toBe('Waiting for DNS: the records for bella-trattoria.example.com.au have not been added at the domain registrar yet.');
    expect(s.sending_domain!.blocked_on).toBe('Waiting for DNS: the sending records for mail.bella-trattoria.example have not been added yet.');

    // The org, its venue and its owner.
    const org = await t.db.selectFrom('orgs').selectAll().where('id', '=', orgId).executeTakeFirstOrThrow();
    expect(org).toMatchObject({ slug: 'bella-trattoria', legal_name: 'Bella Trattoria Pty Ltd', trading_name: 'Bella Trattoria', status: 'onboarding', timezone: 'Australia/Melbourne' });
    const venue = await t.db.selectFrom('venues').selectAll().where('org_id', '=', orgId).executeTakeFirstOrThrow();
    expect(venue).toMatchObject({ slug: 'main', name: 'Bella Trattoria', suburb: 'Carlton', postcode: '3053', timezone: 'Australia/Melbourne', phone: '03 5550 1234', cuisine_tags: ['italian'], price_band: 2, status: 'setup' });
    const staff = await t.db.selectFrom('staff').select(['email', 'is_owner', 'status']).where('org_id', '=', orgId).orderBy('email').execute();
    expect(staff).toEqual([
      { email: 'bella@bella-trattoria.test', is_owner: true, status: 'active' },
      { email: 'gia@bella-trattoria.test', is_owner: false, status: 'invited' },
      { email: 'marco@bella-trattoria.test', is_owner: false, status: 'invited' },
    ]);
    const roles = await t.db.selectFrom('staff_venues as sv').innerJoin('staff as st', 'st.id', 'sv.staff_id').select(['st.email', 'sv.role']).where('sv.org_id', '=', orgId).orderBy('st.email').execute();
    expect(roles).toEqual([
      { email: 'bella@bella-trattoria.test', role: 'owner' },
      { email: 'gia@bella-trattoria.test', role: 'front_of_house' },
      { email: 'marco@bella-trattoria.test', role: 'manager' },
    ]);
    // The invitations went through the outbox and were sent by the worker, once each.
    expect(t.sim.email.sent.filter((m) => m.to === 'marco@bella-trattoria.test')).toHaveLength(1);
    expect(t.sim.email.lastTo('gia@bella-trattoria.test')?.subject).toBe('You have been added to Bella Trattoria');

    // Brand, hours, modules, pages, redirects.
    const brand = await t.db.selectFrom('brands').select(['tokens', 'layout_skeleton', 'tone_of_voice', 'venue_id']).where('org_id', '=', orgId).executeTakeFirstOrThrow();
    expect(brand).toMatchObject({ layout_skeleton: 'editorial', venue_id: null, tone_of_voice: 'Warm and unhurried. We talk like family.', tokens: { colour: { primary: '#14532D', accent: '#B45309', surface: '#FFFDF8' }, typography: { heading: { family: 'Cormorant Garamond' } } } });
    expect(await t.db.selectFrom('trading_hours').select('day_of_week').where('venue_id', '=', venue.id).orderBy('day_of_week').execute()).toEqual([2, 3, 4, 5, 6].map((d) => ({ day_of_week: d })));
    expect(await t.db.selectFrom('hour_exceptions').select(['date', 'closed', 'reason']).where('venue_id', '=', venue.id).execute()).toEqual([{ date: '2026-12-25', closed: true, reason: 'Christmas Day' }]);
    const modules = await t.db.selectFrom('venue_modules').select(['module_key', 'enabled', 'config']).where('venue_id', '=', venue.id).execute();
    const on = modules.filter((m) => m.enabled).map((m) => m.module_key);
    expect(on).toEqual(expect.arrayContaining(onboarding.modulesForServices(['dine-in', 'pickup'])));
    expect(on).toContain('website');
    expect(modules.find((m) => m.module_key === 'website')!.config).toMatchObject({ socialLinks: { instagram: 'https://www.instagram.com/bellatrattoria' } });
    const pages = await t.db.selectFrom('pages').select(['slug', 'status', 'venue_id']).where('org_id', '=', orgId).orderBy('slug').execute();
    expect(pages).toEqual(['contact', 'home', 'menu', 'story'].map((slug) => ({ slug, status: 'published', venue_id: null })));
    const redirects = await t.db.selectFrom('redirects').select(['from_path', 'to_path']).where('org_id', '=', orgId).orderBy('from_path').execute();
    expect(redirects).toEqual([
      { from_path: '/bookings.php', to_path: '/contact' },
      { from_path: '/news/2019/reopening', to_path: '/' },
      { from_path: '/our-menu.html', to_path: '/menu' },
      { from_path: '/the-family', to_path: '/' },
    ]);

    // Live on the subdomain straight away; the custom domain is registered and serves nothing yet.
    expect(await tenancy.resolveHost(t.app, 'bella-trattoria.tables.test')).toMatchObject({ orgId, primaryHost: 'bella-trattoria.tables.test' });
    expect(await tenancy.resolveHost(t.app, 'bella-trattoria.example.com.au')).toBeNull();
    expect(t.sim.hosting.has('bella-trattoria.example.com.au')).toBe(true);
    const site = await t.app.tenant(orgId, ANON, (ctx) => website.getSite(ctx));
    expect(site).toMatchObject({ org: { name: 'Bella Trattoria', status: 'onboarding' }, skeleton: { key: 'editorial' }, venue: { suburb: 'Carlton' } });
    expect(site.brand.cssVariables['--brand-color-primary']).toBe('#14532D');
    const home = await t.app.tenant(orgId, ANON, (ctx) => website.getPage(ctx, { slug: 'home' }));
    expect(home.blocks[0]).toMatchObject({ type: 'hero', heading: 'Bella Trattoria', subheading: 'Pasta made this morning.', imageUrl: 'https://assets.example.com/bella/hero.jpg' });

    // The sending identity exists, unverified, with the DNS records the venue needs.
    const identity = await t.db.selectFrom('sending_identities').select(['domain', 'from_email', 'status', 'dns_records', 'provider']).where('org_id', '=', orgId).executeTakeFirstOrThrow();
    expect(identity).toMatchObject({ domain: 'mail.bella-trattoria.example', from_email: 'hello@mail.bella-trattoria.example', status: 'pending', provider: 'sim-email' });
    expect((identity.dns_records as unknown[]).length).toBeGreaterThan(0);

    const events = await t.db.selectFrom('events').select(['name', 'properties']).where('org_id', '=', orgId).where('name', '=', 'org.provisioned').execute();
    expect(events).toHaveLength(1);
    expect(events[0]!.properties).toMatchObject({ onboarding_id: onboardingId, steps_blocked: 2 });
  });

  it('the status board shows every in-flight onboarding and what each is blocked on; the owner sees what is waiting on them', async () => {
    const a = await getAdmin();
    const board = await onboarding.listOnboardings(t.app, a);
    // The two fixture orgs are live with nothing waiting, so they are not on the board.
    expect(board.map((b) => b.name)).toEqual(['Bella Trattoria']);
    expect(board[0]).toMatchObject({
      onboardingId: bella.onboardingId,
      orgId: bella.orgId,
      status: 'review',
      intake: { complete: true, percentComplete: 100 },
      blockedOn: [
        'Waiting for DNS: the records for bella-trattoria.example.com.au have not been added at the domain registrar yet.',
        'Waiting for DNS: the sending records for mail.bella-trattoria.example have not been added yet.',
      ],
      timeToLiveHours: null,
    });
    const mine = ['org', 'brand', 'hours', 'modules', 'pages', 'test_marker', 'redirects', 'subdomain', 'custom_domain', 'sending_domain', 'staff'];
    expect(board[0]!.steps.map((s) => s.key).filter((k) => mine.includes(k))).toEqual(mine);
    expect((await onboarding.listOnboardings(t.app, a, { includeFinished: true })).length).toBe(3);
    await expect(onboarding.listOnboardings(t.app, await t.fixture.diner.as('owner'))).rejects.toMatchObject({ code: 'forbidden' });

    const owner = await ownerOf(bella.orgId);
    const own = await t.app.tenant(bella.orgId, owner.principal, (ctx) => onboarding.getOwnOnboarding(ctx));
    const domainStep = own!.steps.find((s) => s.key === 'custom_domain')!;
    expect(domainStep.waitingOn).toMatch(/^Waiting for DNS/);
    expect(domainStep.records).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'CNAME' })]));
    // Another org's owner sees their own onboarding, never this one.
    const other = await t.app.tenant(t.fixture.diner.orgId, await t.fixture.diner.as('owner'), (ctx) => onboarding.getOwnOnboarding(ctx));
    expect(other).toMatchObject({ status: 'live' });
    expect(other!.steps).toEqual([]);
  });

  it('running provisioning again changes nothing', async () => {
    const before = { footprint: await footprint(bella.orgId), steps: await steps(bella.onboardingId), sent: t.sim.email.sent.length };
    expect(before.steps.org!.attempts).toBe(1);
    expect(before.steps.staff!.attempts).toBe(1);

    await onboarding.runProvisioning(t.app, bella.onboardingId);
    const run = await onboarding.runProvisioning(t.app, bella.onboardingId);
    expect(run.status).toBe('review');
    // And through the job, as a second worker or a repeated click would.
    await onboarding.startProvisioning(t.app, await getAdmin(), { onboardingId: bella.onboardingId });
    await drainJobs(t.app, JOBS);

    expect(await footprint(bella.orgId)).toEqual(before.footprint);
    expect(await steps(bella.onboardingId)).toEqual(before.steps);
    expect(t.sim.email.sent.length).toBe(before.sent);
    expect(Number((await t.db.selectFrom('orgs').select((eb) => eb.fn.countAll<number>().as('n')).where('slug', '=', 'bella-trattoria').executeTakeFirstOrThrow()).n)).toBe(1);
    expect(t.sim.hosting.domains.size).toBe(1);
  });

  it('a venue cannot mark its own domain or its own sending identity verified', async () => {
    const owner = await ownerOf(bella.orgId);
    const domain = await t.db.selectFrom('domains').select(['id', 'verified_at']).where('org_id', '=', bella.orgId).where('kind', '=', 'custom').executeTakeFirstOrThrow();
    const identity = await t.db.selectFrom('sending_identities').select('id').where('org_id', '=', bella.orgId).executeTakeFirstOrThrow();

    await expect(t.app.tenant(bella.orgId, owner.principal, (ctx) => tenancy.markDomainVerified(ctx, domain.id))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(bella.orgId, owner.principal, (ctx) => comms.setSendingIdentityStatus(ctx, identity.id, 'verified'))).rejects.toMatchObject({ code: 'forbidden' });
    // Nor by an assistant acting for the owner.
    const agent = { kind: 'agent' as const, keyId: randomUUID(), staff: owner.principal, scopes: ['venue:write'], venueIds: null, canWrite: true };
    await expect(t.app.tenant(bella.orgId, agent, (ctx) => tenancy.markDomainVerified(ctx, domain.id))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(bella.orgId, agent, (ctx) => comms.setSendingIdentityStatus(ctx, identity.id, 'verified'))).rejects.toMatchObject({ code: 'forbidden' });

    expect((await t.db.selectFrom('domains').select('verified_at').where('id', '=', domain.id).executeTakeFirstOrThrow()).verified_at).toBeNull();
    expect((await t.db.selectFrom('sending_identities').select('status').where('id', '=', identity.id).executeTakeFirstOrThrow()).status).toBe('pending');
    expect(await tenancy.resolveHost(t.app, 'bella-trattoria.example.com.au')).toBeNull();
    // Re-running provisioning does not verify it either: the provider has not seen the records.
    await onboarding.runProvisioning(t.app, bella.onboardingId);
    expect((await statuses(bella.onboardingId)).custom_domain).toBe('blocked');
  });

  it('when the provider confirms the DNS records, the scheduled poll finishes the blocked steps', async () => {
    // The venue adds its records; the provider now reports both domains verified.
    t.sim.hosting.verify('bella-trattoria.example.com.au');
    t.sim.sendingDomains.verify('mail.bella-trattoria.example');
    t.clock.advanceMinutes(10);
    await tickSchedules(t.app, { only: ['onboarding.poll'] });
    await drainJobs(t.app, JOBS);

    expect(await statuses(bella.onboardingId)).toMatchObject({ custom_domain: 'done', sending_domain: 'done' });
    const domains = await t.db.selectFrom('domains').select(['host', 'kind', 'is_primary', 'verified_at', 'provider_domain_id']).where('org_id', '=', bella.orgId).orderBy('kind').execute();
    expect(domains.find((d) => d.kind === 'custom')).toMatchObject({ host: 'bella-trattoria.example.com.au', is_primary: true, provider_domain_id: 'simdom_1' });
    expect(domains.find((d) => d.kind === 'custom')!.verified_at).not.toBeNull();
    expect(domains.find((d) => d.kind === 'subdomain')).toMatchObject({ is_primary: false });
    expect(await tenancy.resolveHost(t.app, 'bella-trattoria.example.com.au')).toMatchObject({ orgId: bella.orgId, primaryHost: 'bella-trattoria.example.com.au' });
    // The subdomain keeps working and points at the custom domain.
    expect(await tenancy.resolveHost(t.app, 'bella-trattoria.tables.test')).toMatchObject({ orgId: bella.orgId, primaryHost: 'bella-trattoria.example.com.au' });
    expect((await t.db.selectFrom('sending_identities').select(['status', 'verified_at']).where('org_id', '=', bella.orgId).executeTakeFirstOrThrow()).status).toBe('verified');
    // The verification is on the org's own audit log, made by the platform, not by a staff member.
    const audited = await t.db.selectFrom('audit_log').select(['action', 'actor_kind']).where('org_id', '=', bella.orgId).where('action', 'in', ['domain.verified', 'sending_identity.status']).execute();
    expect(audited.map((x) => x.actor_kind)).toEqual(['platform', 'platform']);
    expect((await onboarding.listOnboardings(t.app, await getAdmin()))[0]!.blockedOn).toEqual([]);
  });

  it('a step that fails is retried on its own; finished steps are not redone', async () => {
    const onboardingId = await soldAndFilledIn('casa-verde', { sendingDomain: null });
    t.sim.hosting.failNext(1, 'hosting API timed out');
    await onboarding.runProvisioning(t.app, onboardingId);

    let s = await steps(onboardingId);
    expect(s.custom_domain).toMatchObject({ status: 'failed', attempts: 1, error: 'hosting API timed out' });
    // Steps that do not depend on it still ran.
    expect(s.sending_domain!.status).toBe('skipped');
    expect(s.staff).toMatchObject({ status: 'done', attempts: 1 });
    expect((await orgOf(onboardingId)).status).toBe('provisioning');
    const orgId = (await orgOf(onboardingId)).org_id!;
    const board = await onboarding.listOnboardings(t.app, await getAdmin());
    expect(board.find((b) => b.onboardingId === onboardingId)!.blockedOn).toEqual(['Custom domain: register, surface DNS records, verify failed: hosting API timed out']);
    const before = await footprint(orgId);

    // The poll picks it up again; only the failed step runs.
    t.clock.advanceMinutes(10);
    await tickSchedules(t.app, { only: ['onboarding.poll'] });
    await drainJobs(t.app, JOBS);
    s = await steps(onboardingId);
    expect(s.custom_domain).toMatchObject({ status: 'blocked', error: null });
    for (const key of ['org', 'brand', 'hours', 'modules', 'pages', 'redirects', 'subdomain', 'staff']) expect(s[key], key).toMatchObject({ status: 'done', attempts: 1 });
    expect(await footprint(orgId)).toEqual(before);
    expect((await orgOf(onboardingId)).status).toBe('review');
  });

  it('a failure in the first step holds everything behind it, stalls after repeated attempts, and resumes once fixed', async () => {
    const a = await getAdmin();
    // The address asked for is already another org's.
    const onboardingId = await soldAndFilledIn('oak-diner', { customDomain: null, sendingDomain: null, staff: false });
    const orgsBefore = Number((await t.db.selectFrom('orgs').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);

    const first = await onboarding.runProvisioning(t.app, onboardingId);
    expect(first.status).toBe('provisioning');
    let s = await steps(onboardingId);
    expect(s.org).toMatchObject({ status: 'failed', attempts: 1, error: 'That address is already taken.' });
    expect(s.brand).toMatchObject({ status: 'pending', attempts: 0, blocked_on: 'Waits for "Create the organisation, its venues and the owner" to finish.' });
    expect(s.pages).toMatchObject({ status: 'pending', attempts: 0 });
    expect((await orgOf(onboardingId)).org_id).toBeNull();

    for (let i = 1; i < onboarding.MAX_STEP_ATTEMPTS; i++) await onboarding.runProvisioning(t.app, onboardingId);
    expect((await steps(onboardingId)).org).toMatchObject({ status: 'failed', attempts: onboarding.MAX_STEP_ATTEMPTS });
    expect((await orgOf(onboardingId)).status).toBe('stalled');
    // A stalled onboarding waits for a person: another run does not try again, and the poll leaves it alone.
    await onboarding.runProvisioning(t.app, onboardingId);
    t.clock.advanceMinutes(10);
    await tickSchedules(t.app, { only: ['onboarding.poll'] });
    await drainJobs(t.app, JOBS);
    expect((await steps(onboardingId)).org!.attempts).toBe(onboarding.MAX_STEP_ATTEMPTS);
    // No half-made org was left behind by any of those attempts.
    expect(Number((await t.db.selectFrom('orgs').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)).toBe(orgsBefore);

    // Fix the address, retry the step, and the whole thing completes.
    await onboarding.saveIntakeSection(t.app, a, { onboardingId, section: 'identity', data: { ...(intakeFor('oak-diner-two').identity as object) } });
    await expect(onboarding.retryProvisioningStep(t.app, await t.fixture.diner.as('owner'), { onboardingId, step: 'org' })).rejects.toMatchObject({ code: 'forbidden' });
    await onboarding.retryProvisioningStep(t.app, a, { onboardingId, step: 'org' });
    await drainJobs(t.app, JOBS);
    s = await steps(onboardingId);
    expect(s.org).toMatchObject({ status: 'done', attempts: 1, error: null });
    expect(await statuses(onboardingId)).toMatchObject({ brand: 'done', pages: 'done', subdomain: 'done', custom_domain: 'skipped', sending_domain: 'skipped', staff: 'skipped' });
    const o = await orgOf(onboardingId);
    expect(o.status).toBe('review');
    expect((await t.db.selectFrom('orgs').select('slug').where('id', '=', o.org_id!).executeTakeFirstOrThrow()).slug).toBe('oak-diner-two');
    // Once the org exists its address is fixed.
    await expect(onboarding.saveIntakeSection(t.app, a, { onboardingId, section: 'identity', data: { ...(intakeFor('oak-diner-three').identity as object) } })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('go-live is gated: it refuses while any check fails, and says which', async () => {
    const a = await getAdmin();
    const { onboardingId, orgId } = bella;
    const byKey = (c: onboarding.Checklist) => Object.fromEntries(c.items.map((i) => [i.key, i.status]));

    const checklist = await onboarding.runGoLiveChecks(t.app, a, { onboardingId });
    expect(checklist.ready).toBe(false);
    expect(byKey(checklist)).toMatchObject({
      hours_confirmed: 'fail',
      domain_live: 'pass',
      transactional_email: 'fail',
      staff_signed_in: 'fail',
      pages_published: 'pass',
      structured_data_valid: 'pass',
    });
    expect(checklist.items.find((i) => i.key === 'hours_confirmed')!.reason).toBe('The hours are set, but the owner has not confirmed them yet.');
    expect(checklist.items.find((i) => i.key === 'domain_live')!.reason).toBe('Live on bella-trattoria.example.com.au.');

    await expect(onboarding.goLive(t.app, a, { onboardingId })).rejects.toMatchObject({
      code: 'conflict',
      details: { failing: expect.arrayContaining([expect.objectContaining({ key: 'hours_confirmed' }), expect.objectContaining({ key: 'transactional_email' }), expect.objectContaining({ key: 'staff_signed_in' })]) },
    });
    expect((await t.db.selectFrom('orgs').select('status').where('id', '=', orgId).executeTakeFirstOrThrow()).status).toBe('onboarding');
    expect((await orgOf(onboardingId)).live_at).toBeNull();

    // The owner's confirmation is the owner's: not the platform's, not a manager's.
    const owner = await ownerOf(orgId);
    await expect(t.app.tenant(orgId, onboarding.PROVISIONER, (ctx) => onboarding.confirmGoLiveItem(ctx, { key: 'hours_confirmed' }))).rejects.toMatchObject({ code: 'forbidden' });
    const marco = await t.db.selectFrom('staff').select('user_id').where('org_id', '=', orgId).where('email', '=', 'marco@bella-trattoria.test').executeTakeFirstOrThrow();
    const manager = (await auth.staffPrincipal(t.app, marco.user_id, orgId))!;
    await expect(t.app.tenant(orgId, manager, (ctx) => onboarding.confirmGoLiveItem(ctx, { key: 'hours_confirmed' }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(orgId, owner.principal, (ctx) => onboarding.confirmGoLiveItem(ctx, { key: 'domain_live' }))).rejects.toMatchObject({ code: 'not_found' });
    await t.app.tenant(orgId, owner.principal, (ctx) => onboarding.confirmGoLiveItem(ctx, { key: 'hours_confirmed' }));

    // The owner signs in for the first time.
    await auth.requestStaffLogin(t.app, owner.email);
    const code = t.sim.email.lastTo(owner.email)!.body.match(/\b(\d{6})\b/)![1]!;
    await auth.verifyStaffLogin(t.app, owner.email, code);

    // The test send: queued, sent by the worker, then confirmed by the provider.
    const test = await t.app.tenant(orgId, owner.principal, (ctx) => onboarding.sendGoLiveTestEmail(ctx));
    expect(test.to).toBe(owner.email);
    expect((await onboarding.runGoLiveChecks(t.app, a, { onboardingId })).items.find((i) => i.key === 'transactional_email')).toMatchObject({ status: 'fail', reason: 'The test email is still in the queue.' });
    await drainJobs(t.app, JOBS);
    const sent = t.sim.email.lastTo(owner.email)!;
    expect(sent.subject).toBe('Test email from Bella Trattoria');
    expect((await onboarding.runGoLiveChecks(t.app, a, { onboardingId })).items.find((i) => i.key === 'transactional_email')).toMatchObject({ status: 'fail', reason: expect.stringContaining('Waiting for the provider') });
    const hook = t.sim.email.webhook(SIM_WEBHOOK_SECRET, [{ providerMessageId: sent.providerMessageId, event: 'delivered' }]);
    await comms.handleMessageWebhook(t.app, { adapterKey: 'sim-email', ...hook, url: 'http://x/webhooks/sim-email' });

    const ready = await onboarding.runGoLiveChecks(t.app, a, { onboardingId });
    expect(byKey(ready)).toMatchObject({ hours_confirmed: 'pass', domain_live: 'pass', transactional_email: 'pass', staff_signed_in: 'pass', pages_published: 'pass', structured_data_valid: 'pass' });
    expect(ready.ready).toBe(true);
    // The owner sees the same list.
    expect(byKey(await onboarding.getGoLiveChecklist(t.app, orgId, owner.principal))).toEqual(byKey(ready));
    await expect(onboarding.getGoLiveChecklist(t.app, orgId, manager)).rejects.toMatchObject({ code: 'forbidden' });

    // A check added by another module gates go-live like any other.
    onboarding.registerGoLiveCheck({ key: 'test_menu_confirmed', label: 'Menu confirmed by the owner', order: 5, run: async () => ({ status: 'fail', reason: 'Nine items are still unconfirmed.' }) });
    await expect(onboarding.goLive(t.app, a, { onboardingId })).rejects.toMatchObject({ code: 'conflict', message: 'Not ready to go live: Menu confirmed by the owner.' });
    expect((await t.db.selectFrom('orgs').select('status').where('id', '=', orgId).executeTakeFirstOrThrow()).status).toBe('onboarding');
    onboarding.unregisterGoLiveCheck('test_menu_confirmed');
    // A check that throws counts as a failure, never a pass.
    onboarding.registerGoLiveCheck({ key: 'test_broken', label: 'Broken check', order: 6, run: async () => { throw new Error('boom'); } });
    expect((await onboarding.runGoLiveChecks(t.app, a, { onboardingId })).items.find((i) => i.key === 'test_broken')).toMatchObject({ status: 'fail' });
    onboarding.unregisterGoLiveCheck('test_broken');
    // A check that does not apply does not block.
    onboarding.registerGoLiveCheck({ key: 'test_na', label: 'Kitchen screen paired', order: 7, run: async () => ({ status: 'not_applicable', reason: 'This venue has no kitchen screen.' }) });

    await expect(onboarding.goLive(t.app, owner.principal, { onboardingId })).rejects.toMatchObject({ code: 'forbidden' });
    t.clock.set('2026-10-02T04:30:00.000Z');
    const live = await onboarding.goLive(t.app, a, { onboardingId });
    onboarding.unregisterGoLiveCheck('test_na');
    // Sold at noon on 30 September (Sydney), live 50.5 hours later.
    expect(live).toMatchObject({ orgId, timeToLiveHours: 50.5, manualTouchMinutes: 0 });

    expect((await t.db.selectFrom('orgs').select('status').where('id', '=', orgId).executeTakeFirstOrThrow()).status).toBe('live');
    // Going live changes the status and nothing else about the venue.
    expect(await t.db.selectFrom('venues').select(['status', 'timezone', 'cuisine_tags']).where('org_id', '=', orgId).execute()).toEqual([{ status: 'live', timezone: 'Australia/Melbourne', cuisine_tags: ['italian'] }]);
    const o = await orgOf(onboardingId);
    expect(o.status).toBe('live');
    expect(o.live_at).toEqual(new Date('2026-10-02T04:30:00.000Z'));
    const event = await t.db.selectFrom('events').select('properties').where('org_id', '=', orgId).where('name', '=', 'org.went_live').executeTakeFirstOrThrow();
    expect(event.properties).toEqual({ onboarding_id: onboardingId, hours_to_live: 50.5, manual_touch_minutes: 0 });
    const audit = await t.db.selectFrom('audit_log').select(['actor_kind', 'actor_id']).where('org_id', '=', orgId).where('action', '=', 'org.went_live').executeTakeFirstOrThrow();
    expect(audit).toEqual({ actor_kind: 'platform', actor_id: a.adminUserId });
    // The site is now indexable on its primary host.
    expect((await t.app.tenant(orgId, ANON, (ctx) => website.getRobots(ctx, { host: 'bella-trattoria.example.com.au' }))).sitemap).toBe('http://bella-trattoria.example.com.au/sitemap.xml');

    // Saying it twice changes nothing.
    t.clock.advanceDays(1);
    expect((await onboarding.goLive(t.app, a, { onboardingId })).liveAt).toEqual(new Date('2026-10-02T04:30:00.000Z'));
  });

  it('manual-touch minutes are recorded entry by entry, and time-to-live is a number the platform can read', async () => {
    const a = await getAdmin();
    const { onboardingId } = bella;
    await expect(onboarding.recordManualTouch(t.app, await t.fixture.diner.as('owner'), { onboardingId, minutes: 5, note: 'Not mine to record' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(onboarding.recordManualTouch(t.app, a, { onboardingId, minutes: 0, note: 'Nothing' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(onboarding.recordManualTouch(t.app, a, { onboardingId: randomUUID(), minutes: 5, note: 'Nobody home' })).rejects.toMatchObject({ code: 'not_found' });

    expect(await onboarding.recordManualTouch(t.app, a, { onboardingId, minutes: 25, note: 'Typed the menu in from a photographed PDF' })).toEqual({ manualTouchMinutes: 25 });
    t.clock.advanceMinutes(30);
    expect(await onboarding.recordManualTouch(t.app, a, { onboardingId, minutes: 15, note: 'Call with the owner about DNS' })).toEqual({ manualTouchMinutes: 40 });

    expect((await orgOf(onboardingId)).manual_touch_minutes).toBe(40);
    const touches = await t.db.selectFrom('onboarding_touches').select(['minutes', 'note', 'admin_user_id']).where('onboarding_id', '=', onboardingId).orderBy('recorded_at').execute();
    expect(touches).toEqual([
      { minutes: 25, note: 'Typed the menu in from a photographed PDF', admin_user_id: a.adminUserId },
      { minutes: 15, note: 'Call with the owner about DNS', admin_user_id: a.adminUserId },
    ]);

    const detail = await onboarding.getOnboarding(t.app, a, { onboardingId });
    expect(detail).toMatchObject({ status: 'live', manualTouchMinutes: 40, timeToLiveHours: 50.5, hoursInFlight: null });
    expect(detail.touches.map((x) => x.minutes)).toEqual([25, 15]);

    const metrics = await onboarding.onboardingMetrics(t.app, a);
    // The two fixture orgs went live nine days after sale (216 hours); this one took 50.5.
    expect(metrics).toEqual({ live: 3, inFlight: 2, medianTimeToLiveHours: 216, meanManualTouchMinutes: Math.round((95 + 240 + 40) / 3) });
  });
});
