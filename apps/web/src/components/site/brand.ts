import type { CSSProperties } from 'react';
import { website } from '@ros/modules';

type Tokens = website.BrandTokens;

/**
 * Colours derived from a venue's validated tokens for uses the tokens do not promise contrast
 * for: muted text at body size, links in the primary colour, the edges of form controls. Each
 * falls back to a colour that does reach the contrast, so whatever palette a venue chose, text
 * stays readable and controls stay visible (WCAG 1.4.3 and 1.4.11).
 */
export function derivedColours(tokens: Tokens): Record<string, string> {
  const c = tokens.colour;
  const ratio = website.contrastRatio;
  const readable = (fg: string) => ratio(fg, c.surface) >= 4.5 && ratio(fg, c.surfaceAlt) >= 4.5;
  return {
    '--s-muted': readable(c.textMuted) ? c.textMuted : c.text,
    '--s-link': readable(c.primary) ? c.primary : c.text,
    '--s-edge': ratio(c.border, c.surface) >= 3 ? c.border : ratio(c.textMuted, c.surface) >= 3 ? c.textMuted : c.text,
  };
}

/** Brand variables plus the derived ones, as a style object for the site's root element. */
export function siteStyle(brand: website.BrandView): CSSProperties {
  return { ...brand.cssVariables, ...derivedColours(brand.tokens) } as CSSProperties;
}
