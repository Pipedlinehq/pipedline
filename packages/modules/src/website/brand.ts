import { z } from 'zod';
import { type Ctx, audit, invalid, json, requireStaff, track } from '@ros/core';
import { getVenue } from '../tenancy/venues';
import { brandUpdated } from './module';
import { cacheTags, revalidateAfterCommit } from './revalidate';
import { imageUrl, plainText } from './safe';
import { SKELETON_KEYS, type SkeletonKey } from './skeletons';
import { type BrandTokens, brandCss, brandCssVariables, brandTokensPartial, brandTokensSchema, googleFontsHref, mergeTokens, resolveTokens } from './tokens';

export interface BrandLogo {
  svgUrl: string | null;
  rasterUrl: string | null;
  markUrl: string | null;
}

export interface BrandView {
  tokens: BrandTokens;
  /** The org's layout skeleton. A venue may choose its own in its website config. */
  skeleton: SkeletonKey;
  logo: BrandLogo;
  /** True when this venue has its own override merged over the org brand. */
  hasVenueOverride: boolean;
  /** The CSS custom properties for the root layout, and the same as one :root rule. */
  cssVariables: Record<string, string>;
  css: string;
  fontsHref: string;
}

type BrandRow = {
  venue_id: string | null;
  tokens: unknown;
  logo_svg_url: string | null;
  logo_raster_url: string | null;
  logo_mark_url: string | null;
  layout_skeleton: string;
  tone_of_voice: string | null;
};

const COLS = ['venue_id', 'tokens', 'logo_svg_url', 'logo_raster_url', 'logo_mark_url', 'layout_skeleton', 'tone_of_voice'] as const;

async function loadRows(ctx: Ctx, venueId: string | null): Promise<{ org: BrandRow | null; venue: BrandRow | null }> {
  const rows = await ctx.db
    .selectFrom('brands')
    .select(COLS)
    .where((eb) => (venueId ? eb.or([eb('venue_id', 'is', null), eb('venue_id', '=', venueId)]) : eb('venue_id', 'is', null)))
    .execute();
  return { org: rows.find((r) => r.venue_id === null) ?? null, venue: rows.find((r) => r.venue_id !== null) ?? null };
}

const asSkeleton = (value: string | null | undefined): SkeletonKey => ((SKELETON_KEYS as readonly string[]).includes(value ?? '') ? (value as SkeletonKey) : 'hero-photo');

function toView(org: BrandRow | null, venue: BrandRow | null): BrandView {
  const tokens = resolveTokens(org?.tokens, venue?.tokens);
  return {
    tokens,
    skeleton: asSkeleton(org?.layout_skeleton),
    logo: {
      svgUrl: venue?.logo_svg_url ?? org?.logo_svg_url ?? null,
      rasterUrl: venue?.logo_raster_url ?? org?.logo_raster_url ?? null,
      markUrl: venue?.logo_mark_url ?? org?.logo_mark_url ?? null,
    },
    hasVenueOverride: venue !== null,
    cssVariables: brandCssVariables(tokens),
    css: brandCss(tokens),
    fontsHref: googleFontsHref(tokens),
  };
}

/**
 * The brand a guest-facing surface renders with: platform defaults, the org's brand, then the
 * venue's override. No role and no module check: the brand is the org's identity and every
 * public surface (site, QR menu, ordering, email) shows it.
 */
export async function getBrand(ctx: Ctx, input: { venueId?: string | null } = {}): Promise<BrandView> {
  const { org, venue } = await loadRows(ctx, input.venueId ?? null);
  return toView(org, venue);
}

export interface BrandForEdit {
  effective: BrandView;
  org: { tokens: BrandTokens; skeleton: SkeletonKey; logo: BrandLogo; toneOfVoice: string | null };
  /** What this venue overrides, or null. Only the keys it changes are stored. */
  override: { tokens: unknown; logo: BrandLogo } | null;
}

/** The brand as the editor needs it: the org layer and the venue layer separately. */
export async function getBrandForEdit(ctx: Ctx, input: { venueId?: string | null } = {}): Promise<BrandForEdit> {
  const venueId = input.venueId ?? null;
  requireStaff(ctx, { venueId: venueId ?? undefined, minRole: 'manager' });
  const { org, venue } = await loadRows(ctx, venueId);
  return {
    effective: toView(org, venue),
    org: {
      tokens: resolveTokens(org?.tokens),
      skeleton: asSkeleton(org?.layout_skeleton),
      logo: { svgUrl: org?.logo_svg_url ?? null, rasterUrl: org?.logo_raster_url ?? null, markUrl: org?.logo_mark_url ?? null },
      toneOfVoice: org?.tone_of_voice ?? null,
    },
    override: venue
      ? { tokens: venue.tokens ?? {}, logo: { svgUrl: venue.logo_svg_url, rasterUrl: venue.logo_raster_url, markUrl: venue.logo_mark_url } }
      : null,
  };
}

