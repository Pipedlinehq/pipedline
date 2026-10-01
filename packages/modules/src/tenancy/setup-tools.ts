import { z } from 'zod';
import { defineTool, getPlug, invalid, listConnections, listPlugs } from '@ros/core';
import { getPrimaryHost } from './domains';
import { getTradingHours, setTradingHours } from './hours';
import { getOrg } from './orgs';
import { configurePlugin, disablePlugin, enablePlugin, listPlugins, planPluginChange } from './plugins';
import { getVenue, updateVenue } from './venues';

/**
 * The setup tools this module owns (docs/PIPEDLINE.md "What has to change" section 2): the
 * venue's own details and hours, its plugins, and what it has connected. Each is pinned to the
 * service function the console uses; every change is `propose` then `commit`.
 */

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 17:30.');
const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Use a time zone name such as Australia/Sydney.');
const text = (max: number) => z.string().trim().min(1).max(max);

const hoursShape = z.array(z.object({ day: z.enum(DAYS), opens: z.string(), closes: z.string(), service: z.string() }));

const hoursWords = (hours: Array<{ day: string; opens: string; closes: string }>) =>
  hours.length ? hours.map((h) => `${h.day[0]!.toUpperCase()}${h.day.slice(1, 3)} ${h.opens} to ${h.closes}`).join(', ') : 'none (closed every day)';

export const venueDescribeTool = defineTool({
  name: 'venue_describe',
  module: 'tenancy',
  title: 'The venue\'s details',
  description:
    'The venue as it is on record: name, address, phone, time zone, cuisine, weekly opening hours, whether it is still a draft or live, and the address of its public site. Read this before changing anything with venue_update.',
  effect: 'read',
  scope: 'venue:read',
  venueScoped: true,
  input: z.object({}),
  output: z.object({
    organisation: z.object({ name: z.string(), status: z.string() }),
    venue: z.object({
      name: z.string(),
      short_name: z.string(),
      status: z.string(),
      timezone: z.string(),
      address_line1: z.string().nullable(),
      address_line2: z.string().nullable(),
      suburb: z.string().nullable(),
      state: z.string().nullable(),
      postcode: z.string().nullable(),
      phone: z.string().nullable(),
      email: z.string().nullable(),
      capacity: z.number().nullable(),
      cuisine: z.array(z.string()),
      price_band: z.number().nullable(),
    }),
    hours: hoursShape,
    site_address: z.string().nullable(),
    missing: z.array(z.string()),
  }),
  async run({ ctx, venueId }) {
    const venue = await getVenue(ctx, venueId!);
    const org = await getOrg(ctx);
    const hours = await getTradingHours(ctx, venue.id);
    const host = await getPrimaryHost(ctx, venue.id);
    const missing = [
      ...(!venue.addressLine1 ? ['street address'] : []),
      ...(!venue.suburb ? ['suburb'] : []),
      ...(!venue.state ? ['state'] : []),
      ...(!venue.postcode ? ['postcode'] : []),
      ...(!venue.phone ? ['phone number'] : []),
      ...(!hours.length ? ['opening hours'] : []),
    ];
    return {
      organisation: { name: org.tradingName, status: org.status },
      venue: {
        name: venue.name,
        short_name: venue.slug,
        status: venue.status,
        timezone: venue.timezone,
        address_line1: venue.addressLine1,
        address_line2: venue.addressLine2,
        suburb: venue.suburb,
        state: venue.state,
        postcode: venue.postcode,
        phone: venue.phone,
        email: venue.email,
        capacity: venue.capacity,
        cuisine: venue.cuisineTags,
        price_band: venue.priceBand,
      },
      hours: hours.map((h) => ({ day: DAYS[h.dayOfWeek]!, opens: h.opensAt.slice(0, 5), closes: h.closesAt.slice(0, 5), service: h.serviceType })),
      site_address: host ? `${ctx.app.config.scheme}://${host}` : null,
      missing,
    };
  },
});

const FIELDS = {
  name: ['name', 'name'],
  timezone: ['timezone', 'time zone'],
  address_line1: ['addressLine1', 'street address'],
  address_line2: ['addressLine2', 'address, second line'],
  suburb: ['suburb', 'suburb'],
  state: ['state', 'state'],
  postcode: ['postcode', 'postcode'],
  phone: ['phone', 'phone'],
  email: ['email', 'email'],
  capacity: ['capacity', 'capacity'],
  cuisine: ['cuisineTags', 'cuisine'],
  price_band: ['priceBand', 'price band'],
} as const;

