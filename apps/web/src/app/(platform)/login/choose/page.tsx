import { redirect } from 'next/navigation';
import { auth } from '@ros/modules';
import { app } from '@/lib/runtime';
import { STAFF_COOKIE, readCookie } from '@/lib/cookies';
import { Button } from '@/ui';
import { chooseOrg } from '../actions';

export const metadata = { title: 'Choose a business · Restaurant OS' };

export default async function ChooseOrgPage() {
  const token = await readCookie(STAFF_COOKIE);
  const session = await auth.resolveSession(app(), token);
  if (!session?.userId || session.kind !== 'staff') redirect('/login');
  const memberships = await auth.membershipsOf(app(), session.userId);
  if (!memberships.length) redirect('/login');
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Which business?</h1>
      <p className="mt-1 text-sm text-ink-2">You work with more than one. You can switch later.</p>
      <ul className="mt-8 space-y-2">
        {memberships.map((m) => (
          <li key={m.orgId}>
            <form action={chooseOrg}>
              <input type="hidden" name="orgId" value={m.orgId} />
              <Button type="submit" variant="secondary" className="w-full justify-between">
                <span>{m.orgName}</span>
                <span className="text-ink-3">{m.isOwner ? 'Owner' : 'Team'}</span>
              </Button>
            </form>
          </li>
        ))}
      </ul>
    </main>
  );
}
