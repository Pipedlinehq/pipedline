'use client';

/**
 * Record a first-party event through the site's beacon (window.rosTrack). The beacon is mounted
 * by the site layout, whose effect runs after a page's own effects on first load, so an event
 * fired before it is ready waits for it rather than being lost. Only events a module declared
 * as browser-sendable are stored; the server drops anything else.
 */
export function track(name: string, properties: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  let tries = 0;
  const go = () => {
    if (window.rosTrack) window.rosTrack(name, properties);
    else if (tries++ < 60) window.setTimeout(go, 50);
  };
  go();
}
