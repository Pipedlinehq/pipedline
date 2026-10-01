'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import type { FormState } from '@/ui/client';

function PairButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-20 w-full rounded-xl bg-emerald-500 text-2xl font-bold tracking-wide text-black active:bg-emerald-400 disabled:opacity-60"
    >
      {pending ? 'Pairing…' : 'Pair this screen'}
    </button>
  );
}

/** The unpaired screen: one big field for the code a manager made in the console. */
export function PairForm({ action }: { action: (prev: FormState, form: FormData) => Promise<FormState> }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-8 py-12">
      <h1 className="text-4xl font-bold tracking-tight">Pair this kitchen screen</h1>
      <p className="mt-3 text-xl text-slate-300">
        In the console, a manager opens <span className="font-semibold text-slate-50">Kitchen screens</span> and makes a pairing code. Type it here. The code works once, for 15
        minutes.
      </p>
      <form action={formAction} className="mt-10 space-y-6">
        <label className="block">
          <span className="mb-2 block text-lg font-semibold">Pairing code</span>
          <input
            name="code"
            required
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={12}
            className="block h-24 w-full rounded-xl border-4 border-slate-500 bg-[#15181e] px-6 text-center font-mono text-5xl uppercase tracking-[0.3em] text-slate-50 focus:border-emerald-400"
          />
        </label>
        {state && !state.ok ? (
          <p role="alert" className="rounded-xl border-4 border-red-500 bg-red-950 px-5 py-4 text-xl font-semibold text-red-100">
            {state.error}
          </p>
        ) : null}
        <PairButton />
      </form>
    </main>
  );
}

/** A full-screen explanation with, optionally, one way forward. */
export function ScreenMessage({ title, body, action, actionLabel }: { title: string; body: string; action?: () => Promise<void>; actionLabel?: string }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-8 py-12">
      <h1 className="text-4xl font-bold tracking-tight">{title}</h1>
      <p className="mt-3 text-xl text-slate-300">{body}</p>
      {action ? (
        <form action={action} className="mt-10">
          <button type="submit" className="h-20 w-full rounded-xl bg-slate-100 text-2xl font-bold text-black active:bg-slate-300">
            {actionLabel ?? 'Continue'}
          </button>
        </form>
      ) : null}
    </main>
  );
}
