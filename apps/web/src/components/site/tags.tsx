'use client';

import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Google Analytics and the Meta pixel, loaded only after this visitor has said yes.
 *
 * Until then nothing is requested from either company: no script, no image, no cookie of theirs.
 * The choice is kept in a first-party cookie on this host for six months and can be changed from
 * the footer at any time. A browser that sends Global Privacy Control has already answered: it
 * is not asked, and nothing loads. The server reads both (the cookie and the Sec-GPC header), so
 * the question is part of the page as first drawn, in the page's own flow, or not there at all.
 *
 * The ids arrive validated from the server (lib/site-tags.ts). The tags are the providers'
 * standard ones, written out here as code rather than injected as markup.
 */
const COOKIE = 'ros_tags';
const CHOICE_EVENT = 'ros:tag-choice';
type Choice = 'yes' | 'no' | null;

declare global {
  interface Window {
    dataLayer?: unknown[];
    fbq?: ((...args: unknown[]) => void) & { callMethod?: (...args: unknown[]) => void; queue?: unknown[]; loaded?: boolean; version?: string; push?: unknown };
    _fbq?: unknown;
  }
  interface Navigator {
    globalPrivacyControl?: boolean;
  }
}

function writeChoice(choice: 'yes' | 'no'): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${choice}; Max-Age=${180 * 86_400}; Path=/; SameSite=Lax${secure}`;
}

/** Opens the question again, from the footer. */
export function TagChoiceButton({ className }: { className?: string }) {
  return (
    <button type="button" className={className} onClick={() => window.dispatchEvent(new Event(CHOICE_EVENT))}>
      Measurement choices
    </button>
  );
}

export function ThirdPartyTags({
  googleAnalyticsId,
  metaPixelId,
  siteName,
  initialChoice,
  gpc,
}: {
  googleAnalyticsId: string | null;
  metaPixelId: string | null;
  siteName: string;
  /** What this browser answered before, read from its cookie on the server so the question is in the first paint or not at all. */
  initialChoice: Choice;
  /** The request carried Global Privacy Control: a no the visitor gave before arriving. */
  gpc: boolean;
}) {
  const [choice, setChoice] = useState<Choice>(gpc ? 'no' : initialChoice);
  const [asking, setAsking] = useState(initialChoice === null && !gpc);
  const started = useRef(false);
  const pathname = usePathname();

  useEffect(() => {
    // The same signal as the browser reports it to script, in case a proxy dropped the header.
    if (navigator.globalPrivacyControl === true) {
      setChoice('no');
      setAsking(false);
      return;
    }
    const reopen = () => setAsking(true);
    window.addEventListener(CHOICE_EVENT, reopen);
    return () => window.removeEventListener(CHOICE_EVENT, reopen);
  }, []);

  const decide = useCallback((next: 'yes' | 'no') => {
    writeChoice(next);
    setAsking(false);
    // A yes withdrawn takes effect at once only by reloading: a loaded tag cannot be unloaded.
    if (next === 'no' && started.current) window.location.reload();
    else setChoice(next);
  }, []);

  const allowed = choice === 'yes';

  // The providers' own bootstrap: a queue each script reads when it arrives.
  useEffect(() => {
    if (!allowed || started.current) return;
    started.current = true;
    if (googleAnalyticsId) {
      const layer = (window.dataLayer ??= []);
      // gtag pushes its `arguments` object itself; the library tells commands from events by that.
      const gtag = function gtag() {
        // eslint-disable-next-line prefer-rest-params
        layer.push(arguments);
      } as (...args: unknown[]) => void;
      gtag('js', new Date());
      gtag('config', googleAnalyticsId);
    }
    if (metaPixelId) {
      if (!window.fbq) {
        const fbq: NonNullable<Window['fbq']> = (...args: unknown[]) => {
          if (fbq.callMethod) fbq.callMethod(...args);
          else fbq.queue!.push(args);
        };
        fbq.push = fbq;
        fbq.loaded = true;
        fbq.version = '2.0';
        fbq.queue = [];
        window.fbq = fbq;
        window._fbq = fbq;
      }
      window.fbq('init', metaPixelId);
    }
  }, [allowed, googleAnalyticsId, metaPixelId]);

  // The pixel counts pages itself only on a full load; in-site navigation is told to it here.
  useEffect(() => {
    if (allowed && metaPixelId && window.fbq) window.fbq('track', 'PageView');
  }, [allowed, metaPixelId, pathname]);

  const names = [googleAnalyticsId ? 'Google Analytics' : null, metaPixelId ? 'the Meta pixel' : null].filter(Boolean).join(' and ');
  const owners = [googleAnalyticsId ? 'Google' : null, metaPixelId ? 'Meta' : null].filter(Boolean).join(' and ');

  return (
    <>
      {allowed && googleAnalyticsId ? <Script id="ros-ga" src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(googleAnalyticsId)}`} strategy="afterInteractive" data-tag="google-analytics" /> : null}
      {allowed && metaPixelId ? <Script id="ros-pixel" src="https://connect.facebook.net/en_US/fbevents.js" strategy="afterInteractive" data-tag="meta-pixel" /> : null}
      {asking ? (
        // In the page's flow, above the header: it never sits on top of the order bar or any other control.
        <section aria-label="Measurement choices" data-testid="tag-consent" className="s-alt border-b s-rule px-4 py-3 sm:px-6">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-3">
            <p className="min-w-0 flex-1 basis-80 text-sm">
              {siteName} would like to use {names} to see how this site is used. {owners} would receive details of your visit and may connect them with what {owners.includes(' and ') ? 'they' : 'it'} already
              {owners.includes(' and ') ? ' know' : ' knows'} about you. Nothing is sent unless you allow it, and the site works the same either way.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="s-btn-outline" onClick={() => decide('no')}>
                No thanks
              </button>
              <button type="button" className="s-btn" onClick={() => decide('yes')}>
                Allow
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
