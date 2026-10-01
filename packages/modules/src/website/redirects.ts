import { z } from 'zod';
import { type Ctx, audit, isAppError, notFound, requireStaff, sql } from '@ros/core';
import { assertWebsite } from './module';
import { cacheTags, revalidateAfterCommit } from './revalidate';
import { isSitePath } from './safe';

/**
 * The 301 map from a venue's old site (docs/modules/website.md section 5): the single biggest
 * cause of traffic collapse in a migration when it is skipped. A redirect only ever points at
 * a path on the venue's own site, so the map cannot be used to send visitors somewhere else.
 */
export const MAX_REDIRECTS = 5000;
const MAX_HOPS = 5;

export interface RedirectView {
  id: string;
  from: string;
  to: string;
  statusCode: number;
  hits: number;
  createdAt: Date;
}

/**
 * An old address as a path to match. Accepts a full URL from the old site (its host is
 * dropped, its query ignored) or a path. Returns null when it cannot be a path on a site.
 */
export function normaliseRedirectFrom(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 2000) return null;
  let path: string;
  if (/^https?:\/\//i.test(value)) {
    try {
      path = new URL(value).pathname;
    } catch {
      return null;
    }
  } else {
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
    path = value.split(/[?#]/)[0]!;
  }
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '') path = '/';
  if (path.length > 500 || !isSitePath(path)) return null;
  return path;
}

/** The path part of a redirect target, for following chains and finding loops. */
function targetPath(to: string): string {
  const path = to.split(/[?#]/)[0]!;
  return path.length > 1 ? path.replace(/\/+$/, '') || '/' : path;
}

export const redirectEntry = z.object({
  from: z.string().max(2000),
  to: z.string().max(2000),
  statusCode: z.union([z.literal(301), z.literal(302)]).default(301),
});

export const importRedirectsInput = z.object({
  entries: z.array(redirectEntry).max(MAX_REDIRECTS),
  /** Remove every existing redirect first. Default: add to and update what is there. */
  replace: z.boolean().default(false),
});

export interface ImportRedirectsResult {
  imported: number;
  updated: number;
  unchanged: number;
  /** Entries that were not stored, each with the reason in plain words. */
  rejected: Array<{ from: string; to: string; reason: string }>;
}

/**
 * Import a redirect map. Every entry is checked on its own and a bad one is reported, not
 * stored, so one mistake in a 300-line list does not lose the rest:
 * the target must be a path on this site (no full URLs, nothing protocol-relative), an entry
 * may not point at itself, and no entry may complete a loop with the others.
 */
export async function importRedirects(ctx: Ctx, raw: z.input<typeof importRedirectsInput>): Promise<ImportRedirectsResult> {
  const input = importRedirectsInput.parse(raw);
  requireStaff(ctx, { minRole: 'manager' });
  await assertWebsite(ctx, null);

  const existing = input.replace ? [] : await ctx.db.selectFrom('redirects').select(['from_path', 'to_path', 'status_code']).execute();
  const before = new Map(existing.map((r) => [r.from_path, r]));
  const map = new Map(existing.map((r) => [r.from_path, targetPath(r.to_path)]));
  const accepted = new Map<string, { to: string; statusCode: number }>();
  const result: ImportRedirectsResult = { imported: 0, updated: 0, unchanged: 0, rejected: [] };
  const reject = (e: { from: string; to: string }, reason: string) => void result.rejected.push({ from: e.from.slice(0, 200), to: e.to.slice(0, 200), reason });

  for (const entry of input.entries) {
    const from = normaliseRedirectFrom(entry.from);
    const to = entry.to.trim();
    if (!from) {
      reject(entry, 'The old address is not a page address.');
      continue;
    }
    if (from === '/') {
      reject(entry, 'The home page cannot be redirected.');
      continue;
    }
    if (!isSitePath(to)) {
      reject(entry, 'A redirect can only go to a page on this site. Use a path that starts with a single slash, such as /menu.');
      continue;
    }
    const toPath = targetPath(to);
    if (toPath === from) {
      reject(entry, 'This redirect points at itself.');
      continue;
    }
    // Follow the chain from the target. Arriving back at the start would send a visitor round in circles.
    let cursor: string | undefined = toPath;
    let loops = false;
    const seen = new Set<string>([from]);
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        loops = true;
        break;
      }
      seen.add(cursor);
      cursor = map.get(cursor);
    }
    if (loops) {
      reject(entry, 'This would create a loop with another redirect.');
      continue;
    }
    if (map.size >= MAX_REDIRECTS && !map.has(from)) {
      reject(entry, `A site can hold up to ${MAX_REDIRECTS} redirects.`);
      continue;
    }
    map.set(from, toPath);
    accepted.set(from, { to, statusCode: entry.statusCode });
  }

  if (input.replace) await ctx.db.deleteFrom('redirects').execute();
  for (const [from, v] of accepted) {
    const prior = before.get(from);
    if (prior && prior.to_path === v.to && prior.status_code === v.statusCode) {
      result.unchanged++;
      continue;
    }
    await ctx.db
      .insertInto('redirects')
      .values({ org_id: ctx.orgId, from_path: from, to_path: v.to, status_code: v.statusCode })
      .onConflict((oc) => oc.columns(['org_id', 'from_path']).doUpdateSet({ to_path: v.to, status_code: v.statusCode }))
      .execute();
    if (prior) result.updated++;
    else result.imported++;
  }

  await audit(ctx, {
    action: 'redirects.imported',
    entityType: 'redirects',
    entityId: ctx.orgId,
    after: { imported: result.imported, updated: result.updated, rejected: result.rejected.length, replace: input.replace },
  });
  revalidateAfterCommit(ctx, [cacheTags.org(ctx.orgId)]);
  return result;
}

