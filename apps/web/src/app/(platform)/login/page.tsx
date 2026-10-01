import { ActionForm, Field, FormMessage, Input, SubmitButton } from '@/ui';
import { requestCode, verifyCode } from './actions';

export const metadata = { title: 'Sign in · Restaurant OS' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ email?: string; sent?: string; next?: string }> }) {
  const { email, sent, next } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-ink-2">There is no password. We email you a code each time.</p>

      {sent && email ? (
        <ActionForm action={verifyCode} className="mt-8 space-y-4">
          <FormMessage tone="info">If {email} has an account, a 6-digit code is on its way. It lasts 10 minutes.</FormMessage>
          <input type="hidden" name="email" value={email} />
          {next ? <input type="hidden" name="next" value={next} /> : null}
          <Field label="Code">
            <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required autoFocus />
          </Field>
          <div className="flex items-center justify-between">
            <SubmitButton pendingLabel="Checking…">Sign in</SubmitButton>
            <a href="/login" className="text-sm text-accent underline-offset-2 hover:underline">
              Use a different email
            </a>
          </div>
        </ActionForm>
      ) : (
        <ActionForm action={requestCode} className="mt-8 space-y-4">
          {next ? <input type="hidden" name="next" value={next} /> : null}
          <Field label="Email">
            <Input name="email" type="email" autoComplete="email" required autoFocus defaultValue={email ?? ''} />
          </Field>
          <SubmitButton pendingLabel="Sending…">Email me a code</SubmitButton>
        </ActionForm>
      )}
    </main>
  );
}
