import 'server-only';
import { cookies } from 'next/headers';

/**
 * Cookie names. Every cookie is host-only (no Domain attribute): a venue's site can neither
 * read nor set the console's session, and the console lives on a different registrable domain
 * (docs/THREAT_MODEL.md section 6).
 */
export const STAFF_COOKIE = 'ros_staff';
export const PLATFORM_COOKIE = 'ros_platform';
export const GUEST_COOKIE = 'ros_guest';
export const DEVICE_COOKIE = 'ros_device';
/** The visitor session id for first-party analytics. Not a login; readable by the page's own script. */
export const VISITOR_COOKIE = 'ros_vs';

const secure = process.env.NODE_ENV === 'production' && process.env.ROS_SCHEME !== 'http';

export async function setSessionCookie(name: string, token: string, maxAgeDays: number): Promise<void> {
  (await cookies()).set(name, token, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: maxAgeDays * 86_400 });
}

export async function clearCookie(name: string): Promise<void> {
  (await cookies()).delete(name);
}

export async function readCookie(name: string): Promise<string | null> {
  return (await cookies()).get(name)?.value ?? null;
}
