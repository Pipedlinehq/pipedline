import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { type AgentPrincipal, type App, type StaffPrincipal, drainJobs, getTool } from '@ros/core';
import { SIM_PAY_TOKENS, createSimSignIn, simPosToken, simSignInPayment, simSignInPos, type SimSignIn } from '@ros/adapters';
import { useTestEnv } from '@ros/testkit';
import { auth, hub, ledger, menu, onboarding, ordering, tenancy } from '@ros/modules';
import { type ModernSession, type PersonSays, type ToolAnswer, YES, connectModern, issueKey, rawToolCall } from '../hub/helpers';
import { assistant, httpsApp } from '../hub-2/oauth-helpers';

/**
 * The acceptance test for docs/PIPEDLINE.md "What has to change" sections 1 and 2.
 *
 * A person with nothing but an email address starts a venue themself, connects their assistant,
 * and the assistant sets the whole venue up through the MCP server alone, the owner saying yes
 * to each change. The assistant here is a script with no knowledge of this platform: at each
 * step it reads `setup_status`, and does what `next` says with the tools `next` names.
 *
 * The owner's own part (the sign-in at Square, the test order on their own site) is played
 * through the same service functions the console's pages call. After every step the database is
 * read back.
 */
const EMAIL = 'nina@osteria-nina.example';
const IP = '198.51.100.7';
const ACCOUNT = 'acct-osteria-nina';
const ANON = { kind: 'anon' as const };

const MENU_TEXT = `OSTERIA NINA
Antipasti
Focaccia, rosemary, sea salt  $9
Burrata, tomato, basil  $19.50
Primi
Pappardelle, slow beef ragu  market price
`;

const READING = {
  sections: [
    {
      name: 'Antipasti',
      description: null,
      items: [
        { name: 'Focaccia, rosemary, sea salt', description: null, price_cents: 900, dietary_tags: ['vegan'], allergens: ['gluten'], modifiers: [] },
        { name: 'Burrata, tomato, basil', description: null, price_cents: 1950, dietary_tags: ['vegetarian'], allergens: ['dairy'], modifiers: [] },
      ],
    },
    { name: 'Primi', description: null, items: [{ name: 'Pappardelle, slow beef ragu', description: null, price_cents: null, dietary_tags: [], allergens: ['gluten', 'egg'], modifiers: [] }] },
  ],
};

const SETUP_TOOLS = [
  'connection_start',
  'connections_list',
  'go_live',
  'go_live_check',
  'go_live_confirm',
  'go_live_test_email',
  'menu_import_confirm',
  'menu_import_review',
  'menu_import_start',
  'plugin_configure',
  'plugin_disable',
  'plugin_enable',
  'plugins_list',
  'setup_status',
  'team_invite',
  'venue_describe',
  'venue_update',
];

interface Status {
  complete: boolean;
  summary: string;
  site_address: string | null;
  steps: Array<{ step: string; status: string; detail: string; tools: string[]; owner_only: boolean }>;
  next: { step: string; what_to_do: string; tools: string[] } | null;
  ask_the_owner: string[];
  blocking_go_live: Array<{ check: string; reason: string }>;
}

const codeFrom = (body: string) => body.match(/\b(\d{6})\b/)![1]!;