export async function listRedirects(ctx: Ctx): Promise<RedirectView[]> {
  requireStaff(ctx);
  await assertWebsite(ctx, null);
  const rows = await ctx.db.selectFrom('redirects').select(['id', 'from_path', 'to_path', 'status_code', 'hits', 'created_at']).orderBy('from_path').execute();
  return rows.map((r) => ({ id: r.id, from: r.from_path, to: r.to_path, statusCode: r.status_code, hits: r.hits, createdAt: r.created_at }));
}

export async function removeRedirect(ctx: Ctx, input: { redirectId: string }): Promise<void> {
  requireStaff(ctx, { minRole: 'manager' });
  await assertWebsite(ctx, null);
  if (!z.string().uuid().safeParse(input.redirectId).success) throw notFound('Redirect not found');
  const row = await ctx.db.deleteFrom('redirects').where('id', '=', input.redirectId).returning(['id', 'from_path', 'to_path']).executeTakeFirst();
  if (!row) throw notFound('Redirect not found');
  await audit(ctx, { action: 'redirects.removed', entityType: 'redirect', entityId: row.id, before: { from: row.from_path, to: row.to_path } });
  revalidateAfterCommit(ctx, [cacheTags.org(ctx.orgId)]);
}

export interface ResolvedRedirect {
  /** A path on this site. Never an absolute URL. */
  to: string;
  statusCode: number;
}

/**
 * Where a request for an old address should go, or null. Public: called for a path that
 * matched no page. Counts the hit. A chain (a → b → c) is followed so the visitor makes one hop.
 */
export async function resolveRedirect(ctx: Ctx, input: { path: string }): Promise<ResolvedRedirect | null> {
  const from = typeof input.path === 'string' ? normaliseRedirectFrom(input.path) : null;
  if (!from) return null;
  try {
    await assertWebsite(ctx, null);
  } catch (e) {
    if (isAppError(e) && e.code === 'module_disabled') return null;
    throw e;
  }
  const first = await ctx.db.selectFrom('redirects').select(['id', 'to_path', 'status_code']).where('from_path', '=', from).executeTakeFirst();
  if (!first) return null;
  await ctx.db
    .updateTable('redirects')
    .set({ hits: sql<number>`hits + 1` })
    .where('id', '=', first.id)
    .execute();

  let to = first.to_path;
  const seen = new Set<string>([from]);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const path = targetPath(to);
    if (seen.has(path)) break;
    seen.add(path);
    const next = await ctx.db.selectFrom('redirects').select('to_path').where('from_path', '=', path).executeTakeFirst();
    if (!next) break;
    to = next.to_path;
  }
  // Stored targets were validated on the way in; check again on the way out, so a row written
  // any other way still cannot send a visitor off the site.
  if (!isSitePath(to)) return null;
  return { to, statusCode: first.status_code };
}

/** The addresses in a sitemap.xml document, in order. Pure: fetching the old site is the caller's job. */
export function parseSitemapXml(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  for (const m of xml.matchAll(re)) {
    out.push(m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
    if (out.length >= MAX_REDIRECTS) break;
  }
  return out;
}

/** Words in an old address that say which of the new pages it became. */
const SYNONYMS: Array<{ words: string[]; pages: string[] }> = [
  { words: ['menu', 'menus', 'food', 'drinks', 'eat', 'dining', 'carte', 'winelist', 'lunch', 'dinner', 'breakfast'], pages: ['menu'] },
  { words: ['about', 'story', 'history', 'team', 'chef', 'philosophy'], pages: ['about', 'story'] },
  { words: ['contact', 'find', 'location', 'locations', 'visit', 'hours', 'directions'], pages: ['contact'] },
  { words: ['book', 'booking', 'bookings', 'reservation', 'reservations', 'reserve', 'functions', 'events'], pages: ['contact'] },
  { words: ['faq', 'faqs', 'questions'], pages: ['contact'] },
];

export interface SuggestedRedirect {
  from: string;
  to: string;
  /** False when no page matched and the home page was used: worth a person's look. */
  matched: boolean;
}

/**
 * A first draft of the redirect map from the old site's addresses: each is matched to the new
 * page it most likely became, and to the home page when nothing fits. Pure; a person reviews
 * the result and importRedirects validates it.
 */
export function suggestRedirects(input: { oldUrls: string[]; pageSlugs: string[] }): SuggestedRedirect[] {
  const slugs = new Set(input.pageSlugs);
  const out = new Map<string, SuggestedRedirect>();
  for (const url of input.oldUrls) {
    const from = normaliseRedirectFrom(url);
    if (!from || from === '/') continue;
    const segments = from
      .toLowerCase()
      .split('/')
      .filter(Boolean)
      .map((s) => s.replace(/\.(html?|php|aspx?)$/, ''))
      .filter((s) => s !== 'index');
    // The last part of the address says most about the page; work back from it.
    let slug: string | null = null;
    for (const segment of [...segments].reverse()) {
      for (const word of [segment, ...segment.split(/[-_]/)]) {
        if (word !== 'home' && slugs.has(word)) slug = word;
        else slug = SYNONYMS.find((syn) => syn.words.includes(word))?.pages.find((page) => slugs.has(page)) ?? null;
        if (slug) break;
      }
      if (slug) break;
    }
    const to = slug ? `/${slug}` : '/';
    if (to === from) continue;
    out.set(from, { from, to, matched: slug !== null });
  }
  return [...out.values()];
}