export const venueUpdateTool = defineTool({
  name: 'venue_update',
  module: 'tenancy',
  title: 'Change the venue\'s details or hours',
  description:
    'Set the venue\'s name, address, phone, email, time zone, cuisine, capacity or weekly opening hours. Give only what should change. `hours` replaces the whole week: list every period the venue is open; a day left out is closed. Ask the owner for anything you do not know; do not guess an address or hours.',
  effect: 'write',
  scope: 'venue:write',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({
    name: text(200).optional(),
    timezone: timezone.optional().describe('An IANA time zone name, e.g. Australia/Sydney'),
    address_line1: text(200).optional(),
    address_line2: text(200).nullable().optional(),
    suburb: text(80).optional(),
    state: text(40).optional(),
    postcode: z.string().trim().regex(/^[0-9A-Za-z -]{3,10}$/, 'Enter a postcode.').optional(),
    phone: z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/, 'Enter a phone number.').optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    capacity: z.number().int().positive().max(100_000).optional(),
    cuisine: z.array(text(40)).max(10).optional(),
    price_band: z.number().int().min(1).max(4).optional().describe('1 (cheapest) to 4'),
    hours: z
      .array(z.object({ day: z.enum(DAYS), opens: TIME, closes: TIME.describe('A time at or before `opens` means it closes after midnight'), service: text(40).optional().describe('e.g. lunch, dinner. Leave out for one service all day') }))
      .max(42)
      .optional()
      .describe('The whole week\'s opening hours. Replaces what is there.'),
  }),
  output: z.object({ venue: z.string(), changed: z.array(z.string()) }),
  async propose({ ctx, venueId }, input) {
    const venue = await getVenue(ctx, venueId!);
    const current = venue as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    const changes: string[] = [];
    for (const [arg, [field, label]] of Object.entries(FIELDS)) {
      const value = (input as Record<string, unknown>)[arg];
      if (value === undefined || JSON.stringify(value) === JSON.stringify(current[field])) continue;
      patch[field] = value;
      changes.push(`${label}: ${value === null ? 'removed' : Array.isArray(value) ? value.join(', ') || 'none' : String(value)}`);
    }
    let hours: Array<{ dayOfWeek: number; opensAt: string; closesAt: string; serviceType: string }> | null = null;
    if (input.hours) {
      const before = (await getTradingHours(ctx, venue.id)).map((h) => `${h.dayOfWeek} ${h.opensAt.slice(0, 5)} ${h.closesAt.slice(0, 5)} ${h.serviceType}`).sort();
      const next = input.hours.map((h) => ({ dayOfWeek: DAYS.indexOf(h.day), opensAt: h.opens, closesAt: h.closes, serviceType: h.service ?? 'all' }));
      const after = next.map((h) => `${h.dayOfWeek} ${h.opensAt} ${h.closesAt} ${h.serviceType}`).sort();
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        hours = next;
        changes.push(`opening hours: ${hoursWords([...input.hours].sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.opens.localeCompare(b.opens)))}`);
      }
    }
    if (!changes.length) throw invalid('Nothing would change: those are already the details on record. Say what should be different.');
    return {
      question: `Change these details of ${venue.name}? ${changes.join('; ')}.${hours ? ' This replaces the weekly opening hours.' : ''}`,
      commit: async () => {
        if (Object.keys(patch).length) await updateVenue(ctx, venue.id, patch);
        if (hours) await setTradingHours(ctx, venue.id, hours);
        return { venue: (await getVenue(ctx, venue.id)).name, changed: changes };
      },
    };
  },
});

const pluginShape = z.object({
  plugin: z.string(),
  name: z.string(),
  purpose: z.string(),
  kind: z.enum(['plugin', 'built_in', 'connection']),
  on: z.boolean(),
  can_switch_on_or_off: z.boolean(),
  you_may_change_it: z.boolean(),
  needs: z.array(z.string()),
  settings_apply_to: z.enum(['venue', 'organisation', 'none']),
  settings: z.record(z.string(), z.unknown()),
  settings_schema: z.record(z.string(), z.unknown()),
  connects_by: z.enum(['sign_in', 'access_key', 'nothing']).nullable(),
  can_be_granted: z.array(z.string()),
});

