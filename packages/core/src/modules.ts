import type { z } from 'zod';
import type { Ctx } from './app';
import { AppError, invalid } from './errors';
import { requireStaff } from './authz';
import { audit } from './audit';
import { json } from './json';
import { keyedRegistry, register } from './registry';

/**
 * The module catalogue. Every toggleable module registers itself here with a versioned config
 * schema; `venue_modules` holds which are on for a venue and with what config.
 * docs/MODULES.md (module contract) · docs/ARCHITECTURE.md section 4.
 */
export interface ModuleDef<C = unknown> {
  key: string;
  name: string;
  description: string;
  /** Spine modules are always on and have no venue_modules row. */
  spine?: boolean;
  dependsOn: string[];
  /**
   * What a venue must have or do before the module is useful, in plain words ("a payment
   * account connected"). Shown where plugins are listed; modules it depends on are added to it.
   */
  needs?: string[];
  /**
   * False for a module that governs what assistants may do (the hub). Its settings are then
   * changed only by a person in the console: an assistant never widens its own access, even
   * with a yes. Switching such a module off is still allowed, since that only takes access away.
   */
  assistantConfigurable?: boolean;
  /** Tables this module owns. No other non-spine module may read or write them directly. */
  tables: string[];
  configSchema: z.ZodType<C>;
  configVersion: number;
  defaultConfig: C;
  /** Upgrades a stored config from the version before `configVersion`. */
  migrateConfig?: (stored: unknown, fromVersion: number) => unknown;
}

const registry = keyedRegistry<ModuleDef<any>>('modules');

export function defineModule<C>(def: ModuleDef<C>): ModuleDef<C> {
  return register(registry, def.key, def, 'Module');
}

export function getModuleDef(key: string): ModuleDef<any> {
  const def = registry.get(key);
  if (!def) throw new Error(`Unknown module: ${key}`);
  return def;
}

export function listModuleDefs(): ModuleDef<any>[] {
  return [...registry.values()];
}

/** Which table belongs to which module, for the boundary check in scripts/check-module-boundaries.ts. */
export function tableOwners(): Map<string, string> {
  const owners = new Map<string, string>();
  for (const def of registry.values()) for (const t of def.tables) owners.set(t, def.key);
  return owners;
}

export interface ModuleState<C> {
  enabled: boolean;
  config: C;
}

/** The module's state at a venue. A module that was never switched on reads as disabled with default config. */
export async function getModule<C>(ctx: Ctx, venueId: string, def: ModuleDef<C>): Promise<ModuleState<C>> {
  if (def.spine) return { enabled: true, config: def.defaultConfig };
  const row = await ctx.db
    .selectFrom('venue_modules')
    .select(['enabled', 'config', 'config_version'])
    .where('venue_id', '=', venueId)
    .where('module_key', '=', def.key)
    .executeTakeFirst();
  if (!row) return { enabled: false, config: def.defaultConfig };
  let stored: unknown = row.config;
  if (row.config_version < def.configVersion && def.migrateConfig) {
    stored = def.migrateConfig(stored, row.config_version);
  }
  const parsed = def.configSchema.safeParse(stored);
  // A stored config that no longer parses falls back to defaults rather than taking the venue down.
  return { enabled: row.enabled, config: parsed.success ? parsed.data : def.defaultConfig };
}

/**
 * Guards every route, server action and tool that belongs to a module. A disabled module
 * answers as not-found: its surfaces are hidden, its data is untouched.
 */
export async function assertModule<C>(ctx: Ctx, venueId: string, def: ModuleDef<C>): Promise<C> {
  const state = await getModule(ctx, venueId, def);
  if (!state.enabled) throw new AppError('module_disabled', 'That is not available at this venue.');
  for (const dep of def.dependsOn) {
    const depDef = getModuleDef(dep);
    if (depDef.spine) continue;
    const depState = await getModule(ctx, venueId, depDef);
    if (!depState.enabled) throw new AppError('module_disabled', 'That is not available at this venue.');
  }
  return state.config;
}

export interface SetModuleInput<C> {
  venueId: string;
  enabled?: boolean;
  /** A partial config is merged over what is stored, then validated as a whole. */
  config?: Partial<C>;
}

export async function setModule<C>(ctx: Ctx, def: ModuleDef<C>, input: SetModuleInput<C>): Promise<ModuleState<C>> {
  if (def.spine) throw invalid('Spine modules cannot be switched off or on.');
  requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  const before = await getModule(ctx, input.venueId, def);
  const merged = { ...(before.config as object), ...((input.config ?? {}) as object) };
  const parsed = def.configSchema.safeParse(merged);
  if (!parsed.success) throw invalid('That setting is not valid.', { issues: parsed.error.issues });
  const enabled = input.enabled ?? before.enabled;

  if (enabled) {
    for (const dep of def.dependsOn) {
      const depDef = getModuleDef(dep);
      if (depDef.spine) continue;
      const depState = await getModule(ctx, input.venueId, depDef);
      if (!depState.enabled) throw invalid(`Switch on ${depDef.name} first.`);
    }
  }

  await ctx.db
    .insertInto('venue_modules')
    .values({
      org_id: ctx.orgId,
      venue_id: input.venueId,
      module_key: def.key,
      enabled,
      config: json(parsed.data),
      config_version: def.configVersion,
      enabled_at: enabled ? ctx.now() : null,
    })
    .onConflict((oc) =>
      oc.columns(['venue_id', 'module_key']).doUpdateSet({
        enabled,
        config: json(parsed.data),
        config_version: def.configVersion,
        ...(enabled && !before.enabled ? { enabled_at: ctx.now() } : {}),
      }),
    )
    .execute();

  await audit(ctx, {
    action: 'module.set',
    entityType: 'venue_module',
    entityId: `${input.venueId}:${def.key}`,
    venueId: input.venueId,
    before,
    after: { enabled, config: parsed.data },
  });
  return { enabled, config: parsed.data };
}
