import 'server-only';
import { cache } from 'react';
import { AppError, type Ctx, type DevicePrincipal } from '@ros/core';
import { auth } from '@ros/modules';
import { clientIp } from './http';
import { app } from './runtime';
import { DEVICE_COOKIE, readCookie } from './cookies';

/**
 * A paired kitchen or counter screen (docs/THREAT_MODEL.md section 3: low trust, one venue).
 * The screen holds a long-lived token in an httpOnly cookie; every request re-checks it against
 * the devices table, so a screen revoked in the console is refused on its next poll.
 */
export interface DeviceSession {
  orgId: string;
  principal: DevicePrincipal;
}

/** How long the pairing cookie lives. The token itself lives until the screen is revoked or re-paired. */
export const DEVICE_COOKIE_DAYS = 400;

export const getDeviceSession = cache(async (): Promise<DeviceSession | null> => {
  const token = await readCookie(DEVICE_COOKIE);
  const who = await auth.authenticateDevice(app(), token);
  return who ? { orgId: who.orgId, principal: who.principal } : null;
});

/** Run a service function as the paired screen, inside its org. 401 when the screen is not (or no longer) paired. */
export async function asDevice<T>(req: Request, fn: (ctx: Ctx, session: DeviceSession) => Promise<T>): Promise<T> {
  const session = await getDeviceSession();
  if (!session) throw new AppError('unauthenticated', 'This screen is not paired. Pair it again with a code from the console.');
  return app().tenant(session.orgId, session.principal, (ctx) => fn(ctx, session), { ip: clientIp(req) });
}