export const pluginsListTool = defineTool({
  name: 'plugins_list',
  module: 'tenancy',
  title: 'The plugins and what is switched on',
  description:
    'Every plugin: what it is for, what it needs, whether it is on here, its current settings, and `settings_schema` describing each setting (JSON Schema) so you know what plugin_enable and plugin_configure accept. kind "plugin" is switched on or off with plugin_enable / plugin_disable; "built_in" is always on (some have settings for the whole organisation); "connection" is an outside service, connected with connection_start. Where `you_may_change_it` is false, the change is made by a person in the console.',
  effect: 'read',
  scope: 'plugins:read',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({ only: z.enum(['all', 'on', 'off']).default('all').describe('Narrow the list to what is on, or what is off') }),
  output: z.object({ venue: z.string(), plugins: z.array(pluginShape) }),
  async run({ ctx, venueId }, input) {
    const venue = await getVenue(ctx, venueId!);
    const plugins = (await listPlugins(ctx, venue.id)).filter((p) => input.only === 'all' || (input.only === 'on') === p.on);
    return {
      venue: venue.name,
      plugins: plugins.map((p) => ({
        plugin: p.key,
        name: p.name,
        purpose: p.purpose,
        kind: p.kind,
        on: p.on,
        can_switch_on_or_off: p.canSwitch,
        you_may_change_it: p.assistantMayChange,
        needs: p.needs,
        settings_apply_to: p.settingsApplyTo,
        settings: p.settings,
        settings_schema: p.settingsSchema,
        connects_by: p.connectsBy,
        can_be_granted: p.canBeGranted,
      })),
    };
  },
});

const pluginResult = z.object({ plugin: z.string(), name: z.string(), on: z.boolean(), settings: z.record(z.string(), z.unknown()) });
const settingsArg = z.record(z.string().max(80), z.unknown());
const settingsWords = (changes: string[]) => (changes.length ? ` Settings: ${changes.join('; ')}.` : '');

export const pluginEnableTool = defineTool({
  name: 'plugin_enable',
  module: 'tenancy',
  title: 'Switch a plugin on',
  description:
    'Switch a plugin on at the venue, optionally with settings. `plugin` is the key from plugins_list; `settings` follows that plugin\'s settings_schema, and anything left out takes its default. A setting the plugin does not have, or a value it does not accept, is refused with the reason.',
  effect: 'write',
  scope: 'plugins:write',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({ plugin: z.string().trim().min(1).max(60).describe('The plugin key from plugins_list, e.g. "ordering"'), settings: settingsArg.optional() }),
  output: pluginResult,
  async propose({ ctx, venueId }, input) {
    const venue = await getVenue(ctx, venueId!);
    const args = { venueId: venue.id, plugin: input.plugin, config: input.settings };
    const plan = await planPluginChange(ctx, args, 'enable');
    const needs = (await listPlugins(ctx, venue.id)).find((p) => p.key === plan.key)?.needs ?? [];
    return {
      question: plan.on
        ? `Change the settings of ${plan.name} at ${venue.name}?${settingsWords(plan.changes)}`
        : `Switch on ${plan.name} at ${venue.name}? ${plan.purpose}${settingsWords(plan.changes)}${needs.length ? ` It needs: ${needs.join('; ')}.` : ''}`,
      commit: async () => {
        const done = await enablePlugin(ctx, args);
        return { plugin: plan.key, name: plan.name, on: done.on, settings: done.settings };
      },
    };
  },
});

