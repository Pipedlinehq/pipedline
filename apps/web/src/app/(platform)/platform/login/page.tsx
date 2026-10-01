import { ActionForm, Field, FormMessage, Input, SubmitButton } from '@/ui';
import { requestPlatformCode, verifyPlatformCode } from './actions';

export const metadata = { title: 'Platform sign in · Pipedline' };

export default async function PlatformLoginPage({ searchParams }: { searchParams: Promise<{ email?: string; sent?: string }> }) {
  const { email, sent } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <p className="text-xs font-semibold uppercase tracking-wider text-bad">Platform team only</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Platform sign in</h1>
      <p className="mt-1 text-sm text-ink-2">For the people who run the platform. Venue staff sign in at <a className="text-accent underline" href="/login">the console</a>.</p>

      {sent && email ? (
        <ActionForm action={verifyPlatformCode} className="mt-8 space-y-4">
          <FormMessage tone="info">If {email} is a platform admin, a 6-digit code is on its way. It lasts 10 minutes.</FormMessage>
          <input type="hidden" name="email" value={email} />
          <Field label="Code">
            <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required autoFocus />
          </Field>
          <div className="flex items-center justify-between">
            <SubmitButton pendingLabel="Checking…">Sign in</SubmitButton>
            <a href="/platform/login" className="text-sm text-accent underline-offset-2 hover:underline">
              Use a different email
            </a>
          </div>
        </ActionForm>
      ) : (
        <ActionForm action={requestPlatformCode} className="mt-8 space-y-4">
          <Field label="Email">
            <Input name="email" type="email" autoComplete="email" required autoFocus defaultValue={email ?? ''} />
          </Field>
          <SubmitButton pendingLabel="Sending…">Email me a code</SubmitButton>
        </ActionForm>
      )}
    </main>
  );
}
