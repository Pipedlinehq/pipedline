import { z } from 'zod';
import { invalid } from '@ros/core';

/**
 * Brand tokens: the design dimension of a venue's site (docs/modules/website.md section 1).
 * Stored per org in brands.tokens with an optional per-venue override, emitted as CSS custom
 * properties on the root layout. There are no per-tenant CSS files.
 *
 * Every value is constrained to a number, an enum or a hex colour, and every CSS value is built
 * here from those, so nothing a venue types reaches a stylesheet as free text.
 */

export interface FontDef {
  family: string;
  category: 'serif' | 'sans';
  /** The weights we load from Google Fonts for this face. */
  weights: number[];
  /** A real fallback stack, used while the face loads and if it never does. */
  fallback: string;
}

const SERIF = 'Georgia, Cambria, Times New Roman, serif';
const SANS = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif';

/** The curated allowlist. Unlimited font choice is unlimited licensing and performance trouble. */
export const FONTS: readonly FontDef[] = [
  { family: 'Fraunces', category: 'serif', weights: [300, 400, 500, 600, 700, 900], fallback: SERIF },
  { family: 'Playfair Display', category: 'serif', weights: [400, 500, 600, 700, 800, 900], fallback: SERIF },
  { family: 'Cormorant Garamond', category: 'serif', weights: [300, 400, 500, 600, 700], fallback: SERIF },
  { family: 'Lora', category: 'serif', weights: [400, 500, 600, 700], fallback: SERIF },
  { family: 'Libre Baskerville', category: 'serif', weights: [400, 700], fallback: SERIF },
  { family: 'DM Serif Display', category: 'serif', weights: [400], fallback: SERIF },
  { family: 'Merriweather', category: 'serif', weights: [300, 400, 700, 900], fallback: SERIF },
  { family: 'Source Serif 4', category: 'serif', weights: [300, 400, 500, 600, 700], fallback: SERIF },
  { family: 'Inter', category: 'sans', weights: [300, 400, 500, 600, 700, 800], fallback: SANS },
  { family: 'DM Sans', category: 'sans', weights: [300, 400, 500, 600, 700], fallback: SANS },
  { family: 'Work Sans', category: 'sans', weights: [300, 400, 500, 600, 700], fallback: SANS },
  { family: 'Manrope', category: 'sans', weights: [300, 400, 500, 600, 700, 800], fallback: SANS },
  { family: 'Poppins', category: 'sans', weights: [300, 400, 500, 600, 700], fallback: SANS },
  { family: 'Montserrat', category: 'sans', weights: [300, 400, 500, 600, 700, 800], fallback: SANS },
  { family: 'Karla', category: 'sans', weights: [300, 400, 500, 600, 700], fallback: SANS },
  { family: 'Nunito Sans', category: 'sans', weights: [300, 400, 600, 700, 800], fallback: SANS },
  { family: 'Outfit', category: 'sans', weights: [300, 400, 500, 600, 700], fallback: SANS },
  { family: 'Space Grotesk', category: 'sans', weights: [300, 400, 500, 600, 700], fallback: SANS },
  { family: 'Jost', category: 'sans', weights: [300, 400, 500, 600, 700], fallback: SANS },
  { family: 'Oswald', category: 'sans', weights: [300, 400, 500, 600, 700], fallback: SANS },
];

export const FONT_FAMILIES = FONTS.map((f) => f.family) as [string, ...string[]];
const fontByFamily = new Map(FONTS.map((f) => [f.family, f]));

export function getFont(family: string): FontDef | undefined {
  return fontByFamily.get(family);
}

/** The last-resort stack named in the tokens. An enum, never free text. */
export const FALLBACK_STACKS = ['system-ui, sans-serif', 'Georgia, serif', 'ui-monospace, monospace'] as const;

const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex colour such as #8B2F2F.')
  .transform((v) => v.toUpperCase());

