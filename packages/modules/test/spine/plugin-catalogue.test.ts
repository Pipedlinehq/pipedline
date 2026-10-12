import { beforeAll, describe, expect, it } from 'vitest';
import { checkManifest, listModuleDefs, listTools } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { tenancy } from '@ros/modules';
import { connectModern, issueKey, roomForKeys } from '../hub/helpers';

/**
 * The plugin manifests and the public catalogue (docs/CONSOLE_IA.md section 6): every module
 * carries one, the catalogue is generated from them, the two platform-host answers carry no venue
 * data unless a staff member is behind the request, and the assistant's `plugins_list` is richer
 * for it.
 */
const BANNED = /\b(skus?|merchants?|fulfil+ment|inventory)\b/i;
const CHANNELS = ['website', 'qr', 'ordering', 'delivery', 'bookings', 'guest-plugin'];

describe('plugin manifests and the public catalogue', () => {
  const t = useTestEnv();
  const defs = () => listModuleDefs().filter((d) => !d.key.startsWith('test_'));

  beforeAll(async () => {
    await roomForKeys(t.app, t.fixture);
  });

  it('every module has a manifest that passes the gate\'s checks, in an owner\'s words', () => {
    const all = defs();
    expect(all.length).toBeGreaterThanOrEqual(21);
    for (const def of all) {
      expect(checkManifest(def), def.key).toEqual([]);
      const m = def.manifest;
      for (const text of [m.name, m.purpose, ...m.needs, ...m.reads, ...m.writes, m.consent ?? '']) expect(text, `${def.key}: "${text}"`).not.toMatch(BANNED);
      expect(m.kind, def.key).toBe(CHANNELS.includes(def.key) ? 'channel' : 'module');
      if (m.kind === 'channel') expect(typeof m.publicAddress, def.key).toBe('function');
      if (def.spine) expect(m.kind, def.key).toBe('module');
    }
    // The schema refuses what the type cannot: an empty line, a plug claimed by a module.
    expect(checkManifest({ key: 'x', name: 'X', manifest: { name: 'X', purpose: '', category: 'setup', kind: 'module', needs: [], reads: ['a'], writes: ['b'] } })).toEqual(expect.arrayContaining([expect.stringMatching(/^purpose:/), expect.stringMatching(/^needs:/)]));
    expect(checkManifest({ key: 'x', name: 'X', manifest: { name: 'Other', purpose: 'p', category: 'setup', kind: 'module', needs: ['n'], reads: ['a'], writes: ['b'] } })).toEqual([expect.stringContaining('the manifest says "Other"')]);
    expect(checkManifest({ key: 'x', name: 'X', manifest: { name: 'X', purpose: 'p', category: 'setup', kind: 'plug' as never, needs: ['n'], reads: ['a'], writes: ['b'] } })).toEqual([expect.stringMatching(/^kind:/)]);
  });

  it('the public catalogue lists every module and plug with the expected kinds, tools, schemas and docs, and names no venue', () => {
    const cat = tenancy.pluginCatalogue(t.app);
    expect(tenancy.pluginCatalogueShape.parse(cat)).toBeTruthy();
    expect(cat.platform).toBe('http://console.rosplatform.test');
    expect(cat.assistant_endpoint).toBe('http://console.rosplatform.test/api/mcp');
    expect(cat.guest_endpoint).toBe('http://console.rosplatform.test/api/guest/mcp');
    expect(cat.plugins.length).toBeGreaterThanOrEqual(21 + 1);
    const by = Object.fromEntries(cat.plugins.map((p) => [p.key, p]));

    // Kinds.
    for (const key of CHANNELS) expect(by[key]!.kind, key).toBe('channel');
    expect(by.hub).toMatchObject({ kind: 'module', category: 'setup', always_on: false });
    for (const key of ['tenancy', 'identity', 'ledger', 'events', 'comms', 'console', 'approvals', 'menu', 'analytics', 'onboarding']) expect(by[key], key).toMatchObject({ kind: 'module', always_on: true, connect: null });
    expect(by.criota).toMatchObject({ kind: 'plug', category: 'integration', always_on: false, tools: [], config_schema: null, docs: null });
    expect(by.criota!.connect).toMatch(/^An access key from Criota, entered by the owner in the console\. An assistant never handles it\. Each venue then lists it/);
    expect(by.square).toMatchObject({ kind: 'plug' });
    expect(by.square!.connect).toMatch(/^The owner signs in at Square/);
    // Simulated plugs are offered outside production only.
    expect(by['criota-sim']).toBeDefined();

    // Tools are the module's own defineTool tools: name, effect, description.
    expect(by.bookings!.tools.map((x) => x.name)).toEqual(['booking_add', 'booking_availability', 'booking_cancel', 'booking_confirm', 'booking_decline', 'booking_nudge', 'bookings_list', 'bookings_today']);
    expect(by.bookings!.tools.find((x) => x.name === 'booking_confirm')).toMatchObject({ effect: 'write', description: expect.stringMatching(/./) });
    expect(by.tenancy!.tools.map((x) => x.name)).toEqual(expect.arrayContaining(['plugins_list', 'plugin_enable', 'venue_describe', 'connections_list']));
    expect(by.events!.tools).toEqual([]);
    expect(cat.plugins.flatMap((p) => p.tools.map((x) => x.name))).not.toContain('test_hub_peek');
    // Every tool in the engine belongs to exactly one catalogue entry.
    const engineTools = listTools()
      .filter((x) => !x.name.startsWith('test_'))
      .map((x) => x.name)
      .sort();
    expect(cat.plugins.flatMap((p) => p.tools.map((x) => x.name)).sort()).toEqual(engineTools);

    // The config schema is JSON Schema with the .describe() texts; no settings → null.
    const specials = by.specials!.config_schema as { properties: Record<string, { description?: string; default?: unknown; minimum?: number }> };
    expect(by.specials!.config_scope).toBe('venue');
    expect(specials.properties.max_running).toMatchObject({ type: 'integer', minimum: 1, maximum: 50, default: 10, description: expect.stringContaining('The most specials') });
    expect(by.campaigns).toMatchObject({ config_schema: null, config_scope: null });
    expect(by.analytics!.config_scope).toBe('organisation');
    expect(Object.keys((by.analytics!.config_schema as { properties: object }).properties)).toContain('minCohort');

    // Docs only where the spec exists.
    expect(by.bookings!.docs).toBe('https://github.com/Pipedlinehq/pipedline/blob/main/docs/modules/bookings.md');
    expect(by.events!.docs).toBeNull();
    expect(by.console!.docs).toBeNull();

    // Needs carry the dependency first; manifests carry the rest.
    expect(by.delivery!.needs[0]).toBe('Online ordering switched on first');
    expect(by.ordering!.needs).toContain('A menu with prices');
    expect(by.bookings!.consent).toBe('A booking never adds a guest to a marketing list.');

    // No venue: the only public address is the fixed guest endpoint.
    expect(by['guest-plugin']!.public_address).toBe('http://console.rosplatform.test/api/guest/mcp');
    for (const key of ['website', 'qr', 'ordering', 'delivery', 'bookings']) expect(by[key]!.public_address, key).toBeNull();
    const text = JSON.stringify(cat);
    expect(text).not.toContain('Oak Diner');
    expect(text).not.toContain('oak-diner');
    expect(text).not.toContain('"on"');
  });

  it('for a venue: on and settings for a manager, on only for other staff, addresses on the venue\'s own host; another venue is not found', async () => {
    const diner = t.fixture.diner;
    const manager = await diner.as('manager');
    const cat = await t.app.tenant(diner.orgId, manager, (ctx) => tenancy.pluginCatalogueForVenue(ctx, diner.venueId));
    expect(cat.venue).toMatchObject({ id: diner.venueId, name: 'Oak Diner' });
    const by = Object.fromEntries(cat.plugins.map((p) => [p.key, p]));
    expect(by.ordering).toMatchObject({ on: true, config: expect.objectContaining({ slot_minutes: expect.any(Number) }) });
    expect(by.tenancy).toMatchObject({ on: true, always_on: true, config: null });
    expect(by.analytics!.config).toMatchObject({ minCohort: expect.any(Number) });
    expect(by.campaigns!.config).toBeNull();
    expect(by.criota).toMatchObject({ kind: 'plug', config: null });
    expect(typeof by.criota!.on).toBe('boolean');
    // Channel addresses are on the venue's own verified host; the guest endpoint stays on the platform.
    const host = await t.app.tenant(diner.orgId, manager, (ctx) => tenancy.getPrimaryHost(ctx, diner.venueId));
    expect(host).toBeTruthy();
    expect(by.website!.public_address).toBe(`http://${host}`);
    expect(by.ordering!.public_address).toBe(`http://${host}/order`);
    expect(by.qr!.public_address).toBe(`http://${host}/q/<code>`);
    expect(by['guest-plugin']!.public_address).toBe('http://console.rosplatform.test/api/guest/mcp');

    // Below manager: what is on, not the settings.
    const foh = await diner.as('host'); // Harper: front_of_house at the diner
    const seen = await t.app.tenant(diner.orgId, foh, (ctx) => tenancy.pluginCatalogueForVenue(ctx, diner.venueId));
    const fohBy = Object.fromEntries(seen.plugins.map((p) => [p.key, p]));
    expect(fohBy.ordering).toMatchObject({ on: true, config: null });
    expect(fohBy.analytics!.config).toBeNull();

    // A venue of another organisation, or one this person has no role at, is not found; nobody signed in is refused.
    const group = t.fixture.group;
    await expect(t.app.tenant(diner.orgId, manager, (ctx) => tenancy.pluginCatalogueForVenue(ctx, group.venues.cbd!.id))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(group.orgId, await group.as('manager'), (ctx) => tenancy.pluginCatalogueForVenue(ctx, group.venues.bondi!.id))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(diner.orgId, { kind: 'anon' }, (ctx) => tenancy.pluginCatalogueForVenue(ctx, diner.venueId))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('/plugins.json and /llms.txt: the public answers are cacheable and carry no venue; the signed-in answer is private and carries `on`', async () => {
    const pub = tenancy.pluginsJsonResponse(tenancy.pluginCatalogue(t.app), { personal: false });
    expect(pub.status).toBe(200);
    expect(pub.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(pub.headers.get('cache-control')).toMatch(/^public, max-age=\d+/);
    expect(pub.headers.get('vary')).toBe('Cookie');
    const body = tenancy.pluginCatalogueShape.parse(await pub.json());
    expect(body.plugins.length).toBeGreaterThanOrEqual(22);
    expect(body.plugins[0]).toMatchObject({ key: 'tenancy', kind: 'module', always_on: true });
    expect(body.plugins.every((p) => !('on' in p) && !('config' in p))).toBe(true);
    expect(JSON.stringify(body)).not.toContain('Oak Diner');

    const diner = t.fixture.diner;
    const mine = await t.app.tenant(diner.orgId, await diner.as('owner'), (ctx) => tenancy.pluginCatalogueForVenue(ctx, diner.venueId));
    const priv = tenancy.pluginsJsonResponse(mine, { personal: true });
    expect(priv.headers.get('cache-control')).toBe('private, no-store');
    const privBody = (await priv.json()) as { venue: { name: string }; plugins: Array<{ key: string; on: boolean }> };
    expect(privBody.venue.name).toBe('Oak Diner');
    expect(privBody.plugins.find((p) => p.key === 'ordering')).toMatchObject({ on: true });

    const txt = tenancy.llmsTxtResponse(tenancy.pluginCatalogue(t.app));
    expect(txt.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(txt.headers.get('cache-control')).toMatch(/^public/);
    const text = await txt.text();
    expect(text.startsWith('# Pipedline\n')).toBe(true);
    expect(text).toContain('http://console.rosplatform.test/api/guest/mcp');
    expect(text).toContain('http://console.rosplatform.test/api/mcp');
    expect(text).toContain('### Table bookings (bookings)');
    expect(text).toContain('- booking_confirm (changes; asks first): ');
    expect(text).toContain('- plugins_list (reads): ');
    expect(text).toContain('### Criota (criota)');
    expect(text).not.toContain('Oak Diner');
    expect(text).not.toMatch(BANNED);
  });

  it('plugins_list through an assistant still parses and now carries purpose, needs, reads, writes, consent and the public address', async () => {
    const diner = t.fixture.diner;
    const key = await issueKey(t.app, diner.orgId, await diner.as('manager'), { scopes: ['plugins:read'] });
    const s = await connectModern(t.app, key.key);
    const out = (await s.call('plugins_list', {})).structured as { venue: string; plugins: Array<Record<string, unknown>> };
    expect(out.venue).toBe('Oak Diner');
    const by = Object.fromEntries(out.plugins.map((p) => [p.plugin as string, p]));
    expect(by.bookings).toMatchObject({
      name: 'Table bookings',
      kind: 'plugin',
      catalogue_kind: 'channel',
      category: 'channels',
      purpose: expect.stringContaining('Guests book a table'),
      needs: [expect.stringContaining('Opening hours')],
      reads: expect.arrayContaining(['opening hours and closed days']),
      writes: expect.arrayContaining(['bookings and their status']),
      consent: 'A booking never adds a guest to a marketing list.',
      docs: 'https://github.com/Pipedlinehq/pipedline/blob/main/docs/modules/bookings.md',
    });
    expect(by.delivery!.needs).toEqual(['Online ordering switched on first', 'A courier service connected', 'Delivery zones drawn around the venue']);
    expect(by['guest-plugin']).toMatchObject({ catalogue_kind: 'channel', public_address: 'http://console.rosplatform.test/api/guest/mcp' });
    expect(by.website!.public_address).toMatch(/^http:\/\/.+/);
    expect(by.analytics).toMatchObject({ kind: 'built_in', catalogue_kind: 'module', category: 'insight', consent: expect.stringContaining('totals') });
    expect(by.criota).toMatchObject({ kind: 'connection', catalogue_kind: 'plug', category: 'integration', public_address: null, docs: null });
    expect(by.criota!.needs).toEqual([expect.stringMatching(/^An access key from Criota/)]);
    await s.close();
  });
});
