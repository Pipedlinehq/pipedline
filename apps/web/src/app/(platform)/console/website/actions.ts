'use server';

import { redirect } from 'next/navigation';
import { newSlug, setModule } from '@ros/core';
import { website } from '@ros/modules';
import { getConsole } from '@/lib/console';
import { act, actApp, bool, text } from '@/lib/console-actions';
import { app } from '@/lib/runtime';
import type { FormState } from '@/ui/client';
import { blockFromForm, starterBlock, type BlockType } from '@/components/console/block-form';

/**
 * Website changes. Which site a new page belongs to is a choice between the org's own site and
 * the selected venue's pages; the venue itself always comes from the console, never the form.
 */

const ok = (r: FormState & { data?: unknown }): FormState => (r && r.ok ? { ok: true, message: r.message } : r);
const siteVenue = (fd: FormData, venueId: string) => (text(fd, 'site') === 'venue' ? venueId : null);
const pagePaths = (pageId: string) => ['/console/website', `/console/website/pages/${pageId}`];

// ── Pages ───────────────────────────────────────────────────────────────────

export async function createPage(_: FormState, fd: FormData): Promise<FormState> {
  const r = await act((ctx, c) => website.createPage(ctx, { venueId: siteVenue(fd, c.venue.id), slug: text(fd, 'slug'), title: text(fd, 'title') }), { revalidate: '/console/website' });
  if (r?.ok && r.data) redirect(`/console/website/pages/${r.data.id}`);
  return ok(r);
}

async function currentBlocks(pageId: string) {
  const r = await act((ctx) => website.getPageForEdit(ctx, { pageId }));
  if (!r?.ok || !r.data) throw new Error(r && !r.ok ? r.error : 'Page not found');
  const p = r.data;
  return (p.draft ?? p.published)?.blocks ?? [];
}

async function saveBlocks(pageId: string, change: (blocks: unknown[]) => unknown[] | string, success: string): Promise<FormState> {
  let blocks: unknown[];
  try {
    blocks = await currentBlocks(pageId);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const next = change(blocks);
  if (typeof next === 'string') return { ok: false, error: next };
  return ok(await act((ctx) => website.savePageDraft(ctx, { pageId, blocks: next }), { success, revalidate: pagePaths(pageId) }));
}

export async function saveBlock(_: FormState, fd: FormData): Promise<FormState> {
  const pageId = text(fd, 'pageId');
  const blockId = text(fd, 'blockId');
  const type = text(fd, 'type') as BlockType;
  return saveBlocks(
    pageId,
    (blocks) => {
      const i = blocks.findIndex((b) => (b as { id: string }).id === blockId);
      if (i < 0) return 'That section is no longer on the page. Reload to see the latest.';
      const copy = [...blocks];
      copy[i] = blockFromForm(type, blockId, fd);
      return copy;
    },
    'Section saved to the draft. Publish to put it live.',
  );
}

export async function addBlock(_: FormState, fd: FormData): Promise<FormState> {
  const pageId = text(fd, 'pageId');
  const type = text(fd, 'type') as BlockType;
  if (!(website.BLOCK_TYPES as readonly string[]).includes(type)) return { ok: false, error: 'Choose a kind of section.' };
  const ctx = await act(async (ctx, c) => {
    const media = await website.listMedia(ctx, { limit: 1 });
    const site = await website.getSite(ctx, { venueId: c.venue.id }).catch(() => null);
    const insta = site?.config.socialLinks.instagram ?? null;
    return { firstImage: media[0]?.url ?? null, venueName: c.venue.name, instagramHandle: insta ? (new URL(insta).pathname.split('/').filter(Boolean)[0] ?? null) : null };
  });
  if (!ctx?.ok || !ctx.data) return ok(ctx);
  const block = starterBlock(type, newSlug(8).toLowerCase(), ctx.data);
  if (!block) {
    return { ok: false, error: type === 'gallery' ? 'Upload a photo in Media first, then add the gallery.' : 'Add the Instagram address in Website settings first.' };
  }
  return saveBlocks(pageId, (blocks) => [...blocks, block], 'Section added to the draft. Fill it in below.');
}

export async function moveBlock(_: FormState, fd: FormData): Promise<FormState> {
  const pageId = text(fd, 'pageId');
  const blockId = text(fd, 'blockId');
  const up = text(fd, 'direction') === 'up';
  return saveBlocks(
    pageId,
    (blocks) => {
      const i = blocks.findIndex((b) => (b as { id: string }).id === blockId);
      const j = up ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= blocks.length) return blocks;
      const copy = [...blocks];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    },
    'Moved.',
  );
}

export async function removeBlock(_: FormState, fd: FormData): Promise<FormState> {
  const pageId = text(fd, 'pageId');
  const blockId = text(fd, 'blockId');
  return saveBlocks(pageId, (blocks) => blocks.filter((b) => (b as { id: string }).id !== blockId), 'Section removed from the draft.');
}

