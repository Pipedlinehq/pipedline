import { z } from 'zod';
import { AppError, ROLE_RANK, type StaffRole, type ToolDef, getModuleDef, listTools, notFound } from '@ros/core';
import type { KeyVenue, ResolvedAgentKey } from './keys';
import { scopeAllowed } from './scopes';

/**
 * Which of the declared tools one key is offered (docs/modules/hub.md section 2). A tool is
 * offered only when ALL of these hold at one venue the key can see, at least:
 *   - the key holds the tool's scope, and the venue's settings allow that scope;
 *   - the staff member's role there meets the tool's `minRole`;
 *   - the tool's module is switched on there (a disabled module's tools are not offered);
 *   - if it CHANGES something: the key was allowed to make changes AND the assistant has said
 *     it can put a question to its person. One that cannot is not offered a single write.
 *
 * This is the outer gate. The service function the tool is pinned to runs its own role and
 * module checks inside the tenant transaction, exactly as it does for the console.
 */
export interface OfferedTool {
  tool: ToolDef;
  /** The venues where this key may use the tool. */
  venues: KeyVenue[];
  /** True when the tool takes a `venue` argument: it acts on one venue and the key sees several. */
  takesVenue: boolean;
  /** What is published and validated: the tool's own input, plus `venue` when it takes one. */
  input: z.ZodObject;
}

function moduleOnAt(venue: KeyVenue, moduleKey: string): boolean {
  try {
    return getModuleDef(moduleKey).spine === true || venue.modulesOn.includes(moduleKey);
  } catch {
    // A tool naming a module that is not in the catalogue is offered nowhere.
    return false;
  }
}

/** Whether one venue lets this key use this tool. */
function usableAt(tool: ToolDef, venue: KeyVenue): boolean {
  return scopeAllowed(tool.scope, venue.config) && ROLE_RANK[venue.role] >= ROLE_RANK[tool.minRole ?? 'read_only'] && moduleOnAt(venue, tool.module);
}

const venueChoices = (venues: KeyVenue[]) => venues.map((v) => `"${v.slug}" (${v.name})`).join(', ');

export function offeredTools(caller: ResolvedAgentKey, opts: { canAsk: boolean }): OfferedTool[] {
  const held = new Set(caller.principal.scopes);
  const out: OfferedTool[] = [];
  for (const tool of listTools()) {
    if (!held.has(tool.scope)) continue;
    // A write is offered only where the person allowed changes and can be asked.
    if (tool.effect === 'write' && !(caller.principal.canWrite && opts.canAsk)) continue;
    // A write that cannot say what it would do is not offered; nor is a read bound as a change.
    if ((tool.effect === 'write') !== (typeof (tool as { propose?: unknown }).propose === 'function')) continue;
    if (!(tool.input instanceof z.ZodObject) || !(tool.output instanceof z.ZodObject)) continue;
    const venues = caller.venues.filter((v) => usableAt(tool, v));
    if (!venues.length) continue;
    const takesVenue = tool.venueScoped === true && caller.venues.length > 1;
    const input = takesVenue
      ? tool.input.extend({ venue: z.string().trim().min(1).max(120).describe(`Which venue, by its short name or its name. One of: ${venueChoices(venues)}.`) })
      : tool.input;
    out.push({ tool, venues, takesVenue, input });
  }
  return out;
}

/**
 * The venue a call acts on. Chosen only among venues the key can already see: a venue of
 * another organisation, or one this person has no role at, is not found, by any name.
 */
export function resolveVenue(caller: ResolvedAgentKey, offered: OfferedTool, venueArg: unknown): KeyVenue | null {
  if (!offered.tool.venueScoped) return null;
  let venue: KeyVenue | undefined;
  if (!offered.takesVenue) {
    venue = caller.venues[0];
  } else {
    const wanted = typeof venueArg === 'string' ? venueArg.trim().toLowerCase() : '';
    venue = caller.venues.find((v) => v.slug.toLowerCase() === wanted) ?? caller.venues.find((v) => v.name.toLowerCase() === wanted);
    if (!venue) throw notFound(`Venue not found. Choose one of: ${venueChoices(offered.venues)}.`);
  }
  if (!venue || !offered.venues.some((v) => v.id === venue.id)) throw new AppError('module_disabled', 'That is not available at this venue.');
  return venue;
}

/**
 * The caller as one tool may act: its venues held to those where THIS tool is usable (the key's
 * scope is allowed there, the person's role meets the tool's, the tool's module is on). A tool
 * that chooses its own venue, or covers "every venue this key can see", then cannot reach a
 * venue where the hub's gates say no: that venue is simply not among the person's roles for the
 * call, so the service function answers it as not found. Ownership of the whole organisation
 * survives only when nothing was taken away.
 */
export function narrowTo(caller: ResolvedAgentKey, venues: KeyVenue[]): ResolvedAgentKey {
  if (venues.length === caller.venues.length) return caller;
  const venueRoles: Record<string, StaffRole> = {};
  for (const v of venues) venueRoles[v.id] = v.role;
  const staff = { ...caller.principal.staff, isOwner: false, venueRoles };
  return { ...caller, venues, principal: { ...caller.principal, staff, venueIds: venues.map((v) => v.id) } };
}
