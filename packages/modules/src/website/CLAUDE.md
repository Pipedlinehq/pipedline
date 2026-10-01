# website — module guide

## What it owns

The venue's own site: brand tokens and logo (org brand plus per-venue override), a layout
skeleton, pages built from typed blocks with a draft / published split, an image library, and
redirects from an old site. Plus pure helpers for CSS variables, JSON-LD, sitemap and robots.

- Tables (`websiteModule.tables`): `brands`, `pages`, `media`, `redirects`.
- Toggleable (key `website`). `dependsOn: []`. Reads `tenancy` (org, venues, `domains`) and the menu's `PublicMenu` type for `menuJsonLd`.
- Gate: `assertWebsite(ctx, venueId | null)` (exported) — a venue's site needs the module on there; the org-level site (`venueId` null) needs it on at any venue and takes config from the oldest such venue.
- Guest text: `safe.ts` (`plainText`, `looksLikeMarkup`, `sitePath`, `httpsUrl`, `linkUrl`, `httpsUrlOn`) rejects markup and off-site / non-https links in blocks and config.

## Public functions by purpose

Console (pages: role check then `assertWebsite`; a page at a venue the caller has no role at is not found):
- `listPages(ctx, { venueId? })`, `getPageForEdit(ctx, { pageId })`, `getPagePreview(ctx, getPageInput)`, `listPageCopy(ctx, { venueId?, slug? })` — `read_only`.
- `createPage`, `savePageDraft`, `discardPageDraft`, `publishPage(ctx, { pageId }, via?)`, `unpublishPage`, `deletePage` — manager. Publish/unpublish track events and revalidate cache tags after commit.
- `previewBlockCopy(ctx, blockCopyInput)`, `updateBlockCopy(ctx, blockCopyInput, via?)` — manager; change the text fields of one block on a published page and publish only that.
- `ensureDefaultPages(ctx, { venueId?, skeleton?, copy, publish? })` — manager; builds the skeleton's starting pages from intake copy; never overwrites an existing slug. Called by `onboarding/steps.ts`.
- `getBrandForEdit(ctx, { venueId? })`, `setBrand(ctx, setBrandInput)`, `clearBrandOverride(ctx, { venueId })` — manager (no `assertWebsite`). Merged tokens must pass `brandTokensSchema` (allowlisted fonts, contrast pairs). `getToneOfVoice(ctx)` — any staff.
- `uploadMedia(app, orgId, principal, { contentType, body, alt? })` — app-level, manager; image bytes sniffed, max `MAX_IMAGE_BYTES` (8 MB), `MAX_MEDIA_PER_ORG` 2000; storage call between two transactions. `listMedia(ctx)` (any staff), `setMediaAlt(ctx, ...)` (manager), `removeMedia(app, orgId, principal, { mediaId })` (manager).
- `importRedirects(ctx, importRedirectsInput)` (manager, max `MAX_REDIRECTS` 5000), `listRedirects(ctx)` (any staff), `removeRedirect(ctx, { redirectId })` (manager). Helpers: `parseSitemapXml`, `suggestRedirects`, `normaliseRedirectFrom`.
- `exportWebsiteData(ctx)` — owner; registered as the `website` org export provider by `onboarding/offboarding.ts`.

Guest-facing / public (no role; org from the host):
- `getSite(ctx, { venueId? })` — brand, navigation, config, venue details and hours for the layout.
- `getPage(ctx, { venueId?, slug })` — published content only. `listPublishedPages(ctx, ...)`.
- `getBrand(ctx, { venueId? })` — no role and no module check.
- `getSitemap(ctx, { venueId? })`, `getRobots(ctx, { venueId?, host })`.
- `resolveRedirect(ctx, { path })` — counts the hit, follows chains; null when the module is off.

Pure helpers: `resolveTokens`, `brandCss`, `brandCssVariables`, `googleFontsHref`, `contrastRatio`, `listSkeletons`, `getSkeleton`, `regionFor`, `defaultNav`, `buildDefaultPages`, `readBlocks`, `restaurantJsonLd`, `menuJsonLd`, `validateRestaurantJsonLd`, `serializeJsonLd`, `buildSitemapEntries`, `robotsRules`, `robotsTxt`.

## Hooks

- Defines `onRevalidate(fn)` (`revalidate.ts`, hook list `website.revalidators`): the web app is meant to register Next's `revalidateTag` once. `revalidateAfterCommit(ctx, tags)` runs every registered revalidator after commit. Tags: `cacheTags.org`, `cacheTags.page`, `cacheTags.menu`.
- Currently registered only in `packages/modules/test/website-onboarding/site-pages.test.ts`; nothing in `apps/web/src` calls `onRevalidate`.
- Registers on no other module's hooks.

## Config surface (`websiteConfig`, per venue)

- `skeleton` — the venue's layout skeleton (`SKELETON_KEYS`: hero-photo, editorial, menu-forward, minimal, split-panel, single-scroll); null follows the org brand.
- `enabledBlocks` — block types this venue may show (`BLOCK_TYPES`); a disabled type stays stored and is hidden.
- `navItems` — up to 8 `{ label, href }`; null uses the skeleton default.
- `bookingCtaTarget`, `orderCtaTarget` — default targets for Book / Order buttons.
- `socialLinks` — instagram, facebook, tiktok, x, youtube, tripadvisor, googleBusiness; each accepted only on its own host.
- `integrations` — `googleAnalyticsId` (`G-…`), `metaPixelId` (digits), `googleSiteVerification`. Ids only; no free head snippet.

Org-level brand lives in `brands` (row with `venue_id` null), not a settings namespace.

## Jobs, schedules, events, templates, tools

- Jobs / schedules / templates: none.
- Events: `page.published` (via console, assistant or provisioning), `page.unpublished`, `brand.updated`.
- Tools: `page_copy` (read, scope `website:read`), `page_update_copy` (write, scope `website:write`, `minRole: 'manager'`, `propose` + `commit` via `updateBlockCopy`).

## Simulated vs real

- Uses `app.adapters.storage` (`StoragePort`: `put`, `remove`) for media. Only the simulator exists (`createSimStorage` in `packages/adapters/src/sim/llm.ts`); no real storage adapter in `packages/adapters/src`.

## Known gaps

- `removeMedia`: if the storage delete fails the object is left behind; the code says it "is swept later", but no sweep job exists in the module.
- `ensureDefaultPages` leaves `rich-text` and `criota-reel` blocks out of starting pages ("added by the venue later").
- Cache revalidation has no production registration yet (see Hooks).
