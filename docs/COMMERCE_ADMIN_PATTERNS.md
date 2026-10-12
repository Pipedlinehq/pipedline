# Commerce admin patterns: what Shopify publishes, and the hospitality translation

Research pass, 2026-10-12. Depth companion to `CONSOLE_IA.md` (the sections) and `MODULES.md`
(what exists). Method: **study the public specification**. Everything here was read from pages
Shopify publishes without sign-in: help.shopify.com, shopify.dev reference pages, the
changelog, and the public app-design guidance that replaced the Polaris guideline site. No
admin was signed into, no screenshot of a logged-in admin was read, no JavaScript bundle or
code was downloaded or analysed. Polaris **code** is not used (its licence restricts standalone
products; see §0.3).

Tags: **[V]** verified on the public page at the URL given. **[S]** secondary (an indexed
snippet of a page that no longer resolves, or a page that names but does not define a thing).
**[U]** unverified: stated from memory or inference, to be checked before anyone builds on it.

Vocabulary rule for everything in a "hospitality translation" block (from `CONSOLE_IA.md`):
covers, service, docket, 86'd, pass, front of house. Never "SKU", "fulfilment", "inventory",
"merchant" in our UI. Shopify's own words are quoted in the Shopify blocks only.

---

## 0. Findings that change how to read this document

### 0.1 shopify.dev's Admin API reference is readable without an account [V]

- A bare `curl -L` with no cookies returns HTTP 200 for
  `https://shopify.dev/docs/api/admin-graphql/latest/objects/QueryRoot` and for every reference
  page tried; appending `.md` to any reference URL returns a Markdown rendering (also 200)
  [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/QueryRoot.md].