const family = z.enum(FONT_FAMILIES, { message: 'Choose a typeface from the list.' });
const weights = z.array(z.number().int().min(100).max(900).multipleOf(100)).min(1).max(4);

const headingFont = z.object({
  family,
  weights,
  /** The ratio between heading sizes. */
  scale: z.number().min(1.067).max(1.5),
  tracking: z.string().regex(/^-?0(\.\d{1,3})?em$/, 'Use a letter spacing such as -0.02em.'),
});

const bodyFont = z.object({
  family,
  weights,
  size: z.number().int().min(14).max(20),
  leading: z.number().min(1.2).max(2),
});

const colour = z.object({
  primary: hex,
  primaryContrast: hex,
  secondary: hex,
  accent: hex,
  surface: hex,
  surfaceAlt: hex,
  text: hex,
  textMuted: hex,
  border: hex,
  success: hex,
  warning: hex,
  error: hex,
});

const radius = z.object({
  sm: z.number().int().min(0).max(64),
  md: z.number().int().min(0).max(64),
  lg: z.number().int().min(0).max(64),
  pill: z.number().int().min(0).max(999),
});

const spacing = z.object({
  unit: z.number().int().min(2).max(8),
  sectionY: z.number().int().min(32).max(160),
});

export const IMAGE_RATIOS = ['1:1', '4:3', '3:2', '16:9', '3:4'] as const;
export const IMAGE_TREATMENTS = ['none', 'warm', 'cool', 'mono', 'muted'] as const;
export const IMAGE_CORNERS = ['none', 'sm', 'md', 'lg'] as const;
export const DENSITIES = ['compact', 'comfortable', 'spacious'] as const;

const imagery = z.object({
  ratio: z.enum(IMAGE_RATIOS),
  treatment: z.enum(IMAGE_TREATMENTS),
  corner: z.enum(IMAGE_CORNERS),
});

const tokensShape = z.object({
  typography: z.object({ heading: headingFont, body: bodyFont, fallback: z.enum(FALLBACK_STACKS) }),
  colour,
  radius,
  spacing,
  imagery,
  density: z.enum(DENSITIES),
});

