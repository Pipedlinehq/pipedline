import { z } from 'zod';
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

/** Where a plugin sits in the catalogue people see (docs/CONSOLE_IA.md sections 4 and 6). */
export const MANIFEST_CATEGORIES = ['channels', 'selling', 'guests', 'marketing', 'insight', 'setup', 'integration'] as const;
export type ManifestCategory = (typeof MANIFEST_CATEGORIES)[number];

/**
 * What kind of thing a catalogue entry is. A `channel` is a module guests meet (the website, the
 * QR menu, ordering, delivery, bookings, the guest assistant connection) and gets a card under
 * Channels as well as Plugins. A `module` is anything else inside the engine. A `plug` is a
 * service somebody else runs, connected by the venue; it comes from `definePlug`, so a module
 * manifest may not claim it.
 */
export const CATALOGUE_KINDS = ['channel', 'module', 'plug'] as const;
export type CatalogueKind = (typeof CATALOGUE_KINDS)[number];

const plain = z.string().trim().min(1);

/**
 * The words of a module's manifest, as a zod schema so `defineModule` can refuse an empty one and
 * the gate (`scripts/check-manifests.ts`) can read it. Everything is written for a venue owner:
 * covers, service, docket, till, front of house. Never "SKU", "merchant", "fulfilment",
 * "inventory" (the gate fails on them).
 */
export const moduleManifestWords = z.object({
  /** Shown to people. The same words as the module's `name`, so a card and a confirmation question agree. */
  name: plain.max(60),
  /** One line: what the venue gets from it. */
  purpose: plain.max(400),
  category: z.enum(MANIFEST_CATEGORIES),
  kind: z.enum(['channel', 'module']),
  /**
   * What a venue must have or do before the module is useful, in plain words ("a payment account
   * connected"). Modules it depends on are added to it where plugins are listed. A module that
   * needs nothing says so ("Nothing to connect.").
   */
  needs: z.array(plain.max(240)).min(1),
  /** The data it reads, in plain words ("the menu", "guest records"). */
  reads: z.array(plain.max(160)).min(1),
  /** The data it writes, in plain words ("bookings", "messages"). */
  writes: z.array(plain.max(160)).min(1),
  /** What it means for guests' consent, when it touches guests at all. */
  consent: plain.max(400).optional(),
});
export type ModuleManifestWords = z.infer<typeof moduleManifestWords>;

/** What a channel's `publicAddress` is built from. */
export interface PublicAddressing {
  /** Where the platform answers (the console, the hub, the guest endpoint), e.g. https://app.pipedline.com. */
  platformOrigin: string;
  /** Where the venue's own site answers (its verified primary host), or null: no venue, or no host yet. */
  siteOrigin: string | null;
  /** The venue the catalogue is built for; null in the public catalogue. */
  venue: { id: string; slug: string; name: string } | null;
}

export interface ModuleManifest extends ModuleManifestWords {
  /**
   * For a channel: the address guests use, from the venue's site origin or the platform's, or
   * null when there is none yet. Called with no venue for the public catalogue, where only a
   * fixed address (the guest endpoint) can be given. A path with a part that differs per code or
   * table is written with that part in angle brackets, e.g. `/q/<code>`.
   */
  publicAddress?: (at: PublicAddressing) => string | null;
}

export interface ModuleDef<C = unknown> {
  key: string;
  name: string;
  description: string;
  /** Spine modules are always on and have no venue_modules row. */
  spine?: boolean;
  dependsOn: string[];
  /**
   * The manifest: what the public catalogue (`/plugins.json`, `/llms.txt`), the console's
   * Channels and Plugins pages and the assistant's `plugins_list` show about this module. In
   * plain words for a venue owner. Required; `pnpm check:manifests` reads it.
   */
  manifest: ModuleManifest;
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

/** The manifest's words checked against their schema; the issues, in words, when they fail. */
export function checkManifest(def: Pick<ModuleDef<unknown>, 'key' | 'name' | 'manifest'>): string[] {
  const { publicAddress: _fn, ...words } = (def.manifest ?? {}) as ModuleManifest;
  const parsed = moduleManifestWords.safeParse(words);
  const issues = parsed.success ? [] : parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message));
  if (parsed.success && parsed.data.name !== def.name) issues.push(`name: the manifest says "${parsed.data.name}" but the module is named "${def.name}"`);
  return issues;
}

export function defineModule<C>(def: ModuleDef<C>): ModuleDef<C> {
  const issues = checkManifest(def);
  if (issues.length) throw new Error(`Module ${def.key} has no usable manifest: ${issues.join('; ')}`);
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
