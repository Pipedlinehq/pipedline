'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { track } from './track';

type LinkKind = 'call' | 'directions' | 'booking' | 'order' | 'social' | 'other';

/** An ordinary link that also records `link.clicked` (call, directions, booking, social …). */
export function TrackedLink({ href, kind, children, className, external, label }: { href: string; kind: LinkKind; children: ReactNode; className?: string; external?: boolean; label?: string }) {
  return (
    <a
      href={href}
      className={className}
      aria-label={label}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      onClick={() => track('link.clicked', { kind, target: href.slice(0, 300) })}
    >
      {children}
    </a>
  );
}

/** Records one event when the page it sits on is shown. */
export function TrackOnMount({ name, properties }: { name: string; properties?: Record<string, unknown> }) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    track(name, properties ?? {});
  }, [name, properties]);
  return null;
}

/**
 * Submits the enclosing GET form as soon as a checkbox in it changes, and hides the form's own
 * submit button. Without JavaScript the button is there and the form works the same way.
 */
export function AutoSubmit({ formId }: { formId: string }) {
  useEffect(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;
    const button = form.querySelector<HTMLElement>('[data-autosubmit-hide]');
    if (button) button.hidden = true;
    const onChange = () => form.requestSubmit();
    form.addEventListener('change', onChange);
    return () => form.removeEventListener('change', onChange);
  }, [formId]);
  return null;
}

/** Re-renders the page from the server every few seconds while `active`, for live status. */
export function LiveRefresh({ active, seconds = 5 }: { active: boolean; seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, seconds * 1000);
    return () => window.clearInterval(id);
  }, [active, seconds, router]);
  return null;
}