/** Relative luminance per WCAG 2.x. */
function luminance(hexColour: string): number {
  const n = parseInt(hexColour.slice(1), 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

type ColourKey = keyof z.infer<typeof colour>;

/**
 * The colour pairs that are read as text on a background, with the contrast each must reach
 * (WCAG AA: 4.5 for body text, 3 for large or secondary text).
 */
export const CONTRAST_PAIRS: ReadonlyArray<{ fg: ColourKey; bg: ColourKey; min: number; label: string }> = [
  { fg: 'text', bg: 'surface', min: 4.5, label: 'Text on the page background' },
  { fg: 'text', bg: 'surfaceAlt', min: 4.5, label: 'Text on the alternate background' },
  { fg: 'primaryContrast', bg: 'primary', min: 4.5, label: 'Button text on the primary colour' },
  { fg: 'textMuted', bg: 'surface', min: 3, label: 'Muted text on the page background' },
];

/** The full, validated token set. Colours are upper-case hex; fonts come from the allowlist. */
export const brandTokensSchema = tokensShape.superRefine((t, issue) => {
  for (const pair of CONTRAST_PAIRS) {
    const ratio = contrastRatio(t.colour[pair.fg], t.colour[pair.bg]);
    if (ratio < pair.min) {
      issue.addIssue({
        code: 'custom',
        path: ['colour', pair.fg],
        message: `${pair.label} needs a contrast of at least ${pair.min}:1 to be readable; it is ${ratio.toFixed(1)}:1.`,
      });
    }
  }
  for (const role of ['heading', 'body'] as const) {
    const font = fontByFamily.get(t.typography[role].family);
    const missing = t.typography[role].weights.filter((w) => !font?.weights.includes(w));
    if (missing.length) {
      issue.addIssue({
        code: 'custom',
        path: ['typography', role, 'weights'],
        message: `${t.typography[role].family} is not available in weight ${missing.join(', ')}.`,
      });
    }
  }
});
export type BrandTokens = z.infer<typeof brandTokensSchema>;

/** Any subset of the tokens: what a per-venue override stores, and what an editor sends. */
export const brandTokensPartial = z
  .object({
    typography: z.object({ heading: headingFont.partial(), body: bodyFont.partial(), fallback: z.enum(FALLBACK_STACKS) }).partial(),
    colour: colour.partial(),
    radius: radius.partial(),
    spacing: spacing.partial(),
    imagery: imagery.partial(),
    density: z.enum(DENSITIES),
  })
  .partial();
export type BrandTokensPartial = z.infer<typeof brandTokensPartial>;

export const DEFAULT_BRAND_TOKENS: BrandTokens = brandTokensSchema.parse({
  typography: {
    heading: { family: 'Fraunces', weights: [400, 700], scale: 1.25, tracking: '-0.02em' },
    body: { family: 'Inter', weights: [400, 500], size: 16, leading: 1.6 },
    fallback: 'system-ui, sans-serif',
  },
  colour: {
    primary: '#8B2F2F',
    primaryContrast: '#FFFFFF',
    secondary: '#2F4858',
    accent: '#D4A574',
    surface: '#FFFDF8',
    surfaceAlt: '#F3EDE3',
    text: '#1A1614',
    textMuted: '#6B615A',
    border: '#E2D9CC',
    success: '#2E7D5B',
    warning: '#B5760F',
    error: '#B3261E',
  },
  radius: { sm: 2, md: 6, lg: 16, pill: 999 },
  spacing: { unit: 4, sectionY: 96 },
  imagery: { ratio: '4:3', treatment: 'warm', corner: 'md' },
  density: 'comfortable',
});

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = deepMerge(base[k], v);
  }
  return out;
}

/** Later layers win, key by key. The result is not validated: pass it through brandTokensSchema. */
export function mergeTokens(base: unknown, ...layers: unknown[]): unknown {
  return layers.reduce((acc, layer) => deepMerge(acc, layer), base);
}

/**
 * The tokens a site renders with: platform defaults, then the org's brand, then the venue's
 * override. A stored layer that no longer validates is dropped rather than taking the site down.
 */
export function resolveTokens(orgTokens: unknown, venueOverride?: unknown): BrandTokens {
  const withVenue = brandTokensSchema.safeParse(mergeTokens(DEFAULT_BRAND_TOKENS, orgTokens ?? {}, venueOverride ?? {}));
  if (withVenue.success) return withVenue.data;
  const orgOnly = brandTokensSchema.safeParse(mergeTokens(DEFAULT_BRAND_TOKENS, orgTokens ?? {}));
  return orgOnly.success ? orgOnly.data : DEFAULT_BRAND_TOKENS;
}

const TREATMENT_FILTER: Record<(typeof IMAGE_TREATMENTS)[number], string> = {
  none: 'none',
  warm: 'sepia(0.12) saturate(1.08)',
  cool: 'saturate(0.95) hue-rotate(-6deg)',
  mono: 'grayscale(1)',
  muted: 'saturate(0.8)',
};
const DENSITY_SCALE: Record<(typeof DENSITIES)[number], string> = { compact: '0.85', comfortable: '1', spacious: '1.15' };

