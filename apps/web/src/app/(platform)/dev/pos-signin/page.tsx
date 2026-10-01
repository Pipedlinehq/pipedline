import { notFound } from 'next/navigation';
import { getPlug } from '@ros/core';
import { requireSim } from '@/lib/dev';
import { simPosSignIn } from '@/lib/ops-dev';
import { Card, PageHeader, buttonClass } from '@/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Simulated sign-in · Restaurant OS', robots: { index: false } };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

/**
 * The simulated provider's sign-in page: where "Connect Square" sends the browser when no real
 * Square application is configured and ROS_SIM_SQUARE_OAUTH is on. It plays the seller's side:
 * which merchant account is signing in, and Allow or Deny. Either answer goes back to the
 * console's real callback route, the way the provider's redirect would.
 *
 * Development only: a 404 unless providers are simulated, the environment is not production
 * and the simulated sign-in is switched on (lib/dev.ts, packages/adapters/src/sim/oauth.ts).
 */
export default async function SimPosSignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireSim();
  const signIn = simPosSignIn();
  const query = await searchParams;
  if (!signIn || one(query.plug) !== signIn.key) notFound();
  const state = one(query.state);
  const scopes = one(query.scope).split(' ').filter(Boolean);
  const name = getPlug(signIn.key).name;
  const control = 'block h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink';

  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <PageHeader title={`Simulated ${name} sign-in`} description={`Development only. This stands in for ${name}'s own sign-in page: nothing here reaches ${name}.`} />
      <Card title="Restaurant OS is asking for access">
        {/* A plain GET form: the answer is a redirect from the "provider", followed by the browser like any other. */}
        <form method="get" action="/dev/pos-signin/decide" className="space-y-4">
          <input type="hidden" name="state" value={state} />
          <div>
            <p className="text-sm font-medium text-ink">It would be allowed to</p>
            <ul className="mt-1 list-disc pl-5 text-sm text-ink-2" data-testid="signin-scopes">
              {scopes.length ? scopes.map((s) => <li key={s}>{s}</li>) : <li>(nothing was asked for)</li>}
            </ul>
          </div>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Merchant account signing in</span>
            <input name="account" defaultValue="simsq-merchant" required pattern="[a-z0-9\-]{3,80}" className={control} />
            <span className="mt-1 block text-xs text-ink-2">Any name. An account nobody has set up gets one location; seed more with POST /api/dev/ops/pos-seed.</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" name="decision" value="allow" className={buttonClass('primary', 'md')}>
              Allow
            </button>
            <button type="submit" name="decision" value="deny" formNoValidate className={buttonClass('secondary', 'md')}>
              Deny
            </button>
          </div>
        </form>
      </Card>
    </main>
  );
}