describe('setup: from an email address to a live venue, through the MCP server alone', () => {
  const t = useTestEnv();
  let app: App;
  let signIn: SimSignIn;

  // What the owner holds.
  let sessionToken = '';
  let owner: StaffPrincipal;
  let orgId = '';
  let venueId = '';
  let host = '';
  // What the assistant holds: a connection, and nothing else.
  let claude: ModernSession;
  let accessToken = '';
  /** What the person says to the next question. */
  let says: PersonSays = 'yes';
  // A second organisation, started by someone else.
  const other = { orgId: '', venueId: '', owner: null as unknown as StaffPrincipal };

  const row = {
    org: () => t.db.selectFrom('orgs').selectAll().where('id', '=', orgId).executeTakeFirstOrThrow(),
    venue: () => t.db.selectFrom('venues').selectAll().where('id', '=', venueId).executeTakeFirstOrThrow(),
    onboarding: () => t.db.selectFrom('onboardings').selectAll().where('org_id', '=', orgId).executeTakeFirstOrThrow(),
    modules: async () => Object.fromEntries((await t.db.selectFrom('venue_modules').select(['module_key', 'enabled', 'config']).where('venue_id', '=', venueId).execute()).map((r) => [r.module_key, r])),
    steps: async () => Object.fromEntries((await t.db.selectFrom('provisioning_steps').select(['step', 'status', 'blocked_on', 'error']).where('org_id', '=', orgId).execute()).map((r) => [r.step, r])),
    audits: (action: string) => t.db.selectFrom('audit_log').select(['actor_kind', 'actor_id', 'after']).where('org_id', '=', orgId).where('action', '=', action).orderBy('occurred_at').execute(),
    orgsOwnedBy: async (email: string) =>
      (await t.db.selectFrom('staff as s').innerJoin('users as u', 'u.id', 's.user_id').select('s.org_id').where('u.email', '=', email).where('s.is_owner', '=', true).execute()).map((r) => r.org_id),
  };

  /** Sign in at the open front door, as a browser would, and return the session. */
  async function signInAs(email: string) {
    await auth.requestOpenLogin(t.app, email, { ip: IP });
    return auth.verifyOpenLogin(t.app, email, codeFrom(t.sim.email.lastTo(email)!.body), { ip: IP });
  }

  const status = async (s: ModernSession = claude): Promise<Status> => {
    const r = await s.call('setup_status');
    if (r.isError) throw new Error(`setup_status refused: ${r.text}`);
    return r.structured as unknown as Status;
  };

  /** One step of the script: it may only use a tool `next` named for the step it was told to do. */
  async function follow(expectStep: string, tool: string, args: Record<string, unknown> = {}, person: PersonSays = 'yes'): Promise<ToolAnswer> {
    const s = await status();
    expect(s.next?.step).toBe(expectStep);
    expect(s.next!.tools).toContain(tool);
    says = person;
    return claude.call(tool, args);
  }

  beforeAll(async () => {
    app = httpsApp(t.app);
    // The simulated Square sign-in, registered as the runtime does when ROS_SIM_SQUARE_OAUTH is on.
    signIn = createSimSignIn({ key: 'square', baseUrl: 'https://console.rosplatform.test', clock: t.clock });
    t.app.adapters.register('oauth', signIn);
    t.app.adapters.register('pos', simSignInPos(t.sim.pos, signIn));
    t.app.adapters.register('payment', simSignInPayment(t.sim.payment, signIn.key));
    t.sim.pos.addLocation(ACCOUNT, { ref: 'L-NINA', name: 'Osteria Nina', timezone: 'Australia/Sydney' });
    t.sim.llm.respond(onboarding.MENU_EXTRACT_PURPOSE, () => READING);
  });

  it('1 · a person nobody has seen signs in with their email address', async () => {
    expect(await t.db.selectFrom('users').select('id').where('email', '=', EMAIL).execute()).toEqual([]);
    // The staff sign-in sends nothing to an address that belongs to nobody. The open one sends a code to anyone.
    await auth.requestStaffLogin(t.app, EMAIL, { ip: IP });
    expect(t.sim.email.lastTo(EMAIL)).toBeUndefined();

    const login = await signInAs(EMAIL);
    expect(login).toMatchObject({ newUser: true, memberships: [], activeOrgId: null });
    sessionToken = login.token;

    const user = await t.db.selectFrom('users').select(['id', 'email']).where('email', '=', EMAIL).executeTakeFirstOrThrow();
    expect(user.id).toBe(login.userId);
    const session = await t.db.selectFrom('sessions').select(['kind', 'user_id', 'org_id']).where('user_id', '=', user.id).executeTakeFirstOrThrow();
    expect(session).toEqual({ kind: 'staff', user_id: user.id, org_id: null });
    // A wrong code proves nothing.
    await auth.requestOpenLogin(t.app, 'someone@else.example', { ip: IP });
    await expect(auth.verifyOpenLogin(t.app, 'someone@else.example', '000000')).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(await t.db.selectFrom('users').select('id').where('email', '=', 'someone@else.example').execute()).toEqual([]);
  });

  it('2 · they start their own venue: an organisation and one draft venue, provisioned with no platform admin', async () => {
    const who = (await auth.authenticate(t.app, sessionToken))!;
    expect(who.orgId).toBeNull();
    // Nobody signed in, or a guest, cannot start anything.
    await expect(onboarding.selfServeStart(t.app, ANON, { venueName: 'Osteria Nina' }, { ip: IP })).rejects.toMatchObject({ code: 'unauthenticated' });

    const adminsBefore = await t.db.selectFrom('platform_admins').select('user_id').execute();
    const started = await onboarding.selfServeStart(t.app, who.principal, { venueName: 'Osteria Nina', firstName: 'Nina' }, { ip: IP });
    expect(started.created).toBe(true);
    ({ orgId } = started);
    venueId = started.venueId!;
    host = started.host!;
    expect(host).toBe('osteria-nina.tables.test');

    expect(await row.org()).toMatchObject({ slug: 'osteria-nina', trading_name: 'Osteria Nina', status: 'onboarding', settings: { quota: { max_venues: 5 } } });
    expect(await row.venue()).toMatchObject({ org_id: orgId, name: 'Osteria Nina', status: 'setup', timezone: 'Australia/Sydney', address_line1: null });
    expect(await t.db.selectFrom('venues').select('id').where('org_id', '=', orgId).execute()).toHaveLength(1);
    const staff = await t.db.selectFrom('staff').select(['id', 'email', 'is_owner', 'status', 'first_name']).where('org_id', '=', orgId).execute();
    expect(staff).toEqual([{ id: expect.any(String), email: EMAIL, is_owner: true, status: 'active', first_name: 'Nina' }]);
    expect(await t.db.selectFrom('staff_venues').select(['venue_id', 'role']).where('staff_id', '=', staff[0]!.id).execute()).toEqual([{ venue_id: venueId, role: 'owner' }]);
    expect(await t.db.selectFrom('domains').select(['host', 'is_primary']).where('org_id', '=', orgId).where('verified_at', 'is not', null).execute()).toEqual([{ host, is_primary: true }]);

    // The same onboarding and provisioning records the platform path makes, marked as self-serve.
    const ob = await row.onboarding();
    expect(ob).toMatchObject({ origin: 'self_serve', started_by_user_id: who.session.userId, status: 'review', live_at: null });
    const steps = await row.steps();
    expect(Object.values(steps).filter((s) => s.status === 'failed' || s.status === 'pending' || s.status === 'running')).toEqual([]);
    expect([steps.org!.status, steps.brand!.status, steps.modules!.status, steps.subdomain!.status]).toEqual(['done', 'done', 'done', 'done']);
    // Nothing the owner has not chosen is switched on: only assistant access, so their assistant can connect.
    expect(Object.fromEntries(Object.entries(await row.modules()).map(([k, m]) => [k, m.enabled]))).toEqual({ hub: true });
    expect(steps.pages).toMatchObject({ status: 'skipped' });

    expect((await row.audits('org.self_serve_started')).map((a) => a.actor_kind)).toEqual(['platform']);
    // No platform admin exists, was made, or acted.
    expect(await t.db.selectFrom('platform_admins').select('user_id').execute()).toEqual(adminsBefore);
    expect(await t.db.selectFrom('onboarding_touches').select('id').where('onboarding_id', '=', ob.id).execute()).toEqual([]);

    // Their session is pointed at the organisation they now own.
    const chosen = await auth.selectOrg(t.app, sessionToken, orgId);
    owner = chosen.principal as StaffPrincipal;
    expect(owner).toMatchObject({ isOwner: true, venueRoles: { [venueId]: 'owner' } });
    // The draft is not public: no page, and the venue is not live.
    expect((await tenancy.resolveHost(t.app, host))!.orgStatus).toBe('onboarding');
  });

  it('3 · starting again returns the same organisation, and the limits bite', async () => {
    const who = (await auth.authenticate(t.app, sessionToken))!;
    const again = await onboarding.selfServeStart(t.app, who.principal, { venueName: 'A Second Place' }, { ip: IP });
    expect(again).toMatchObject({ created: false, orgId, venueId, host });
    expect(await row.orgsOwnedBy(EMAIL)).toEqual([orgId]);
    expect(await t.db.selectFrom('orgs').select('id').where('trading_name', '=', 'A Second Place').execute()).toEqual([]);
    // Asking for "another" is only for someone who already owns a live organisation.
    expect(await onboarding.selfServeStart(t.app, who.principal, { venueName: 'A Second Place', another: true }, { ip: IP })).toMatchObject({ created: false, orgId });

    // Per person: five calls an hour, whatever they ask for.
    const limit = onboarding.SELF_SERVE_LIMITS.perPerson.limit;
    for (let i = 4; i <= limit; i++) await onboarding.selfServeStart(t.app, who.principal, { venueName: 'Osteria Nina' }, { ip: IP });
    await expect(onboarding.selfServeStart(t.app, who.principal, { venueName: 'Osteria Nina' }, { ip: IP })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(await row.orgsOwnedBy(EMAIL)).toEqual([orgId]);

    // Per address: three new organisations a day. Two more people start from the same address; the next is refused.
    const others: string[] = [];
    for (const email of ['otto@bar-due.example', 'pia@caffe-tre.example']) {
      const login = await signInAs(email);
      const p = (await auth.authenticate(t.app, login.token))!;
      const made = await onboarding.selfServeStart(t.app, p.principal, { venueName: email.startsWith('otto') ? 'Bar Due' : 'Caffe Tre' }, { ip: IP });
      expect(made.created).toBe(true);
      others.push(made.orgId);
      if (email.startsWith('otto')) {
        other.orgId = made.orgId;
        other.venueId = made.venueId!;
        other.owner = (await auth.selectOrg(t.app, login.token, made.orgId)).principal as StaffPrincipal;
      }
    }
    const fourth = await signInAs('quinn@fourth.example');
    const q = (await auth.authenticate(t.app, fourth.token))!;
    await expect(onboarding.selfServeStart(t.app, q.principal, { venueName: 'Fourth' }, { ip: IP })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(await row.orgsOwnedBy('quinn@fourth.example')).toEqual([]);
    expect(await t.db.selectFrom('onboardings').select('id').where('started_by_user_id', '=', q.session.userId).execute()).toEqual([]);
    expect(new Set([orgId, ...others]).size).toBe(3);

    // The cap on venues per free organisation: the organisation cannot raise it for itself.
    await expect(t.app.tenant(orgId, owner, (ctx) => tenancy.setOrgSettings(ctx, tenancy.ORG_QUOTA_NAMESPACE, tenancy.orgQuota, { max_venues: 500 }))).rejects.toMatchObject({ code: 'forbidden' });
    await t.app.tenant(orgId, { kind: 'platform', reason: 'test' }, (ctx) => tenancy.writeOrgQuota(ctx, { max_venues: 1 }));
    await expect(t.app.tenant(orgId, owner, (ctx) => tenancy.createVenue(ctx, { slug: 'second', name: 'Second' }))).rejects.toMatchObject({ code: 'conflict', message: 'This organisation can have up to 1 venue. Contact us to add more.' });
    expect(await t.db.selectFrom('venues').select('id').where('org_id', '=', orgId).execute()).toHaveLength(1);
  });

  it('4 · the owner signs their assistant in; setup_status tells it everything it needs', async () => {
    const a = assistant(app, { name: 'Claude' });
    const sentTo = await a.start();
    const review = await app.tenant(orgId, owner, (ctx) => hub.reviewOAuthRequest(ctx, sentTo.searchParams));
    if (review.outcome !== 'ask') throw new Error('expected the consent question');
    expect(review.account).toMatchObject({ org: 'Osteria Nina', isOwner: true });
    expect(review.scopes.changes.map((s) => s.scope)).toEqual(expect.arrayContaining(['setup:write', 'plugins:write', 'venue:write', 'connections:write', 'menu:write', 'team:write']));
    const decided = await app.tenant(orgId, owner, (ctx) => hub.decideOAuthRequest(ctx, sentTo.searchParams, { allow: true, allowChanges: true }));
    expect(await a.finish(decided.redirectTo)).toBe('AUTHORIZED');
    accessToken = a.tokens()!.access_token;
    expect(await t.db.selectFrom('agent_keys').select(['kind', 'can_write']).where('org_id', '=', orgId).execute()).toEqual([{ kind: 'oauth', can_write: true }]);

    claude = await connectModern(app, accessToken, { answer: () => says });
    expect(await claude.names()).toEqual(expect.arrayContaining(SETUP_TOOLS));
    // No setup tool takes an organisation, and with one venue none takes a venue either.
    for (const tool of (await claude.tools()).filter((x) => SETUP_TOOLS.includes(x.name))) {
      expect(tool.inputProperties.some((p) => /^(org|venue)(_?id)?$/i.test(p))).toBe(false);
      expect(tool.hasOutputShape).toBe(true);
      expect(tool.readOnly).toBe(getTool(tool.name)!.effect === 'read');
    }

    const s = await status();
    expect(s.complete).toBe(false);
    expect(s.summary).toBe('Osteria Nina is a draft: 0 of 5 setup steps are done. It is not public until it goes live.');
    expect(s.steps.map((x) => [x.step, x.status])).toEqual([
      ['venue_details', 'to_do'],
      ['opening_hours', 'to_do'],
      ['plugins', 'to_do'],
      ['connections', 'optional'],
      ['menu', 'to_do'],
      ['team', 'optional'],
      ['go_live', 'to_do'],
    ]);
    expect(s.next).toMatchObject({ step: 'venue_details', tools: ['venue_describe', 'venue_update'] });
    expect(s.next!.what_to_do).toContain('street address, suburb, state, postcode, phone number');
    // What only the owner can answer is said as questions to put to them.
    expect(s.ask_the_owner).toEqual([
      'What is the venue\'s street address, suburb, state, postcode, phone number?',
      'What are the opening hours, day by day?',
      'What do you want this to do for the venue: a QR menu, online ordering, a website, loyalty, or only answers from the till you already use?',
      'Where is your menu? Give the address of a web page that lists it, or paste the menu as text.',
      'Do you confirm: menu confirmed by the owner?',
      'Do you confirm: trading hours set and confirmed by the owner?',
    ]);
    expect(s.blocking_go_live.map((b) => b.check)).toEqual(expect.arrayContaining(['menu_confirmed', 'hours_confirmed', 'transactional_email']));
    // Every tool a step names is one this connection is actually offered.
    const offered = await claude.names();
    for (const step of s.steps) for (const tool of step.tools) expect(offered).toContain(tool);
  });

  it('5 · the venue\'s details and hours: nothing changes without the owner\'s yes', async () => {
    const details = { address_line1: '14 Via Roma Lane', suburb: 'Leichhardt', state: 'NSW', postcode: '2040', phone: '02 5550 0142', cuisine: ['italian'] };
    // The owner says no: nothing is written.
    const declined = await follow('venue_details', 'venue_update', details, 'no');
    expect(declined).toMatchObject({ isError: true, text: 'Nothing was changed: you did not confirm it.' });
    expect(claude.asked.at(-1)).toBe('Change these details of Osteria Nina? street address: 14 Via Roma Lane; suburb: Leichhardt; state: NSW; postcode: 2040; phone: 02 5550 0142; cuisine: italian.');
    expect(await row.venue()).toMatchObject({ address_line1: null, suburb: null, phone: null });

    const done = await follow('venue_details', 'venue_update', details);
    expect(done.isError).toBe(false);
    expect(await row.venue()).toMatchObject({ address_line1: '14 Via Roma Lane', suburb: 'Leichhardt', state: 'NSW', postcode: '2040', phone: '02 5550 0142', cuisine_tags: ['italian'], status: 'setup' });
    // The change is on the audit log as the assistant's, under the owner's key.
    const key = await t.db.selectFrom('agent_keys').select('id').where('org_id', '=', orgId).executeTakeFirstOrThrow();
    expect((await row.audits('venue.updated')).filter((x) => x.actor_kind !== 'platform').map((x) => [x.actor_kind, x.actor_id])).toEqual([['agent', key.id]]);
    // An address that is not one is refused before anyone is asked.
    const asked = claude.asked.length;
    expect(await claude.call('venue_update', { timezone: 'Mars/Olympus' })).toMatchObject({ isError: true, text: expect.stringContaining('Use a time zone name such as Australia/Sydney.') });
    expect(claude.asked.length).toBe(asked);

    const week = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => ({ day, opens: '08:00', closes: '22:00' }));
    const hours = await follow('opening_hours', 'venue_update', { hours: week });
    expect(hours.isError).toBe(false);
    expect(claude.asked.at(-1)).toContain('opening hours: Sun 08:00 to 22:00, Mon 08:00 to 22:00');
    const rows = await t.db.selectFrom('trading_hours').select(['day_of_week', 'opens_at', 'closes_at']).where('venue_id', '=', venueId).orderBy('day_of_week').execute();
    expect(rows.map((r) => r.day_of_week)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(rows[0]).toMatchObject({ opens_at: '08:00:00', closes_at: '22:00:00' });
    expect(await row.audits('hours.set')).toHaveLength(1);

    const described = (await claude.call('venue_describe')).structured as { venue: Record<string, unknown>; hours: unknown[]; missing: string[]; site_address: string };
    expect(described.venue).toMatchObject({ name: 'Osteria Nina', status: 'setup', suburb: 'Leichhardt' });
    expect(described.hours).toHaveLength(7);
    expect(described.missing).toEqual([]);
    expect(described.site_address).toBe(`https://${host}`);
  });

  it('6 · plugins: listed with their settings described, switched on and configured; a bad setting is refused in words', async () => {
    const s = await status();
    expect(s.next).toMatchObject({ step: 'plugins', tools: ['plugins_list', 'plugin_enable', 'plugin_configure', 'plugin_disable'] });

    const list = (await claude.call('plugins_list')).structured as { plugins: Array<Record<string, any>> };
    const plugin = (key: string) => list.plugins.find((p) => p.plugin === key)!;
    expect(plugin('qr')).toMatchObject({ kind: 'plugin', on: false, can_switch_on_or_off: true, settings_apply_to: 'venue' });
    expect(plugin('ordering')).toMatchObject({ kind: 'plugin', on: false, name: 'Online ordering' });
    expect(plugin('ordering').needs).toContain('A payment account connected (Square), so guests can pay online');
    expect(plugin('hub')).toMatchObject({ on: true, you_may_change_it: false });
    expect(plugin('ordering').you_may_change_it).toBe(true);
    // The settings are described from the module's own schema: type, bounds, default, choices.
    expect(plugin('ordering').settings_schema.properties.slot_minutes).toMatchObject({ type: 'integer', minimum: 5, maximum: 120, default: 15 });
    expect(plugin('qr').settings_schema.properties.stage).toMatchObject({ enum: ['view', 'order'], default: 'view' });
    // Analytics is built in: always on, with settings for the whole organisation.
    expect(plugin('analytics')).toMatchObject({ kind: 'built_in', on: true, can_switch_on_or_off: false, settings_apply_to: 'organisation' });
    expect(plugin('analytics').settings_schema.properties.campaignQuietDays).toMatchObject({ minimum: 7, maximum: 90 });
    // A connected service is listed too, with how it is connected.
    expect(plugin('square')).toMatchObject({ kind: 'connection', on: false, connects_by: 'sign_in' });

    // A setting the schema refuses: said in words, nothing asked, nothing written.
    const asked = claude.asked.length;
    const tooSmall = await claude.call('plugin_enable', { plugin: 'ordering', settings: { slot_minutes: 2 } });
    expect(tooSmall.isError).toBe(true);
    expect(tooSmall.text).toMatch(/^Those settings for Online ordering are not valid\. slot_minutes: .*5/);
    const typo = await claude.call('plugin_enable', { plugin: 'ordering', settings: { slot_mins: 20 } });
    expect(typo.text).toContain('Online ordering has no setting called "slot_mins". Its settings are: pickup_enabled, slot_minutes,');
    expect((await claude.call('plugin_enable', { plugin: 'bookings' })).text).toBe('There is no plugin called "bookings".');
    expect((await claude.call('plugin_enable', { plugin: 'analytics' })).text).toBe('Analytics is always on: there is nothing to switch on.');
    expect((await claude.call('plugin_configure', { plugin: 'qr', settings: { show_prices: false } })).text).toContain('switched off here');
    // An assistant does not widen its own access, even where its owner would say yes.
    expect((await claude.call('plugin_configure', { plugin: 'hub', settings: { guest_level_reads_enabled: true } })).text).toBe('Assistant access and plugs is set up by a person in the console, not by an assistant.');
    expect(claude.asked.length).toBe(asked);
    expect(Object.keys(await row.modules())).toEqual(['hub']);

    // QR menu, then ordering, each with settings, each on the owner's yes.
    const qr = await follow('plugins', 'plugin_enable', { plugin: 'qr', settings: { stage: 'view', tipping_enabled: false, session_idle_minutes: 90 } });
    expect(qr.structured).toMatchObject({ plugin: 'qr', on: true, settings: { stage: 'view', session_idle_minutes: 90 } });
    expect(claude.asked.at(-1)).toMatch(/^Switch on QR menu and table ordering at Osteria Nina\? .* Settings: session_idle_minutes: 120 to 90\. It needs: A menu;/);
    expect((await row.modules()).qr).toMatchObject({ enabled: true, config: { stage: 'view', session_idle_minutes: 90, show_prices: true } });

    says = 'yes';
    const ord = await claude.call('plugin_enable', { plugin: 'ordering', settings: { auto_accept: true, lead_time_minutes: 10 } });
    expect(ord.structured).toMatchObject({ plugin: 'ordering', on: true });
    expect((await row.modules()).ordering).toMatchObject({ enabled: true, config: { auto_accept: true, lead_time_minutes: 10, slot_minutes: 15 } });

    const tuned = await claude.call('plugin_configure', { plugin: 'ordering', settings: { max_orders_per_slot: 8 } });
    expect(tuned.isError).toBe(false);
    expect(claude.asked.at(-1)).toBe('Change the settings of Online ordering at Osteria Nina? Settings: max_orders_per_slot: 6 to 8.');
    // The partial change kept what was set before it.
    expect((await row.modules()).ordering!.config).toMatchObject({ max_orders_per_slot: 8, auto_accept: true, lead_time_minutes: 10 });

    // Analytics: configured for the organisation, through its own setter.
    const quiet = await claude.call('plugin_configure', { plugin: 'analytics', settings: { campaignQuietDays: 14 } });
    expect(quiet.isError).toBe(false);
    expect(claude.asked.at(-1)).toBe('Change the settings of Analytics for the whole of Osteria Nina? Settings: campaignQuietDays: 7 to 14.');
    expect(((await row.org()).settings as Record<string, any>).analytics).toMatchObject({ campaignQuietDays: 14, minCohort: 5 });
    expect((await claude.call('plugin_configure', { plugin: 'analytics', settings: { minCohort: 2 } })).text).toMatch(/^Those settings for Analytics are not valid\. minCohort: /);

    // Every switch is on the audit log, and switching a plugin on set up what it needs.
    expect((await row.audits('module.set')).filter((x) => x.actor_kind === 'agent')).toHaveLength(3);
    expect((await row.steps()).payments_connect).toMatchObject({ status: 'pending' });
    await drainJobs(t.app, { kinds: ['onboarding.provision'] });
    expect((await row.steps()).payments_connect).toMatchObject({ status: 'blocked', blocked_on: expect.stringContaining('Connect your payment account') });

    // Switched off again, and back on, by the same tools.
    expect((await claude.call('plugin_disable', { plugin: 'qr' })).structured).toMatchObject({ on: false });
    expect((await row.modules()).qr).toMatchObject({ enabled: false, config: { session_idle_minutes: 90 } });
    expect((await claude.call('plugin_enable', { plugin: 'qr' })).structured).toMatchObject({ on: true, settings: { session_idle_minutes: 90 } });
  });

  it('7 · a change needs both halves: no commit, no change; one commit, one effect', async () => {
    const before = (await row.modules()).ordering!.config;
    const args = { plugin: 'ordering', settings: { cutoff_before_close_minutes: 30 } };
    // The first half alone: the question, and nothing written.
    const first = await rawToolCall(app, accessToken, 'plugin_configure', args);
    expect(first.asking?.question).toBe('Change the settings of Online ordering at Osteria Nina? Settings: cutoff_before_close_minutes: 15 to 30.');
    expect((await row.modules()).ordering!.config).toEqual(before);
    // A yes with no note from a question, and a yes carrying a made-up note: nothing changes.
    expect((await rawToolCall(app, accessToken, 'plugin_configure', args, { inputResponses: YES })).answer).toMatchObject({ isError: true });
    const forged = await rawToolCall(app, accessToken, 'plugin_configure', args, { inputResponses: YES, requestState: 'not-a-note' });
    expect(forged.answer?.isError ?? !!forged.error).toBe(true);
    expect((await row.modules()).ordering!.config).toEqual(before);

    const audits = (await row.audits('module.set')).length;
    const yes = await rawToolCall(app, accessToken, 'plugin_configure', args, { inputResponses: YES, requestState: first.asking!.requestState });
    expect(yes.answer).toMatchObject({ isError: false });
    expect((await row.modules()).ordering!.config).toMatchObject({ cutoff_before_close_minutes: 30 });
    // The same yes sent again: refused, and still exactly one change on record.
    const replay = await rawToolCall(app, accessToken, 'plugin_configure', args, { inputResponses: YES, requestState: first.asking!.requestState });
    expect(replay.answer).toMatchObject({ isError: true, text: hub.SAID.spent });
    expect((await row.audits('module.set')).length).toBe(audits + 1);
    const spent = await t.db.selectFrom('agent_confirmations').select('spent_at').where('org_id', '=', orgId).where('tool', '=', 'plugin_configure').where('spent_at', 'is not', null).execute();
    expect(spent.length).toBeGreaterThanOrEqual(1);
    const calls = await t.db.selectFrom('agent_calls').select('outcome').where('org_id', '=', orgId).where('tool', '=', 'plugin_configure').execute();
    expect(calls.map((c) => c.outcome)).toEqual(expect.arrayContaining(['asked', 'stale', 'confirmed', 'spent']));
  });

  it('8 · connecting Square: the assistant gets a link, the owner signs in, and no token passes through the assistant', async () => {
    const s = await status();
    expect(s.next).toMatchObject({ step: 'connections' });
    expect(s.next!.what_to_do).toContain('Taking orders needs a payment account, and none is connected. Call connection_start (Square)');
    const before = (await claude.call('connections_list')).structured as { connections: unknown[]; can_connect: Array<{ service: string; how: string }> };
    expect(before.connections).toEqual([]);
    expect(before.can_connect.find((c) => c.service === 'square')!.how).toContain('connection_start');

    const started = await follow('connections', 'connection_start', { service: 'square' });
    expect(started.isError).toBe(false);
    expect(claude.asked.at(-1)).toMatch(/^Start connecting Square to Osteria Nina\? You will be given a link to open in your browser/);
    const out = started.structured as Record<string, any>;
    expect(Object.keys(out).sort()).toEqual(['asks_for', 'link_expires', 'name', 'service', 'sign_in_link', 'what_next']);
    const link = new URL(out.sign_in_link);
    expect(`${link.origin}${link.pathname}`).toBe('https://console.rosplatform.test/dev/pos-signin');
    const state = link.searchParams.get('state')!;
    // Nothing is connected by asking for the link.
    expect(await t.db.selectFrom('connections').select('id').where('org_id', '=', orgId).execute()).toEqual([]);
    expect((await row.audits('connection.signin_started')).map((a) => a.actor_kind)).toEqual(['agent']);

    // The owner's side, in their own browser: they approve at Square and are sent back to the console's
    // callback page, which calls completePosOAuth with their signed-in session.
    const code = signIn.approve(ACCOUNT);
    // Someone else's session cannot finish it, and nor can the owner of another organisation.
    await expect(ledger.completePosOAuth(t.app, { orgId: other.orgId, principal: other.owner, state, code })).rejects.toMatchObject({ code: 'invalid' });
    const outcome = await ledger.completePosOAuth(t.app, { orgId, principal: owner, state, code });
    expect(outcome.status).toBe('connected');

    const conn = await t.db.selectFrom('connections').selectAll().where('org_id', '=', orgId).executeTakeFirstOrThrow();
    expect(conn).toMatchObject({ plug_key: 'square', venue_id: venueId, status: 'connected', external_account_id: ACCOUNT });
    expect(conn.secret_ref).not.toBeNull();
    // The token exists only sealed in the secret store. The assistant never saw it, nor the code.
    const token = simPosToken(ACCOUNT);
    const after = await claude.call('connections_list');
    const everythingTheAssistantSaw = JSON.stringify([started, after, await status()]);
    expect(everythingTheAssistantSaw).not.toContain(token);
    expect(everythingTheAssistantSaw).not.toContain(code);
    expect(JSON.stringify(conn)).not.toContain(token);
    expect((after.structured as { connections: Array<Record<string, unknown>> }).connections).toEqual([
      expect.objectContaining({ service: 'square', name: 'Square', status: 'connected', problem: null, allowed: expect.arrayContaining(['PAYMENTS_READ', 'PAYMENTS_WRITE']) }),
    ]);
    await drainJobs(t.app, { kinds: ['onboarding.provision', 'onboarding.poll'] });
  });

  it('9 · the menu: read from the owner\'s text, reviewed item by item, allergens checked by a person', async () => {
    const begun = await follow('menu', 'menu_import_start', { text: MENU_TEXT });
    expect(begun.isError).toBe(false);
    const importId = (begun.structured as { import_id: string }).import_id;
    expect(await t.db.selectFrom('menu_imports').select(['status', 'source_kind', 'venue_id']).where('id', '=', importId).executeTakeFirstOrThrow()).toEqual({ status: 'extracting', source_kind: 'text', venue_id: venueId });
    // While it is being read, setup_status says to wait rather than to do anything.
    expect((await status()).next).toMatchObject({ step: 'menu', what_to_do: 'The menu is being read. Call menu_import_review in a minute.' });
    await drainJobs(t.app, { kinds: ['onboarding.menu_import'] });

    const review = (await follow('menu', 'menu_import_review')).structured as { waiting: number; items: Array<Record<string, any>>; content_note: string };
    expect(review.waiting).toBe(3);
    expect(review.items.map((i) => [i.item, i.section, i.name, i.price, i.allergens_unverified])).toEqual([
      ['s1i1', 'Antipasti', 'Focaccia, rosemary, sea salt', '$9.00', true],
      ['s1i2', 'Antipasti', 'Burrata, tomato, basil', '$19.50', true],
      ['s2i1', 'Primi', 'Pappardelle, slow beef ragu', null, true],
    ]);
    expect(review.content_note).toContain('quoted content');
    expect(await t.db.selectFrom('menu_items').select('id').where('org_id', '=', orgId).execute()).toEqual([]);

    // Not without a price, and not until the owner has checked the allergens.
    const asked = claude.asked.length;
    expect((await claude.call('menu_import_confirm', { confirm_all_waiting: true, allergens_checked: true })).text).toContain('"Pappardelle, slow beef ragu" has no price');
    expect((await claude.call('menu_import_confirm', { confirm: ['s1i1'] })).text).toContain('have not been checked');
    expect(claude.asked.length).toBe(asked);
    expect(await t.db.selectFrom('menu_items').select('id').where('org_id', '=', orgId).execute()).toEqual([]);

    const confirmed = await follow('menu', 'menu_import_confirm', { confirm_all_waiting: true, allergens_checked: true, edits: [{ item: 's2i1', price_cents: 3200, allergens: ['gluten', 'egg', 'celery'] }] });
    expect(confirmed.structured).toMatchObject({ put_on_menu: 3, still_waiting: 0 });
    // The owner was shown every item, as it would go on the menu.
    expect(claude.asked.at(-1)).toBe(
      'Put these 3 items on the menu at Osteria Nina? 1. Antipasti: Focaccia, rosemary, sea salt, $9.00, allergens: gluten, vegan. 2. Antipasti: Burrata, tomato, basil, $19.50, allergens: dairy, vegetarian. 3. Primi: Pappardelle, slow beef ragu, $32.00, allergens: gluten, egg, celery. ' +
        'By saying yes you confirm the prices are right and that you have checked these allergens against the kitchen\'s own list.',
    );
    const items = await t.db.selectFrom('menu_items').select(['name', 'price_cents', 'allergens']).where('org_id', '=', orgId).orderBy('price_cents').execute();
    expect(items).toEqual([
      { name: 'Focaccia, rosemary, sea salt', price_cents: 900, allergens: ['gluten'] },
      { name: 'Burrata, tomato, basil', price_cents: 1950, allergens: ['dairy'] },
      { name: 'Pappardelle, slow beef ragu', price_cents: 3200, allergens: ['gluten', 'egg', 'celery'] },
    ]);
    expect(await t.db.selectFrom('menu_imports').select(['status', 'confirmed_item_count']).where('id', '=', importId).executeTakeFirstOrThrow()).toEqual({ status: 'confirmed', confirmed_item_count: 3 });
    expect((await row.audits('menu_import.item_confirmed')).map((a) => a.actor_kind)).toEqual(['agent', 'agent', 'agent']);
  });

  it('10 · the go-live checks gate: each failing one says how it is put right, and go_live is refused until they pass', async () => {
    let s = await status();
    expect(s.steps.filter((x) => x.step !== 'go_live').map((x) => x.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'optional']);
    expect(s.next).toMatchObject({ step: 'go_live', tools: ['go_live_confirm', 'go_live_check'] });

    const checks = async () => {
      const r = (await claude.call('go_live_check')).structured as { ready: boolean; live: boolean; checks: Array<Record<string, any>> };
      return { ...r, by: Object.fromEntries(r.checks.map((c) => [c.check, c])) };
    };
    let c = await checks();
    expect(c).toMatchObject({ ready: false, live: false });
    expect(Object.fromEntries(c.checks.map((x) => [x.check, x.status]))).toEqual({
      menu_confirmed: 'fail',
      hours_confirmed: 'fail',
      domain_live: 'pass',
      transactional_email: 'fail',
      staff_signed_in: 'pass',
      pages_published: 'not_applicable',
      structured_data_valid: 'not_applicable',
      redirects_mapped: 'not_applicable',
      payment_ready: 'fail',
      kitchen_test_order: 'fail',
      loyalty_enrolment_tested: 'not_applicable',
    });
    expect(c.by.menu_confirmed).toMatchObject({ tool: 'go_live_confirm', needs_owner_confirmation: true, reason: 'The menu is in place, but the owner has not confirmed it yet.' });
    expect(c.by.transactional_email).toMatchObject({ tool: 'go_live_test_email' });
    expect(c.by.payment_ready).toMatchObject({ owner_only: true, reason: 'no test payment has been taken at Osteria Nina.' });

    // Not ready: refused in words, nobody asked, nothing live.
    const asked = claude.asked.length;
    const early = await claude.call('go_live');
    expect(early).toMatchObject({ isError: true, text: expect.stringMatching(/^Not ready to go live\. Menu confirmed by the owner: /) });
    expect(claude.asked.length).toBe(asked);
    expect((await row.org()).status).toBe('onboarding');

    // The owner's own yes to the menu and to the hours, each put to them as what it is.
    expect((await follow('go_live', 'go_live_confirm', { check: 'menu_confirmed' })).isError).toBe(false);
    expect(claude.asked.at(-1)).toBe('For Osteria Nina going live, do you confirm that the menu is right, prices and allergens included. Osteria Nina: 3 items?');
    s = await status();
    expect(s.next).toMatchObject({ step: 'go_live', tools: ['go_live_confirm', 'go_live_check'] });
    expect((await claude.call('go_live_confirm', { check: 'hours_confirmed' })).isError).toBe(false);
    expect(claude.asked.at(-1)).toContain('these are the opening hours. Osteria Nina: Sun 08:00 to 22:00, Mon 08:00 to 22:00');
    expect((await claude.call('go_live_confirm', { check: 'domain_live' })).text).toContain('That is not something to confirm.');
    expect((await claude.call('go_live_confirm', { check: 'hours_confirmed' })).text).toContain('already confirmed');
    const confirmations = (await row.onboarding()).confirmations as Record<string, { staffId: string }>;
    expect(Object.keys(confirmations).sort()).toEqual(['hours_confirmed', 'menu_confirmed']);
    expect(confirmations.menu_confirmed!.staffId).toBe(owner.staffId);

    // The test email.
    const mail = await follow('go_live', 'go_live_test_email');
    expect(mail.structured).toMatchObject({ sent_to: EMAIL });
    await drainJobs(t.app, { kinds: ['comms.send'] });
    expect(t.sim.email.lastTo(EMAIL)!.subject).toBe('Test email from Osteria Nina');
    expect(await t.db.selectFrom('messages').select(['template_key', 'status']).where('org_id', '=', orgId).where('template_key', '=', 'onboarding.test_send').execute()).toEqual([{ template_key: 'onboarding.test_send', status: 'sent' }]);
    t.clock.advanceMinutes(6);

    // What is left is the owner's alone, and setup_status says so.
    s = await status();
    expect(s.next!.what_to_do).toMatch(/^Payment account connected and a test payment taken: no test payment has been taken at Osteria Nina\. .* Only the owner can do this; tell them, then call go_live_check\.$/);
    // The owner places one order on their own site and pays for it; the kitchen accepts it (auto_accept, as they set).
    const site = (await tenancy.resolveHost(t.app, host))!;
    expect(site.orgId).toBe(orgId);
    const offered = await t.app.tenant(site.orgId, ANON, (ctx) => menu.getPublicMenu(ctx, venueId));
    const focaccia = offered.menus.flatMap((m) => m.sections.flatMap((x) => x.items)).find((i) => i.name.startsWith('Focaccia'))!;
    const order = await t.app.tenant(site.orgId, ANON, (ctx) =>
      ordering.createOrder(ctx, { venueId, channel: 'pickup', lines: [{ menuItemId: focaccia.id, qty: 1 }], idempotencyKey: `test-${randomUUID()}`, customer: { name: 'Nina', email: EMAIL } }),
    );
    const paid = await ordering.payOrder(t.app, { orgId: site.orgId, principal: ANON }, { trackingToken: order.trackingToken!, sourceToken: `${SIM_PAY_TOKENS.ok}:${randomUUID()}` });
    expect(paid.status).toBe('paid');
    await drainJobs(t.app);
    expect(await t.db.selectFrom('orders').select(['payment_status', 'total_cents']).where('org_id', '=', orgId).execute()).toEqual([{ payment_status: 'paid', total_cents: 900 }]);

    c = await checks();
    expect(c.checks.filter((x) => x.status === 'fail')).toEqual([]);
    expect(c.ready).toBe(true);
    expect((await row.org()).status).toBe('onboarding');
  });

  it('11 · go live: on the owner\'s yes the venue is public, its menu is served on its own address, and setup is complete', async () => {
    const declined = await follow('go_live', 'go_live', {}, 'no');
    expect(declined.isError).toBe(true);
    expect(claude.asked.at(-1)).toBe(`Take Osteria Nina live now? Its site at https://${host} becomes public, and guests can use everything that is switched on. All 7 go-live checks that apply have passed.`);
    expect((await row.org()).status).toBe('onboarding');

    const live = await follow('go_live', 'go_live');
    expect(live.structured).toMatchObject({ live: true, site_address: `https://${host}` });
    expect((await row.org()).status).toBe('live');
    expect((await row.venue()).status).toBe('live');
    const ob = await row.onboarding();
    expect(ob.status).toBe('live');
    expect(ob.live_at).toEqual(t.clock());
    expect((await row.audits('org.went_live')).map((a) => a.actor_kind)).toEqual(['agent']);
    expect(await t.db.selectFrom('events').select('name').where('org_id', '=', orgId).where('name', '=', 'org.went_live').execute()).toHaveLength(1);
    // Again is not a second go-live.
    expect((await claude.call('go_live')).text).toBe('Osteria Nina is already live.');
    expect(await row.audits('org.went_live')).toHaveLength(1);

    // The public menu, for the venue's own host, to anyone.
    const site = (await tenancy.resolveHost(t.app, host))!;
    expect(site).toMatchObject({ orgId, orgStatus: 'live', primaryHost: host });
    const served = await t.app.tenant(site.orgId, ANON, (ctx) => menu.getPublicMenu(ctx, venueId));
    expect(served.menus.flatMap((m) => m.sections.map((x) => [x.name, x.items.map((i) => [i.name, i.priceCents])]))).toEqual([
      ['Antipasti', [['Focaccia, rosemary, sea salt', 900], ['Burrata, tomato, basil', 1950]]],
      ['Primi', [['Pappardelle, slow beef ragu', 3200]]],
    ]);

    const s = await status();
    expect(s).toMatchObject({ complete: true, next: null, ask_the_owner: [], blocking_go_live: [] });
    expect(s.summary).toBe('Setup is complete: Osteria Nina is live. Plugins, settings, the menu and the team can still be changed at any time.');
    expect(s.steps.find((x) => x.step === 'go_live')).toMatchObject({ status: 'done', detail: `Osteria Nina is live at https://${host}.` });
  });

  it('12 · the team: an invitation by the assistant, on the owner\'s yes', async () => {
    says = 'yes';
    const invited = await claude.call('team_invite', { email: 'Rosa@osteria-nina.example', first_name: 'Rosa', role: 'front_of_house' });
    expect(invited.structured).toMatchObject({ first_name: 'Rosa', role: 'front_of_house', status: 'invited' });
    expect(claude.asked.at(-1)).toBe('Invite Rosa (rosa@osteria-nina.example) to Osteria Nina as front of house at Osteria Nina? They are emailed an invitation and sign in with that address.');
    const rosa = await t.db.selectFrom('staff').select(['id', 'status', 'is_owner']).where('org_id', '=', orgId).where('email', '=', 'rosa@osteria-nina.example').executeTakeFirstOrThrow();
    expect(rosa).toMatchObject({ status: 'invited', is_owner: false });
    expect(await t.db.selectFrom('staff_venues').select(['venue_id', 'role']).where('staff_id', '=', rosa.id).execute()).toEqual([{ venue_id: venueId, role: 'front_of_house' }]);
    await drainJobs(t.app, { kinds: ['comms.send'] });
    expect(t.sim.email.lastTo('rosa@osteria-nina.example')!.subject).toBe('You have been added to Osteria Nina');
    // Another owner is not something an assistant adds.
    const asked = claude.asked.length;
    expect((await claude.call('team_invite', { email: 'second.owner@example.com', first_name: 'Sam', role: 'owner' })).isError).toBe(true);
    expect(claude.asked.length).toBe(asked);
    expect(await t.db.selectFrom('staff').select('id').where('org_id', '=', orgId).where('is_owner', '=', true).execute()).toHaveLength(1);
  });

  it('13 · a front-of-house assistant cannot switch a plugin on: not offered, and forbidden if it tries', async () => {
    const login = await signInAs('rosa@osteria-nina.example');
    expect(login.activeOrgId).toBe(orgId);
    const rosa = (await auth.authenticate(t.app, login.token))!.principal as StaffPrincipal;
    expect(rosa.venueRoles[venueId]).toBe('front_of_house');
    const before = await row.modules();

    // The service function itself refuses the role, whoever calls it.
    await expect(t.app.tenant(orgId, rosa, (ctx) => tenancy.enablePlugin(ctx, { venueId, plugin: 'loyalty' }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(orgId, rosa, (ctx) => tenancy.listPlugins(ctx, venueId))).rejects.toMatchObject({ code: 'forbidden' });
    // And so does the tool, for a key that holds the permission but whose person is front of house.
    const key: AgentPrincipal = { kind: 'agent', keyId: randomUUID(), staff: rosa, scopes: ['plugins:write', 'setup:read', 'setup:write'], venueIds: null, canWrite: true };
    const enable = getTool('plugin_enable')!;
    if (enable.effect !== 'write') throw new Error('plugin_enable is a write');
    await expect(t.app.tenant(orgId, key, (ctx) => enable.propose({ ctx, venueId }, enable.input.parse({ plugin: 'loyalty' })))).rejects.toMatchObject({ code: 'forbidden' });
    const goLive = getTool('go_live')!;
    if (goLive.effect !== 'write') throw new Error('go_live is a write');
    await expect(t.app.tenant(orgId, key, (ctx) => goLive.propose({ ctx, venueId: null }, {}))).rejects.toMatchObject({ code: 'forbidden' });

    // Signed in as an assistant of hers, the hub does not even offer the tool, and a call to it by name is refused.
    const a = assistant(app, { name: 'Rosa\'s assistant' });
    const sentTo = await a.start();
    await expect(app.tenant(orgId, rosa, (ctx) => hub.decideOAuthRequest(ctx, sentTo.searchParams, { allow: true, allowChanges: true }))).rejects.toMatchObject({ code: 'forbidden' });
    const decided = await app.tenant(orgId, rosa, (ctx) => hub.decideOAuthRequest(ctx, sentTo.searchParams, { allow: true }));
    await a.finish(decided.redirectTo);
    const hers = await connectModern(app, a.tokens()!.access_token, { answer: () => 'yes' });
    const names = await hers.names();
    for (const tool of ['plugin_enable', 'plugin_configure', 'plugin_disable', 'plugins_list', 'setup_status', 'go_live', 'venue_update', 'team_invite', 'connection_start']) expect(names).not.toContain(tool);
    const tried = await rawToolCall(app, a.tokens()!.access_token, 'plugin_enable', { plugin: 'loyalty' });
    expect(tried.asking).toBeNull();
    expect(tried.answer?.isError ?? !!tried.error).toBe(true);
    expect(hers.asked).toEqual([]);
    expect(await row.modules()).toEqual(before);
    await hers.close();
  });

  it('14 · another organisation\'s assistant cannot see or change this venue: it is not found', async () => {
    // Otto owns Bar Due, started the same way. His assistant has every permission there.
    const scopes = hub.knownScopes(t.app).filter((s) => /^(setup|plugins|venue|connections|menu|team):/.test(s));
    const ottoKey = await issueKey(t.app, other.orgId, other.owner, { scopes, canWrite: true });
    const otto = await connectModern(t.app, ottoKey.key, { answer: () => 'yes' });
    const venueBefore = await row.venue();
    const modulesBefore = await row.modules();

    // Everything it is told is about its own organisation.
    const s = await status(otto);
    expect(s.summary).toContain('Bar Due is a draft');
    expect(JSON.stringify(s)).not.toContain('Osteria Nina');
    expect(((await otto.call('venue_describe')).structured as { venue: { name: string } }).venue.name).toBe('Bar Due');
    // No tool takes an organisation or a venue it could aim elsewhere; an argument that tries is refused or ignored.
    const aimed = await otto.call('venue_update', { venue: venueBefore.slug, org_id: orgId, venue_id: venueId, name: 'Taken Over' } as never);
    expect(aimed.isError).toBe(false);
    expect((await t.db.selectFrom('venues').select('name').where('id', '=', other.venueId).executeTakeFirstOrThrow()).name).toBe('Taken Over');
    // Nina's menu import, by its id: not found.
    const ninasImport = await t.db.selectFrom('menu_imports').select('id').where('org_id', '=', orgId).executeTakeFirstOrThrow();
    expect(await otto.call('menu_import_review', { import_id: ninasImport.id })).toMatchObject({ isError: true, text: 'Menu import not found' });
    expect((await otto.call('menu_import_confirm', { import_id: ninasImport.id, confirm: ['s1i1'], allergens_checked: true })).text).toBe('Menu import not found');

    // The service functions the tools are pinned to, called with this venue's id by the other owner: not found, never forbidden.
    const asOtto = <T>(fn: (ctx: Parameters<Parameters<App['tenant']>[2]>[0]) => Promise<T>) => t.app.tenant(other.orgId, other.owner, fn);
    await expect(asOtto((ctx) => tenancy.getVenue(ctx, venueId))).rejects.toMatchObject({ code: 'not_found' });
    await expect(asOtto((ctx) => tenancy.listPlugins(ctx, venueId))).rejects.toMatchObject({ code: 'not_found' });
    await expect(asOtto((ctx) => tenancy.enablePlugin(ctx, { venueId, plugin: 'loyalty' }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(asOtto((ctx) => tenancy.disablePlugin(ctx, { venueId, plugin: 'ordering' }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(asOtto((ctx) => onboarding.getSetupStatus(ctx, venueId))).rejects.toMatchObject({ code: 'not_found' });
    await expect(asOtto((ctx) => ledger.startPosSignIn(ctx, { plugKey: 'square', venueId }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(asOtto((ctx) => onboarding.requestMenuImport(ctx, { venueId, source: { kind: 'text', text: MENU_TEXT } }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(asOtto((ctx) => onboarding.getMenuImport(ctx, ninasImport.id))).rejects.toMatchObject({ code: 'not_found' });

    // Bar Due is still a draft with nothing done; going live is its own checklist, and it does not pass.
    expect((await otto.call('go_live')).text).toMatch(/^Not ready to go live\./);
    expect((await t.db.selectFrom('orgs').select('status').where('id', '=', other.orgId).executeTakeFirstOrThrow()).status).toBe('onboarding');
    // Nothing of Nina's moved.
    expect(await row.venue()).toEqual(venueBefore);
    expect(await row.modules()).toEqual(modulesBefore);
    expect((await row.org()).status).toBe('live');
    await otto.close();
    await claude.close();
  });
});
