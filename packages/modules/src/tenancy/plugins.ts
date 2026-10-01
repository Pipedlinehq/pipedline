import { z } from 'zod';
import {
  type Ctx,
  type ModuleDef,
  type ModuleState,
  forbidden,
  getModule,
  getModuleDef,
  hookList,
  invalid,
  keyedRegistry,
  listConnections,
  listModuleDefs,
  listPlugs,
  notFound,
  register,
  requireStaff,
  setModule,
} from '@ros/core';

/**
 * Plugins as a venue sees them (docs/PIPEDLINE.md: "every capability is a plugin a venue
 * switches on"). A plugin is a module from the catalogue, or a plug (a connected service).
 * Nothing here is a second implementation: switching a module on or off and saving its config
 * is core `setModule`, which validates the whole config against the module's own schema and
 * writes the audit entry. What this file adds is what an owner (or their assistant) needs
 * before the change: the list, each plugin's settings described from its schema, and a refusal
 * that says which setting is wrong and why.
 */

/** A spine module whose settings belong to the whole organisation (orgs.settings), not one venue. */
export interface OrgPluginSettings {
  module: string;
  schema: z.ZodType<Record<string, unknown>>;
  get(ctx: Ctx): Promise<Record<string, unknown>>;
  /** The module's own setter: it merges, validates, checks the role and audits. */
  set(ctx: Ctx, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const orgSettings = keyedRegistry<OrgPluginSettings>('tenancy.orgPluginSettings');

/** A module with org-level settings registers them so they can be listed and changed as that plugin's settings. */
export function registerOrgPluginSettings(def: OrgPluginSettings): OrgPluginSettings {
  return register(orgSettings, def.module, def, 'Plugin settings');
}

export type PluginEnabledHook = (ctx: Ctx, args: { venueId: string; moduleKey: string }) => Promise<void>;
const enabledHooks = hookList<PluginEnabledHook>('tenancy.pluginEnabled');

/** Runs in the transaction that switched a module on at a venue (onboarding: set up what the module needs). */
export function onPluginEnabled(fn: PluginEnabledHook): void {
  enabledHooks.add(fn);
}

export interface PluginView {
  key: string;
  name: string;
  purpose: string;
  /** plugin = a module the venue switches on; built_in = always on; connection = a service the venue connects. */
  kind: 'plugin' | 'built_in' | 'connection';
  on: boolean;
  canSwitch: boolean;
  /** False when its settings are changed only by a person in the console (the module that governs assistants). */
  assistantMayChange: boolean;
  /** What it needs before it is useful, in plain words. */
  needs: string[];
  settingsApplyTo: 'venue' | 'organisation' | 'none';
  settings: Record<string, unknown>;
  /** The settings described as JSON Schema, generated from the module's own zod schema. */
  settingsSchema: Record<string, unknown>;
  /** For a connection: how it is connected. */
  connectsBy: 'sign_in' | 'access_key' | 'nothing' | null;
  /** For a connection: what it may be allowed to read and write. */
  canBeGranted: string[];
}

const isTestModule = (key: string) => key.startsWith('test_');

function describeSchema(schema: z.ZodType): Record<string, unknown> {
  try {
    const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    return rest;
  } catch {
    // A shape with no JSON Schema form is described as "an object"; the save still validates against the real schema.
    return { type: 'object' };
  }
}

const hasSettings = (schema: z.ZodType) => !(schema instanceof z.ZodObject) || Object.keys(schema.shape).length > 0;

function needsOf(def: ModuleDef<unknown>): string[] {
  const deps = def.dependsOn.map((k) => getModuleDef(k)).filter((d) => !d.spine).map((d) => `${d.name} switched on first`);
  return [...deps, ...(def.needs ?? [])];
}

const CONNECTS: Record<string, { by: PluginView['connectsBy']; need: (name: string) => string }> = {
  oauth: { by: 'sign_in', need: (name) => `The owner signs in at ${name} in a browser and approves the connection.` },
  api_key: { by: 'access_key', need: (name) => `An access key from ${name}, entered by the owner in the console. An assistant never handles it.` },
  none: { by: 'nothing', need: () => 'Nothing: it is connected in the console.' },
};

/** Every module and every plug, as they stand at one venue. Manager at the venue: settings are shown. */
export async function listPlugins(ctx: Ctx, venueId: string): Promise<PluginView[]> {
  requireStaff(ctx, { venueId, minRole: 'manager' });
  const out: PluginView[] = [];
  for (const def of listModuleDefs()) {
    if (isTestModule(def.key)) continue;
    const org = orgSettings.get(def.key);
    if (def.spine) {
      out.push({
        key: def.key,
        name: def.name,
        purpose: def.description,
        kind: 'built_in',
        on: true,
        canSwitch: false,
        assistantMayChange: !!org && def.assistantConfigurable !== false,
        needs: needsOf(def),
        settingsApplyTo: org ? 'organisation' : 'none',
        settings: org ? await org.get(ctx) : {},
        settingsSchema: org ? describeSchema(org.schema) : {},
        connectsBy: null,
        canBeGranted: [],
      });
      continue;
    }
    const state = await getModule(ctx, venueId, def);
    out.push({
      key: def.key,
      name: def.name,
      purpose: def.description,
      kind: 'plugin',
      on: state.enabled,
      canSwitch: true,
      assistantMayChange: def.assistantConfigurable !== false,
      needs: needsOf(def),
      settingsApplyTo: hasSettings(def.configSchema) ? 'venue' : 'none',
      settings: (state.config ?? {}) as Record<string, unknown>,
      settingsSchema: describeSchema(def.configSchema),
      connectsBy: null,
      canBeGranted: [],
    });
  }
  const live = (await listConnections(ctx, { venueId })).filter((c) => c.status === 'connected' || c.status === 'unhealthy');
  for (const plug of listPlugs()) {
    if (plug.simulated && ctx.app.config.env === 'production') continue;
    const how = CONNECTS[plug.auth]!;
    out.push({
      key: plug.key,
      name: plug.name,
      purpose: plug.description,
      kind: 'connection',
      on: live.some((c) => c.plug_key === plug.key),
      canSwitch: false,
      assistantMayChange: false,
      needs: [how.need(plug.name)],
      settingsApplyTo: 'none',
      settings: {},
      settingsSchema: {},
      connectsBy: how.by,
      canBeGranted: plug.scopes,
    });
  }
  return out;
}

const show = (v: unknown) => (v === undefined ? 'not set' : JSON.stringify(v));

/**
 * A settings change checked against the plugin's schema before anything is written. A key the
 * plugin does not have, or a value its schema refuses, is answered with which and why, in
 * words a person can act on. Returns only the keys that would actually change.
 */
function checkedPatch(name: string, schema: z.ZodType, current: Record<string, unknown>, patch: Record<string, unknown> | undefined): { patch: Record<string, unknown>; changes: string[] } {
  const given = Object.fromEntries(Object.entries(patch ?? {}).filter(([, v]) => v !== undefined));
  if (schema instanceof z.ZodObject) {
    const known = Object.keys(schema.shape);
    const unknown = Object.keys(given).filter((k) => !known.includes(k));
    if (unknown.length) {
      throw invalid(`${name} has no setting called ${unknown.map((k) => `"${k}"`).join(', ')}. ${known.length ? `Its settings are: ${known.join(', ')}.` : 'It has no settings.'}`);
    }
  }
  const parsed = schema.safeParse({ ...current, ...given });
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message));
    throw invalid(`Those settings for ${name} are not valid. ${issues.join('; ')}.`, { issues: parsed.error.issues });
  }
  const after = parsed.data as Record<string, unknown>;
  const changed = Object.keys(given).filter((k) => JSON.stringify(current[k]) !== JSON.stringify(after[k]));
  return { patch: Object.fromEntries(changed.map((k) => [k, given[k]])), changes: changed.map((k) => `${k}: ${show(current[k])} to ${show(after[k])}`) };
}