export async function savePageMeta(_: FormState, fd: FormData): Promise<FormState> {
  const pageId = text(fd, 'pageId');
  return ok(
    await act(
      (ctx) =>
        website.savePageDraft(ctx, {
          pageId,
          title: text(fd, 'title'),
          seoTitle: text(fd, 'seoTitle') || null,
          seoDescription: text(fd, 'seoDescription') || null,
          ogImageUrl: text(fd, 'ogImageUrl') || null,
        }),
      { success: 'Saved to the draft.', revalidate: pagePaths(pageId) },
    ),
  );
}

export async function publishPage(_: FormState, fd: FormData): Promise<FormState> {
  const pageId = text(fd, 'pageId');
  return ok(await act((ctx) => website.publishPage(ctx, { pageId }), { success: 'Published. The page is live on the site.', revalidate: pagePaths(pageId) }));
}

export async function unpublishPage(_: FormState, fd: FormData): Promise<FormState> {
  const pageId = text(fd, 'pageId');
  return ok(await act((ctx) => website.unpublishPage(ctx, { pageId }), { success: 'Taken off the site. Its content is kept as a draft.', revalidate: pagePaths(pageId) }));
}

export async function discardDraft(_: FormState, fd: FormData): Promise<FormState> {
  const pageId = text(fd, 'pageId');
  return ok(await act((ctx) => website.discardPageDraft(ctx, { pageId }), { success: 'Draft thrown away. The page is back to what is live.', revalidate: pagePaths(pageId) }));
}

export async function deletePage(_: FormState, fd: FormData): Promise<FormState> {
  const r = await act((ctx) => website.deletePage(ctx, { pageId: text(fd, 'pageId') }), { revalidate: '/console/website' });
  if (r?.ok) redirect('/console/website');
  return ok(r);
}

// ── Brand ───────────────────────────────────────────────────────────────────

const COLOURS = ['primary', 'primaryContrast', 'secondary', 'accent', 'surface', 'surfaceAlt', 'text', 'textMuted', 'border', 'success', 'warning', 'error'] as const;

function weightsFor(family: string, current: number[]): number[] {
  const font = website.getFont(family);
  if (!font) return current;
  if (current.every((w) => font.weights.includes(w))) return current;
  const pick = [400, 700].filter((w) => font.weights.includes(w));
  return pick.length ? pick : font.weights.slice(0, 2);
}

/** Only what differs from `base`, so a venue override stores just its own changes. */
function diff(next: Record<string, unknown>, base: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    const b = base[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object') {
      const d = diff(v as Record<string, unknown>, b as Record<string, unknown>);
      if (Object.keys(d).length) out[k] = d;
    } else if (JSON.stringify(v) !== JSON.stringify(b)) out[k] = v;
  }
  return out;
}

export async function saveBrand(_: FormState, fd: FormData): Promise<FormState> {
  return ok(
    await act(
      async (ctx, c) => {
        const venueId = siteVenue(fd, c.venue.id);
        const current = await website.getBrandForEdit(ctx, { venueId });
        const eff = current.effective.tokens;
        const heading = text(fd, 'headingFamily') || eff.typography.heading.family;
        const body = text(fd, 'bodyFamily') || eff.typography.body.family;
        const colour: Record<string, string> = {};
        for (const k of COLOURS) colour[k] = (text(fd, `colour.${k}`) || eff.colour[k]).toUpperCase();
        const radius = Number(text(fd, 'radius'));
        const tokens = {
          typography: {
            heading: { family: heading, weights: weightsFor(heading, eff.typography.heading.weights) },
            body: { family: body, weights: weightsFor(body, eff.typography.body.weights) },
          },
          colour,
          radius: Number.isFinite(radius) ? { sm: Math.round(radius / 2), md: radius, lg: radius * 2 } : {},
          imagery: { ratio: text(fd, 'imageRatio') || eff.imagery.ratio, treatment: text(fd, 'imageTreatment') || eff.imagery.treatment, corner: text(fd, 'imageCorner') || eff.imagery.corner },
          density: text(fd, 'density') || eff.density,
        };
        const logo = { svgUrl: text(fd, 'logoSvgUrl') || null, rasterUrl: text(fd, 'logoRasterUrl') || null, markUrl: text(fd, 'logoMarkUrl') || null };
        if (venueId) {
          const base = current.org.tokens as unknown as Record<string, unknown>;
          return website.setBrand(ctx, { venueId, tokens: diff(tokens, base) as never, logo });
        }
        const skeleton = text(fd, 'skeleton');
        return website.setBrand(ctx, {
          tokens: tokens as never,
          logo,
          ...(skeleton ? { skeleton: skeleton as (typeof website.SKELETON_KEYS)[number] } : {}),
          toneOfVoice: text(fd, 'toneOfVoice') || null,
        });
      },
      { success: 'Brand saved. The site picks it up straight away.', revalidate: '/console/website/brand' },
    ),
  );
}

