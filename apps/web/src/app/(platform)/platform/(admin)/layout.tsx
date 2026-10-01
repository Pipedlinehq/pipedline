import Link from 'next/link';
import type { ReactNode } from 'react';
import { getPlatformSession } from '@/lib/staff';
import { openSupportAccesses, platformAdminName } from '@/lib/ops-platform';
import { PlatformNav } from '@/components/platform/nav';
import { SupportBanner } from '@/components/platform/support-banner';
import { platformSignOut } from '../login/actions';
import { closeSupportAction } from './support-actions';

export const dynamic = 'force-dynamic';

/** The platform admin frame: separate sign-in, separate cookie, and a banner whenever support access is open. */
export default async function PlatformAdminLayout({ children }: { children: ReactNode }) {
  await getPlatformSession();
  const [open, who] = await Promise.all([openSupportAccesses(), platformAdminName()]);
  return (
    <div className="min-h-dvh">
      <SupportBanner open={open} close={closeSupportAction} />
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-6 py-3">
          <Link href="/platform" className="font-semibold tracking-tight">
            Restaurant OS <span className="rounded bg-ink px-1.5 py-0.5 text-xs font-medium text-white">Platform</span>
          </Link>
          <PlatformNav />
          <div className="ml-auto flex items-center gap-3 text-sm text-ink-2">
            <span>{who}</span>
            <form action={platformSignOut}>
              <button type="submit" className="rounded-md px-2 py-1 text-ink-2 hover:bg-sunken hover:text-ink">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