const CSS_VALUE = /^[A-Za-z0-9 #.,%()'/-]+$/;
const CSS_FORBIDDEN = /url\(|expression\(|@|\/\*|\*\//i;

function cssValue(name: string, value: string): string {
  // Every value is built from validated numbers, enums and hex colours. This is the second lock:
  // a value that could close a declaration or open a rule is refused outright.
  if (!CSS_VALUE.test(value) || CSS_FORBIDDEN.test(value)) throw invalid(`The brand setting ${name} is not valid.`);
  return value;
}

function fontStack(familyName: string): string {
  const font = fontByFamily.get(familyName);
  if (!font) throw invalid('Choose a typeface from the list.');
  return `'${font.family}', ${font.fallback}`;
}

/**
 * The CSS custom properties the root layout emits. Takes anything and validates it first, so a
 * caller cannot pass through a value that was never checked.
 */
export function brandCssVariables(tokens: unknown): Record<string, string> {
  const parsed = brandTokensSchema.safeParse(tokens);
  if (!parsed.success) throw invalid('Those brand settings are not valid.', { issues: parsed.error.issues });
  const t = parsed.data;
  const corner = t.imagery.corner === 'none' ? 0 : t.radius[t.imagery.corner];
  const vars: Record<string, string> = {
    '--brand-font-heading': fontStack(t.typography.heading.family),
    '--brand-font-body': fontStack(t.typography.body.family),
    '--brand-font-fallback': t.typography.fallback,
    '--brand-heading-weight': String(Math.max(...t.typography.heading.weights)),
    '--brand-heading-weight-light': String(Math.min(...t.typography.heading.weights)),
    '--brand-heading-tracking': t.typography.heading.tracking,
    '--brand-type-scale': String(t.typography.heading.scale),
    '--brand-body-weight': String(Math.min(...t.typography.body.weights)),
    '--brand-body-weight-strong': String(Math.max(...t.typography.body.weights)),
    '--brand-body-size': `${t.typography.body.size}px`,
    '--brand-body-leading': String(t.typography.body.leading),
    '--brand-color-primary': t.colour.primary,
    '--brand-color-primary-contrast': t.colour.primaryContrast,
    '--brand-color-secondary': t.colour.secondary,
    '--brand-color-accent': t.colour.accent,
    '--brand-color-surface': t.colour.surface,
    '--brand-color-surface-alt': t.colour.surfaceAlt,
    '--brand-color-text': t.colour.text,
    '--brand-color-text-muted': t.colour.textMuted,
    '--brand-color-border': t.colour.border,
    '--brand-color-success': t.colour.success,
    '--brand-color-warning': t.colour.warning,
    '--brand-color-error': t.colour.error,
    '--brand-radius-sm': `${t.radius.sm}px`,
    '--brand-radius-md': `${t.radius.md}px`,
    '--brand-radius-lg': `${t.radius.lg}px`,
    '--brand-radius-pill': `${t.radius.pill}px`,
    '--brand-space-unit': `${t.spacing.unit}px`,
    '--brand-section-y': `${t.spacing.sectionY}px`,
    '--brand-image-ratio': t.imagery.ratio.replace(':', ' / '),
    '--brand-image-filter': TREATMENT_FILTER[t.imagery.treatment],
    '--brand-image-radius': `${corner}px`,
    '--brand-density': DENSITY_SCALE[t.density],
  };
  for (const [name, value] of Object.entries(vars)) cssValue(name, value);
  return vars;
}

/** The same properties as one rule, for a <style> element in the root layout. */
export function brandCss(tokens: unknown, selector: ':root' | ':host' = ':root'): string {
  const vars = brandCssVariables(tokens);
  return `${selector}{${Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(';')}}`;
}

/** The Google Fonts stylesheet address for the faces and weights the tokens use. */
export function googleFontsHref(tokens: unknown): string {
  const parsed = brandTokensSchema.safeParse(tokens);
  if (!parsed.success) throw invalid('Those brand settings are not valid.', { issues: parsed.error.issues });
  const wanted = new Map<string, Set<number>>();
  for (const role of [parsed.data.typography.heading, parsed.data.typography.body]) {
    const set = wanted.get(role.family) ?? new Set<number>();
    for (const w of role.weights) set.add(w);
    wanted.set(role.family, set);
  }
  const families = [...wanted.entries()].map(([name, ws]) => `family=${name.replace(/ /g, '+')}:wght@${[...ws].sort((a, b) => a - b).join(';')}`);
  return `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap`;
}