function moduleNamed(key: string): ModuleDef<any> {
  const def = listModuleDefs().find((d) => d.key === key && !isTestModule(d.key));
  if (!def) {
    if (listPlugs().some((p) => p.key === key)) throw invalid('That is a connected service, not a plugin to switch on. It is connected by its owner signing in.');
    throw notFound(`There is no plugin called "${key}".`);
  }
  return def;
}

export const pluginChangeInput = z.object({
  venueId: z.string().uuid(),
  plugin: z.string().trim().min(1).max(60),
  /** Settings to change. Anything left out stays as it is. */
  config: z.record(z.string(), z.unknown()).optional(),
});
export type PluginChangeInput = z.input<typeof pluginChangeInput>;

export interface PluginChange {
  key: string;
  name: string;
  purpose: string;
  /** Whether the plugin is on now, before the change. */
  on: boolean;
  settingsApplyTo: 'venue' | 'organisation';
  /** Each setting that would change, as "key: before to after". */
  changes: string[];
  /** Makes the change. Call inside the same transaction the preview was built in. */
  apply(): Promise<{ on: boolean; settings: Record<string, unknown> }>;
}

/**
 * What switching a plugin on (and/or changing its settings) would do, checked but not done.
 * Manager at the venue, as `setModule` requires. `apply` makes the change.
 */
