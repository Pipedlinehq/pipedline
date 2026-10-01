import { notFound, redirect } from 'next/navigation';
import { auth } from '@ros/modules';
import { app } from '@/lib/runtime';
import { STAFF_COOKIE, readCookie } from '@/lib/cookies';
import { ActionForm, Field, FormMessage, Input, SubmitButton } from '@/ui';
import { requestStartCode, startVenue, verifyStartCode } from './actions';
import { selfServeOpen } from './open';

export const metadata = { title: 'Start a venue · Pipedline' };
export const dynamic = 'force-dynamic';

export default async function StartPage({ searchParams }: { searchParams: Promise<{ email?: string; sent?: string }> }) {
  if (!selfServeOpen()) notFound();
  const { email, sent } = await searchParams;
  const token = await readCookie(STAFF_COOKIE);
  const session = await auth.resolveSession(app(), token);
  const signedIn = session?.kind === 'staff' && session.userId ? session.userId : null;
  if (signedIn && (await auth.membershipsOf(app(), signedIn)).length) redirect(session?.orgId ? '/console' : '/login/choose');

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Start a venue</h1>
      {signedIn ? (
        <>
          <p className="mt-1 text-sm text-ink-2">It starts as a draft. Nothing is public until you take it live.</p>
          <ActionForm action={startVenue} className="mt-8 space-y-4">
            <Field label="Venue name">
              <Input name="venueName" maxLength={200} required autoFocus />
            </Field>
            <Field label="Time zone">
              <Input name="timezone" defaultValue="Australia/Sydney" required />
            </Field>
            <SubmitButton pendingLabel="Setting up…">Start</SubmitButton>
          </ActionForm>
        </>
      ) : sent && email ? (
        <ActionForm action={verifyStartCode} className="mt-8 space-y-4">
          <FormMessage tone="info">A 6-digit code is on its way to {email}. It lasts 10 minutes.</FormMessage>
          <input type="hidden" name="email" value={email} />
          <Field label="Code">
            <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required autoFocus />
          </Field>
          <div className="flex items-center justify-between">
            <SubmitButton pendingLabel="Checking…">Continue</SubmitButton>
            <a href="/start" className="text-sm text-accent underline-offset-2 hover:underline">
              Use a different email
            </a>
          </div>
        </ActionForm>
      ) : (
        <>
          <p className="mt-1 text-sm text-ink-2">There is no password. We email you a code.</p>
          <ActionForm action={requestStartCode} className="mt-8 space-y-4">
            <Field label="Email">
              <Input name="email" type="email" autoComplete="email" required autoFocus defaultValue={email ?? ''} />
            </Field>
            <SubmitButton pendingLabel="Sending…">Email me a code</SubmitButton>
          </ActionForm>
          <p className="mt-6 text-sm text-ink-2">
            Already have a venue?{' '}
            <a href="/login" className="text-accent underline-offset-2 hover:underline">
              Sign in
            </a>
          </p>
        </>
      )}
    </main>
  );
}
