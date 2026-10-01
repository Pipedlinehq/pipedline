import { type Ctx, requireOwner } from '@ros/core';

/**
 * Everything the website module holds for an org, for the org's data export when it leaves
 * (docs/THREAT_MODEL.md section 10). Owner or platform only.
 */
export async function exportWebsiteData(ctx: Ctx): Promise<Record<string, unknown>> {
  requireOwner(ctx);
  const brands = await ctx.db.selectFrom('brands').select(['venue_id', 'tokens', 'logo_svg_url', 'logo_raster_url', 'logo_mark_url', 'layout_skeleton', 'tone_of_voice']).execute();
  const pages = await ctx.db
    .selectFrom('pages')
    .select(['id', 'venue_id', 'slug', 'title', 'blocks', 'seo_title', 'seo_description', 'og_image_url', 'status', 'published_at', 'draft'])
    .orderBy('created_at')
    .execute();
  const media = await ctx.db.selectFrom('media').select(['id', 'url', 'alt', 'width', 'height', 'bytes', 'content_type', 'created_at']).orderBy('created_at').execute();
  const redirects = await ctx.db.selectFrom('redirects').select(['from_path', 'to_path', 'status_code', 'hits']).orderBy('from_path').execute();
  return { brands, pages, media, redirects };
}
