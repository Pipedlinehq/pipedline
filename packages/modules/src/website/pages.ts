import { z } from 'zod';
import { type Ctx, type StaffRole, audit, conflict, invalid, isUniqueViolation, json, notFound, requireStaff, track } from '@ros/core';
import { BLOCK_TEXT_FIELDS, type Block, blockSchema, blocksSchema, readBlocks } from './blocks';
import { getBrand } from './brand';
import { type WebsiteScope, assertWebsite, pagePublished, pageUnpublished } from './module';
import { cacheTags, revalidateAfterCommit } from './revalidate';
import { imageUrl, plainText } from './safe';
import { type DefaultPageCopy, SKELETON_KEYS, type SkeletonKey, buildDefaultPages } from './skeletons';

const RESERVED_SLUGS = new Set([
  'api', 'u', 'q', 'order', 'checkout', 'account', 'console', 'admin', 'platform', 'hub', 'mcp', 'static', 'assets', 'media', 'webhooks', 'sitemap', 'robots', 'favicon',
]);

export const pageSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/, 'A page address is lowercase letters, numbers and hyphens.')
  .refine((s) => !RESERVED_SLUGS.has(s), 'That address is used by the site itself. Choose another.');

/** Everything about a page that is versioned between draft and published. */
export const pageContent = z.object({
  title: plainText(120),
  blocks: blocksSchema,
  seoTitle: plainText(70).nullable().default(null),
  seoDescription: plainText(200).nullable().default(null),
  ogImageUrl: imageUrl.nullable().default(null),
});
export type PageContent = z.infer<typeof pageContent>;

export interface PageSummary {
  id: string;
  venueId: string | null;
  slug: string;
  title: string;
  status: 'draft' | 'published';
  /** True when there are edits the public cannot see yet. */
  hasUnpublishedChanges: boolean;
  publishedAt: Date | null;
  updatedAt: Date;
}

export interface PageForEdit extends PageSummary {
  /** What the public sees now, or null when the page has never been published. */
  published: PageContent | null;
  /** The working copy, or null when nothing has changed since publishing. */
  draft: PageContent | null;
}

export interface PublicPage {
  id: string;
  venueId: string | null;
  slug: string;
  title: string;
  /** Validated blocks of the types this venue has enabled, in order. Data only: render every string as text. */
  blocks: Block[];
  seo: { title: string | null; description: string | null; ogImageUrl: string | null };
  publishedAt: Date | null;
  /** Tag the rendered page with these so a publish revalidates exactly it. */
  cacheTags: string[];
}

export interface PublishResult {
  pageId: string;
  venueId: string | null;
  slug: string;
  publishedAt: Date;
  /**
   * The cache tags this publish invalidates. Already handed to any revalidator registered with
   * onRevalidate (after commit); returned as well so a caller can act on them itself.
   */
  revalidateTags: string[];
}

const COLS = ['id', 'venue_id', 'slug', 'title', 'blocks', 'seo_title', 'seo_description', 'og_image_url', 'status', 'published_at', 'draft', 'updated_at'] as const;

interface Row {
  id: string;
  venue_id: string | null;
  slug: string;
  title: string;
  blocks: unknown;
  seo_title: string | null;
  seo_description: string | null;
  og_image_url: string | null;
  status: string;
  published_at: Date | null;
  draft: unknown;
  updated_at: Date;
}

const UUID = z.string().uuid();

function liveContent(r: Row): PageContent {
  return { title: r.title, blocks: readBlocks(r.blocks), seoTitle: r.seo_title, seoDescription: r.seo_description, ogImageUrl: r.og_image_url };
}

function draftContent(r: Row): PageContent | null {
  if (!r.draft || typeof r.draft !== 'object') return null;
  const d = r.draft as Record<string, unknown>;
  return {
    title: typeof d.title === 'string' ? d.title : r.title,
    blocks: readBlocks(d.blocks),
    seoTitle: typeof d.seoTitle === 'string' ? d.seoTitle : null,
    seoDescription: typeof d.seoDescription === 'string' ? d.seoDescription : null,
    ogImageUrl: typeof d.ogImageUrl === 'string' ? d.ogImageUrl : null,
  };
}