export const pluginConfigureTool = defineTool({
  name: 'plugin_configure',
  module: 'tenancy',
  title: 'Change a plugin\'s settings',
  description:
    'Change settings of a plugin that is already on (or of a built-in one, whose settings apply to the whole organisation). `settings` follows the plugin\'s settings_schema from plugins_list; give only what should change. An invalid value is refused with the reason and nothing is saved.',
  effect: 'write',
  scope: 'plugins:write',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({ plugin: z.string().trim().min(1).max(60), settings: settingsArg.refine((s) => Object.keys(s).length > 0, 'Give at least one setting to change.') }),
  output: pluginResult,
  async propose({ ctx, venueId }, input) {
    const venue = await getVenue(ctx, venueId!);
    const args = { venueId: venue.id, plugin: input.plugin, config: input.settings };
    const plan = await planPluginChange(ctx, args, 'configure');
    const where = plan.settingsApplyTo === 'organisation' ? `for the whole of ${(await getOrg(ctx)).tradingName}` : `at ${venue.name}`;
    return {
      question: `Change the settings of ${plan.name} ${where}?${settingsWords(plan.changes)}`,
      commit: async () => {
        const done = await configurePlugin(ctx, args);
        return { plugin: plan.key, name: plan.name, on: done.on, settings: done.settings };
      },
    };
  },
});

export const pluginDisableTool = defineTool({
  name: 'plugin_disable',
  module: 'tenancy',
  title: 'Switch a plugin off',
  description: 'Switch a plugin off at the venue. Its pages, tools and guest-facing surfaces stop being offered; its data and settings are kept, and it can be switched on again later.',
  effect: 'write',
  scope: 'plugins:write',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({ plugin: z.string().trim().min(1).max(60) }),
  output: pluginResult,
  async propose({ ctx, venueId }, input) {
    const venue = await getVenue(ctx, venueId!);
    const args = { venueId: venue.id, plugin: input.plugin };
    const plan = await planPluginChange(ctx, args, 'disable');
    // Switching assistant access off ends the connection this question is being asked over.
    const warning = plan.key === 'hub' ? ' This ends every assistant\'s access to this venue, including this one; it can only be switched back on in the console.' : '';
    return {
      question: `Switch off ${plan.name} at ${venue.name}? Guests and staff stop seeing it straight away. Its data and settings are kept.${warning}`,
      commit: async () => {
        const done = await disablePlugin(ctx, args);
        return { plugin: plan.key, name: plan.name, on: done.on, settings: done.settings };
      },
    };
  },
});

const HOW: Record<string, string> = {
  oauth: 'The owner signs in at the service in a browser. Get the link with connection_start.',
  api_key: 'The owner enters the service\'s access key in the console. An assistant never handles it.',
  none: 'Connected in the console.',
};

export const connectionsListTool = defineTool({
  name: 'connections_list',
  module: 'tenancy',
  title: 'Connected services',
  description:
    'The outside services this venue has connected (its till, payments and so on): whether each is healthy, when it last worked, what it was allowed to read and write, and the services that could be connected and how.',
  effect: 'read',
  scope: 'connections:read',
  venueScoped: true,
  input: z.object({}),
  output: z.object({
    connections: z.array(
      z.object({
        service: z.string(),
        name: z.string(),
        status: z.string(),
        connected_at: z.string().nullable(),
        last_ok: z.string().nullable(),
        problem: z.string().nullable(),
        sign_in_expires: z.string().nullable(),
        allowed: z.array(z.string()),
      }),
    ),
    can_connect: z.array(z.object({ service: z.string(), name: z.string(), purpose: z.string(), how: z.string(), can_be_granted: z.array(z.string()) })),
  }),
  async run({ ctx, venueId }) {
    const rows = (await listConnections(ctx, { venueId: venueId! })).filter((c) => c.status !== 'revoked');
    const nameOf = (key: string) => {
      try {
        return getPlug(key).name;
      } catch {
        return key;
      }
    };
    return {
      connections: rows.map((c) => ({
        service: c.plug_key,
        name: nameOf(c.plug_key),
        status: c.status,
        connected_at: c.connected_at ? c.connected_at.toISOString() : null,
        last_ok: c.last_ok_at ? c.last_ok_at.toISOString() : null,
        problem: c.last_error,
        sign_in_expires: c.expires_at ? c.expires_at.toISOString() : null,
        allowed: c.scopes,
      })),
      can_connect: listPlugs()
        .filter((p) => !(p.simulated && ctx.app.config.env === 'production') && !rows.some((c) => c.plug_key === p.key && c.status === 'connected'))
        .map((p) => ({ service: p.key, name: p.name, purpose: p.description, how: HOW[p.auth]!, can_be_granted: p.scopes })),
    };
  },
});
