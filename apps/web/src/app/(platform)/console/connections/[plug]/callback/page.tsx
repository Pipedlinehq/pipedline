import { notFound, redirect } from 'next/navigation';
import { ledger } from '@ros/modules';
import { runAction } from '@/lib/actions';
import { CONNECTIONS_PATH, signInPosPlug } from '@/lib/pos-signin';
import { app } from '@/lib/runtime';
import { getStaffSession } from '@/lib/staff';
import { PosLocationChooser } from '@/components/console/pos-signin';
import { ReadError } from '@/components/console/states';
import { Card, LinkButton, PageHeader } from '@/ui';
import { choosePosLocation, leavePosSignIn } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Connecting a point of sale · Restaurant OS', robots: { index: false } };

type Query = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || null;

/**
 * Where the provider sends the person back after its sign-in page. This URL is registered at
 * the provider as the Redirect URL (for Square: /console/connections/square/callback on the
 * platform host), so it never moves.
 *
 * The query carries `state` and either `code` or `error`, exactly as the provider wrote them.
 * Who is asking, and for which org, comes from the signed-in session only. A person who is
 * signed out is sent to sign in and returned here with the query intact (lib/staff.ts).
 *
 * Reaching this page completes the sign-in: the service checks the state, exchanges the code
 * and connects. A code works once, so loading the page a second time is answered by the
 * service as an expired sign-in, and nothing is connected twice.
 */
export default async function PosSignInCallback({ params, searchParams }: { params: Promise<{ plug: string }>; searchParams: Promise<Query> }) {
  const [{ plug: plugKey }, query] = await Promise.all([params, searchParams]);
  const plug = signInPosPlug(plugKey);
  if (!plug) notFound();
  const session = await getStaffSession();

  const r = await runAction(() =>
    ledger.completePosOAuth(app(), { orgId: session.orgId, principal: session.principal, state: one(query.state) ?? '', code: one(query.code), error: one(query.error) }),
  );

  const back = <LinkButton href={CONNECTIONS_PATH}>Back to connected services</LinkButton>;

  if (!r.ok) {
    return (
      <>
        <PageHeader title={`${plug.name} was not connected`} />
        <Card>
          <div className="space-y-4" data-testid="signin-refused">
            <ReadError message={r.error} />
            <p className="text-sm text-ink-2">Nothing was connected and nothing was changed.</p>
            {back}
          </div>
        </Card>
      </>
    );
  }

  const outcome = r.data;
  if (outcome.status === 'connected') return redirect(`${CONNECTIONS_PATH}?connected=${encodeURIComponent(outcome.connection.plugKey)}`);

  if (outcome.status === 'declined') {
    return (
      <>
        <PageHeader title={`${plug.name} was not connected`} />
        <Card>
          <div className="space-y-4" data-testid="signin-declined">
            <p className="text-sm text-ink">
              You pressed Deny at {plug.name}, so nothing was connected. We have no access to your {plug.name} account and no sales will arrive from it.
            </p>
            <p className="text-sm text-ink-2">If that was not what you meant, start again from Connected services and press Allow.</p>
            {back}
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title={`Which ${plug.name} location?`} description={`That ${plug.name} account has more than one location. Choose the one whose sales belong to the venue you are connecting. Nothing is connected until you choose.`} />
      <Card>
        <PosLocationChooser plugKey={plug.key} plugName={plug.name} pending={outcome.pending} locations={outcome.locations.map((l) => ({ ref: l.ref, name: l.name }))} choose={choosePosLocation} leave={leavePosSignIn} />
      </Card>
    </>
  );
}