const isPublished = (r: Row) => r.status === 'published';

function summary(r: Row): PageSummary {
  return {
    id: r.id,
    venueId: r.venue_id,
    slug: r.slug,
    title: r.title,
    status: isPublished(r) ? 'published' : 'draft',
    hasUnpublishedChanges: r.draft !== null,
    publishedAt: r.published_at,
    updatedAt: r.updated_at,
  };
}

function forEdit(r: Row): PageForEdit {
  return { ...summary(r), published: isPublished(r) ? liveContent(r) : null, draft: draftContent(r) };
}

async function loadPage(ctx: Ctx, pageId: string): Promise<Row> {
  if (!UUID.safeParse(pageId).success) throw notFound('Page not found');
  const r = await ctx.db.selectFrom('pages').select(COLS).where('id', '=', pageId).executeTakeFirst();
  if (!r) throw notFound('Page not found');
  return r;
}

/** Role, then module. A page at a venue the caller has no role at is not found. */
async function guard(ctx: Ctx, venueId: string | null, minRole: StaffRole): Promise<WebsiteScope> {
  requireStaff(ctx, { venueId: venueId ?? undefined, minRole });
  return assertWebsite(ctx, venueId);
}

function tagsFor(ctx: Ctx, scope: WebsiteScope, page: { id: string; venue_id: string | null }, blocks: Block[]): string[] {
  const tags = [cacheTags.org(ctx.orgId), cacheTags.page(page.id)];
  if (blocks.some((b) => b.type === 'menu')) {
    for (const venueId of page.venue_id ? [page.venue_id] : scope.venueIds) tags.push(cacheTags.menu(venueId));
  }
  return tags;
}

function parseContent(raw: unknown): PageContent {
  const parsed = pageContent.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw invalid(first ? `${first.message}${first.path.length ? ` (${first.path.join('.')})` : ''}` : 'That page content is not valid.', { issues: parsed.error.issues });
  }
  return parsed.data;
}

/** The pages of one site: the org-level site when venueId is absent, otherwise that venue's own pages. */
export async function listPages(ctx: Ctx, input: { venueId?: string | null } = {}): Promise<PageSummary[]> {
  const venueId = input.venueId ?? null;
  await guard(ctx, venueId, 'read_only');
  const rows = await ctx.db
    .selectFrom('pages')
    .select(COLS)
    .where((eb) => (venueId ? eb('venue_id', '=', venueId) : eb('venue_id', 'is', null)))
    .orderBy('created_at')
    .orderBy('slug')
    .execute();
  return rows.map(summary);
}

/** One page with both versions, for the editor. */
export async function getPageForEdit(ctx: Ctx, input: { pageId: string }): Promise<PageForEdit> {
  const row = await loadPage(ctx, input.pageId);
  await guard(ctx, row.venue_id, 'read_only');
  return forEdit(row);
}

export const createPageInput = z.object({
  venueId: z.string().uuid().nullish(),
  slug: pageSlug,
  title: plainText(120),
  blocks: z.array(z.unknown()).default([]),
  seoTitle: z.string().nullish(),
  seoDescription: z.string().nullish(),
  ogImageUrl: z.string().nullish(),
});

