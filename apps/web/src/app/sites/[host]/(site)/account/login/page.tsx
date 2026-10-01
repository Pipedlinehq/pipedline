import { SiteActionForm, SiteSubmit } from '@/components/site/action-form';
import { requestGuestCode, verifyGuestCode } from '../actions';

export const metadata = { title: 'Sign in', robots: { index: false } };

export default async function GuestLoginPage({ params, searchParams }: { params: Promise<{ host: string }>; searchParams: Promise<{ to?: string; sent?: string; next?: string }> }) {
  const { host } = await params;
  const { to, sent, next } = await searchParams;
  const nextPath = typeof next === 'string' ? next : '/account';
  return (
    <div className="mx-auto max-w-md space-y-6 px-4 py-16 sm:px-6">
      <div className="space-y-2">
        <h1 className="s-heading">Sign in</h1>
        <p>Enter your email or mobile number and we will send you a code. No password.</p>
      </div>
      {sent && to ? (
        <SiteActionForm action={verifyGuestCode.bind(null, host)} className="space-y-4">
          <p className="s-notice" role="status">
            We sent a 6-digit code to {to}. It lasts 10 minutes.
          </p>
          <input type="hidden" name="destination" value={to} />
          <input type="hidden" name="next" value={nextPath} />
          <label className="block space-y-1">
            <span className="font-semibold">Code</span>
            <input className="s-input text-lg tracking-widest" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required autoFocus />
          </label>
          <SiteSubmit pending="Checking…">Sign in</SiteSubmit>
        </SiteActionForm>
      ) : (
        <SiteActionForm action={requestGuestCode.bind(null, host)} className="space-y-4">
          <input type="hidden" name="next" value={nextPath} />
          <label className="block space-y-1">
            <span className="font-semibold">Email or mobile number</span>
            <input className="s-input" name="destination" autoComplete="email" required autoFocus />
          </label>
          <SiteSubmit pending="Sending…">Send me a code</SiteSubmit>
        </SiteActionForm>
      )}
    </div>
  );
}
