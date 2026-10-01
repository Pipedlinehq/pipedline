import { NextResponse, type NextRequest } from 'next/server';

/**
 * Host routing (docs/ARCHITECTURE.md section 2). The platform host serves the console, the
 * hub and webhooks. Every other host is a venue's site and is rewritten, invisibly, to
 * /sites/<host>/…, where the host is resolved to an org from the domains table.
 *
 * Tenancy is never derived from a path the visitor can type: /sites/… is refused from outside.
 * No database work happens here; this only decides which half of the app a request belongs to.
 */
const PLATFORM_HOST = (process.env.ROS_PLATFORM_HOST ?? 'localhost:3000').toLowerCase();
const IS_PRODUCTION = process.env.NODE_ENV === 'production' && process.env.ROS_ENV !== 'development';

function requestHost(req: NextRequest): string {
  // Tests and local tools may name the tenant host explicitly; never honoured in production.
  if (!IS_PRODUCTION) {
    const override = req.headers.get('x-ros-host');
    if (override) return override.toLowerCase();
  }
  return (req.headers.get('host') ?? '').toLowerCase();
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/sites' || pathname.startsWith('/sites/')) {
    return new NextResponse('Not found', { status: 404 });
  }
  const host = requestHost(req);
  if (host === PLATFORM_HOST || host === '') {
    // Tell server code which page was asked for, so sign-in can return the person to it.
    const headers = new Headers(req.headers);
    headers.set('x-ros-path', pathname + req.nextUrl.search);
    return NextResponse.next({ request: { headers } });
  }

  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) return new NextResponse('Not found', { status: 404 });
  const url = req.nextUrl.clone();
  url.pathname = `/sites/${host.replace(/:\d+$/, '')}${pathname === '/' ? '' : pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