/** Start a new page as a draft. Nothing is public until it is published. */
export async function createPage(ctx: Ctx, raw: z.input<typeof createPageInput>): Promise<PageForEdit> {
  const parsed = createPageInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That page is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  const venueId = input.venueId ?? null;
  await guard(ctx, venueId, 'manager');
  const content = parseContent({ title: input.title, blocks: input.blocks, seoTitle: input.seoTitle ?? null, seoDescription: input.seoDescription ?? null, ogImageUrl: input.ogImageUrl ?? null });
  try {
    const row = await ctx.db
      .insertInto('pages')
      .values({ org_id: ctx.orgId, venue_id: venueId, slug: input.slug, title: content.title, blocks: json([]), status: 'draft', draft: json(content) })
      .returning(COLS)
      .executeTakeFirstOrThrow();
    await audit(ctx, { action: 'page.created', entityType: 'page', entityId: row.id, venueId, after: { slug: row.slug, title: row.title } });
    return forEdit(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('A page with that address already exists.');
    throw e;
  }
}

export const savePageDraftInput = z.object({
  pageId: z.string(),
  title: z.string().optional(),
  blocks: z.array(z.unknown()).optional(),
  seoTitle: z.string().nullable().optional(),
  seoDescription: z.string().nullable().optional(),
  ogImageUrl: z.string().nullable().optional(),
});

/** Save the working copy. The published page is untouched until publishPage. */
export async function savePageDraft(ctx: Ctx, raw: z.input<typeof savePageDraftInput>): Promise<PageForEdit> {
  const input = savePageDraftInput.parse(raw);
  const row = await loadPage(ctx, input.pageId);
  await guard(ctx, row.venue_id, 'manager');
  const base = draftContent(row) ?? liveContent(row);
  const content = parseContent({
    title: input.title ?? base.title,
    blocks: input.blocks ?? base.blocks,
    seoTitle: input.seoTitle !== undefined ? input.seoTitle : base.seoTitle,
    seoDescription: input.seoDescription !== undefined ? input.seoDescription : base.seoDescription,
    ogImageUrl: input.ogImageUrl !== undefined ? input.ogImageUrl : base.ogImageUrl,
  });
  const updated = await ctx.db.updateTable('pages').set({ draft: json(content) }).where('id', '=', row.id).returning(COLS).executeTakeFirstOrThrow();
  await audit(ctx, { action: 'page.draft_saved', entityType: 'page', entityId: row.id, venueId: row.venue_id, after: { title: content.title, blocks: content.blocks.length } });
  return forEdit(updated);
}

/** Throw away unpublished edits to a published page. */
export async function discardPageDraft(ctx: Ctx, input: { pageId: string }): Promise<PageForEdit> {
  const row = await loadPage(ctx, input.pageId);
  await guard(ctx, row.venue_id, 'manager');
  if (!isPublished(row)) throw invalid('This page has never been published, so there is nothing to go back to.');
  const updated = await ctx.db.updateTable('pages').set({ draft: null }).where('id', '=', row.id).returning(COLS).executeTakeFirstOrThrow();
  await audit(ctx, { action: 'page.draft_discarded', entityType: 'page', entityId: row.id, venueId: row.venue_id });
  return forEdit(updated);
}

async function writePublished(ctx: Ctx, scope: WebsiteScope, row: Row, content: PageContent, via: 'console' | 'assistant' | 'provisioning', draft: PageContent | null): Promise<PublishResult> {
  const now = ctx.now();
  await ctx.db
    .updateTable('pages')
    .set({
      title: content.title,
      blocks: json(content.blocks),
      seo_title: content.seoTitle,
      seo_description: content.seoDescription,
      og_image_url: content.ogImageUrl,
      status: 'published',
      published_at: now,
      draft: draft ? json(draft) : null,
    })
    .where('id', '=', row.id)
    .execute();
  await track(
    ctx,
    pagePublished,
    { page_id: row.id, slug: row.slug, scope: row.venue_id ? 'venue' : 'org', blocks: content.blocks.length, via },
    { venueId: row.venue_id, source: via === 'assistant' ? 'agent' : 'server' },
  );
  const revalidateTags = tagsFor(ctx, scope, row, content.blocks);
  revalidateAfterCommit(ctx, revalidateTags);
  return { pageId: row.id, venueId: row.venue_id, slug: row.slug, publishedAt: now, revalidateTags };
}

/**
 * Make the working copy the public page. Returns the cache tags to revalidate: the org, the
 * page, and the menu of each venue whose live menu the page shows.
 */
export async function publishPage(ctx: Ctx, input: { pageId: string }, via: 'console' | 'provisioning' = 'console'): Promise<PublishResult> {
  const row = await loadPage(ctx, input.pageId);
  const scope = await guard(ctx, row.venue_id, 'manager');
  const content = parseContent(draftContent(row) ?? liveContent(row));
  if (!content.blocks.length) throw invalid('Add at least one section before publishing.');
  const before = isPublished(row) ? liveContent(row) : null;
  const result = await writePublished(ctx, scope, row, content, via, null);
  await audit(ctx, { action: 'page.published', entityType: 'page', entityId: row.id, venueId: row.venue_id, before, after: content });
  return result;
}

/** Take a page off the site. Its content is kept as the working copy. */
export async function unpublishPage(ctx: Ctx, input: { pageId: string }): Promise<{ pageId: string; revalidateTags: string[] }> {
  const row = await loadPage(ctx, input.pageId);
  const scope = await guard(ctx, row.venue_id, 'manager');
  if (row.slug === 'home') throw invalid('The home page cannot be taken down on its own. Edit it, or switch the website off.');
  if (!isPublished(row)) return { pageId: row.id, revalidateTags: [] };
  const live = liveContent(row);
  await ctx.db
    .updateTable('pages')
    .set({ status: 'draft', draft: json(draftContent(row) ?? live) })
    .where('id', '=', row.id)
    .execute();
  await audit(ctx, { action: 'page.unpublished', entityType: 'page', entityId: row.id, venueId: row.venue_id, before: live });
  await track(ctx, pageUnpublished, { page_id: row.id, slug: row.slug, scope: row.venue_id ? 'venue' : 'org' }, { venueId: row.venue_id });
  const revalidateTags = tagsFor(ctx, scope, row, live.blocks);
  revalidateAfterCommit(ctx, revalidateTags);
  return { pageId: row.id, revalidateTags };
}

export async function deletePage(ctx: Ctx, input: { pageId: string }): Promise<{ revalidateTags: string[] }> {
  const row = await loadPage(ctx, input.pageId);
  const scope = await guard(ctx, row.venue_id, 'manager');
  if (row.slug === 'home') throw invalid('The home page cannot be deleted.');
  await ctx.db.deleteFrom('pages').where('id', '=', row.id).execute();
  await audit(ctx, { action: 'page.deleted', entityType: 'page', entityId: row.id, venueId: row.venue_id, before: { slug: row.slug, published: isPublished(row) ? liveContent(row) : null, draft: draftContent(row) } });
  const revalidateTags = isPublished(row) ? tagsFor(ctx, scope, row, liveContent(row).blocks) : [];
  revalidateAfterCommit(ctx, revalidateTags);
  return { revalidateTags };
}

const normaliseSlug = (slug: string) => {
  const s = slug.trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  return s === '' ? 'home' : s;
};

async function findBySlug(ctx: Ctx, venueId: string | null, slug: string, publishedOnly: boolean): Promise<Row | null> {
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return null;
  let q = ctx.db
    .selectFrom('pages')
    .select(COLS)
    .where('slug', '=', slug)
    .where((eb) => (venueId ? eb.or([eb('venue_id', '=', venueId), eb('venue_id', 'is', null)]) : eb('venue_id', 'is', null)));
  if (publishedOnly) q = q.where('status', '=', 'published');
  const rows = await q.execute();
  // A venue's own page wins over the org-level page of the same address.
  return rows.find((r) => r.venue_id !== null) ?? rows[0] ?? null;
}

function toPublic(ctx: Ctx, scope: WebsiteScope, row: Row, content: PageContent): PublicPage {
  const enabled = new Set<string>(scope.config.enabledBlocks);
  const blocks = content.blocks.filter((b) => enabled.has(b.type));
  return {
    id: row.id,
    venueId: row.venue_id,
    slug: row.slug,
    title: content.title,
    blocks,
    seo: { title: content.seoTitle, description: content.seoDescription, ogImageUrl: content.ogImageUrl },
    publishedAt: row.published_at,
    cacheTags: tagsFor(ctx, scope, row, blocks),
  };
}

export const getPageInput = z.object({ venueId: z.string().uuid().nullish(), slug: z.string().max(200).default('home') });

/**
 * A published page, as the public site renders it. No role: the caller is whoever is visiting
 * the site of the org this transaction acts for. A draft, a page of another org and a page at
 * a venue with the website off are all simply not found. With a venueId, the venue's own page
 * is used when it has one, otherwise the org-level page of the same address.
 */
export async function getPage(ctx: Ctx, raw: z.input<typeof getPageInput>): Promise<PublicPage> {
  const parsed = getPageInput.safeParse(raw);
  if (!parsed.success) throw notFound('Page not found');
  const venueId = parsed.data.venueId ?? null;
  const scope = await assertWebsite(ctx, venueId);
  const row = await findBySlug(ctx, venueId, normaliseSlug(parsed.data.slug), true);
  if (!row) throw notFound('Page not found');
  return toPublic(ctx, scope, row, liveContent(row));
}

/** The working copy of a page, rendered the way the public page would be. Staff only. */
export async function getPagePreview(ctx: Ctx, raw: z.input<typeof getPageInput>): Promise<PublicPage> {
  const parsed = getPageInput.safeParse(raw);
  if (!parsed.success) throw notFound('Page not found');
  const venueId = parsed.data.venueId ?? null;
  const scope = await guard(ctx, venueId, 'read_only');
  const row = await findBySlug(ctx, venueId, normaliseSlug(parsed.data.slug), false);
  if (!row) throw notFound('Page not found');
  return { ...toPublic(ctx, scope, row, draftContent(row) ?? liveContent(row)), cacheTags: [] };
}

/** Published pages of a site, for navigation and the sitemap. Public. */
export async function listPublishedPages(
  ctx: Ctx,
  input: { venueId?: string | null } = {},
): Promise<Array<{ id: string; venueId: string | null; slug: string; title: string; publishedAt: Date | null; blockTypes: Block['type'][] }>> {
  const venueId = input.venueId ?? null;
  await assertWebsite(ctx, venueId);
  const rows = await ctx.db
    .selectFrom('pages')
    .select(COLS)
    .where('status', '=', 'published')
    .where((eb) => (venueId ? eb.or([eb('venue_id', '=', venueId), eb('venue_id', 'is', null)]) : eb('venue_id', 'is', null)))
    .orderBy('created_at')
    .orderBy('slug')
    .execute();
  const bySlug = new Map<string, Row>();
  for (const r of rows) if (!bySlug.has(r.slug) || r.venue_id !== null) bySlug.set(r.slug, r);
  return [...bySlug.values()].map((r) => ({ id: r.id, venueId: r.venue_id, slug: r.slug, title: r.title, publishedAt: r.published_at, blockTypes: readBlocks(r.blocks).map((b) => b.type) }));
}

export const ensureDefaultPagesInput = z.object({
  venueId: z.string().uuid().nullish(),
  /** Defaults to the venue's configured skeleton, then the org brand's. */
  skeleton: z.enum(SKELETON_KEYS).optional(),
  copy: z.unknown(),
  publish: z.boolean().default(true),
});

export interface EnsureDefaultPagesResult {
  skeleton: SkeletonKey;
  created: Array<{ id: string; slug: string }>;
  /** Addresses that already had a page and were left exactly as they were. */
  skipped: string[];
  revalidateTags: string[];
}

/**
 * Give a site its starting pages: the skeleton's composition filled from the venue's intake
 * copy. Safe to run again: an address that already has a page is never overwritten.
 */
export async function ensureDefaultPages(
  ctx: Ctx,
  raw: { venueId?: string | null; skeleton?: SkeletonKey; copy: DefaultPageCopy; publish?: boolean },
  via: 'console' | 'provisioning' = 'console',
): Promise<EnsureDefaultPagesResult> {
  const input = ensureDefaultPagesInput.parse(raw);
  const venueId = input.venueId ?? null;
  const scope = await guard(ctx, venueId, 'manager');
  const skeleton = input.skeleton ?? (venueId ? scope.config.skeleton : null) ?? (await getBrand(ctx, { venueId })).skeleton;
  let pages;
  try {
    pages = buildDefaultPages(skeleton, input.copy as DefaultPageCopy);
  } catch (e) {
    if (e instanceof z.ZodError) throw invalid(e.issues[0]?.message ?? 'That copy is not valid.', { issues: e.issues });
    throw e;
  }

  const existing = await ctx.db
    .selectFrom('pages')
    .select('slug')
    .where((eb) => (venueId ? eb('venue_id', '=', venueId) : eb('venue_id', 'is', null)))
    .execute();
  const have = new Set(existing.map((r) => r.slug));

  const result: EnsureDefaultPagesResult = { skeleton, created: [], skipped: [], revalidateTags: [] };
  const tags = new Set<string>();
  for (const page of pages) {
    if (have.has(page.slug)) {
      result.skipped.push(page.slug);
      continue;
    }
    const content: PageContent = { title: page.title, blocks: page.blocks, seoTitle: page.seoTitle, seoDescription: page.seoDescription, ogImageUrl: null };
    const row = await ctx.db
      .insertInto('pages')
      .values({ org_id: ctx.orgId, venue_id: venueId, slug: page.slug, title: page.title, blocks: json([]), status: 'draft', draft: json(content) })
      .returning(COLS)
      .executeTakeFirstOrThrow();
    result.created.push({ id: row.id, slug: row.slug });
    if (input.publish) {
      const published = await writePublished(ctx, scope, row, content, via, null);
      for (const t of published.revalidateTags) tags.add(t);
    }
    await audit(ctx, { action: input.publish ? 'page.published' : 'page.created', entityType: 'page', entityId: row.id, venueId, after: content });
  }
  result.revalidateTags = [...tags];
  return result;
}

// ── Copy changes to one block (the assistant's tool, and a quick edit in the console) ───────

export const blockCopyInput = z.object({
  pageId: z.string(),
  blockId: z.string().max(40),
  /** field → new text. Only the block's own text fields; links, images and lists are edited in the console. */
  changes: z.record(z.string(), z.string().nullable()),
});

export interface BlockCopyChange {
  field: string;
  before: string | null;
  after: string | null;
}

export interface BlockCopyPreview {
  pageId: string;
  venueId: string | null;
  slug: string;
  pageTitle: string;
  blockId: string;
  blockType: Block['type'];
  changes: BlockCopyChange[];
}

interface PlannedCopy {
  row: Row;
  scope: WebsiteScope;
  live: PageContent;
  nextBlock: Block;
  preview: BlockCopyPreview;
}

async function planBlockCopy(ctx: Ctx, raw: z.input<typeof blockCopyInput>): Promise<PlannedCopy> {
  const input = blockCopyInput.parse(raw);
  const row = await loadPage(ctx, input.pageId);
  const scope = await guard(ctx, row.venue_id, 'manager');
  if (!isPublished(row)) throw invalid('That page is not published yet. Publish it from the console first.');
  const live = liveContent(row);
  const block = live.blocks.find((b) => b.id === input.blockId);
  if (!block) throw notFound('That section is not on the published page.');

  const allowed = BLOCK_TEXT_FIELDS[block.type];
  const fields = Object.keys(input.changes);
  if (!fields.length) throw invalid('Say which wording to change.');
  const unknown = fields.filter((f) => !allowed.includes(f));
  if (unknown.length) throw invalid(`A ${block.type} section has no text called ${unknown.join(', ')}. It has: ${allowed.join(', ')}.`);

  const parsed = blockSchema.safeParse({ ...block, ...input.changes });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw invalid(first ? `${first.path.join('.')}: ${first.message}` : 'That wording is not valid.', { issues: parsed.error.issues });
  }
  const current = block as unknown as Record<string, string | null>;
  const next = parsed.data as unknown as Record<string, string | null>;
  const changes = fields
    .map((field) => ({ field, before: current[field] ?? null, after: next[field] ?? null }))
    .filter((c) => c.before !== c.after);
  return {
    row,
    scope,
    live,
    nextBlock: parsed.data,
    preview: { pageId: row.id, venueId: row.venue_id, slug: row.slug, pageTitle: live.title, blockId: block.id, blockType: block.type, changes },
  };
}

