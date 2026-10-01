import { z } from 'zod';

/**
 * The validators every piece of venue-written website content passes through. Content is data:
 * text is plain text, links are https or a path on the venue's own site, and nothing a venue
 * types is ever treated as markup (docs/THREAT_MODEL.md section 6).
 */

const CONTROL_MULTILINE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/;
const CONTROL_SINGLE_LINE = /[\u0000-\u001F\u007F\u2028\u2029]/;

/**
 * Where an HTML parser would open a tag, a comment or a processing instruction: "<" followed
 * at once by a letter, "/", "!" or "?". "2 < 3", "<3" and "under <$20" are ordinary text.
 */
const MARKUP = /<[a-zA-Z/!?]/;

export function looksLikeMarkup(value: string): boolean {
  return MARKUP.test(value);
}

export interface PlainTextOptions {
  min?: number;
  /** Allow line breaks (paragraph copy). Single-line fields refuse them. */
  multiline?: boolean;
}

/** Plain text, trimmed. Refuses markup and control characters rather than trying to clean them. */
export function plainText(max: number, opts: PlainTextOptions = {}) {
  const control = opts.multiline ? CONTROL_MULTILINE : CONTROL_SINGLE_LINE;
  return z
    .string()
    .trim()
    .min(opts.min ?? 1, 'This cannot be empty.')
    .max(max, `Keep this under ${max} characters.`)
    .refine((v) => !control.test(v), opts.multiline ? 'Remove the control characters.' : 'Use a single line of text.')
    .refine((v) => !MARKUP.test(v), 'Plain text only: HTML tags are not supported here.');
}

const PATH_CHARS = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#[\]]*$/;

/**
 * A path on the venue's own site: one leading slash, never two (a protocol-relative URL leaves
 * the site), no backslash (browsers read "\" as "/"), no spaces or control characters.
 */
export function isSitePath(value: string): boolean {
  return value.length <= 2000 && PATH_CHARS.test(value);
}

/** An absolute https URL with a real host and no embedded credentials. */
export function isHttpsUrl(value: string): boolean {
  if (value.length > 2000 || !/^https:\/\/[^\s"'<>`\\]+$/i.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  return /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i.test(url.hostname);
}

/** A path on this site, e.g. /menu or /#hours. Used wherever leaving the site must be impossible. */
export const sitePath = z.string().refine(isSitePath, 'Use a path on this site that starts with a single slash, such as /menu.');

/** A full https address. */
export const httpsUrl = z.string().refine(isHttpsUrl, 'Use a full address that starts with https://.');

/** A link a venue may point a button or menu entry at: https, or a path on its own site. */
export const linkUrl = z.string().refine((v) => isSitePath(v) || isHttpsUrl(v), 'Use a full https:// address, or a path on this site such as /menu.');

/** An image address: from the media library (https) or a path on this site. */
export const imageUrl = linkUrl;

/** An https URL whose host is one of the given sites (or a subdomain of one), for social links. */
export function httpsUrlOn(hosts: string[]) {
  return z.string().refine((v) => {
    if (!isHttpsUrl(v)) return false;
    const host = new URL(v).hostname.toLowerCase();
    return hosts.some((h) => host === h || host.endsWith(`.${h}`));
  }, `Use the full https:// address of the profile on ${hosts[0]}.`);
}
