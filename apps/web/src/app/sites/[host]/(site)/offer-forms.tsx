'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { SiteSubmit } from '@/components/site/action-form';
import type { OfferFormState } from './offer-actions';

function CodeCard({ state, orderHref }: { state: OfferFormState & { ok: true }; orderHref: string | null }) {
  return (
    <div className="s-notice space-y-2" data-tone="success" role="status">
      <p className="font-semibold">Your code</p>
      <p className="s-tabular text-3xl font-semibold tracking-widest" data-issued-code={state.code}>
        {state.code}
      </p>
      <p>{state.summary}.</p>
      {state.expiresAt ? <p className="text-sm">Use it by {new Date(state.expiresAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}. We have also saved it; sign in to see it any time.</p> : null}
      {orderHref ? (
        <Link href={orderHref} className="s-btn">
          Use it on an order
        </Link>
      ) : null}
    </div>
  );
}

export function SignupForm({ action, orderHref }: { action: (prev: OfferFormState, form: FormData) => Promise<OfferFormState>; orderHref: string | null }) {
  const [state, formAction] = useActionState(action, null);
  if (state?.ok && state.code) return <CodeCard state={state} orderHref={orderHref ? `${orderHref}?code=${encodeURIComponent(state.code)}` : null} />;
  return (
    <form action={formAction} className="space-y-4">
      <label className="block space-y-1">
        <span className="font-semibold">First name</span>
        <input className="s-input" name="firstName" autoComplete="given-name" maxLength={100} />
      </label>
      <label className="block space-y-1">
        <span className="font-semibold">Email or mobile number</span>
        <input className="s-input" name="contact" autoComplete="email" required maxLength={254} />
      </label>
      <p className="text-sm">We send your code there. Nothing else unless you choose to hear from us later.</p>
      {state && !state.ok ? (
        <p role="alert" className="s-notice" data-tone="error">
          {state.error}
        </p>
      ) : null}
      <SiteSubmit pending="Getting your code…">Get my code</SiteSubmit>
    </form>
  );
}

export function ClaimForm({ action, orderHref }: { action: (prev: OfferFormState, form: FormData) => Promise<OfferFormState>; orderHref: string | null }) {
  const [state, formAction] = useActionState(action, null);
  if (state?.ok && state.code) return <CodeCard state={state} orderHref={orderHref ? `${orderHref}?code=${encodeURIComponent(state.code)}` : null} />;
  return (
    <form action={formAction} className="space-y-3">
      {state && !state.ok ? (
        <p role="alert" className="s-notice" data-tone="error">
          {state.error}
        </p>
      ) : null}
      <SiteSubmit pending="Claiming…">Claim this offer</SiteSubmit>
    </form>
  );
}