/** What a copy change would do, without doing it: each field's wording before and after. */
export async function previewBlockCopy(ctx: Ctx, raw: z.input<typeof blockCopyInput>): Promise<BlockCopyPreview> {
  return (await planBlockCopy(ctx, raw)).preview;
}

export interface BlockCopyResult extends BlockCopyPreview {
  publishedAt: Date;
  revalidateTags: string[];
}

/**
 * Change the wording of one block on a published page and publish that change. Only this
 * change goes live: other edits waiting in the page's working copy stay unpublished, and the
 * working copy receives the same wording so it is not lost at the next publish.
 */
export async function updateBlockCopy(ctx: Ctx, raw: z.input<typeof blockCopyInput>, via: 'console' | 'assistant' = 'console'): Promise<BlockCopyResult> {
  const plan = await planBlockCopy(ctx, raw);
  const { row, live, preview } = plan;
  if (!preview.changes.length) return { ...preview, publishedAt: row.published_at ?? ctx.now(), revalidateTags: [] };

  const content: PageContent = { ...live, blocks: live.blocks.map((b) => (b.id === preview.blockId ? plan.nextBlock : b)) };
  let draft = draftContent(row);
  if (draft) {
    const patch = Object.fromEntries(preview.changes.map((c) => [c.field, c.after]));
    draft = {
      ...draft,
      blocks: draft.blocks.map((b) => {
        if (b.id !== preview.blockId || b.type !== preview.blockType) return b;
        const merged = blockSchema.safeParse({ ...b, ...patch });
        return merged.success ? merged.data : b;
      }),
    };
  }
  const published = await writePublished(ctx, plan.scope, row, content, via, draft);
  await audit(ctx, {
    action: 'page.copy_updated',
    entityType: 'page',
    entityId: row.id,
    venueId: row.venue_id,
    before: Object.fromEntries(preview.changes.map((c) => [`${preview.blockId}.${c.field}`, c.before])),
    after: Object.fromEntries(preview.changes.map((c) => [`${preview.blockId}.${c.field}`, c.after])),
  });
  return { ...preview, publishedAt: published.publishedAt, revalidateTags: published.revalidateTags };
}

