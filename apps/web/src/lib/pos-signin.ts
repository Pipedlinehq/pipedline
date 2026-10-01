import 'server-only';
import { type PlugDef, listPlugs } from '@ros/core';
import { ledger } from '@ros/modules';
import { app } from './runtime';

/**
 * Connecting a point of sale by signing in at the provider (Square), as the console drives it.
 * The service functions are in packages/modules/src/ledger/pos-oauth.ts; this file only holds
 * what the screens share: where things live, and what "read-only" means for each plug.
 */
export const CONNECTIONS_PATH = '/console/settings/connections';

/**
 * Where the provider sends the person back. A fixed URL per plug, because it is registered at
 * the provider as the Redirect URL (docs/GOING_LIVE.md): for Square,
 * `<scheme>://<ROS_PLATFORM_HOST>/console/connections/square/callback`.
 */
export const posSignInCallbackPath = (plugKey: string) => `/console/connections/${plugKey}/callback`;

/** The points of sale connected by sign-in that this deployment may offer. */
export function signInPosPlugs(): PlugDef[] {
  const production = app().config.env === 'production';
  return listPlugs().filter((p) => p.adapters.pos && p.auth === 'oauth' && !(p.simulated && production));
}

export function signInPosPlug(key: string): PlugDef | null {
  return signInPosPlugs().find((p) => p.key === key) ?? null;
}

/** Whether this deployment holds the provider's application credentials (or a simulated provider stands in). */
export function signInConfigured(plugKey: string): boolean {
  return app().adapters.has('oauth', plugKey);
}

export type PosAccess = 'read' | 'write';

/** What each level of access asks the provider for. A plug not listed is asked for everything it may be granted. */
const ACCESS: Record<string, Record<PosAccess, string[]>> = {
  square: { read: ledger.SQUARE_READ_SCOPES, write: [...ledger.SQUARE_READ_SCOPES, ...ledger.SQUARE_WRITE_SCOPES] },
};

/** The scopes to ask for. Anything but an explicit "write" is read-only: the least that makes sales arrive. */
export function scopesFor(plugKey: string, access: string): string[] | undefined {
  const levels = ACCESS[plugKey];
  if (!levels) return undefined;
  return access === 'write' ? levels.write : levels.read;
}

/** Which level a connection was given, from the scopes it holds. */
export function accessOf(plugKey: string, scopes: string[]): PosAccess | null {
  const levels = ACCESS[plugKey];
  if (!levels) return null;
  return levels.write.every((s) => scopes.includes(s)) ? 'write' : 'read';
}
