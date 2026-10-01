import { type App, listPlugs, listTools } from '@ros/core';
import type { HubConfig } from './module';

/**
 * What a key may do. A scope is the OUTER gate: a tool is offered only to a key holding its
 * scope, and the service function behind the tool still runs its own role and module checks.
 * The inner gate is never weakened (docs/modules/hub.md section 2).
 *
 * Scopes are not a fixed list: each tool names its own (`sales:read`, `venue:write` …), and a
 * connected plug contributes `plug:<key>:read` and `plug:<key>:write`.
 */

/** Per-campaign outcome totals, pulled by a service such as Criota with a key holding only this. */
export const OUTCOMES_SCOPE = 'outcomes:read';

/** Scopes a key may hold whether or not a tool with the scope is registered yet. */
const STANDING_SCOPES = [OUTCOMES_SCOPE];

export function plugScope(plugKey: string, effect: 'read' | 'write'): string {
  return `plug:${plugKey}:${effect}`;
}

/** A scope is a read scope when it ends in `:read`; anything else can change something. */
export function isReadScope(scope: string): boolean {
  return scope.endsWith(':read');
}

/** Guest-level scopes are gated by their own switch (docs/modules/hub.md section 3). */
export function isGuestLevelScope(scope: string): boolean {
  return scope.startsWith('guests:');
}

function mcpPlugs(app: App) {
  return listPlugs().filter((p) => p.kind === 'mcp' && !(p.simulated && app.config.env === 'production'));
}

/** Every scope a key could be given in this process. */
export function knownScopes(app: App): string[] {
  const scopes = new Set<string>(STANDING_SCOPES);
  for (const t of listTools()) scopes.add(t.scope);
  for (const p of mcpPlugs(app)) {
    scopes.add(plugScope(p.key, 'read'));
    scopes.add(plugScope(p.key, 'write'));
  }
  return [...scopes].sort();
}

export interface ScopeInfo {
  scope: string;
  effect: 'read' | 'write';
  /** The tools the scope unlocks, for the form that creates a key. */
  tools: Array<{ name: string; title: string; effect: 'read' | 'write' }>;
  /** Set when the scope belongs to a connected service rather than the venue's own data. */
  plug?: string;
  guestLevel: boolean;
}

/** The scopes with what each unlocks, for the console's key form. */
export function describeScopes(app: App): ScopeInfo[] {
  const tools = listTools();
  const plugByScope = new Map<string, string>();
  for (const p of mcpPlugs(app)) {
    plugByScope.set(plugScope(p.key, 'read'), p.name);
    plugByScope.set(plugScope(p.key, 'write'), p.name);
  }
  return knownScopes(app).map((scope) => ({
    scope,
    effect: isReadScope(scope) ? 'read' : 'write',
    tools: tools.filter((t) => t.scope === scope).map((t) => ({ name: t.name, title: t.title, effect: t.effect })),
    ...(plugByScope.has(scope) ? { plug: plugByScope.get(scope)! } : {}),
    guestLevel: isGuestLevelScope(scope),
  }));
}

function matches(pattern: string, scope: string): boolean {
  if (pattern === '*' || pattern === scope) return true;
  if (pattern.endsWith(':*')) return scope.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith('*:')) return scope.endsWith(pattern.slice(1));
  return false;
}

/** Whether one venue's settings allow a scope to be used there. */
export function scopeAllowed(scope: string, config: Pick<HubConfig, 'allowed_scopes' | 'guest_level_reads_enabled'>): boolean {
  if (isGuestLevelScope(scope) && !config.guest_level_reads_enabled) return false;
  return config.allowed_scopes.some((p) => matches(p, scope));
}