- The landing page says nothing about needing an account to read; its authentication section is
  about *calling* the API ("Every GraphQL Admin API request carries an access token in the
  `X-Shopify-Access-Token` header") [V: https://shopify.dev/docs/api/admin-graphql/latest].
- **The exact QueryRoot URL is** `https://shopify.dev/docs/api/admin-graphql/latest/objects/QueryRoot`
  (current version label 2026-10). **Caveat:** as rendered today the page carries only the
  description ("The schema's entry-point for queries") and a "Map" section listing
  `Job.query`; it does **not** enumerate the query fields. The queries live as one page each at
  `/docs/api/admin-graphql/latest/queries/<name>` (e.g. `orders`, `customers`, `products`,
  `segments`, `abandonedCheckouts`, `orderSavedSearches`), and `/queries` as an index returns 404
  [V: curl 200/404 checks, 2026-10-12].
- help.shopify.com returns **403 to a bare curl** (bot filter) but serves every page to an
  ordinary fetcher/browser; it is public, just not scriptable with curl [V: curl checks].

### 0.2 The Polaris guideline site is gone from its old URLs [V]

Every `polaris.shopify.com/...` and `polaris-react.shopify.com/...` URL tried (content:
voice-and-tone, actionable-language, error-messages, help-documentation, fundamentals; patterns:
resource-index-layout, resource-details-layout, common-actions, app-settings-layout; components:
empty-state, badge, modal; legal/license) now **301-redirects to**
`https://shopify.dev/docs/api/polaris`, which describes Polaris only as "Shopify's unified UI
framework built on web components" and has no content or pattern sections
[V: https://shopify.dev/docs/api/polaris]. Search engines still index the old pages; those
snippets are cited below as [S].

What replaced them, and what §1 is built from:
- **Built for Shopify design requirements** (the UX rulebook) [V: https://shopify.dev/docs/apps/launch/built-for-shopify/requirements]
- **App design: layout** and **app structure** [V: https://shopify.dev/docs/apps/design/layout; https://shopify.dev/docs/apps/design/app-structure]
- **App Home patterns**: templates (Homepage, Index, Details, Settings) and compositions (Index
  table, Setup guide, Metrics card, Footer help, Callout card…) [V: https://shopify.dev/docs/api/app-home/latest/patterns]
- **Web component pages** with best-practice and content guidance (Button, Modal, Badge, Banner,
  Empty state) [V: https://shopify.dev/docs/api/app-home/latest/web-components]

### 0.3 Polaris licence (why we build our own) [S]

The indexed copy of `polaris.shopify.com/legal/license` says apps that do not integrate with
Shopify may be built with Polaris only if they are "dissimilar and visually distinct from
Shopify products and services, including the internal administration page of a Shopify merchant
store", at Shopify's sole discretion [S: https://polaris.shopify.com/legal/license — now 301s].
The GitHub LICENSE file was **not** read (outside the boundary). `CONSOLE_IA.md`'s decision
stands: structure and vocabulary only; our own look, our own code.

### 0.4 Renames and moves since most people last looked [V]

- **Marketing → Growth.** Changelog 2026-06-17: "The Marketing tab is now the Growth tab",
  holding Campaigns, Attribution and Campaign Autopilot; "Automations now live in the Shopify
  Messaging app" [V: https://changelog.shopify.com/posts/the-marketing-tab-is-now-the-growth-tab].
- **Shopify Email → Shopify Messaging** ("Shopify Messaging, formerly known as Shopify Email";
  SMS added) [V: https://changelog.shopify.com/posts/shopify-messaging-now-supports-sms-marketing].
- **Blogs moved into Content** (2025-03-20): "access your blogs, metaobjects, and files all
  within the Content section" [V: https://changelog.shopify.com/posts/blogs-moved-to-the-content-section-in-admin];
  **Menus** are at Content > Menus [V: https://help.shopify.com/en/manual/online-store/menus-and-links].
- **Orders help lives under Fulfillment.** `/en/manual/orders` serves a page whose sub-pages
  are all `/manual/fulfillment/...` [V: https://help.shopify.com/en/manual/orders].
- A **"refreshed design"** of the admin is rolling out that moves search and the store switcher
  into the sidebar [V: https://help.shopify.com/en/manual/shopify-admin/shopify-admin-overview].
- **Product status `UNLISTED`** (API 2025-10+): active but reachable only by direct link
  [V: https://shopify.dev/docs/api/admin-graphql/latest/enums/ProductStatus].

---

## 1. Cross-cutting conventions (the "how every page works" layer)

### 1.1 Index pages: views, filters, search, sort, columns

**Two list styles exist** [V: https://help.shopify.com/en/manual/shopify-admin/productivity-tools/searching-filtering-views]:
- *Enhanced* (views in a menu; filters as tokens inside one search bar): Abandoned Checkouts,
  Collections, Companies, Customers, Discounts, Draft Orders, Files, Gift cards, Inventory,
  Metaobjects, Metaobject Entries, Orders, Products, Purchase orders, Transfers.
- *Tabbed* (views as tabs above the list; filters as tags under the search bar): Blog posts,
  Catalogs, Customer Segments, Marketing Automations, Marketing Campaigns, Reports, Shipping Labels.
- Users list has no custom views.

**Views** [V: same page]:
- Every list ships **default views** that "can't be renamed or deleted" (Discounts: All, Active,
  Scheduled, Expired; Products: All, Active, Draft, Archived [V: https://help.shopify.com/en/manual/products/searching-filtering];
  Orders: All, Unfulfilled, where Unfulfilled = fulfilment status unfulfilled or partially
  fulfilled, excluding cancelled or fully refunded [V: https://help.shopify.com/en/manual/fulfillment/managing-orders/viewing-orders/filtering-orders]).
- Create: customise **All**, **Save** → "Save view as"; or after filtering, **Save** > **Save as
  new view**; **Duplicate view**; **Rename view**; **Delete view** confirmed in a "Delete view?"
  dialog; **Update view** to save edits. Creating/renaming/deleting is desktop only.
- **Sort order is not saved with a view**; leaving resets it. Filter changes do save to any view
  except All [V: products page].
- **Column customisation** (hide, unhide, drag to reorder; leftmost fixed) on Orders, Inventory,
  Transfers, Purchase orders, Metaobjects; saved per view.
- **Hide archived** toggle where applicable.
- API mirror: `SavedSearch` ("a search query in the Shopify admin used on resource index views")
  with `name`, `query`, `searchTerms`, `filters`, `resourceType`; queries `orderSavedSearches`,
  `productSavedSearches`, `collectionSavedSearches`, `draftOrderSavedSearches`,
  `fileSavedSearches`, `codeDiscountSavedSearches`, `automaticDiscountSavedSearches`,
  `urlRedirectSavedSearches` [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/SavedSearch].
  `SearchResultType`: ARTICLE, BALANCE_TRANSACTION, BLOG, COLLECTION, CUSTOMER,
  DISCOUNT_REDEEM_CODE, DRAFT_ORDER, FILE, INVENTORY_TRANSFER, ORDER, PAGE, PRICE_RULE, PRODUCT,
  URL_REDIRECT [V: https://shopify.dev/docs/api/admin-graphql/latest/enums/SearchResultType].

**Search syntax** (the same grammar in the admin's search fields and the API `query` argument)
[V: https://shopify.dev/docs/api/usage/search-syntax; https://help.shopify.com/en/manual/shopify-admin/productivity-tools/searching-filtering-views]:
`field:value`, comparators `:` `:<` `:>` `:<=` `:>=`, implied AND, `OR`, `-`/`NOT`, quoted
phrases, `*` prefix and existence (`published_at:*`), quoted dates (`created_at:>'2020-10-21'`),
`metafields.{namespace}.{key}`; in the admin bar "commas act as or and spaces act as and", with
`is` / `is not`. Product search supports `title:ani*`, `tag:`, `AND NOT`.

**Per-list filters** are enumerated in each area below (Orders §2.2, Products §2.3, Discounts
§2.6). They are long: Orders alone has ~25 filters.

### 1.2 Bulk selection and bulk actions [V: https://help.shopify.com/en/manual/shopify-admin/productivity-tools/bulk-actions]

- Desktop: checkboxes, shift-click ranges, header checkbox selects the page; "Select all 50+
  items" on a store-wide view; "Select all results" for a filtered set over 50. Mobile: up to 25.
- Pages: Orders, Products, Customers (desktop and mobile); Discounts (desktop); Drafts,
  Abandoned checkouts, Transfers, Inventory, Collections, Gift cards, Files (desktop).
- Labels: Orders "Fulfill orders", "Capture order payments", "Print packing slips", "Archive
  orders", "Add tags", "Remove tags" (+ cancel, mark in progress/unfulfilled, app and Flow
  actions). Products "Make products available", "Make products unavailable", "Delete selected
  products", "Add to collection", "Remove from collection". Customers "Delete selected
  customers", tags. Discounts "Activate discounts", "Deactivate discounts", "Delete discounts".
- "Deleting list items requires an extra confirmation click." No undo is documented.
- Bulk cancel is capped at 250 orders and warns that the refund prompt may not appear
  [V: https://help.shopify.com/en/manual/fulfillment/managing-orders/canceling-orders].
- **Bulk editor** (spreadsheet-style) for products/variants, inventory, collections, customers:
  **Bulk edit** → **Columns** → edit cells → **Save**; error text "Update the invalid values,
  then save again"; CSV recommended for large sets [V: https://help.shopify.com/en/manual/shopify-admin/productivity-tools/bulk-editing].
- Index-table composition: when items are selected "a bulk action bar replaces the search and
  sort controls" showing "N of M selected"; destructive bulk actions confirm in a modal ("Delete 2
  puzzles?" … "cannot be undone"); completion is a toast ("2 puzzles archived"); pagination
  "Page X of Y"; status badges in a dedicated column; row actions revealed on hover
  [V: https://shopify.dev/docs/api/app-home/latest/patterns/compositions/index-table].
  The Index template says tables over 100 rows paginate, and the empty state "should only be
  visible if the merchant has not created any … yet" [V: https://shopify.dev/docs/api/app-home/latest/patterns/templates/resource-index].

### 1.3 Resource detail pages

- **Two columns**: main column for "information that defines the resource", aside for
  "supporting information such as status, metadata, and summaries"; breadcrumbs so the merchant
  can "return to the previous page without using the browser back button"; secondary actions
  (Duplicate, Delete) in the header; Delete is critical-tone and confirmed by a modal; in-page
  tables paginate past 10 rows [V: https://shopify.dev/docs/api/app-home/latest/patterns/templates/details].
  Older Polaris wording: defining information in the primary column, "status and metadata in the
  secondary column"; "typically paired with the resource index layout" [S: https://polaris.shopify.com/patterns/resource-details-layout].
- **Save bar**: "Form inputs should generally be saved using the App Bridge Contextual Save
  Bar"; the merchant must not be able to leave a form with unsaved changes except via Save or
  Discard [V: https://shopify.dev/docs/apps/launch/built-for-shopify/requirements §4.1.5].
  The Settings template "displays save/discard controls when the form has unsaved changes" and
  pairs the save with a toast [V: https://shopify.dev/docs/api/app-home/latest/patterns/templates/settings].
- **Overflow / "More actions"** on an order holds "View order status page" and "Cancel order"
  [V: https://help.shopify.com/en/manual/fulfillment/managing-orders/managing-order-details;
  https://help.shopify.com/en/manual/fulfillment/managing-orders/canceling-orders].
- **Layout rules**: most content in cards; "Avoid placing paragraphs of text directly on the
  background"; a card "should have at most one primary styled action"; no primary buttons in
  tables; 4px grid; "Avoid changing information density within a single page"
  [V: https://shopify.dev/docs/apps/design/layout]. Built for Shopify rejects "non-card
  containers", serif fonts, dark backgrounds, missing back buttons on sub-pages, and requires
  WCAG 2.1 AA contrast [V: requirements §4.1.1].

### 1.4 The Timeline (comments + system events on a record)

- Appears on **orders, draft orders, customers, transfers** (help centre)
  [V: https://help.shopify.com/en/manual/shopify-admin/productivity-tools/timeline] and on
  **discounts** ("records when the discount was created, when it became active or expired, when
  edits were saved") [V: https://help.shopify.com/en/manual/discounts/managing-discounts].
  API: `CommentEvent` is "A comment that staff members add to the timeline of" Order,
  DraftOrder, Customer, InventoryTransfer, Company, CompanyLocation, PriceRule; fields `author`,
  `canEdit`, `canDelete`, `edited`, `embed`, `attachments`, `rawMessage`
  [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/CommentEvent]. The `Event`
  interface: `action`, `message`, `createdAt`, `attributeToApp`, `attributeToUser`, `appTitle`,
  `criticalAlert` [V: https://shopify.dev/docs/api/admin-graphql/latest/interfaces/Event].
  Order/Customer `events` keep data for **one year** and can exclude comments
  [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/Order].
- Mechanics: "Leave a comment..." box → Post; **@mention** a staff member (they get an email,
  plus push if on the app; no notification without a mention; not notified if they lack access
  to that section); paper-clip attachments; emoji; **#** references to orders, drafts,
  customers, products, variants, transfers, purchase orders; edit only your own comment and only
  within **5 minutes**; delete is irreversible; comments "won't be visible to your customers"
  [V: timeline page].
- Payment events expand to "Information from the gateway"; under a sent email you can **resend**
  it to the customer or yourself [V: managing-order-details].

### 1.5 Actions, verbs and button labels

From the public Button guidance [V: https://shopify.dev/docs/api/app-home/latest/web-components/actions/button]:
primary "Should be used sparingly"; critical tone "only for destructive actions that are
difficult or impossible to undo"; labels use "strong, actionable verbs", **sentence case**, no
articles, no end punctuation, consistent placement; examples "Save changes", "Add product",
"Export products", "Print labels", "Delete variant" paired with "Cancel"; loading labels
describe the work ("Saving product...", "Updating 247 variants..."). Built for Shopify: "the
most logical action should appear visually dominant" [V: requirements §4.2.5].

Labels Shopify actually uses (all [V] at the pages cited in §2): Create order · Save · Save view
as · Update view · Delete view · Duplicate · Mark as paid · Send invoice · Reserve inventory ·
Fulfill orders · Capture order payments · Print packing slips · Archive orders · Add tags /
Remove tags · Cancel order · Refund · Restock items · Mark as ready for pickup · Mark as picked
up · Prepare delivery · Mark as ready for delivery · Mark as delivered · Cancel delivery ·
Activate discounts / Deactivate discounts / Delete discounts · Make products available /
unavailable · Add to collection · Turn on automation · Save without turning on · Add recipient ·
Send test notification · Suspend · Remove · Revoke Access · Clear history · Set limit.
Pattern: **verb + object noun**, past-tense only in status badges.

### 1.6 Destructive confirmations and modals [V: https://shopify.dev/docs/api/app-home/latest/web-components/overlays/modal]

Modal is "a last resort for important decisions"; never launch a modal from a modal; cannot open
on page load. For destructive or irreversible actions: explain consequences in the body, pair a
critical primary button with Cancel, use specific verbs ("Delete", "Save", "Continue") "instead
of vague labels like 'Yes,' 'OK,' or 'Submit'". Observed: "Delete view?" → **Delete view**;
cancel dialog's confirm is **Cancel order**; discount bulk delete "requires a confirmation
click"; Users "Remove permanently deletes the user, and this can't be undone".

### 1.7 Status badges [V: https://shopify.dev/docs/api/app-home/latest/web-components/feedback-and-status-indicators/badge]

Badges "communicate object states, order statuses, or system-generated classifications"; for
merchant-made labels use a **chip** instead. Tones: info, success, warning, critical, caution,
neutral, auto; "use the same tone for the same status across an app". Labels "1-2 words", past
tense ("Refunded" not "Refund"). Examples given: Fulfilled, Paid, Active, Draft, Open, On hold,
Action required, Attention needed, In stock, Low stock, Out of stock, Partially refunded,
Refunded, Scheduled, Archived. Index template mapping: Active→success, Draft→neutral,
Archived→info [V: index-table composition].

### 1.8 Empty states [V: https://shopify.dev/docs/api/app-home/latest/web-components/feedback-and-status-indicators/empty-state]

Use for empty lists, empty tables, unconfigured features, and filtered results that match
nothing (different wording from truly empty). Anatomy: optional single graphic, required plain
heading, optional subheading (links allowed), one primary action, optional secondary. "Say why
it's empty, then what to do." Examples: "Add your first product" / "Products you add here are
ready to sell across your sales channels" / **Add product**; "No customers yet" / "Import a
customer list, or wait for customers to place their first order" / Import customers + **Add
customer**; "No customers match those filters" / "Try changing the filters or the search term".

### 1.9 Errors, banners, toasts, voice

- Built for Shopify: "Errors should be red, guide merchants to solutions, and appear next to
  relevant fields when possible"; must not auto-dismiss, must be contextual, must not appear
  before interaction [V: requirements §4.2.4]. "Apps must use clear and easy to understand
  language, proper grammar, and proper spelling throughout" [§4.2.1]. Don'ts: no visible
  timers or guilt language, no red for non-errors, no "multiple banners", no unrelated
  auto-appearing modals, promos must be dismissible and stay dismissed [§4.3.2–4.3.6].
- Banner [V: https://shopify.dev/docs/api/app-home/latest/web-components/feedback-and-status-indicators/banner]:
  tones info/success/warning/critical; "allow dismissal unless immediate action's required";
  one topic per banner; info/warning/critical banners carry a call to action; page-wide banners
  sit outside sections, contextual ones inside; stacking is unprioritised so queue them yourself;
  for a status on one item use a badge, not a banner.
- Toast confirms completed actions ("2 puzzles archived", "Step 1 completed!") [V: index-table;
  setup-guide].
- Polaris wording rules, indexed snippets only [S: https://polaris.shopify.com/content/error-messages;
  https://polaris.shopify.com/content/voice-and-tone; https://polaris-react.shopify.com/content/fundamentals]:
  say what went wrong and what to do next with specifics (numbers, dates, the merchant's own
  data); avoid "invalid"; avoid "we" unless Shopify caused it; apologise when at fault "but not
  excessively"; plain language, contractions, "a roughly seventh-grade reading level",
  "sounding human" over fine-tuning tone. A real example of Shopify's error voice: a
  deactivated discount code shows "Unable to find a valid discount matching the code entered"
  [V: https://help.shopify.com/en/manual/discounts/managing-discounts].

### 1.10 Help text, settings layout, onboarding, metrics

- **Footer help**: a centred, subdued line with a "Learn more" link at the bottom of a page
  [V: https://shopify.dev/docs/api/app-home/latest/patterns/templates/settings;
  https://shopify.dev/docs/api/app-home/latest/patterns].
- **Settings template**: sections with a heading; rows = heading + "subdued explanatory
  paragraph" + action or chevron, divided; "Use the Modal API to confirm destructive actions
  like resetting all settings"; example groups Store Information, Notifications, Connected
  accounts, Preferences, Tools [V: settings template]. Layout page: settings use "A narrower
  left column holds the title and description, and a wider right column holds the form
  elements" [V: layout]. Built for Shopify: long forms "grouped into logical sections"
  [§4.3.4]; onboarding "must justify any data requests" and be removable after completion
  [§4.2.2]; "Your homepage should clearly indicate if the app is set up and working" [§4.2.3].
- **Setup guide composition**: title, intro ("Use this personalized guide to get your store
  ready for sales"), progress ("0 out of 3 steps completed"), dismiss + collapse, steps with
  checkbox, description, primary action and optional link, toast per completed step
  [V: https://shopify.dev/docs/api/app-home/latest/patterns/compositions/setup-guide].
- **Metrics card**: value, label, comparison badge with optional arrow, linked to the detail
  report [V: https://shopify.dev/docs/api/app-home/latest/patterns/compositions/metrics-card].
- **Homepage template**: setup guide, metrics, callout cards, footer help; "Use banners
  sparingly" (one visible); persist dismissals so sections do not reappear
  [V: https://shopify.dev/docs/api/app-home/latest/patterns/templates/homepage].
- **Admin blocks** (app cards on a detail page): keep under 600px, "include an empty state that
  explains what the block does"; **admin actions** live in the More actions menu; bulk actions
  from apps on index pages [V: https://shopify.dev/docs/apps/design/app-structure].

### 1.11 Global chrome: search, alerts, switcher, shortcuts, activity log

- **Search**: `Ctrl/Cmd + K` from any page; finds "apps, customers, orders, products, sales
  channels, and other information"; default filters Apps, Customers, Orders, Products, Sales
  channels; optional filters Blogs, Catalogs, Companies, Discounts, Draft orders, Locations,
  Markets, Metafields, Metaobjects, Navigation, Pages, Purchase orders, Reports, Segments,
  Settings; type `/` to show filters; one filter at a time; 7 results then "Show # more";
  recents stored on the device with "Clear history"; a link opens Sidekick to keep searching
  [V: https://help.shopify.com/en/manual/shopify-admin/admin-search].
- **Alerts feed**: bell with unseen count; covers "disruptions, product compliance, monetary
  transaction confirmations, and completed processes"; mark read/unread, mark all read
  [V: https://help.shopify.com/en/manual/shopify-admin/shopify-admin-overview].
- **Store switcher** in the top bar (or sidebar in the refreshed design): recent stores, "View
  all" [V: same].
- **Keyboard shortcuts**: `?` opens the list; `A` then `P` adds a product (sequence within ~1s)
  [V: https://help.shopify.com/en/manual/shopify-admin/productivity-tools/keyboard-shortcuts].
- **Store activity log** (Settings > General > Resources): who (person, app, or sales channel;
  system actions appear as "Shopify"), what, when; max 250 rows; view-only; no export
  [V: https://help.shopify.com/en/manual/shopify-admin/activity-logs].

### 1.12 Tags, metafields, metaobjects, Flow, scheduling

- **Tags** on products, transfers, customers, blog posts, orders, draft orders, discounts;
  250 per item (5 per discount); 40 chars on orders/drafts, 255 elsewhere; not case sensitive;
  letters, numbers, hyphens; used for filters, automated collections, segments (via a segment,
  not a direct filter), Flow; hidden from customers [V: https://help.shopify.com/en/manual/shopify-admin/productivity-tools/using-tags].
- **Metafields**: definitions (Settings > Custom data) with `name`, `namespace.key`, `type`,
  `validations`, `access` (Admin/Storefront/Customer Account), `pinnedPosition`, `capabilities`
  (admin filtering, unique values), `useAsCollectionCondition`
  [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/MetafieldDefinition]. Types
  include single_line_text_field, multi_line_text_field, rich_text_field, number_integer,
  number_decimal, boolean, date, date_time, json, money, color, rating, url, link, weight,
  volume, dimension, file_reference, product_reference, variant_reference, collection_reference,
  customer_reference, order_reference, metaobject_reference, mixed_reference, and `list.*`
  variants [V: https://shopify.dev/docs/apps/build/custom-data/metafields/list-of-data-types].
  Filterable on index pages (`metafields.namespace.key`) and bulk-editable.
- **Metaobjects**: a definition (fields, types, validations, display name) in Settings > Custom
  data; entries in Content > Metaobjects; accessible in admin, API, Liquid, Storefront API
  [V: https://help.shopify.com/en/manual/custom-data/metaobjects].
- **Shopify Flow**: "an ecommerce automation platform"; a workflow = trigger + conditions +
  actions; installed from the App Store, Basic plan and up [V: https://help.shopify.com/en/manual/shopify-flow].
  83 triggers including Order created / paid / fulfilled / canceled, Refund created, Customer
  created, Customer joined segment, Customer tags added, Customer abandons checkout, Customer
  left online store without making a purchase, Product variant out of stock / back in stock,
  Fulfillment order ready to fulfill, Fulfillment order line items prepared for pickup, Return
  requested, Draft order created, Discount code created, Scheduled time, Workflow error occurred
  [V: https://help.shopify.com/en/manual/shopify-flow/reference/triggers]. 109 actions
  including Add order tags, Archive order, Cancel order, Capture payment, Mark order as paid,
  Update order note, Hold fulfillment order, Send draft order invoice, Send internal email,
  Send HTTP request, Send Admin API request, Run code, Wait, For each loop, Count, Sum, Log
  output, Send Shopify alert for errors, Get … data [V: https://help.shopify.com/en/manual/shopify-flow/reference/actions].
- **Future publishing** for products, collections, blog posts, pages: "Your online store
  publishes the content at the dates and times that you specify"; products must be Active;
  check Store defaults time zone; items show "Hidden" with the scheduled time
  [V: https://help.shopify.com/en/manual/shopify-admin/productivity-tools/future-publishing].

### 1.13 Hospitality translation of the cross-cutting layer

**Maps directly to Pipedline (console/spine):**
- Views on every list (Orders, Bookings, Guests, Menu, Offers, Campaigns, Reviews). Default
  views are *ours to name*: Orders "Needs accepting / In the kitchen / Ready / Today / All";
  Bookings "Arriving next / Tonight / Unconfirmed / No-shows this month"; Menu "On the menu /
  86'd / Not on the menu yet / Retired". The Pipedline MCP already exposes `saved_view_run`;
  the console should let staff create, rename, duplicate and delete views the Shopify way.
- Timeline on every docket, booking and guest: system events (`events` spine, `audit`) plus
  staff comments with @mention and attachment. Assistant actions (agent_calls) belong on the
  same timeline, badged "Assistant", because Shopify's `attributeToApp`/`appTitle` is exactly
  that distinction.
- Bulk action bar, destructive confirm (verb repeats: "Cancel 3 orders?" → **Cancel orders**),
  toast on completion, save bar on forms, empty states that say why and what next.
- Verb vocabulary (hospo): Accept order · Start cooking · Mark ready · Mark collected · Mark
  delivered · Confirm booking · Decline booking · Seat · Mark no-show · 86 item · Put back on
  the menu · Comp item · Refund · Tell the guest (toggle) · Approve batch.
- Status badges in past tense, one tone per status: Accepted, Cooking, Ready, Collected,
  Delivered, Cancelled, Refunded; Confirmed, Seated, Finished, No-show; 86'd, Sold out today.

**Pipedline lacks (per `CONSOLE_IA.md`/`MODULES.md`):** saved-view CRUD in the console (only
run), column customisation, per-user Home metric choice, a timeline component with comments and
mentions, a global search with category filters, an alerts feed, an audit-log page (the spine
has `audit()`; nothing surfaces it), tags on guests/orders/bookings as a filterable facet,
scheduled publishing, keyboard shortcuts.

**Hospitality needs commerce does not have:** a *service period* is the natural default filter
("Tonight's dinner"), not a date range; dockets are numbered per service and reset daily; the
pass needs a *screen* mode (large type, no sidebar) which commerce admins never consider;
front-of-house roles need a phone-first "accept / ready / collected" flow (Shopify's mobile app
is a reduced admin, not a floor tool); 86'd is a time-boxed state ("until end of service"), not
a stock count; guest-written text (notes, allergies, reviews) is untrusted and must render as
quoted text (CLAUDE.md rule 13), where Shopify renders customer notes as plain text too.

---

## 2. Area by area

Each area: **2.x.1 what the help centre says it contains · 2.x.2 objects and states from the
Admin GraphQL reference · 2.x.3 workflows and UI · 2.x.4 hospitality translation**.

### 2.1 Home

**2.1.1 Contains** [V: https://help.shopify.com/en/manual/shopify-admin/shopify-home]
- "the Shopify admin landing page": daily tasks, next steps for orders, recent sales activity,
  recommendations, growth steps. Requires the **Home** staff permission.
- **Metrics section**: a sales summary with drop-downs for sales channel and time period;
  defaults Sessions, total sales, total orders, conversion rate, last 30 days; each user picks
  their own 4 of ~17 metrics (edit icon → "Select metric" with search); per-user, not store-wide.
- Hidden while the store is in private mode (setup tasks shown instead); session data after
  private mode ends; full metrics after the first sale.
- **Order tasks**: open order work grouped by type with counts: capturing payments, fulfilling
  orders, processing return requests, reviewing high-risk orders, submitting chargeback evidence.
  Order-task cards cannot be dismissed.
- **Home cards** feed: feature updates, advice, insights, guides, Sidekick Pulse; dismissible
  except order tasks; "Discover more of Shopify" footer section not dismissible.
- **Insights**: cards on sales, sessions, fulfilments (trends, streaks, top 5); up to 3 per day,
  each expires after 24 hours; store needs ≥10 orders/week averaged over 6 months; each links to
  a report.
- **Sidekick Pulse** (early access): recommendation cards (§2.13). **Sidekick guides**: a card
  opens a chat that works through a task, progress shown on the card.
- Activity globe (per-user pause; respects reduced motion).
- Admin overview adds: Home "highlights urgent actions, such as unpaid orders that still need to
  be captured" [V: https://help.shopify.com/en/manual/shopify-admin/shopify-admin-overview].
  Each sales channel has a dashboard selectable "from the drop-down in Shopify Home"
  [V: https://help.shopify.com/en/manual/online-sales-channels/manage].

**2.1.2 Objects.** No Home object. Metrics come from Analytics (`shopifyqlQuery`, §2.9);
tasks are filtered order queries (`financial_status:authorized`, `fulfillment_status:unfulfilled`,
`return_status:return_requested`, `risk_level:high`, `chargeback_status:needs_response`)
[V: https://shopify.dev/docs/api/admin-graphql/latest/queries/orders].

**2.1.3 UI.** App Home "Homepage" template: setup guide → metrics → callout → footer help; one
banner at a time; persist dismissals [V: homepage template]. Built for Shopify: the homepage
must "clearly indicate if the app is set up and working" [V: requirements §4.2.3].

**2.1.4 Hospitality translation.**
- *Maps:* `CONSOLE_IA.md` §2 already mirrors this order: today's service → "waiting for your
  yes" → week vs last week → setup progress → assistant activity. Shopify's **order tasks by
  type with counts** = our "needs attention" strip: orders waiting to be accepted, dockets past
  their promised time, bookings to confirm, approvals waiting, reviews to answer; each count
  deep-links to the matching saved view. **Setup tasks replace metrics until live** = our
  setup-progress card (`setup_status`, `go_live_check`). **Insights with a 24h life** = our
  Monday digest items (`insights_digest`), shown as expiring cards. **Pulse** = assistant
  suggestions with approve/dismiss (§2.13).
- *Lacks:* per-user metric picker (4 tiles, chosen from the metrics catalogue), channel and
  period drop-downs on the tiles, dismissible cards with persisted dismissal, task counts that
  open a filtered list, insight cards that expire.
- *Hospo-only:* **today's service by sitting** (lunch/dinner): covers booked vs capacity, next
  hour's arrivals, tables seated now; **86'd right now** (items off the menu this service);
  **surcharge active today** (public holiday); **the pass is online** (kitchen screens
  connected); yesterday's no-shows; staff on tonight (rostering is deferred, but Home is where
  it would show). Spend per head, not AOV. Sessions and conversion rate matter far less than
  covers and dockets; do not copy those defaults.

### 2.2 Orders

**2.2.1 Contains** [V: https://help.shopify.com/en/manual/orders → fulfilment section;
https://help.shopify.com/en/manual/fulfillment/managing-orders]
Sub-pages: Viewing and filtering orders · Draft orders and invoices · Understanding your order
statuses · Validating addresses · Viewing and managing order details · Editing orders · Managing
payments · Printing orders · Refunding orders · Returns and exchanges · Protecting orders from
fraud · Canceling orders · Forecasting orders and viewing order analytics · Exporting orders ·
Contacting a Shopify store about an order. Plus **Orders > Drafts**, **Orders > Abandoned
checkouts** [V: https://help.shopify.com/en/manual/orders/create-orders/create-draft;
https://help.shopify.com/en/manual/orders/abandoned-checkouts], the **Local delivery** tab
[V: https://help.shopify.com/en/manual/fulfillment/fulfilling-orders/local-delivery-fulfillment],
and delivery-method setup (shipping, local delivery, pickup in store)
[V: https://help.shopify.com/en/manual/fulfillment/setup/delivery-methods/local-delivery;
https://help.shopify.com/en/manual/fulfillment/setup/delivery-methods/pickup-in-store].

**2.2.2 Objects and states**
- **Order** [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/Order]: three
  independent axes plus returns:
  - *Order status* (filter `status`: open, closed, cancelled, not_closed; `closed` = all items
    fulfilled or cancelled and all money settled; `cancelledAt`, `cancelReason`, `cancellation`
    with staff notes). Help centre: **Open**, **Archived**, **Canceled**; a cancelled-then-
    archived order shows both [V: https://help.shopify.com/en/manual/fulfillment/managing-orders/order-status].
  - *Payment* `displayFinancialStatus`: AUTHORIZED, EXPIRED, PAID, PARTIALLY_PAID,
    PARTIALLY_REFUNDED, PENDING, REFUNDED, VOIDED [V: https://shopify.dev/docs/api/admin-graphql/latest/enums/OrderDisplayFinancialStatus].
    Help centre adds **Due** (payment-terms date passed), **Expiring** (badge two days before an
    authorisation lapses) and **Unpaid** (a grouping of Authorized, Pending, Expired, Partially
    paid) [V: order-status page].
  - *Fulfilment* `displayFulfillmentStatus`: FULFILLED, FULFILLMENT_NOT_REQUIRED ("Not
    required" in the list), IN_PROGRESS, ON_HOLD, PARTIALLY_FULFILLED, REQUEST_DECLINED,
    SCHEDULED, UNFULFILLED (OPEN, PENDING_FULFILLMENT, RESTOCKED are superseded)
    [V: https://shopify.dev/docs/api/admin-graphql/latest/enums/OrderDisplayFulfillmentStatus].
  - *Return* `returnStatus`: IN_PROGRESS, INSPECTION_COMPLETE, NO_RETURN, RETURN_FAILED,
    RETURN_REQUESTED, RETURNED [V: https://shopify.dev/docs/api/admin-graphql/latest/enums/OrderReturnStatus].
  - *Cancel reason* `OrderCancelReason`: CUSTOMER, DECLINED, FRAUD, INVENTORY, OTHER, STAFF
    [V: https://shopify.dev/docs/api/admin-graphql/latest/enums/OrderCancelReason].
  - Other fields: `events` (timeline, 1-year retention), `note` (≤5,000 chars, merchant or
    customer), `tags` (replace semantics; `tagsAdd` appends), `customAttributes` ("gift
    messages, delivery instructions, or internal notes"), `lineItems`,
    `nonFulfillableLineItems` (tips, fully refunded), `fulfillmentOrders`, `fulfillments`,
    `refunds`, `transactions`, `risk`, `shippingLine(s)`, `discountApplications`,
    `totalPriceSet` vs `currentTotalPriceSet` (after returns), `customer` (null for guest
    checkout), `sourceName` (web, mobile app, POS), `publication` (the channel), `test`,
    `unpaid`, `fullyPaid`, `poNumber`, `edited`, `merchantEditable`, `confirmed` (stock
    reserved), `fulfillable`, `agreements` (payment terms) [V: Order page].
  - Filters on the `orders` query [V: https://shopify.dev/docs/api/admin-graphql/latest/queries/orders]:
    `delivery_method` shipping | pick-up | retail | local | pickup-point | none;
    `risk_level` high | medium | low | none | pending; `chargeback_status`;
    `fraud_protection_level`; `channel`, `sales_channel`, `source_name`, `tag`, `tag_not`,
    `sku`, `discount_code`, `customer_id`, `location_id`, `fulfillment_location_id`,
    `created_at`, `processed_at`, `updated_at`, `current_total_price`,
    `subtotal_line_items_quantity`, `metafields.{ns}.{key}`; default sort PROCESSED_AT.
- **FulfillmentOrder** ("an item or a group of items in an Order that will be fulfilled from
  the same location"; created by Shopify, not by merchants): `status` CANCELLED, CLOSED,
  IN_PROGRESS, INCOMPLETE, ON_HOLD, OPEN, SCHEDULED; `requestStatus`; `assignedLocation`;
  `deliveryMethod`; `destination`; `fulfillAt` (scheduled → open), `fulfillBy` (deadline);
  `fulfillmentHolds`; `supportedActions`; `merchantRequests`
  [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/FulfillmentOrder;
  https://shopify.dev/docs/api/admin-graphql/latest/enums/FulfillmentOrderStatus].
  `DeliveryMethodType`: LOCAL, NONE, PICK_UP, PICKUP_POINT, RETAIL, SHIPPING
  [V: https://shopify.dev/docs/api/admin-graphql/latest/enums/DeliveryMethodType].
- **Fulfillment** (a shipment of items): `status` SUCCESS, CANCELLED, ERROR, FAILURE;
  `displayStatus` ATTEMPTED_DELIVERY, CANCELED, CARRIER_PICKED_UP, CONFIRMED, DELAYED,
  DELIVERED, FAILURE, FULFILLED, IN_TRANSIT, LABEL_PRINTED, LABEL_PURCHASED, LABEL_VOIDED,
  MARKED_AS_FULFILLED, NOT_DELIVERED, OUT_FOR_DELIVERY, PICKED_UP, READY_FOR_PICKUP, SUBMITTED;
  `trackingInfo`, `events`, `deliveredAt`, `estimatedDeliveryAt`, `inTransitAt`
  [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/Fulfillment;
  https://shopify.dev/docs/api/admin-graphql/latest/enums/FulfillmentStatus;
  https://shopify.dev/docs/api/admin-graphql/latest/enums/FulfillmentDisplayStatus].
- **Location**: `name`, `address`, `isActive`, `fulfillsOnlineOrders`, `hasActiveInventory`,
  `inventoryLevels`, `localPickupSettingsV2`, `addressVerified`, `deactivatable`, `deletable`,
  `metafields` [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/Location].
  `DeliveryLocalPickupTime`: ONE_HOUR "Usually ready in 1 hour", TWO_HOURS, FOUR_HOURS,
  TWENTY_FOUR_HOURS, TWO_TO_FOUR_DAYS, FIVE_OR_MORE_DAYS (CUSTOM deprecated)
  [V: https://shopify.dev/docs/api/admin-graphql/latest/enums/DeliveryLocalPickupTime].
- **DraftOrder** ("An order a merchant creates on behalf of a customer" for phone, in-person or
  chat sales, invoices, custom items, wholesale pricing, pre-orders): `status` OPEN ("has not
  been paid, and an invoice hasn't been sent"), INVOICE_SENT, COMPLETED ("has been paid");
  `invoiceUrl`, `invoiceSentAt`, `completedAt`, `order`, `ready`, `reserveInventoryUntil`,
  `appliedDiscount`, `shippingLine`, `paymentTerms`, `poNumber`, `visibleToCustomer`,
  `acceptAutomaticDiscounts`, `allowDiscountCodesInCheckout`, `events`, `tags`, `note2`
  [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/DraftOrder;
  https://shopify.dev/docs/api/admin-graphql/latest/enums/DraftOrderStatus].
- **AbandonedCheckout** ("the buyer added items and gave contact information but didn't finish
  purchasing"): `abandonedCheckoutUrl`, `completedAt`, `customer`, `lineItems`, `totalPriceSet`,
  `discountCodes`, `note` (merchant-facing), `customAttributes`, `name`; query filters
  `email_state` sent | not_sent | scheduled | suppressed, `recovery_state` recovered |
  not_recovered, `status` open | closed; needs `manage_abandoned_checkouts` permission
  [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/AbandonedCheckout].

**2.2.3 Workflows and UI**
- **Orders index** [V: https://help.shopify.com/en/manual/fulfillment/managing-orders/viewing-orders/filtering-orders]:
  search by order number, customer name, email, product; filters **Order status** (Open,
  Archived, Canceled), **Payment status** (Authorized, Due, Expired, Paid, Partially paid,
  Partially refunded, Pending, Refunded, Unpaid, Voided), **Fulfillment status** (Fulfilled,
  Unfulfilled, Partially fulfilled, Scheduled, On hold, Request declined), **Return status**
  (Return requested, Return in progress, Return closed), **Delivery method** (In store, Local
  delivery, Pickup in store, Pickup point, Shipping), **Delivery status** (In transit, Out for
  delivery, Attempted delivery, Delayed, Failed delivery, Delivered, Tracking added, No status),
  **Fraud risk** (High, Medium, Low), **Chargeback and inquiry status** (Open, Submitted, Won,
  Lost), **Tagged with / Not tagged with**, **Date** (Today, Last 7/30/90 days, Last 12
  months, Custom), **App**, **Channel**, Order total, Number of items, Total product weight,
  Label status, Destination, Address validation, Product, Discount code, B2B, Payout action
  required, Credit card (last 4 digits), order metafields. Default views **All** and
  **Unfulfilled**. Column customisation on this list [V: views page].
- **Order details** [V: https://help.shopify.com/en/manual/fulfillment/managing-orders/managing-order-details]:
  product values frozen at order time; Timeline; Notes (pencil; customers can add notes if
  enabled); Tags (40 chars); Contact section → click email → "Review email" → **Send
  notification**; **More actions** → "View order status page". Cards for items/fulfilment,
  payment, customer, risk exist but are not named on the public page [U].
- **Pickup in store** [V: pickup-in-store page]: per location "Let customers pick up orders
  directly at this location"; "Expected pickup date" drop-down; "Ready for pickup notification"
  instructions; flow **Ready for pickup** → **Mark as ready for pickup** → **Mark as picked up**
  (with "Send notification to customer"); emails "Ready for pickup" and "Picked up by customer".
- **Local delivery** [V: local-delivery setup + fulfilment pages]: zones by radius (≤160 km) or
  postcodes, ≤10 zones per location, "Minimum order price", "Delivery price", "Delivery
  information" (appears in the confirmation email), ≤3 conditional prices; order flow
  **Prepare delivery** → **Mark as ready for delivery** → **Mark as delivered** (sends a
  delivery confirmation); **Cancel delivery** returns it to Unfulfilled; Orders page has a
  **Local delivery** tab; "Out for delivery" is a state within "Ready for delivery", not a
  button; "Delivery instructions" section shows the guest's checkout note.
- **Draft orders** [V: https://help.shopify.com/en/manual/orders/create-orders/create-draft]:
  Orders > Drafts > **Create order**; "Product" search or **Custom item** (name, price,
  quantity, "Item is taxable", "Item is a physical product"); discounts per line or order;
  **Add shipping or delivery** → Shipping rates / Local delivery / Pickup in store / Custom;
  "Charge taxes"; **Payment due later** with **Payment terms** (Due on receipt, Due on
  fulfillment, Net 7/15/30/45/60/90, Fixed term) and "+ Require deposit" (Plus); "Search or
  create a customer"; Tags; Market (pricing); **Reserve inventory** with an expiry (units move
  to Committed); then **Send an invoice** (checkout link), accept payment, set terms, or save
  as draft; "Ignore and create order" when a rule blocks; **Duplicate** (discounts and shipping
  do not carry over); **Delete draft order**; drafts created ≥ 2025-04-01 are "deleted after 1
  year of inactivity". Do not mark paid before payment "or the invoice link won't work"
  [S: https://help.shopify.com/manual/orders/create-orders/send-draft].
- **Abandoned checkouts** [V: https://help.shopify.com/en/manual/orders/abandoned-checkouts]:
  abandoned "if it remains incomplete for more than ten minutes after the customer has provided
  their email"; Orders > Abandoned checkouts; columns **Email status** and **Recovery status**;
  a **Blocked** view (high-risk, blocked by Shopify Payments); manual email via the customer's
  address (link cannot be expired); automatic via Shopify Messaging's "Abandoned checkout emails
  by Shopify" with delay and recipients; recovered when the order completes by any route;
  Online Store and Buy Button only; deleted after 3 months; convert to a draft to keep.
- **Cancel order dialog** [V: canceling-orders]: **Refund payment** (Original payment method /
  Store credit with expiry / Later), **Reason for cancellation**, **Staff note**, **Restock
  inventory** (default on), **Send a notification to the customer** (default on) → **Cancel
  order**. Partially fulfilled orders cannot be cancelled; result shows in the Timeline; payment
  becomes Voided / Refunded / Partially refunded.
- **Refund** [V: https://help.shopify.com/en/manual/fulfillment/managing-orders/refunding-orders]:
  quantities per line (0 to exclude), **Restock items**, **Refund shipping**, **Reason for
  refund** (staff only; not a return reason), **Send a notification to the customer**, **Refund
  method** (original / store credit / both), **Refund amount**; repeatable partial refunds →
  Partially refunded.
- **Edit order** [V: https://help.shopify.com/en/manual/fulfillment/managing-orders/editing-orders]:
  before fulfilment: add/remove products, quantities, shipping fee, manual discounts; if the
  total rises "send the customer an updated invoice", if it falls "issue a refund"; Sidekick can
  stage the edit for review.
- **Order processing settings** (Settings > General per the page) [V: https://help.shopify.com/en/manual/checkout-settings/order-processing]:
  "Automatically fulfill the order's line items" (+ "Notify customers of their shipment", "…even
  those with a high risk of fraud"), "Automatically archive the order" (paid-and-fulfilled or
  fully refunded), "Require a confirmation step".
- **Notifications** (§2.12): customer emails Order confirmation, Order canceled, Order refund,
  Shipping confirmation, Shipping update, Out for delivery, Delivered, Ready for pickup, Picked
  up by customer, local-delivery confirmation; staff recipients per location or channel.
- **Tasks on Home** group orders needing payment capture, fulfilment, returns, risk review,
  chargeback evidence (§2.1).

**2.2.4 Hospitality translation**
- *Maps directly* (ordering, delivery, qr modules): Shopify's three independent axes are the
  single most useful import. A docket needs **what the kitchen is doing** (New → Accepted →
  Cooking → At the pass/Ready → Collected | Delivered | Served), **money** (Unpaid tab, Paid,
  Partly refunded, Refunded, Voided, Due for functions), and **how it leaves** (Pickup,
  Delivery, At the table, Counter). Never fuse them into one status field. Shopify's pickup flow
  (Mark as ready for pickup → Mark as picked up, each with a guest message) and local-delivery
  flow (Prepare → Ready for delivery → Delivered, "Delivery instructions" shown from the guest's
  note) are the pickup and first-party delivery dockets almost verbatim. `DeliveryMethodType`
  RETAIL = "In store" is our dine-in/counter order. "Usually ready in 1 hour" becomes a
  **promise time** in minutes with a per-service default (15 min pickup at lunch, 25 at
  dinner). Cancel dialog fields map one-to-one: *Why* (guest asked · kitchen couldn't make it ·
  closed early · entered by mistake · suspected fraud · other), *refund now / later*, *put items
  back on the menu* (if 86'd by stock), *tell the guest* toggle, *staff note*. Refund dialog
  likewise, with "reason (staff only)" and **house credit** instead of store credit.
- *Lacks:* an order **timeline** (ordered 19:02 via QR menu · accepted 19:03 by Sam · fired ·
  ready 19:21 · collected 19:30 · assistant changed pickup time, before/after); **saved views**
  with the filter set above (delivery method, docket state, payment state, source channel,
  tagged, promise time overdue, allergy flagged); **bulk actions** (Accept selected, Print
  dockets, Mark collected, Add tags); **phone/function orders** (draft orders: custom item,
  deposit = "Payment due later" + "Require deposit", hold items, send a pay link, auto-expire
  stale drafts); **abandoned pickup carts** (guest gave a phone/email in the venue's checkout
  but didn't pay: list, "Email status / Recovery status", one-tap recovery message, 3-month
  purge) and the same for **abandoned bookings**; **order source badge** (Website · QR · Phone ·
  Inside assistant · Uber Eats) from `sourceName`/`publication`; **edit an open order** with the
  balance collected or refunded; **auto-close** finished dockets (Shopify's auto-archive) with
  a "require a tap to accept" setting (Shopify's "Require a confirmation step" is for the guest;
  ours is for the kitchen); **notes vs tags vs custom attributes** as three distinct fields;
  order number prefix per channel/venue.
- *Hospo-only:* table number and cover count on the docket; docket numbers per service, reset
  daily; **courses and firing** (entrées away, mains away); **86'd substitutions** mid-order;
  **split bills** and **open tabs** (unpaid until the table closes, which is normal, not an
  exception as "Unpaid" is in commerce); **surcharges** (public holiday %, weekend %, card fee,
  large-group service charge) as explicit docket lines; tips/gratuity; **allergy and dietary
  notes flagged** on the docket (quoted guest text, rendered as text); **service period** as a
  docket attribute; **no-shows** belong to bookings, not orders; third-party marketplace
  dockets (Uber Eats/DoorDash) arriving by plug; kitchen printer/screen routing (kds deferred).

### 2.3 Products → Menu

**2.3.1 Contains** [V: https://help.shopify.com/en/manual/products]
Adding and updating products · Product details · Variants · Product media · Collections ·
Product bundles · Purchase options · Digital products · Combined listings · Importing and
exporting products · Searching for products and filtering your product list · Product
disclosures · Creating and selling gift cards · Managing vendor information · Dropshipping ·
Temporarily changing your product line · Product analytics overview. A product "needs only a
title and price"; then description, media, compare-at price, inventory, variants, tags,
metafields; bulk editor; CSV. Inventory and locations are a sibling section
[V: https://help.shopify.com/en/manual/inventory-and-locations].

**2.3.2 Objects and states**
- **Product** [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/Product]: `status`
  ACTIVE ("ready to sell… but it isn't automatically published"), ARCHIVED, DRAFT (new default
  for duplicates/unarchived), UNLISTED ("viewable only through a direct link"; API 2025-10+)
  [V: https://shopify.dev/docs/api/admin-graphql/latest/enums/ProductStatus]; `title`,
  `handle`, `descriptionHtml`, `productType`, `vendor`, `tags`, `options` (limit
  `shop.resourceLimits.maxProductOptions`), `variants` (≤2,048 per product), `media`,
  `category` (Standard Product Taxonomy), `collections`, `publishedAt`,
  `publishedOnPublication`, `resourcePublicationsV2`, `metafields`, `seo`, `totalInventory`,
  `tracksInventory`, `hasOnlyDefaultVariant`, `isGiftCard`, `requiresSellingPlan`,
  `sellingPlanGroups`, `combinedListing`, `bundleComponents`, `templateSuffix`, `events`,
  `feedback`.
- **ProductVariant** [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant]:
  `title`, `sku` ("Required in order to connect to a fulfillment service"), `barcodes` (≤20),
  `price`, `compareAtPrice`, `inventoryItem`, `inventoryQuantity`, `inventoryPolicy` (allow
  orders when out of stock), `selectedOptions`, `position`, `availableForSale`, `taxable`,
  `requiresComponents`, `sellableOnlineQuantity`, `media`, `metafields`, `deliveryProfile`.
- **Collection** ("a group of products… to make their stores easier to browse"; unpublished by
  default): `title`, `handle`, `descriptionHtml`, `sortOrder`, `products`, `productsCount`,
  `image`, `seo`, `resourcePublications`, `metafields`, `templateSuffix`; automated rules via
  `CollectionRuleColumn` TAG, TITLE, TYPE, VENDOR, VARIANT_PRICE, VARIANT_COMPARE_AT_PRICE,
  VARIANT_INVENTORY, VARIANT_TITLE, VARIANT_WEIGHT, IS_PRICE_REDUCED, PRODUCT_CATEGORY_ID(_WITH_DESCENDANTS),
  PRODUCT_TAXONOMY_NODE_ID, PRODUCT_METAFIELD_DEFINITION, VARIANT_METAFIELD_DEFINITION
  [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/Collection;
  https://shopify.dev/docs/api/admin-graphql/latest/enums/CollectionRuleColumn].
- **Inventory states** [V: https://help.shopify.com/en/manual/inventory-and-locations/fundamentals/inventory-states]:
  **On hand** = Committed + Unavailable + Available; **Available** (sellable now);
  **Committed** (unfulfilled orders, draft-order reservations, transfers ready to ship);
  **Unavailable** (damaged, quality control, safety stock, other); **Incoming** (not counted
  until received). "Every adjustment is recorded, so you know when and why a quantity changed"
  [V: inventory index]. **Continue selling when out of stock** is per variant and only when
  "Inventory tracked" is on; out of stock = "at zero or below"; does not apply to POS
  [V: https://help.shopify.com/en/manual/inventory-and-locations/setup/selling-when-out-of-stock].
- `products` query filters include `status`, `tag`, `vendor` (OR), `product_type`,
  `collection_id`, `category_id`, `published_status`, `product_publication_status`,
  `inventory_total`, `out_of_stock_somewhere`, `tracks_inventory`, `is_price_reduced`,
  `gift_card`, `bundles`, `metafields.{ns}.{key}`, `sku`, `barcode`, `handle`, `title`
  [V: https://shopify.dev/docs/api/admin-graphql/latest/queries/products].

**2.3.3 Workflows and UI**
- Index: views All (default) / Active / Draft / Archived; "Search and filter" bar; filters
  Vendors, Tag, Statuses, Categories, Sales channel, Region catalog, B2B catalog, Company
  location catalog, Retail catalog, Unassigned catalog, Types, Collection, Publishing error, Gift
  card, Combined listings, Metafields; sort by Product, Created (default), Updated, Inventory,
  Product type, Publishing, Vendor; filters AND across, OR within; views auto-update
  [V: https://help.shopify.com/en/manual/products/searching-filtering].
- Adding a sales channel "makes all existing products available on it automatically"; per-
  product channel availability [V: https://help.shopify.com/en/manual/online-sales-channels/manage].
- Future publishing: product must be Active; shows "Hidden" + date in the Publishing section
  [V: future-publishing]. Bulk editor columns e.g. price, SKU, compare-at [V: bulk-editing].
- Product tags "help shoppers find products in online store search" but "aren't displayed to
  customers" [V: using-tags].
- Gift cards: sold as products and "create gift cards directly from your Shopify admin"
  [V: https://help.shopify.com/en/manual/products/gift-card-products].

**2.3.4 Hospitality translation**
- *Maps (menu, specials modules):* product → **menu item**; variant → **size/portion** (small /
  large, glass / bottle); collection → **menu section**, with automated collections → "smart
  sections" (all items tagged `vegetarian`, everything under $15) worth copying for dietary
  menus; status Draft / Active / Archived / Unlisted → **Not on the menu yet / On the menu /
  Retired / Secret (link-only, QR-only)**; publishing per channel → **"Where it shows"**
  checkboxes (Website · QR · Pickup · Delivery · Inside assistants) with Shopify's default of
  "available everywhere when a channel is added"; future publishing → **scheduled menus**
  (brunch goes live 8:00 Sat, winter menu on 1 June); `compareAtPrice` → "was $18" for
  specials; `hasOnlyDefaultVariant` → the common case for a dish; `menu_import_*` tools
  already cover CSV import; `menu_set_availability` is the 86 switch.
- *Lacks:* **86'd as a time-boxed state** ("86 until end of service / until tomorrow / until I
  say", auto-return; count of 86s per item in analytics) rather than Shopify's stock count with
  "continue selling when out of stock"; item **timeline** (price changed by whom, 86'd at 19:40
  by kitchen, back on at 21:00); **saved views** with filters (section, dietary tag, channel,
  86'd, has photo, missing description); **bulk edit** of prices and sections in a grid (menu
  rounds); **channel-specific price list** (delivery uplift) — Shopify does this with catalogs
  (§2.8); **smart sections**; **set menus/banquets** (bundles) and **meal deals**; **vouchers**
  (gift cards; `giftcards` deferred) distinct from offers; item-level "publishing error"
  equivalent ("missing photo for the assistant", "no allergen info").
- *Hospo-only:* **modifiers** (add bacon +$3, no onion, choose a sauce, min/max picks, defaults)
  are not variants and have no Shopify analogue in the product model; **courses** and **kitchen
  station** (grill, cold larder, bar) routing; **prep time** per item feeding promise time;
  **dietary tags shown to guests** (V, VG, GF, DF, contains nuts) where Shopify hides tags;
  **allergen matrix** as a legal document; **specials board** with a date range (exists);
  **ingredients and COGS** (deferred; Shopify's Committed/Available is the nearest idea);
  **service-period menus** (lunch vs dinner vs late); menu as a printable/PDF artefact.

### 2.4 Customers → Guests

**2.4.1 Contains** [V: https://help.shopify.com/en/manual/customers]
Customer accounts · Managing customers · Searching for customer profiles · Customer segmentation
· Importing and exporting customer lists · Importing contact lists from Mailchimp · Providing
online customer service · Solving customer CSV file errors · Store credit. "Customers can be
grouped into customer segments."

**2.4.2 Objects and states**
- **Customer** [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/Customer]:
  `state` (classic accounts only) ENABLED, INVITED, DISABLED, DECLINED
  [V: https://shopify.dev/docs/api/admin-graphql/latest/enums/CustomerState];
  `defaultEmailAddress.marketingState` SUBSCRIBED, UNSUBSCRIBED ("was previously subscribed"),
  PENDING, NOT_SUBSCRIBED (never), REDACTED ("personal data is erased", read-only), INVALID
  [V: https://shopify.dev/docs/api/admin-graphql/latest/enums/CustomerEmailMarketingState];
  SMS consent (deprecated field, same shape); `tags`, `note`, `addresses`, `defaultAddress`,
  `amountSpent` (lifetime), `numberOfOrders`, `lastOrder`, `orders`, `events` (1 year),
  `taxExempt`/`taxExemptions`, `verifiedEmail`, `locale`, `metafields`, `mergeable`,
  `canDelete` (only with no orders), `productSubscriberStatus`, `statistics`
  (predicted spend tier), `storeCreditAccounts` (one per currency), `companyContactProfiles`,
  `paymentMethods`, `subscriptionContracts`, `dataSaleOptOut`.
- **Segment** ("dynamic, rule-based customer lists"): `name` (unique), `query`, `creationDate`,
  `lastEditDate`, `default` (Shopify-created); mutations `segmentCreate/Update/Delete`;
  `customerSegmentMembers` (≤250 per page, `totalCount`, `statistics`); `segmentFilters`,
  `segmentFilterSuggestions`, `segmentValueSuggestions` for building a picker
  [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/Segment;
  https://shopify.dev/docs/apps/build/marketing/customer-segments/manage].
- **Segment query language** [V: https://shopify.dev/docs/api/shopifyql/segment-query-language-reference]:
  `<attribute> <operator> <value>`; AND/OR with parentheses (AND binds first); ≤10 clauses;
  operators `=` `!=` `>` `>=` `<` `<=` `BETWEEN … AND …`, `CONTAINS`/`NOT CONTAINS` (lists),
  `MATCHES`/`NOT MATCHES` (functions); dates `2020-05-30`, `-7d` `-2w` `-1m` `-1y`, `today`,
  `yesterday`. Filters: `customer_tags`, `customer_account_status`, `customer_added_date`,
  `customer_email_domain`, `customer_language`, `customer_cities/regions/countries`,
  `customer_within_distance`, `companies`, `store_credit_accounts`,
  `email_subscription_status`, `sms_subscription_status`, `product_subscription_status`,
  `amount_spent`, `number_of_orders`, `first_order_date`, `last_order_date`,
  `abandoned_checkout_date`, `predicted_spend_tier`, `rfm_group`, `orders_placed`,
  `products_purchased`, `shopify_email.opened/clicked/bounced/…`,
  `storefront_event.product_viewed/collection_viewed`, `anniversary('metafields.facts.birth_date') = today`.
  Example: `email_subscription_status = 'SUBSCRIBED' AND (customer_countries CONTAINS 'CA' OR amount_spent > 999.99)`.
  Admin editor default query: `FROM customers SHOW customer_name, note, subscription_status,
  location, orders, amount_spent WHERE [filters] ORDER BY updated_at`
  [V: https://help.shopify.com/en/manual/customers/customer-segmentation/reference-guide].
- `customers` query filters: `accepts_marketing`, `country`, `customer_date`, `email`,
  `first_name`, `last_name`, `last_abandoned_order_date`, `order_date` (ranges), `orders_count`,
  `phone`, `state`, `tag`, `tag_not`, `total_spent`, `updated_at`
  [V: https://shopify.dev/docs/api/admin-graphql/latest/queries/customers].

**2.4.3 Workflows and UI**
- **Profile page** [V: https://help.shopify.com/en/manual/customers/manage-customers]: Timeline
  (one entry per email sent, warning icon on failures, resend to customer or self); "Customer
  Note" (staff only); Customer overview (name, language, email, phone); Addresses (default);
  Tax settings; **Marketing subscriptions** (email, SMS, WhatsApp — changed "through the
  marketing settings", i.e. consent is the guest's); Tags (not case sensitive); Payment methods
  (send update link); Store credit (balance → All transactions / Expirable amounts; credits and
  debits as timeline events) [V: https://help.shopify.com/en/manual/customers/store-credit];
  merge two customers; delete only if no orders.
- **Index** [V: manage-customers; https://help.shopify.com/en/manual/customers/customer-search]:
  "Search customers" matches name, mailing address, email, phone; **Sort by**; **Columns**
  (drag, show/hide; "Customer name" first); default **All customers** segment; select all on
  page (50) or all in a segment/search; **Edit customers** (bulk editor: name, tags, marketing
  acceptance, metafields), bulk Add/Remove tags, **Delete selected customers**, **Merge**.
- **Segments** are used to target email, to limit discount eligibility (≤5 segments on an
  automatic discount, ≤100 on a code) [V: managing-discounts], as the Flow trigger "Customer
  joined segment" [V: Flow triggers], and for predicted spend tier planning.
- **Accounts**: one-time 6-digit code, no password, sessions up to 365 days; customers "view and
  manage their orders, edit profile information… self-serve returns or reordering"
  [V: https://help.shopify.com/en/manual/customers/customer-accounts].
- **Store credit**: staff issue from the profile with amount, currency, expiry ("expires at the
  end of the day in your store's timezone"), email notify; refunds to store credit need the
  "Refund to store credit" permission; redeemed in full only, signed in or via Shop Pay
  [V: store-credit].

**2.4.4 Hospitality translation**
- *Maps (identity, loyalty, reviews):* profile sections map cleanly: contact, staff-only note,
  tags, **consents** (email/SMS as states the guest changes, REDACTED on erase ↔
  `identity.onCustomerErase`), visits and spend (lifetime spend, number of visits, last visit),
  **house credit** (store credit: amount, expiry end-of-day venue time, timeline events,
  manager issues it after a bad night), **merge duplicates** (identity merges exist), delete
  rules. `anniversary()` is exactly the birthday-offer trigger. `customer_within_distance` is
  the local-radius filter a venue wants.
- *Lacks:* a **guest timeline** (bookings, dockets, messages sent with resend, review left,
  loyalty events, consent changes, assistant touches); **segments with a query language** that
  campaigns and offers consume: `last_visit_date < -60d`, `visits_count >= 5`, `amount_spent >
  500`, `no_show_count >= 2`, `dietary_tags CONTAINS 'gluten-free'`, `postcode IN (...)`,
  `email_subscription_status = 'SUBSCRIBED'`, `last_booking_date`, `abandoned_booking_date`,
  `favourite_item MATCHES (...)`, `anniversary('birth_date') = today`; a filter picker fed by
  `segmentFilters`-style metadata so staff never type ShopifyQL; **default segments**
  ("Regulars", "Lapsed 60+ days", "Subscribed, never visited", "Booked, never came"); index
  **Columns** and **Sort by**; bulk tag/delete/merge; **RFM-style groups** for retention (the
  spine); **predicted next visit**.
- *Hospo-only:* **structured dietary needs and allergies** (not tags; shown on every docket and
  booking; quoted guest text rendered as text); **no-show count and reliability**; **seating
  preferences**, favourite table/server; **party size history**; **booker vs attendee**
  (one guest books for six); **walk-in vs booked**; **special dates** (anniversary, birthday);
  **card recognition** consent (`card_recognition`, hashed per org, nothing may depend on it);
  review history and responses; loyalty tier and points; the Australian consent rules (no
  staff-granted marketing consent, `identity.grantConsent` refuses staff).

### 2.5 Marketing (now "Growth")

**2.5.1 Contains** [V: https://help.shopify.com/en/manual/promoting-marketing;
https://help.shopify.com/en/manual/promoting-marketing/create-marketing]
"From the Growth page" merchants "create marketing campaigns, send email and SMS marketing",
build sign-up forms, connect integrations, review performance, add pixels. Sub-pages: Developing
a marketing plan · Setting up marketing in Shopify (Shopify Messaging, collecting contact
information, Shopify Forms, Campaigns, Facebook/Instagram, social posting, Marketing automation
tools, Recovering abandoned checkouts, Shopcodes QR codes, Launchpad, new abandoned-checkout
automation) · Content marketing · Brand assets · SEO · Analyzing campaigns · **Campaign
Autopilot** ("review and approve tactics before you run them") · Shopify Audiences (Plus) ·
Knowledge Base · Sales events · Collabs · Product Network · Pixels and customer events. Growth
tab = Campaigns, Attribution, Autopilot; Automations in the Shopify Messaging app [V: changelog].

**2.5.2 Objects and states**
- **MarketingActivity** ("marketing that a merchant created through an app"): `status` ACTIVE,
  DELETED, DELETED_EXTERNALLY, DISCONNECTED, DRAFT, FAILED, INACTIVE ("has completed running"),
  PAUSED, PENDING, SCHEDULED, UNDEFINED; `statusLabel`, `statusBadgeTypeV2`, `adSpend`,
  `budget`, `marketingChannelType`, `tactic`, `utmParameters`, `urlParameterValue`,
  `sourceAndMedium`, `targetStatus`, `title`, `parentActivityId`, `hierarchyLevel`,
  `inMainWorkflowVersion`, `app`, `formData`, `activityListUrl`
  [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/MarketingActivity;
  https://shopify.dev/docs/api/admin-graphql/latest/enums/MarketingActivityStatus].
- Flow triggers for lifecycle: Customer created, Customer joined segment, Customer subscribed to
  email marketing, Customer abandons checkout, Customer left online store without making a
  purchase, Order paid, Scheduled time [V: Flow triggers].

**2.5.3 Workflows and UI**
- **Campaigns** "create and track multichannel marketing efforts that work towards a specific
  goal"; **campaign activities** are "existing traffic that you can manually associate with a
  campaign" (a Messaging newsletter, a social ad); **UTM auto-match rules**; **shareable
  links** (full URLs private for ad managers; short links and QR codes public); report metrics
  Sales, Orders, AOV, Sessions [V: https://help.shopify.com/en/manual/promoting-marketing/create-marketing/campaigns;
  https://help.shopify.com/en/manual/promoting-marketing/create-marketing/campaigns/understanding-campaigns].
- **Automations** (Apps > Messaging > Automations): **Create automation** → template (four
  groups: recovering site visitors, welcoming new subscribers, post-purchase, customer
  appreciation) → channel (email or SMS) → **Turn on automation**; turning off cancels
  workflows "in a wait stage"; "Save without turning on"; **Edit workflow** → **Apply changes**;
  custom or third-party automations go to Shopify Flow; some templates use Flow's "order paid"
  and "customer joined segment" triggers [V: https://help.shopify.com/en/manual/promoting-marketing/create-marketing/create-marketing-automations].
  Named types include Abandoned cart, Abandoned checkout, Abandoned product browse, Customer
  winback ("after a specified amount of time has passed after their last order"), Custom
  [S: https://help.shopify.com/en/manual/promoting-marketing/create-marketing/marketing-automations/types].
  Abandoned-checkout emails don't count toward Messaging send limits [V: same page].
- Marketing reports: Performance by marketing channel / campaign / activity, Sales attributed to
  marketing, Sessions attributed to marketing campaigns, Marketing top channel performance
  [V: https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/marketing-reports].
- Views: Marketing Campaigns and Marketing Automations are *tabbed* lists [V: views page].

**2.5.4 Hospitality translation**
- *Maps (campaigns, comms, approvals):* **Autopilot's "review and approve tactics"** is our
  "waiting for your yes" batch approval, already the contract. **Automation = lifecycle flow**
  with the same lifecycle: template → channel → *Turn on*; *turned off cancels anyone mid-wait*;
  *saved but not on*. Template groups translate: *bring them back* (lapsed 45/60/90 days;
  abandoned booking; abandoned pickup order), *welcome* (joined the list at booking or QR),
  *after the visit* (thank-you, review ask 2h after the table closed, "your usual table next
  Friday?"), *appreciation* (birthday via `anniversary()`, 10th visit). **Campaign = one named
  effort** grouping sends, a QR code on table talkers, and a Criota UGC post (the plug) with
  attribution to visits/bookings/dockets through the ledger.
- *Lacks:* campaign object with **short links and QR codes** that attribute (the qr module makes
  menu codes, not campaign codes); **UTM auto-match**; **automation statuses** and the
  "cancel in-flight waits" rule; **template library** grouped by goal; **activity statuses**
  (Draft, Scheduled, Active, Paused, Inactive, Failed) with a status label and badge tone from
  the object itself (Shopify's `statusLabel`/`statusBadgeTypeV2` is a good trick: the server
  decides wording and tone); **attribution report** by campaign and channel; **sign-up forms**;
  **pixel/customer events** (events spine exists; a per-venue pixel on the website is not
  exposed).
- *Hospo-only:* **service-period targeting** (fill Tuesday lunch), **booking-driven triggers**
  (confirmed → pre-visit note with parking/menu; seated → nothing; finished → review ask;
  no-show → gentle nudge), **weather/local events** as triggers, **review responses** as a
  marketing surface, SMS consent captured at booking, Criota creators as a channel, no
  "sessions" vocabulary (visits and covers instead).

### 2.6 Discounts → Offers

**2.6.1 Contains** [V: https://help.shopify.com/en/manual/discounts]
Discount types · Discount methods · Managing and editing your discounts · Combining discounts ·
Automatically apply discounts to abandoned checkout recovery emails · Exporting discounts · Add
a discount to a gift card · Managing sales channel settings for discounts · FAQ. Discounts apply
"to the subtotal of the order before taxes".

**2.6.2 Objects and states**
- Union `Discount`: DiscountAutomaticApp, DiscountAutomaticBasic, DiscountAutomaticBxgy,
  DiscountAutomaticFreeShipping, DiscountCodeApp, DiscountCodeBasic, DiscountCodeBxgy,
  DiscountCodeFreeShipping [V: https://shopify.dev/docs/api/admin-graphql/latest/unions/Discount].
  Prefix = **method** (automatic vs code), suffix = **type** (amount off, buy X get Y, free
  shipping, app-defined).
- `DiscountStatus`: ACTIVE, EXPIRED, SCHEDULED [V: https://shopify.dev/docs/api/admin-graphql/latest/enums/DiscountStatus].
- **DiscountCodeBasic** [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/DiscountCodeBasic]:
  `title`, `summary` (server-written explanation of who/where/rules), `shortSummary`,
  `startsAt`, `endsAt` (null = no expiry), `usageLimit` (null = unlimited),
  `appliesOncePerCustomer`, `asyncUsageCount`, `codesCount`, `combinesWith`, `customerGets`,
  `context` (who may use it; replaces `customerSelection`), `minimumRequirement`,
  `recurringCycleLimit`, `discountClasses`, `tags`, `totalSales`, `codes`, `rollouts`,
  `shareableUrls`, `hasTimelineComment`.
- **DiscountCombinesWith**: `orderDiscounts`, `productDiscounts`, `shippingDiscounts`
  [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/DiscountCombinesWith].
  **DiscountMinimumRequirement**: DiscountMinimumQuantity | DiscountMinimumSubtotal
  [V: https://shopify.dev/docs/api/admin-graphql/latest/unions/DiscountMinimumRequirement].
  **DiscountCustomerSelection**: DiscountCustomerAll | DiscountCustomerSegments | DiscountCustomers
  [V: https://shopify.dev/docs/api/admin-graphql/latest/unions/DiscountCustomerSelection].
- **DiscountCodeBxgy**: `customerBuys` (items + required quantity), `customerGets`,
  `usesPerOrderLimit` [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/DiscountCodeBxgy].
  **DiscountCodeFreeShipping**: `destinationSelection`, `maximumShippingPrice`,
  `minimumRequirement`, `appliesOnOneTimePurchase`/`appliesOnSubscription`
  [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/DiscountCodeFreeShipping].

**2.6.3 Workflows and UI**
- **Types** named: "Amount off discounts" (percentage or fixed; products, collection, or whole
  order), "Buy X get Y discounts", "Free shipping discounts"; apps and Checkout Blocks for
  tiered logic [V: https://help.shopify.com/en/manual/discounts/discount-types].
- **Methods**: automatic ("applied in the cart and at checkout when eligibility conditions are
  met") vs code ("the most common method") [V: https://help.shopify.com/en/manual/discounts/discount-methods].
- **Classes and limits** [V: https://help.shopify.com/en/manual/discounts/discount-combinations]:
  product, order, shipping; "Maximum of 25 active automatic discounts"; "Maximum of 5 product
  or order discount codes and 1 shipping discount code per order"; each discount has a
  **Combinations** setting and both sides must allow it; type and method can't be changed after
  creation.
- **Form** [V: https://help.shopify.com/en/manual/discounts/discount-types/percentage-fixed-amount]:
  Method "Discount code" / "Automatic discount"; code with **Generate code**; Value
  "Percentage" / "Fixed amount"; applies to "Specific products" / "Specific collections";
  "Purchase type" One-time / Subscription / Both; **Minimum requirements**: "Minimum purchase
  amount" / "Minimum quantity of items"; **Eligibility**: "All customers", "Specific
  customers", "Customer segments", "Markets"; **Maximum discount uses**: "Limit number of times
  this discount can be used in total", "Limit to one per customer"; **Combinations**; **Active
  dates** with "Set end date".
- **Index** [V: https://help.shopify.com/en/manual/discounts/managing-discounts]: views All /
  Active / Scheduled / Expired [V: views page]; filters Status, Method, Type, Combines with,
  Start date, Times used, Eligibility, Market eligibility, Customer segment eligibility,
  Specific customer eligibility, Tag; **Activate discounts / Deactivate discounts / Delete
  discounts** (each confirmed); **Duplicate**; deactivate (unexpired only) and reactivate
  (expired only); segment limits 5 (automatic) / 100 (code); 5 codes per order incl. shareable
  links; a **Rollout** column; **Timeline** on the discount (created, active/expired, edits
  saved, staff comments).
- Discounts can be set per sales channel and applied automatically in abandoned-checkout emails
  [V: discounts index].

**2.6.4 Hospitality translation**
- *Maps (offers, loyalty):* **code offers = vouchers/promo codes**; **automatic offers = the
  specials everyone gets** (happy hour, lunch deal, kids eat free Tuesday); **buy X get Y** =
  "buy a main, get a drink", 2-for-1; **free shipping** = free delivery over $40;
  **Scheduled / Active / Expired** lifecycle; **eligibility** All guests · Loyalty members ·
  A guest list (segment) · Named guests; **once per guest** for first-visit offers; **total use
  cap**; **combinations** with a plain-words summary the server writes (`summary`:
  "15% off mains for loyalty members, Tue–Thu, dine-in only, not with other offers").
- *Lacks:* method as a first-class choice; the **class model** (dish / whole bill / delivery) and
  per-offer combinability; **lifecycle views**; **usage counts and sales attributed**
  (`asyncUsageCount`, `totalSales`) per offer; **Duplicate**; **Timeline** on an offer;
  **per-channel availability** (dine-in only, pickup only, not via marketplaces); the guest-
  facing refusal text when a dead code is tried; **tags on offers**; export.
- *Hospo-only:* **time-of-day recurrence** (happy hour 4–6pm weekdays) rather than start/end
  dates; **dine-in vs takeaway vs delivery** applicability; **surcharges** as first-class objects
  (public holiday %, Sunday %, card fee, group service charge, split-bill fee) — commerce has
  no surcharge; a "negative discount" hack would be wrong because surcharges apply *after*
  discounts and have legal display rules in AU; **comps and voids** (manager comps a dish:
  reason, approver, shows on docket and in reports); **staff meals**; **minimum spend per
  head** for groups; **loyalty rules** (points per $, thresholds, expiry) living next to
  offers; **vouchers as prepaid value** (gift cards) vs offers.

### 2.7 Content → Website

**2.7.1 Contains** [V: https://help.shopify.com/en/manual/custom-data/navigating-content;
changelog 2025-03-20; https://help.shopify.com/en/manual/online-store/menus-and-links]
Content section: **Metaobjects** (default views as cards: Available on storefront, Web pages,
Active, Draft, Recent entries; filter tokens; "Save view as"), **Files** (filter by size, type:
image / video / external video / 3D model / other, and where used: products / other; views),
**Blogs** (moved 2025), **Menus** (links to products, collections, webpages, blog posts; drop-
down menus; "Theme settings" choose placement; URL redirects). Pages live under Online store >
"Creating and editing pages" [V: https://help.shopify.com/en/manual/content]. Rich text editor
and media editor are productivity tools [V: productivity-tools index].

**2.7.2 Objects.** Metaobject definitions (name, fields with types and validations, display
name, type handle, options controlling where usable) and entries (admin, API, Liquid, Storefront
API) [V: https://help.shopify.com/en/manual/custom-data/metaobjects]. `SearchResultType` shows
saved views exist for ARTICLE, BLOG, PAGE, FILE, URL_REDIRECT [V: SearchResultType]. Future
publishing for blog posts and pages shows "Hidden" + scheduled time in a Visibility section
[V: future-publishing].

**2.7.3 Workflows.** Content lists are *enhanced* (Files, Metaobjects) or *tabbed* (Blog posts)
[V: views page]. Bulk actions are not available for blog posts, pages, URL redirects
[V: bulk-actions].

**2.7.4 Hospitality translation**
- *Maps (website module):* Pages → About / Functions / Contact / Allergen info; **Files** → the
  photo library with "where used" (dish photo on 3 items and the hero); **Menus** (navigation)
  → site navigation; **Metaobjects** → structured content types a venue needs (team, press,
  FAQs, function packages, events, awards) with entries rendered as pages.
- *Lacks:* a file library with usage filters; a navigation editor; **scheduled publishing** of
  pages and posts; **news/events** (blog) with a date; **structured content types** (function
  packages: capacity, minimum spend, inclusions; events: date, tickets link).
- *Hospo-only:* **trading hours and exceptions** (`hours_set_exception` exists) as content that
  must also reach Google Business Profile and the assistant; public-holiday hours; **what's
  on**; **function packages** tied to bookings capacity; **menus as printable content** (PDF,
  print), QR table talkers (qr module); the brand kit as a first-class object (Shopify keeps
  "Brand" under Settings, §2.12).

### 2.8 Markets → price lists per channel and venue

**2.8.1 Contains** [V: https://help.shopify.com/en/manual/markets]
"group customers into markets based on conditions such as location, customer group, retail
location, or sales channel"; each market customises currency, language, pricing, product
availability, theme content, domains, taxes, shipping; a **backup region** for visitors who
match no active market; fixed-amount discounts and gift cards convert across currencies.
Sub-pages: Customizing markets · Getting started · Rollouts · Discounts and gift cards ·
International SEO · Backup region.

**2.8.2 Objects.** **Market** ("A merchant-defined group of buyers identified by conditions such
as their region, retail location, or company location"): `name` (not shown to customers),
`handle`, `status`, `type` (`MarketType` CHANNEL, COMPANY_LOCATION, LOCATION, NONE, REGION),
`conditions`, `currencySettings`, `webPresences` (domain/subfolder/locales), `catalogs`
(pricing + availability per context), `metafields`
[V: https://shopify.dev/docs/api/admin-graphql/latest/objects/Market;
https://shopify.dev/docs/api/admin-graphql/latest/enums/MarketType]. Draft orders take a
Market to set pricing [V: create-draft]. Products filter by Region / B2B / Company location /
Retail / Unassigned **catalog** [V: products searching-filtering]. **Publication** carries a
`catalog` [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/Publication].

**2.8.3 UI.** Settings > "International sales tools" needs Manage settings, Domains, Dashboards,
Reports and Products permissions [V: settings-permissions]. Rollouts stage pricing changes and
add a "Rollout" column to Discounts [V: managing-discounts].

**2.8.4 Hospitality translation**
- *Maps (tenancy, menu, channels):* a single venue has no "markets". The pattern that transfers
  is **a catalog = price list + availability per context**, where the contexts are **channels**
  (dine-in, pickup, delivery, marketplaces with their commission uplift, inside assistants) and
  **venues in a group** (`MarketType.LOCATION`; the venue switcher is Shopify's store
  switcher). `MarketType.CHANNEL` is literally "price differently on this channel". Languages →
  bilingual menus.
- *Lacks:* **price lists per channel** (delivery menu +15%) and **per-venue overrides** within a
  group (same menu, different price in the CBD); "available on this channel" as a catalog, not
  a per-item checkbox; a **backup** rule (what a guest sees when no channel rule matches);
  staged **rollouts** of a price change at a date/time (menu round goes live Monday 11:00).
- *Hospo-only:* **service-period pricing** (lunch price vs dinner price for the same dish) is a
  third dimension commerce lacks; **state-based public holidays** (NSW vs Vic surcharge days);
  GST-inclusive display (`Shop.taxesIncluded` is true for AU venues); liquor licensing hours
  per venue.

### 2.9 Analytics

**2.9.1 Contains** [V: https://help.shopify.com/en/manual/reports-and-analytics;
https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports]
Shopify analytics (Analytics overview dashboard · Reports · Live View) · Google Analytics ·
Analytics discrepancies. Reports available "depend on your Shopify subscription plan".

**2.9.2 Objects and the query language**
- **ShopifyQL** ("a query language for commerce"): `FROM` (dataset: sales, orders, customers,
  marketing, inventory, payments…), `SHOW` metrics, `WHERE`, `GROUP BY`, `DURING` (named
  windows), `SINCE/UNTIL` (`-30d`…`today`), `TIMESERIES`, `COMPARE TO previous_period`, `WITH
  LAST_CLICK_ATTRIBUTION`, `ORDER BY`, `LIMIT`, `VISUALIZE … TYPE line`, `ANNOTATE`; used in the
  admin's ShopifyQL editor, the Admin API `shopifyqlQuery`, a Python SDK/CLI, and a metric-card
  web component [V: https://shopify.dev/docs/api/shopifyql].
- **Report categories** (11): Acquisition, Behavior, Customers, Finance, Fraud, Inventory,
  Marketing, Order, Profit, Retail sales, Sales; filter the Reports list by "Created by" =
  Shopify [V: https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports].
- Report names (selection, [V] at the category pages under
  `…/report-types/default-reports/`): **Sales** Total sales over time · Total sales by product
  / by product variant / by vendor · Sales by discount codes · Total sales by referrer / by
  billing location / by currency · Total sales by sales channel · Net sales by channel · Sales
  by customer name · Average order value over time · bundle and subscription reports.
  **Customers** New customers over time · New vs returning customers · Customers by location ·
  Returning customers · One-time customers · Customer cohort analysis · Predicted spend tier ·
  RFM customer analysis (11 groups) · RFM customer list. **Orders** Orders over time · Orders
  and reversals by product · Shipping and delivery performance · Orders fulfilled over time ·
  Items bought together · shipping-label reports. **Retail (POS)** POS total sales by product /
  variant / vendor / product type · Total sales by POS location · POS total sales by staff
  member · POS staff daily sales total · POS staff sales total. **Finance** Finance Summary ·
  Total sales breakdown · Gross profit breakdown · Payments by method / gateway / over time ·
  Taxes · Discounts by order · Store credit transactions · Outstanding store credit balance ·
  Net sales from gift cards · Outstanding gift card balance · **Tips by staff member** · Tips
  over time · Cost of goods sold. **Behavior** Conversion rate breakdown / over time · Core Web
  Vitals · Searches by search query · Searches with no clicks / no results · Sessions by landing
  page / device. **Marketing** as §2.5.

**2.9.3 Workflows and UI**
- **Overview dashboard**: "updated within about 1 minute"; any date range with period
  comparison; "metric cards for every available report" — add, remove, rearrange, group into
  labelled sections, resize; automatic insights; **targets** for metrics
  [V: https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/overview-dashboard].
  Custom reports also create a metric card in the library [V: shopify-reports].
- **Report page anatomy**: ShopifyQL editor · quick filters **Date range**, **Comparison**,
  **Currency**, **Store** (multi-store orgs) · configuration panel with **Freeform** (Metrics,
  Dimensions, Visualization, Attribution, Filters) and **Cohorts** (Metric, Cohort definition,
  Visualization, Interval, Filters) tabs · annotations · data visualisation · data table with a
  Summary row (Flat / Nested) · export; edits in the panel rewrite the query live; **Run**
  [V: https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/new-analytics/new-reports].
- **Live View**: "Visitors right now" (5 min), Total sales / sessions / orders since midnight
  in store time, **Customer behavior** (last 10 min): Active carts · Checking out · Purchased;
  Top locations, Customers, Top products; globe/map with session and order dots
  [V: https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/live-view].
- Reports is a *tabbed* list [V: views page]. Home metrics (§2.1) draw from the same library.
- A weekly **Store order summary** email (Mondays 9AM local, default on) goes to staff
  [V: https://help.shopify.com/en/manual/fulfillment/setup/notifications/staff-notifications].

**2.9.4 Hospitality translation**
- *Maps (analytics module):* `metrics_catalogue` ↔ the metrics library; `saved_view_run` ↔
  custom reports ("data explorations"); the Monday digest ↔ the weekly order summary email;
  `funnel_report` ↔ Conversion rate breakdown; `menu_performance` ↔ Sales by product.
- *Lacks:* a **reports catalogue** grouped by category with "Created by: Pipedline / this venue";
  the **report page anatomy** (date range · compare to · chart · table · export · save as my
  report) as one reusable screen; **cohorts by first-visit month** — retention is Pipedline's
  spine, so this is not optional; **RFM-style groups** feeding segments; **targets** (covers per
  week); **annotations** (mark the night the review went viral, the public holiday); **Live
  View** → "In the venue right now": open dockets, covers seated, kitchen queue, bookings
  arriving in the next hour, orders in guests' assistants right now; metric cards that link to
  their report.
- *Hospo-only:* **covers and spend per head** (not AOV), sales **by service period and by
  hour**, **table turn time**, **ticket times** (order → ready, by station), **no-show rate
  and booking lead time**, **86 frequency** per item, menu mix and margin (COGS deferred),
  **tips by staff** (Shopify has this — keep it), **delivery times** by zone, **review
  sentiment** and response time, **repeat-visit rate** (the cohort chart), surcharge revenue.

### 2.10 Sales channels → Channels

**2.10.1 Contains** [V: https://help.shopify.com/en/manual/online-sales-channels;
https://help.shopify.com/en/manual/online-sales-channels/manage]
Managing sales channels · Sales channels and Markets · Shop · Shopify Collective · **Shopify
agentic storefronts** · Marketplace channels (Google, Amazon, Temu) · Social commerce (Facebook,
Instagram, TikTok) · Buy Button · Sell on WordPress; Online Store and Point of sale are separate
manuals. Channels appear under **Sales channels** in the sidebar and in **Settings > Sales
channels**; add from the App Store (**Install**); remove via the channel's menu → **Uninstall**
with an acknowledgement checkbox; adding a channel publishes all products to it; a channel shows
**Unavailable** with a "You can't add this channel" explanation when ineligible; each channel
has its own dashboard, selectable from Home; agentic storefronts "need no installation and are
active by default for eligible stores".

**2.10.2 Objects.** **Publication** ("A group of products and collections that are published to
an app"): `catalog`, `autoPublish` ("Whether new products are automatically published"),
`supportsFuturePublishing`, `products`, `collections`, `includedProducts`, `hasCollection`;
the older `Channel` object remains [V: Publication page]. Products filter `published_status`
(`<channel>-published / -visible / -intended / -hidden`) and `product_publication_status`
(approved, rejected, needs_action, awaiting_review, published, demoted, scheduled,
provisionally_published) [V: products query]. Orders carry `publication` and `sourceName`
[V: Order].

**2.10.3 Agentic storefronts** [V: https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts]:
"discover and buy your products in AI channels" — ChatGPT (discovery referrer; pay on the
store's checkout), Google AI Mode and Gemini, Microsoft Copilot, Meta (direct checkout where
activated); managed at **Sales channels > Agentic**; requires the Agentic Storefronts
Supplemental Terms; orders show "channel or referrer attribution"; direct checkout off by
default on the Agentic plan.

**2.10.4 Hospitality translation**
- *Maps (hub, guest-plugin, channels page in `CONSOLE_IA.md` §3):* the card-per-channel page is
  already the right shape. Copy: **status with an explanation** ("Needs setup — add your opening
  hours" from the manifest's `needs`), **per-channel dashboard**, a **terms acceptance** step
  for third-party channels, **"available everywhere when added"** default with per-item
  opt-out, and **order attribution** (a "Came from" badge on every docket: Website · QR · Phone
  · Claude/ChatGPT · Uber Eats). "Inside assistants" is Shopify's agentic storefront one-for-
  one; our difference is deliberate: opt-in, and no payment inside the chat in Australia.
- *Lacks:* a per-item **channel availability matrix** (on QR, not on delivery);
  **auto-add new items to this channel** (`autoPublish`) as a channel setting; **channel
  status reasons**; a **channel dashboard** (sales, dockets, guests by channel); the **source
  badge** on dockets and in filters.
- *Hospo-only:* **third-party marketplaces** (Uber Eats, DoorDash, Deliveroo) and **booking
  aggregators** (OpenTable, TheFork) as channels that *push dockets and bookings in*;
  **Google Business Profile** order/reserve links; **phone** as a channel (draft orders);
  **walk-ins** as the channel with no record until the docket; the pass as an internal
  "channel" (kitchen screens live under Orders in `CONSOLE_IA.md`, correctly).

### 2.11 Apps → Plugins

**2.11.1 Contains** [V: https://help.shopify.com/en/manual/apps]
About apps · Apps made by Shopify · Finding and choosing apps · Installing and setting up apps ·
Managing apps · App extensions and functions · Getting help with apps · Uninstalling apps.

**2.11.2 Objects.** **AppInstallation** ("An app installed on a shop"): `app`, `accessScopes`
("permissions a merchant granted"), `activeSubscriptions`, `allSubscriptions`,
`oneTimePurchases`, `credits`, `launchUrl`, `uninstallUrl`, `metafields` (owning app only),
`revenueAttributionRecords` [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/AppInstallation].
Activity log entries name apps and channels as actors [V: activity-logs].

**2.11.3 Workflows and UI**
- **Install screen** groups access into "View personal data" and "View and edit store data",
  expandable, with the developer's privacy policy; custom-app links expire in 7 days;
  collaborators need "Manage and install apps and channels" and "Approve app charges"
  [V: https://help.shopify.com/en/manual/apps/install-setup-apps].
- **Settings > Apps** lists installed and recently uninstalled apps; the **about page** shows
  billing, access, history, privacy, permissions, extensions/functions/pixels, compatibility;
  **Activity and permissions** lists each area the app can view or edit with its last activity
  date; permissions unused for 30 days appear under **Unused access**; "Recent activity" shows
  view/edit request counts for 30 days (third-party apps only); **Privacy** groups personal
  data by category; **Billing and usage charges** (trial days, plan, cycle, usage spend vs
  limit, **Set limit** can only raise); **Functions** card with **Share logs** (24h);
  **Pixels** → Customer events; menu → **Uninstall the app**, App Store page, support, review
  [V: https://help.shopify.com/en/manual/apps/managing-apps].
- Apps add **blocks** to Products/Orders/Customers detail pages (**+ Block**, **Pin** for all
  staff), **admin actions** in More actions, and **bulk actions** on index pages
  [V: install-setup-apps; app-structure]. Shopify badges every extension with the app's icon
  and name; extensions may not advertise or request reviews [V: app-structure].

**2.11.4 Hospitality translation**
- *Maps (hub, `CONSOLE_IA.md` §4):* the manifest's `reads` / `writes` / `consent` is the
  "View personal data / View and edit" screen in plain words; **Connect** on third-party plugs
  = Install with a terms step; cost pass-through = "Billing and usage charges".
- *Lacks:* a **plugin detail page** (purpose, needs, reads, writes, consent, status, docs,
  **Activity and permissions with last-used dates**, recently uninstalled); an **unused-access
  nudge** ("Klaviyo hasn't read guests in 30 days — remove access?"); per-plug **activity
  counts** (agent_calls exists for the assistant; extend the same log to plugs as actors);
  **blocks on detail pages** (a Criota card on a guest profile, a Square card on a docket)
  and **plug actions in More actions**; a usage **spending limit** for metered plugs
  (Resend/Twilio, hosted-agent tokens).
- *Hospo-only:* the **POS plug** (Square) is the ledger's source of truth, not an add-on;
  delivery marketplaces and booking aggregators as plugs that *create records*; accounting
  (Xero); rostering; Criota's consent implications ("a booking never adds a guest to a
  marketing list"; a creator campaign never reads guest identities).

### 2.12 Settings

**2.12.1 Contains** [V: https://help.shopify.com/en/manual/your-account/staff-accounts/staff-permissions/settings-permissions;
https://help.shopify.com/en/manual/shopify-admin/shopify-admin-overview; search results]
Settings options named on the permissions page: **Store settings** (General) · **Plan** ·
**Payments** · **Checkout and customer accounts** · **Shipping and delivery** · **Taxes and
duties** · **Locations** · **Gift cards** · **International sales tools** (Markets) · **Apps and
sales channels** · **Domains** · **Brand** · **Notifications** · **Custom data** (metafields,
metaobjects) · **Languages** · **Policies** · **Customer privacy**; plus **Users** (Settings >
Users) [V: https://help.shopify.com/en/manual/organization-settings/users/user-access],
**Store activity log** (General > Resources) [V: activity-logs], and **Order processing**
(General per the page) [V: order-processing]. General also manages store details, grouping
into an organisation, and ownership transfer [S: search snippet].

**2.12.2 Objects.** **Shop** ("The central configuration and settings hub"): `name`,
`myshopifyDomain`, `primaryDomain`, `email`, `contactEmail`, `ianaTimezone`,
`timezoneAbbreviation`, `weightUnit`, `unitSystem`, `currencyCode`, `currencyFormats`,
`enabledPresentmentCurrencies`, `taxesIncluded`, `taxShipping`, `plan`, `features`,
`checkoutApiSupported`, `orderNumberFormatPrefix/Suffix`, `setupRequired`,
`customerAccountsV2`, `marketingSmsConsentEnabledAtCheckout`, `transactionalSmsDisabled`,
`fulfillmentServices`, `resourceLimits` (max variants, max options, locations), `shopPolicies`,
`shopAddress`, `metafields` [V: https://shopify.dev/docs/api/admin-graphql/latest/objects/Shop].
**StaffMember**: `name`, `email`, `active`, `isShopOwner`, `accountType` (regular, invited,
collaborator, collaborator_team_member, requested, restricted, saml), `locale`, `avatar`
[V: https://shopify.dev/docs/api/admin-graphql/latest/objects/StaffMember].

**2.12.3 Workflows and UI**
- **Users and roles**: Settings > Users; Shopify-managed roles (store owner, **Administrator**,
  organisation roles); custom roles on some plans; "the cumulative permissions from all the
  user's assigned roles"; **Assign role** to many; **Actions** → **Suspend** / **Remove**
  (permanent); **Revoke Access** per device; CSV import for bulk; Basic/Starter cannot add
  users [V: user-access]. Permission families: store-level, organisation-level, POS app-level,
  partner; "Sensitive permissions"; each Settings option needs a named permission ("Manage
  settings", "Manage plan", "Locations", "Domains", "Manage taxes and duties", "Manage shipping
  and delivery", "Manage and install apps and channels")
  [V: https://help.shopify.com/en/manual/your-account/staff-accounts/staff-permissions/staff-permissions-description;
  settings-permissions].
- **Notifications** [V: https://help.shopify.com/en/manual/orders/notifications;
  https://help.shopify.com/en/manual/fulfillment/setup/notifications/customer-notifications;
  staff-notifications]: categories customer email, SMS, staff, exchange, webhooks; customer
  templates named: Order confirmation, Order canceled, Order refund, Shipping confirmation,
  Shipping update, Out for delivery, Delivered (+ Ready for pickup, Picked up by customer,
  local-delivery confirmation); most "can't be deactivated", some have a "Send a notification to
  the customer" toggle at the moment of action; **staff recipients** are an email or a staff
  member, optionally limited to a POS location or web orders, with **Add recipient**, per-
  recipient on/off, **Send test notification**; other staff alerts: **Store order summary**
  (weekly Mondays 9AM default), New return request, Sales attribution ended, New draft order,
  Order dispute updates; needs Orders + Manage settings permissions.
- **Order processing**: auto-fulfil, auto-archive, confirmation step (§2.2.3).
- **Store defaults** time zone governs future publishing [V: future-publishing]; store credit
  expiry uses "your store's timezone" [V: store-credit].
- Settings page pattern (§1.10): rows with heading + subdued description + chevron; narrow
  title column, wide form column; destructive settings confirmed in a modal.

**2.12.4 Hospitality translation**
- *Maps (tenancy, console, comms, platform):* Store details → **Venue details** (name,
  address, **time zone** — `ctx.now()` and business dates already run in the venue's zone,
  currency AUD, GST-inclusive); Users → **Team** with stacked roles (owner, manager, staff,
  device — `requireStaff(minRole)` exists) and *Suspend* / *Remove* / *Revoke device*
  (`auth.onStaffDisabled`); Customer privacy → **Privacy** (consents, erasure, card
  recognition); Policies → **House policies** (booking cancellation, deposit, allergen
  disclaimer); Brand → brand kit (Website); Locations → venues in the group; **Notifications**
  → staff alerts (new order → kitchen; new booking; review posted; assistant needs approval)
  with recipients per venue/channel and **Send test notification**; Store activity log →
  surfacing `audit()`; Order processing → "Accept orders automatically / require a tap" and
  "Close finished dockets automatically".
- *Lacks:* Settings as a **grid of option cards with one-line descriptions**; a documented
  **permission per settings option**; an **activity log page** (the spine has `audit`; Shopify
  caps at 250 rows and view-only — we can filter and export, but keep the same columns: who
  incl. assistant/plug, what, when); the **staff notification recipients** model and test send;
  **weekly summary** email as a notification setting (the digest exists; make it a setting);
  **order number prefix** per channel; **Suspend** (soft) vs **Remove** (hard) for staff.
- *Hospo-only:* **service periods** and **trading hours exceptions** (public holidays,
  private functions); **surcharges** configuration; **floor plan/tables** (deferred);
  **kitchen screens and printers** (routing by station); **docket numbering** reset per service;
  **tipping** (pooled vs individual); **deposit and no-show fee** policy; **liquor licence
  hours**; **GST registration** and receipt wording.

### 2.13 Sidekick → Assistant

**2.13.1 Contains** [V: https://help.shopify.com/en/manual/ai-powered-tools/sidekick
(the old productivity-tools/sidekick URL redirects here)]
Sub-pages: set-up · voice-and-screenshare · help-and-guidance · generate-content · generate-apps
· skills · memory · pulse. "You can chat with Sidekick from any page in your Shopify admin on
desktop or mobile"; text, voice mode, screen sharing, Apple Watch voice. Tasks: "analyzing
data, managing orders, or editing products", working with third-party apps, writing blog posts
and product descriptions and images, generating custom apps. **"presents changes for your
review before applying them."** **Background tasks**: "continues working in the background,
even if you close the chat or navigate away", then notifies. **Memory**: "uses past
conversations and recent activity in your admin". **Skills**: "save them as skills and run them
again with a shortcut". **Pulse** recommendations on Home.

**2.13.2 Pulse** [V: https://help.shopify.com/en/manual/ai-powered-tools/sidekick/pulse]:
"Sidekick proactively researches your store's data and generates personalized recommendations";
up to five cards on Home; "Sidekick never makes changes to your store without your approval";
acting opens a chat with a to-do list, each change reviewed and approved; dismiss with an
optional reason that tunes future suggestions; requires recent sales, admin-level access, and
Shopify Network Intelligence on.

**2.13.3 Where it shows up elsewhere.** Search: a link opens Sidekick when results are thin
[V: admin-search]. Order editing: Sidekick "makes the changes in the order editor for you to
review" [V: editing-orders]. Home: Sidekick guides run a task from a card with progress
[V: shopify-home]. Built for Shopify 4.3.5 forbids apps styling AI features so they look like
Shopify's [V: requirements].

**2.13.4 Hospitality translation**
- *Maps (hub, approvals, `CONSOLE_IA.md` §5):* "presents changes for your review" = Pipedline's
  `propose` → plain-words question → `commit`, and the approvals queue; **Pulse** = assistant
  suggestions on Home with approve / dismiss-with-reason — `insights_digest` already produces
  the material; **memory** = agent memory (tenant-scoped; consent-aware; never guest PII into a
  third-party assistant without the connection's terms); **skills** = saved prompts/routines
  for the venue ("Monday numbers", "86 report"); the assistant log (agent_calls, before/after)
  is Shopify's Timeline attribution (`attributeToApp`, `appTitle`) made visible.
- *Lacks:* an **assistant entry point on every console page carrying page context** ("about
  this docket / this guest"); **background tasks with a notification when ready**;
  **recommendation cards** with a dismissal feedback loop and a cap (five); **guides** (the
  assistant walks the owner through go-live from a Home card with progress — `go_live_check` is
  the material); **saved prompts**; an "Ask the assistant" fallback in global search.
- *Hospo-only:* **several assistants, not one** — the owner's own Claude/ChatGPT over MCP, the
  hosted agent with modes off/shadow/supervised/autonomous (richer than Sidekick's single
  review-before-apply), and *guests'* assistants (the guest-plugin channel), each with its own
  permissions; **floor-side use** (voice at the pass, phone in hand, 86 an item by speaking);
  **per-tool approval** rather than a blanket "review"; **quoted guest content labelling** when
  text goes to an assistant; **no payment inside the chat** in Australia.

---

## 3. The 15 patterns most worth adding to Pipedline's console next (ranked)

| # | Pattern (Shopify source) | Hospo wording in the console | Module(s) |
|---|---|---|---|
| 1 | Saved views with filter tokens, default views you can't delete, sort not saved, column customisation (§1.1) | **Views** on Orders, Bookings, Guests, Menu, Offers; defaults "Needs accepting · In the kitchen · Ready · Today"; "Save view as", "Update view", "Delete view?" | console (shell) + each module declares its filters |
| 2 | Three independent status axes on an order + return/delivery status, each a badge and a filter (§2.2) | **Kitchen** (New/Accepted/Cooking/Ready/Collected·Delivered·Served) × **Money** (Unpaid/Paid/Partly refunded/Refunded/Voided/Due) × **How it leaves** (Pickup/Delivery/At the table/Counter); "Came from" source badge | ordering, delivery, qr |
| 3 | Timeline with system events + staff comments, @mentions, attachments, # references, app attribution (§1.4) | **Timeline** on every docket, booking and guest; "Leave a note for the team…", @Sam, assistant entries badged | spine `events`/`audit` + console component |
| 4 | Bulk-action bar "N selected", destructive confirm that repeats the verb, toast, save bar guarding unsaved changes (§1.2, §1.3, §1.6) | "3 selected — Accept · Print dockets · Mark collected · More"; "Cancel 3 orders?" → **Cancel orders**; "Unsaved changes — Save / Discard" | console (shell) |
| 5 | Customer segments with a query language, filter picker fed by filter metadata, segments consumed by discounts and automations (§2.4) | **Guest lists**: `last_visit_date < -60d AND email_subscription_status = 'SUBSCRIBED'`; defaults "Regulars", "Lapsed 60+ days", "Booked, never came"; used by campaigns and offers | identity, campaigns, offers |
| 6 | Discount model: method (code/automatic) × type × class, combinability per offer, Active/Scheduled/Expired, usage count and sales attributed, server-written summary (§2.6) | **Offers**: "Code or automatic?", "Dish / whole bill / delivery", "Can be used with…", status views, "Used 42 times · $1,260 in sales", plain-words summary; plus **Surcharges** as their own object | offers, loyalty |
| 7 | Abandoned checkouts list with Email status / Recovery status, recovery message, 3-month purge, convert to draft (§2.2) | **Didn't finish**: abandoned pickup orders and abandoned bookings; "Send a nudge", "Recovered" badge; keep by turning into a phone order | ordering, bookings, campaigns |
| 8 | Home: task counts by type that deep-link to filtered views; dismissible cards with persisted dismissal; Pulse cards with approve / dismiss-with-reason, capped at five (§2.1, §2.13) | **Needs attention**: "4 orders to accept · 2 bookings to confirm · 1 batch waiting for your yes · 3 reviews to answer"; **Your assistant suggests** (approve / not now, why?) | console/home, hub, approvals |
| 9 | Reports catalogue by category with "Created by"; report page = date range · compare to · chart · table · export · save; cohorts; targets; annotations (§2.9) | **Reports**: Sales · Guests · Bookings · Menu · Delivery · Staff; "Compare to last month"; **Repeat-visit cohorts**; "Covers target: 900/week"; "Mark this night" | analytics |
| 10 | Draft orders: custom item, payment terms with deposit, hold items, send a pay link, auto-expire (§2.2) | **Phone and function orders**: "Add a custom item", "Deposit now, balance on the day", "Hold the private room", "Send a pay link", drafts untouched for a year are cleared | ordering, bookings (functions) |
| 11 | Future publishing + inventory policy per variant (§1.12, §2.3) | **Scheduled menus** ("Brunch menu goes live Sat 8:00", "Winter menu from 1 June") and **86'd until** (end of service / tomorrow / until I say) with auto-return | menu, specials, website |
| 12 | Publication per channel with autoPublish; catalogs = price list + availability per context (§2.8, §2.10) | **Where it shows** per item (Website · QR · Pickup · Delivery · Inside assistants) with "new items go everywhere" per channel; **Price lists** per channel and per venue (delivery +15%) | menu, channels, tenancy |
| 13 | Staff notifications: recipients per location/channel, per-recipient on/off, "Send test notification", weekly summary email (§2.12) | **Alerts to the team**: new order → kitchen printer/screen · new booking → manager · review posted · assistant needs your yes; "Send a test"; "Monday numbers" email as a setting | comms, console/settings |
| 14 | App about page: activity and permissions with last-used dates, unused access after 30 days, data grouped by category, blocks on detail pages (§2.11) | **Plug detail**: "Reads guests, writes messages · last used 2 days ago"; "Klaviyo hasn't read guests in 30 days — remove access?"; a Criota card on a guest, a Square card on a docket | hub/plugins |
| 15 | Store activity log (who incl. apps/channels, what, when) + global search Ctrl/Cmd+K with category filters and an assistant fallback (§1.11) | **Activity**: "Sam 86'd the barramundi 19:40 · Assistant changed Friday's hours · Square posted 212 dockets"; **Search** "orders, guests, menu items…" with "Ask your assistant" | console/settings, hub |

Honourable mentions, cheaper and still worth it: empty states that say why and what next
(§1.8); status badges past-tense with one tone per status (§1.7); settings as option cards with a
one-line description (§1.10); house credit with end-of-day expiry on the guest profile (§2.4);
"Came from" attribution on dockets from the agentic-storefront pattern (§2.10).

---

## 4. Did not read / could not verify

**Pages that no longer resolve (only indexed snippets, tagged [S] above):**
- All Polaris content guidelines: voice-and-tone, actionable-language, error-messages,
  help-documentation, fundamentals, grammar-and-mechanics, merchant-to-customer.
- All Polaris patterns: resource-index-layout, resource-details-layout, common-actions,
  app-settings-layout. All Polaris component content guidelines (empty-state, badge, modal).
- `polaris.shopify.com/legal/license`. The GitHub LICENSE and the Polaris repo's markdown were
  deliberately **not** read (outside the stated boundary).

**Not verified from a public page:**
- The QueryRoot field list itself (the page renders no fields; individual query pages exist).
- Shopify's **default segment template names** ("Customers who have purchased more than once",
  "Email subscribers", "Abandoned checkouts in the last 30 days" are third-party claims) [U].
- Orders default views beyond **All** and **Unfulfilled** (Unpaid/Open/Archived as views) [U];
  Orders sort options [U]; the named cards on the order details page (items/fulfilment,
  payment, customer, risk, conversion summary) [U]; the exact "Mark as paid" button label on a
  draft (the page says "marking the order as paid") [U]; "Collect payment" wording [U].
- Discount form: the "Summary" card, the combination checkbox labels ("Product discounts /
  Order discounts / Shipping discounts" in the UI), a "No minimum requirements" option [U].
- Customers index **filters** (as opposed to search, sort, columns, segments) [U].
- Full customer **notification template list** (only Order confirmation, Order canceled, Order
  refund, Shipping confirmation, Shipping update, Out for delivery, Delivered, Ready for pickup,
  Picked up by customer and a local-delivery confirmation were confirmed) [U for the rest].
- Permission names per admin area (Home, Orders, Draft orders, Products, Customers, Reports,
  Marketing, Discounts…) — the public page lists the permission *groups* only [U].
- The exact date Shopify Email became Shopify Messaging (third party says 2025-12-10) [U].
- The "Expected pickup date" drop-down's visible option labels (the API enum's "Usually ready
  in 1 hour"… descriptions are verified; the admin labels are not) [U].
- Automatic archiving criteria beyond "paid and fulfilled" or "fully refunded"; whether Order
  processing sits under Settings > General or Settings > Checkout (the page body says General;
  the search snippet says Checkout) [U].
- Sidekick plan/region availability and any privacy statement; Live View permissions; Markets
  sub-objects (`MarketWebPresence`, catalog fields); `MarketingTactic` values;
  `CustomerMarketingOptInLevel`; `SearchFilter` structure; `CommentEventEmbed` members;
  `DiscountMinimumQuantity/Subtotal` field names; `ShopPlan`/`ShopFeatures`/`ShopResourceLimits`
  sub-fields; the last 11k characters of the Order page and 16k of the Shop page [U].
- Anything about Shopify POS beyond the retail reports, the Shop app, Shopify Payments, B2B,
  and the refreshed admin design's final layout — out of scope and not read.

**Explicitly not done:** no sign-in, no fetch behind authentication, no JavaScript bundle, no
screenshot of a logged-in admin, no code from any Shopify repository.
