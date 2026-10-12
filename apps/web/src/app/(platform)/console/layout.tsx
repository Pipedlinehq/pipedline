import type { ReactNode } from 'react';
import { getConsole } from '@/lib/console';
import { consoleSections } from '@/lib/console-sections';
import { Button } from '@/ui';
import { FlashRegion } from '@/components/console/flash';
import { ConsoleSearch } from '@/components/console/search';
import { searchConsole } from './search-actions';
import { signOut } from '../login/actions';
import { selectVenue } from './actions';
import { ConsoleNav, PhoneBar, VenueSelect } from './nav';

export const dynamic = 'force-dynamic';

/**
 * The console frame (docs/CONSOLE_IA.md section 1): the venue switcher at the top of the
 * sidebar with the organisation's name, the twelve sections in order, and on a phone a bar
 * along the bottom. Navigation shows what the person's role at the selected venue can use;
 * that is a courtesy, not the control: every page and action checks the role again on the server.
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const c = await getConsole();
  const sections = await consoleSections(c);
  const venues = c.venues.map((v) => ({ id: v.id, name: v.name }));

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[16rem_minmax(0,1fr)]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-ink focus:px-3 focus:py-2 focus:text-sm focus:text-page">
        Skip to content
      </a>

      <aside className="hidden border-r border-line bg-surface md:sticky md:top-0 md:flex md:h-dvh md:flex-col">
        <div className="border-b border-line px-5 pb-4 pt-5">
          <p className="truncate text-xs font-medium uppercase tracking-[0.08em] text-ink-3">{c.org.tradingName}</p>
          <div className="mt-2">
            <VenueSelect venues={venues} selected={c.venue.id} action={selectVenue} />
          </div>
          <div className="mt-3">
            <ConsoleSearch action={searchConsole} />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          <ConsoleNav sections={sections} />
        </div>
        <div className="flex items-center justify-between border-t border-line px-5 py-3">
          <span className="font-display text-base text-ink">Pipedline</span>
          <form action={signOut}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </aside>

      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-surface/95 px-4 py-2.5 backdrop-blur md:hidden">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-ink-3">{c.org.tradingName}</p>
          <VenueSelect venues={venues} selected={c.venue.id} action={selectVenue} id="venue-select-phone" />
        </div>
        <ConsoleSearch action={searchConsole} compact />
        <span className="font-display text-base text-ink">Pipedline</span>
      </header>

      <main id="main" className="min-w-0 px-4 pb-24 pt-5 md:px-10 md:pb-12 md:pt-8">
        <div className="mx-auto max-w-[80rem]">{children}</div>
      </main>

      <PhoneBar sections={sections} signOut={signOut} />
      <FlashRegion />
    </div>
  );
}
