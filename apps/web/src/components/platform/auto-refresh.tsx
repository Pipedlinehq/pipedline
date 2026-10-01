'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Re-reads the page every few seconds while something is running in the background (provisioning steps). */
export function AutoRefresh({ everyMs = 3000, active, label = 'Updating by itself while provisioning runs…' }: { everyMs?: number; active: boolean; label?: string }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => router.refresh(), everyMs);
    return () => window.clearInterval(id);
  }, [active, everyMs, router]);
  return active ? (
    <p role="status" className="text-xs text-ink-2">
      {label}
    </p>
  ) : null;
}