export async function planPluginChange(ctx: Ctx, raw: PluginChangeInput, want: 'enable' | 'configure' | 'disable'): Promise<PluginChange> {
  const input = pluginChangeInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  const def = moduleNamed(input.plugin);
  // An assistant does not set the rules it is held to, whoever says yes. Taking access away is fine.
  if (ctx.principal.kind === 'agent' && def.assistantConfigurable === false && want !== 'disable') {
    throw forbidden(`${def.name} is set up by a person in the console, not by an assistant.`);
  }

  if (def.spine) {
    const org = orgSettings.get(def.key);
    if (want !== 'configure') throw invalid(`${def.name} is always on: there is nothing to switch ${want === 'enable' ? 'on' : 'off'}.`);
    if (!org) throw invalid(`${def.name} has no settings to change.`);
    const current = await org.get(ctx);
    const { patch, changes } = checkedPatch(def.name, org.schema, current, input.config);
    if (!changes.length) throw invalid(`Nothing would change: ${def.name} already has those settings.`);
    return { key: def.key, name: def.name, purpose: def.description, on: true, settingsApplyTo: 'organisation', changes, apply: async () => ({ on: true, settings: await org.set(ctx, patch) }) };
  }

  const before = (await getModule(ctx, input.venueId, def)) as ModuleState<Record<string, unknown>>;
  const plan = (changes: string[], apply: PluginChange['apply']): PluginChange => ({ key: def.key, name: def.name, purpose: def.description, on: before.enabled, settingsApplyTo: 'venue', changes, apply });

  if (want === 'disable') {
    if (!before.enabled) throw invalid(`${def.name} is already switched off here.`);
    return plan([], async () => {
      const s = await setModule(ctx, def, { venueId: input.venueId, enabled: false });
      return { on: s.enabled, settings: s.config as Record<string, unknown> };
    });
  }

  const { patch, changes } = checkedPatch(def.name, def.configSchema, before.config ?? {}, input.config);
  if (want === 'configure') {
    if (!before.enabled) throw invalid(`${def.name} is switched off here. Switch it on first; its settings can be given at the same time.`);
    if (!changes.length) throw invalid(`Nothing would change: ${def.name} already has those settings.`);
    return plan(changes, async () => {
      const s = await setModule(ctx, def, { venueId: input.venueId, config: patch });
      return { on: s.enabled, settings: s.config as Record<string, unknown> };
    });
  }

  if (before.enabled && !changes.length) throw invalid(`${def.name} is already switched on here.`);
  for (const dep of def.dependsOn) {
    const depDef = getModuleDef(dep);
    if (!depDef.spine && !(await getModule(ctx, input.venueId, depDef)).enabled) throw invalid(`Switch on ${depDef.name} first.`);
  }
  return plan(changes, async () => {
    const s = await setModule(ctx, def, { venueId: input.venueId, enabled: true, config: patch });
    if (!before.enabled) for (const hook of enabledHooks.all()) await hook(ctx, { venueId: input.venueId, moduleKey: def.key });
    return { on: s.enabled, settings: s.config as Record<string, unknown> };
  });
}

/** Switch a plugin on at a venue, optionally with settings. Manager. Runs what the plugin needs set up (onPluginEnabled). */
export async function enablePlugin(ctx: Ctx, raw: PluginChangeInput): Promise<{ on: boolean; settings: Record<string, unknown> }> {
  return (await planPluginChange(ctx, raw, 'enable')).apply();
}

/** Change a plugin's settings. Manager. A venue plugin must be on; a built-in one's settings are the organisation's. */
export async function configurePlugin(ctx: Ctx, raw: PluginChangeInput): Promise<{ on: boolean; settings: Record<string, unknown> }> {
  return (await planPluginChange(ctx, raw, 'configure')).apply();
}

/** Switch a plugin off at a venue. Manager. Its data and settings are kept. */
export async function disablePlugin(ctx: Ctx, raw: PluginChangeInput): Promise<{ on: boolean; settings: Record<string, unknown> }> {
  return (await planPluginChange(ctx, raw, 'disable')).apply();
}