export interface PageCopy {
  pageId: string;
  venueId: string | null;
  slug: string;
  title: string;
  blocks: Array<{ blockId: string; type: Block['type']; text: Record<string, string | null> }>;
}

/** The wording on a site's published pages, block by block. Staff only. */
export async function listPageCopy(ctx: Ctx, input: { venueId?: string | null; slug?: string } = {}): Promise<PageCopy[]> {
  const venueId = input.venueId ?? null;
  await guard(ctx, venueId, 'read_only');
  let q = ctx.db
    .selectFrom('pages')
    .select(COLS)
    .where('status', '=', 'published')
    .where((eb) => (venueId ? eb.or([eb('venue_id', '=', venueId), eb('venue_id', 'is', null)]) : eb('venue_id', 'is', null)))
    .orderBy('created_at')
    .orderBy('slug');
  if (input.slug) q = q.where('slug', '=', normaliseSlug(input.slug));
  // Where a venue has its own page at an address, that is the one its site shows.
  const bySlug = new Map<string, Row>();
  for (const r of await q.execute()) if (!bySlug.has(r.slug) || r.venue_id !== null) bySlug.set(r.slug, r);
  return [...bySlug.values()].map((r) => ({
    pageId: r.id,
    venueId: r.venue_id,
    slug: r.slug,
    title: r.title,
    blocks: readBlocks(r.blocks).map((b) => ({
      blockId: b.id,
      type: b.type,
      text: Object.fromEntries(BLOCK_TEXT_FIELDS[b.type].map((f) => [f, ((b as unknown as Record<string, string | null>)[f] ?? null) as string | null])),
    })),
  }));
}