export const setBrandInput = z.object({
  /** Set to write a per-venue override instead of the org's brand. */
  venueId: z.string().uuid().nullish(),
  /** Any subset of the tokens; merged over what is stored, then validated as a whole. */
  tokens: brandTokensPartial.optional(),
  /** The org's layout skeleton. Ignored for a venue override: a venue chooses its own in its website config. */
  skeleton: z.enum(SKELETON_KEYS).optional(),
  logo: z
    .object({ svgUrl: imageUrl.nullable(), rasterUrl: imageUrl.nullable(), markUrl: imageUrl.nullable() })
    .partial()
    .optional(),
  /** Three or four sentences in the venue's own voice, used to steer generated copy. Org brand only. */
  toneOfVoice: plainText(1500, { multiline: true }).nullable().optional(),
});
export type SetBrandInput = z.input<typeof setBrandInput>;

/**
 * Write the org's brand, or one venue's override of it. The merged result must be a complete,
 * valid token set (allowlisted typefaces, hex colours with readable contrast) or nothing is saved.
 */
export async function setBrand(ctx: Ctx, raw: SetBrandInput): Promise<BrandView> {
  const parsed = setBrandInput.safeParse(raw);
  if (!parsed.success) throw invalid('Those brand settings are not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  const venueId = input.venueId ?? null;
  requireStaff(ctx, { venueId: venueId ?? undefined, minRole: 'manager' });
  if (venueId) await getVenue(ctx, venueId);

  const { org, venue } = await loadRows(ctx, venueId);
  const before = toView(org, venue);
  const current = venueId ? venue : org;

  // The org row holds a full token set; a venue row holds only what it overrides.
  const orgTokens = resolveTokens(org?.tokens);
  const stored = venueId ? mergeTokens(venue?.tokens ?? {}, input.tokens ?? {}) : mergeTokens(orgTokens, input.tokens ?? {});
  const effective = brandTokensSchema.safeParse(venueId ? mergeTokens(orgTokens, stored) : stored);
  if (!effective.success) {
    throw invalid(effective.error.issues[0]?.message ?? 'Those brand settings are not valid.', { issues: effective.error.issues });
  }

  const skeleton = venueId ? asSkeleton(org?.layout_skeleton) : (input.skeleton ?? asSkeleton(org?.layout_skeleton));
  const values = {
    tokens: json(venueId ? stored : effective.data),
    layout_skeleton: skeleton,
    logo_svg_url: input.logo?.svgUrl !== undefined ? input.logo.svgUrl : (current?.logo_svg_url ?? null),
    logo_raster_url: input.logo?.rasterUrl !== undefined ? input.logo.rasterUrl : (current?.logo_raster_url ?? null),
    logo_mark_url: input.logo?.markUrl !== undefined ? input.logo.markUrl : (current?.logo_mark_url ?? null),
    tone_of_voice: venueId ? null : input.toneOfVoice !== undefined ? input.toneOfVoice : (current?.tone_of_voice ?? null),
  };

  if (current) {
    await ctx.db
      .updateTable('brands')
      .set(values)
      .where((eb) => (venueId ? eb('venue_id', '=', venueId) : eb('venue_id', 'is', null)))
      .execute();
  } else {
    await ctx.db.insertInto('brands').values({ org_id: ctx.orgId, venue_id: venueId, ...values }).execute();
  }

  const after = await getBrand(ctx, { venueId });
  await audit(ctx, {
    action: 'brand.updated',
    entityType: 'brand',
    entityId: venueId ?? ctx.orgId,
    venueId,
    before: { tokens: before.tokens, skeleton: before.skeleton, logo: before.logo },
    after: { tokens: after.tokens, skeleton: after.skeleton, logo: after.logo },
  });
  await track(ctx, brandUpdated, { scope: venueId ? 'venue' : 'org', skeleton: after.skeleton }, { venueId });
  revalidateAfterCommit(ctx, [cacheTags.org(ctx.orgId)]);
  return after;
}

/** Remove a venue's override so it follows the org's brand again. */
export async function clearBrandOverride(ctx: Ctx, input: { venueId: string }): Promise<BrandView> {
  const venueId = z.string().uuid().parse(input.venueId);
  requireStaff(ctx, { venueId, minRole: 'manager' });
  const before = await getBrand(ctx, { venueId });
  await ctx.db.deleteFrom('brands').where('venue_id', '=', venueId).execute();
  const after = await getBrand(ctx, { venueId });
  await audit(ctx, { action: 'brand.override_cleared', entityType: 'brand', entityId: venueId, venueId, before: { tokens: before.tokens }, after: { tokens: after.tokens } });
  revalidateAfterCommit(ctx, [cacheTags.org(ctx.orgId)]);
  return after;
}

/** The tone-of-voice sample, for copy generation. Staff only: it is not shown on the site. */
export async function getToneOfVoice(ctx: Ctx): Promise<string | null> {
  requireStaff(ctx);
  const row = await ctx.db.selectFrom('brands').select('tone_of_voice').where('venue_id', 'is', null).executeTakeFirst();
  return row?.tone_of_voice ?? null;
}
