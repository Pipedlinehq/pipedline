import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { type Ctx, type PlatformPrincipal, isAppError } from '@ros/core';
import { onboarding } from '@ros/modules';
import { app } from './runtime';
import { getPlatformSession } from './staff';

/**
 * The platform admin area (docs/THREAT_MODEL.md sections 3 and 9). Pages run as the platform
 * principal from getPlatformSession(); onboarding and health functions check it against
 * platform_admins on every call. Acting inside a tenant happens only through an open support
 * access and onboarding.supportPrincipal, which refuses unless that admin has one open there.
 */

/** The admin's own open support accesses, so every platform page can show the banner. Not a credential: each is re-checked with supportPrincipal. */
export const SUPPORT_COOKIE = 'ros_platform_support';

export interface OpenSupport {
  accessId: string;
  orgId: string;
  orgName: string;
  reason: string;
}

const supportList = z.array(z.object({ accessId: z.string().uuid(), orgId: z.string().uuid(), orgName: z.string().max(200), reason: z.string().max(500) })).max(20);

export async function platformActor(): Promise<PlatformPrincipal> {
  return (await getPlatformSession()).principal as PlatformPrincipal;
}

/** Who the signed-in admin is, in words, for "reviewed by". platform_admins and users are platform tables. */
export const platformAdminName = cache(async (): Promise<string> => {
  const actor = await platformActor();
  const u = actor.adminUserId ? await app().db.selectFrom('users').select(['email', 'name']).where('id', '=', actor.adminUserId).executeTakeFirst() : undefined;
  return u?.email ?? 'platform admin';
});

async function readSupportCookie(): Promise<OpenSupport[]> {
  const raw = (await cookies()).get(SUPPORT_COOKIE)?.value;
  if (!raw) return [];
  try {
    const list = supportList.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return list.success ? list.data : [];
  } catch {
    return [];
  }
}

export async function writeSupportCookie(list: OpenSupport[]): Promise<void> {
  const jar = await cookies();
  if (!list.length) {
    jar.delete(SUPPORT_COOKIE);
    return;
  }
  const secure = process.env.NODE_ENV === 'production' && process.env.ROS_SCHEME !== 'http';
  jar.set(SUPPORT_COOKIE, Buffer.from(JSON.stringify(list)).toString('base64url'), { httpOnly: true, secure, sameSite: 'lax', path: '/platform', maxAge: 86_400 });
}

/** The support accesses this admin has open, each confirmed against the record. */
export const openSupportAccesses = cache(async (): Promise<OpenSupport[]> => {
  const actor = await platformActor();
  const out: OpenSupport[] = [];
  for (const s of await readSupportCookie()) {
    try {
      await onboarding.supportPrincipal(app(), actor, { orgId: s.orgId });
      out.push(s);
    } catch (e) {
      if (!isAppError(e)) throw e;
    }
  }
  return out;
});

export async function rememberSupport(s: OpenSupport): Promise<void> {
  const list = (await readSupportCookie()).filter((x) => x.orgId !== s.orgId);
  await writeSupportCookie([...list, s]);
}

export async function forgetSupport(accessId: string): Promise<void> {
  await writeSupportCookie((await readSupportCookie()).filter((x) => x.accessId !== accessId));
}

/**
 * Run a service function inside an org as this admin's support principal. Refused by
 * onboarding.supportPrincipal unless support access is open there, with its reason on record.
 */
export async function asSupport<T>(orgId: string, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const principal = await onboarding.supportPrincipal(app(), await platformActor(), { orgId });
  return app().tenant(orgId, principal, fn);
}