export async function clearOverride(_: FormState): Promise<FormState> {
  return ok(await act((ctx, c) => website.clearBrandOverride(ctx, { venueId: c.venue.id }), { success: 'This venue follows the brand again.', revalidate: '/console/website/brand' }));
}

// ── Media ───────────────────────────────────────────────────────────────────

export async function uploadMedia(_: FormState, fd: FormData): Promise<FormState> {
  const file = fd.get('file');
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: 'Choose an image to upload.' };
  const body = Buffer.from(await file.arrayBuffer());
  return ok(
    await actApp(
      async () => {
        const c = await getConsole();
        return website.uploadMedia(app(), c.session.orgId, c.session.principal, { contentType: file.type || 'application/octet-stream', body, alt: text(fd, 'alt') || null });
      },
      { success: 'Uploaded.', revalidate: '/console/website/media' },
    ),
  );
}

export async function removeMedia(_: FormState, fd: FormData): Promise<FormState> {
  return ok(
    await actApp(
      async () => {
        const c = await getConsole();
        return website.removeMedia(app(), c.session.orgId, c.session.principal, { mediaId: text(fd, 'mediaId') });
      },
      { success: 'Image removed.', revalidate: '/console/website/media' },
    ),
  );
}

export async function setMediaAlt(_: FormState, fd: FormData): Promise<FormState> {
  return ok(await act((ctx) => website.setMediaAlt(ctx, { mediaId: text(fd, 'mediaId'), alt: text(fd, 'alt') || null }), { success: 'Saved.', revalidate: '/console/website/media' }));
}

// ── Redirects ───────────────────────────────────────────────────────────────

/** One per line: "old new", "old,new" or "old -> new". An optional 302 at the end makes it temporary. */
function parseRedirects(raw: string) {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const parts = l.split(/\s*(?:->|,|\s)\s*/).filter(Boolean);
      const status = parts[2] === '302' ? 302 : 301;
      return { from: parts[0] ?? '', to: parts[1] ?? '', statusCode: status as 301 | 302 };
    });
}

export async function importRedirects(_: FormState, fd: FormData): Promise<FormState> {
  const entries = parseRedirects(text(fd, 'entries'));
  if (!entries.length) return { ok: false, error: 'Paste at least one line: the old address, then the new one.' };
  const r = await act((ctx) => website.importRedirects(ctx, { entries, replace: bool(fd, 'replace') }), { revalidate: '/console/website/redirects' });
  if (!r?.ok || !r.data) return ok(r);
  const d = r.data;
  const head = `${d.imported} added, ${d.updated} updated, ${d.unchanged} unchanged.`;
  if (!d.rejected.length) return { ok: true, message: head };
  return { ok: false, error: `${head} ${d.rejected.length} not stored: ${d.rejected.map((x) => `${x.from} (${x.reason})`).join('; ')}` };
}

export async function removeRedirect(_: FormState, fd: FormData): Promise<FormState> {
  return ok(await act((ctx) => website.removeRedirect(ctx, { redirectId: text(fd, 'redirectId') }), { success: 'Redirect removed.', revalidate: '/console/website/redirects' }));
}

// ── Settings (the module's config at this venue) ────────────────────────────

export async function saveSettings(_: FormState, fd: FormData): Promise<FormState> {
  const nav = text(fd, 'navItems');
  const navItems = nav
    ? nav
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [label, href] = l.split('|').map((x) => x.trim());
          return { label: label ?? '', href: href ?? '' };
        })
    : null;
  const social = Object.fromEntries(['instagram', 'facebook', 'tiktok', 'x', 'youtube', 'tripadvisor', 'googleBusiness'].map((k) => [k, text(fd, `social.${k}`) || null]));
  const skeleton = text(fd, 'skeleton');
  const config = {
    skeleton: skeleton || null,
    enabledBlocks: fd.getAll('enabledBlocks').map(String),
    navItems,
    bookingCtaTarget: text(fd, 'bookingCtaTarget') || null,
    orderCtaTarget: text(fd, 'orderCtaTarget') || null,
    socialLinks: social,
    integrations: {
      googleAnalyticsId: text(fd, 'googleAnalyticsId') || null,
      metaPixelId: text(fd, 'metaPixelId') || null,
      googleSiteVerification: text(fd, 'googleSiteVerification') || null,
    },
  };
  // Checked here only to say which field is wrong; setModule validates it again and decides.
  const parsed = website.websiteConfig.safeParse(config);
  if (!parsed.success) {
    const first = parsed.error.issues[0]!;
    return { ok: false, error: `${first.message} (${first.path.join(' › ')})` };
  }
  return ok(
    await act((ctx, c) => setModule(ctx, website.websiteModule, { venueId: c.venue.id, config: parsed.data }), {
      success: 'Website settings saved.',
      revalidate: '/console/website/settings',
      bustsSite: true,
    }),
  );
}
