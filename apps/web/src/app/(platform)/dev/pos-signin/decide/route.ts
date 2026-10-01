import { NextResponse } from 'next/server';
import { route } from '@/lib/http';
import * as dev from '@/lib/ops-dev';

export const dynamic = 'force-dynamic';

/**
 * The simulated provider answering its own sign-in page (/dev/pos-signin): a redirect back to
 * the console's callback route with a code (Allow) or an error (Deny), as a real provider's
 * would be. Development only: a 404 unless a simulated sign-in is switched on.
 */
export const GET = async (req: Request): Promise<Response> => {
  // Checked before route(): next/navigation's notFound() is not an AppError, and route() would answer it as a 500.
  if (!dev.simPosSignIn()) return new Response('Not found', { status: 404 });
  return route(async (r: Request) => {
    const q = new URL(r.url).searchParams;
    const { redirectTo } = await dev.decidePosSignIn({ state: q.get('state') ?? '', decision: q.get('decision') === 'allow' ? 'allow' : 'deny', account: q.get('account') ?? undefined });
    return NextResponse.redirect(redirectTo, 302);
  })(req);
};
