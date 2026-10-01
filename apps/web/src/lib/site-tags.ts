import 'server-only';
import type { website } from '@ros/modules';

/**
 * Third-party measurement tags on a venue's site: Google Analytics 4 and the Meta pixel, as
 * named integrations. A venue supplies an id and nothing else; the tag itself is written here
 * (components/site/tags.tsx), so there is no snippet for anyone to paste script into
 * (docs/THREAT_MODEL.md section 6).
 *
 * Two gates, both of which must be open before any request leaves for Google or Meta:
 *
 *   1. The deployment switch ROS_SITE_TAGS=1. Off by default: both tags hand a visitor's
 *      browsing to a third party, and the wording a visitor agrees to has not been signed off
 *      (THREAT_MODEL open items: consent wording, data-handling agreement). With it off, an id
 *      saved in the console is stored and does nothing.
 *   2. The visitor's own yes, asked on the site, remembered in a first-party cookie, and never
 *      asked of a browser sending Global Privacy Control (that is already a no).
 *
 * The ids are checked again here against the providers' own formats, although the website
 * module's schema already did, because they end up inside a script address.
 */
export interface SiteTags {
  googleAnalyticsId: string | null;
  metaPixelId: string | null;
}

const GA = /^G-[A-Z0-9]{6,12}$/;
const PIXEL = /^\d{10,20}$/;

/** The visitor's answer, kept on this host only: 'yes' or 'no'. Written by the page's own script when they choose. */
export const TAGS_COOKIE = 'ros_tags';

export function siteTagsEnabled(): boolean {
  return process.env.ROS_SITE_TAGS === '1';
}

/** The tags this site may offer its visitors, or null when there are none to offer. */
export function siteTags(config: website.WebsiteConfig): SiteTags | null {
  if (!siteTagsEnabled()) return null;
  const ga = config.integrations.googleAnalyticsId;
  const pixel = config.integrations.metaPixelId;
  const tags: SiteTags = { googleAnalyticsId: ga && GA.test(ga) ? ga : null, metaPixelId: pixel && PIXEL.test(pixel) ? pixel : null };
  return tags.googleAnalyticsId || tags.metaPixelId ? tags : null;
}
