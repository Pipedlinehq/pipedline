'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

declare global {
  interface Window {
    /** Record a first-party event from anywhere on a venue's site. */
    rosTrack?: (name: string, properties?: Record<string, unknown>) => void;
  }
}

let ready: Promise<void> | null = null;

function startSession(): Promise<void> {
  const q = new URLSearchParams(window.location.search);
  const device = window.matchMedia('(max-width: 640px)').matches ? 'mobile' : window.matchMedia('(max-width: 1024px)').matches ? 'tablet' : 'desktop';
  return fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: window.location.pathname,
      referrer: document.referrer || null,
      utm_source: q.get('utm_source'),
      utm_medium: q.get('utm_medium'),
      utm_campaign: q.get('utm_campaign'),
      utm_content: q.get('utm_content'),
      creator: q.get('creator'),
      campaign: q.get('campaign'),
      code: q.get('code'),
      device,
    }),
  }).then(
    () => undefined,
    () => undefined,
  );
}

function send(name: string, properties: Record<string, unknown> = {}) {
  const body = JSON.stringify({ events: [{ name, properties, at: new Date().toISOString() }] });
  void (ready ?? Promise.resolve()).then(() => fetch('/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => undefined));
}

/**
 * First-party analytics for a venue's site: starts the visitor session (carrying any campaign
 * or creator parameters on the landing URL) and records a page view on every navigation.
 * No third-party script, no cross-site identifier.
 */
export function Beacon() {
  const pathname = usePathname();
  useEffect(() => {
    ready ??= startSession();
    window.rosTrack = send;
  }, []);
  useEffect(() => {
    send('page.viewed', { path: pathname, title: document.title.slice(0, 200) });
  }, [pathname]);
  return null;
}
