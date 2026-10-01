# MODULE — `website` (theming & content)

Delivers visually distinct restaurant sites from one codebase.

## 1. The two dimensions

**Design tokens** (per org, optional per-venue override) × **layout skeleton** (one of 4–6).

```jsonc
// brands.tokens
{
  "typography": {
    "heading": { "family": "Fraunces", "weights": [400,700], "scale": 1.25, "tracking": "-0.02em" },
    "body":    { "family": "Inter",    "weights": [400,500], "size": 16, "leading": 1.6 },
    "fallback": "system-ui, sans-serif"
  },
  "colour": {
    "primary": "#8B2F2F", "primaryContrast": "#FFFFFF",
    "secondary": "#2F4858", "accent": "#D4A574",
    "surface": "#FFFDF8", "surfaceAlt": "#F3EDE3",
    "text": "#1A1614", "textMuted": "#6B615A", "border": "#E2D9CC",
    "success": "#2E7D5B", "warning": "#B5760F", "error": "#B3261E"
  },
  "radius": { "sm": 2, "md": 6, "lg": 16, "pill": 999 },
  "spacing": { "unit": 4, "sectionY": 96 },
  "imagery": { "ratio": "4:3", "treatment": "warm", "corner": "md" },
  "density": "comfortable"
}
```

Emitted as CSS custom properties on the root layout. **No per-tenant CSS files, ever.**

Google Fonts is the pragmatic font source (a curated allowlist of ~20 faces at onboarding —
unlimited font choice creates unlimited licensing and performance problems). Every face needs
a real fallback stack.

## 2. Layout skeletons

Hand-designed React layout archetypes, not a slot-filling template engine:

| Skeleton | Suits |
|---|---|
| `hero-photo` | food-led, image-heavy, casual |
| `editorial` | chef-led, story-first, fine dining |
| `menu-forward` | menu is the landing page — cafés, takeaway |
| `minimal` | wine bars, omakase, small rooms |
| `split-panel` | two-column, strong for venue + booking side by side |
| `single-scroll` | one-page, everything inline, food trucks / pop-ups |

6 skeletons × distinct tokens reads as genuinely different sites while remaining one codebase.
Adding skeleton #7 later upgrades every future tenant. Resist per-tenant custom layouts — the
first one you build is the moment the model breaks.

## 3. Content

```sql
pages(id, org_id, venue_id NULL, slug, title, blocks jsonb, seo_*, published_at)
```

Block types: `hero` · `about` · `menu` (pulls live from the `ordering` menu model) · `gallery`
· `hours-location` · `booking-cta` · `testimonials` · `faq` · `contact` · `rich-text` ·
`instagram-feed` · `criota-reel` (creator UGC embedded on the venue's own site — this is where
the two ventures visibly meet).

Restaurant edits content in the console; publish triggers `revalidateTag('org:<id>')`.

## 4. Rendering & caching

Static render + tag-based revalidation, per tenant. `cacheTag('org:<id>')`,
`cacheTag('menu:<venue_id>')`, `cacheTag('page:<page_id>')`. A menu edit busts one venue's
menu, nothing else. Without per-tenant tags you either serve stale menus or rebuild the world
on every edit — at 300 venues only one of those is survivable.

## 5. SEO — a real deliverable, and a real liability

You are taking over their organic traffic. Get these right or you will cost restaurants money:

- Per-venue `LocalBusiness` + `Restaurant` structured data (address, geo, hours, price range,
  cuisine, menu URL, accepts reservations)
- `Menu` structured data from the live menu model
- Canonical URLs, per-page meta, OG images generated from brand tokens
- **301 redirect map imported from their old site during onboarding** — the single biggest
  cause of traffic collapse in a website migration, and the step most likely to get skipped
- `sitemap.xml` + `robots.txt` per domain
- Core Web Vitals budget enforced in CI; a slow template hurts every tenant at once

## 6. Domain lifecycle

1. Onboard → live immediately on `<org-slug>.<platform-domain>`
2. Restaurant provides DNS access → add custom domain via the Vercel Domains API,
   surface the required records, poll for verification
3. Verified → custom domain becomes primary, subdomain 301s to it
4. Old site redirects imported and live before the DNS cutover, not after

## 7. Config surface

`skeleton` · `enabled_blocks[]` · `nav_items[]` · `booking_cta_target` · `order_cta_target`
· `social_links` · `google_analytics_id` · `custom_head_snippet` (allowlisted, sanitised)
