# menu — module guide

## What it owns

One menu model read by the website, the QR menu, ordering, the guest plugin and the ledger:
menus, sections, items, modifier groups, modifiers, the 86 (sold-out) state, when a menu or
section goes live and retires, where each item shows (the five channels) and a price per channel.
Nothing is hard-deleted; removed rows get `deleted_at` so past orders and ledger lines still resolve.

- Tables (`menuModule.tables`): `menus`, `menu_sections`, `menu_items`, `modifier_groups`, `modifiers`, `item_modifier_groups`, `menu_item_prices`, `menu_settings`. Migrations 0004 and 0790.
- Spine (`spine: true`): always on, so no `assertModule` call anywhere in the module. Per-venue settings therefore live in `menu_settings`, not `venue_modules.config`.
- `dependsOn: []`. Reads `tenancy` (`getVenue`, `getOrg`, `openWindows` for end of service and tomorrow's opening).
- Spec: `docs/modules/ordering.md` section 1 ("Menu as built (2026-10-13)" there).

## The five channels ("where it shows", docs/CONSOLE_IA.md section 9 pattern 12)

`MENU_CHANNELS = ['website', 'qr', 'pickup', 'delivery', 'assistants']` (`contract.ts`;
`MENU_CHANNEL_WORDS` gives the words a venue sees). `menu_items.shown_on text[]` is the
answer per item. The two older switches `is_visible_online` (= website) and `is_visible_in_venue`
(= qr) stay on the row and a trigger (`app.menu_items_shown_on_sync`, migration 0790) keeps the
three in step whoever writes: a change to `shown_on` sets the switches; a change to a switch alone
moves the channels it stood for (online = website, pickup, delivery, assistants). The arrays are
`text[]` checked by `app.menu_channels_ok`, not `menu_channel[]`: the driver hands an array of a
custom enum back as one unparsed string. The scalar enum `menu_channel` is used by `menu_item_prices.channel`.

`MenuSurface = MenuChannel | 'online' | 'in_venue'`: the two older names keep every existing
caller working (`channelOf`: online → website, in_venue → qr). **Ordering still passes `online`
for pickup and delivery** (`ordering/pricing.ts` is the Orders builder's). For an item hidden
from pickup or delivery, or a delivery price, to reach an order, ordering must pass the order's
channel as the surface (`surface: input.channel === 'dine-in-qr' ? 'qr' : input.channel`) or call
`priceFor(ctx, itemId, channel)` per line. Until it does, orders see the website's menu at the
item's own price.

Defaults for a new item: its own `shownOn`, else its section's `shown_on`, else the venue's
`menu_settings.new_items_shown_on` ("new items go everywhere" per channel; no row = every channel).

## Schedules (pattern 11)

`menus.live_from` / `live_until` and `menu_sections.live_from` / `live_until` are instants.
Inputs take a venue-local `"YYYY-MM-DDTHH:MM"` (`liveFrom`, `liveUntil`), turned into the instant
with `zonedTimeToUtc` at write time, so daylight saving cannot move a go-live. `scheduleStateAt(row, at)`
gives `not_active | scheduled | live | retired` (`contract.ts`); `getPublicMenu` and
`getOrderableItems` use `liveAt` on both the menu and the section. A section may be scheduled
inside a live menu. The retire time must be after the go-live time (`invalid`).

## Sold out until (pattern 11)

`setItemAvailability(ctx, { itemId, available, until })` with `until` one of `'end_of_service'`
(the current or next trading period's close, else local midnight), `'tomorrow'` (the venue's
first opening on its next calendar day, else that day's midnight), an ISO time (refused with
`invalid` if already passed), or `null` / `'until_changed'`. The return is **computed on read**
(`itemAvailableAt`, `itemBackAt`): every reader compares `unavailable_until` with its clock, so
there is no job that can run late, twice or not at all, and the site, QR menu, ordering, kitchen
screen, console and assistants all flip at the same instant. The row is never rewritten by the
clock: `is_available` stays false with the past `unavailable_until`; `getMenuEditor`'s
`availability` filter and the console's `isOff` account for that. `backWords(until, now, tz)`
gives "back 9:30 pm" / "back Fri 2 Oct, 12:00 pm" / "until put back" for screens.

## Public functions by purpose

Console (manager at the venue, `requireStaff` `minRole: 'manager'`; each change is audited as
`menu.<entity>_<action>` and tracked as `menu.edited`):
- `createMenu`, `updateMenu(ctx, menuId, patch)`, `deleteMenu` — `menuInput` has `liveFrom`, `liveUntil`; delete soft-deletes its sections and items.
- `createSection`, `updateSection`, `deleteSection` — `sectionInput` has `liveFrom`, `liveUntil`, `shownOn` (nullable: the default for new items here; null = venue default).
- `createItem`, `updateItem`, `deleteItem` — `itemInput` has `shownOn`, `channelPrices` (`partialRecord` of channel → cents | null to remove), and the older `isVisibleOnline` / `isVisibleInVenue` (read only when `shownOn` is not given). `menu.edited` carries `price_changed` when the item's price or a channel price changed.
- `setItemChannels(ctx, { itemId, show?, hide? })` — "Show on… / Hide from…": adds or removes channels, the rest untouched. Audits `menu.item_updated` with `{ name, shownOn }` before/after.
- `setItemChannelPrice(ctx, { itemId, channel, priceCents | null })` — one row per item and channel (`menu_item_prices`, unique). Audits `menu.item_channel_price` `{ name, channel, priceCents, basePriceCents }`.
- `getMenuSettings(ctx, venueId)` (`read_only`), `updateMenuSettings(ctx, { venueId, newItemsShownOn })` (manager; audits `menu.settings_updated`).
- `setItemModifierGroups`, `createModifierGroup` / `updateModifierGroup` / `deleteModifierGroup`, `createModifier` / `updateModifier` / `deleteModifier` — unchanged.
- `getMenuEditor(ctx, venueId, filter?)` — the whole editable tree plus `settings` and `asOf`; each menu and section carries `schedule` (as of `filter.asOf`, else now); each item `shownOn` and `channelPrices`. `minRole: 'read_only'`. Filters: `q`, `availability: 'off' | 'on'`, `visibility` (the older four), `shownOn`, `hiddenFrom`, `schedule`, `asOf`.

Kitchen screen (`requireDevice(ctx, venueId, 'kitchen')`): `setItemAvailability` (above), `setModifierAvailability`.

Guest-facing / public (no role check; org comes from the host):
- `getPublicMenu(ctx, venueId, { surface?, at? })` — `PublicMenu` with `channel`; only menus and sections live and served at `at`; items on the surface's channel; `priceCents` is the channel's price where set; `availableFrom` is when a sold-out item is back (null: until put back / available).
- `priceFor(ctx, itemId, channel)` → `{ itemId, channel, priceCents, basePriceCents }`; not found for another org's or a removed item.

Other modules:
- `getOrderableItems(ctx, venueId, itemIds, { surface, at? })` — server price for the surface's channel, `isAvailable`, `isServed` (menu served, menu live, section live), allergens, alcohol, prep minutes, `maxPerOrder`, `posCatalogId`, modifier groups. Ids not shown on that channel are absent (caller answers not-found).
- `resolveCatalogIds`, `menuItemRef`, `MENU_REF_PREFIX` — unchanged.
- Pure helpers: `menuServedAt`, `itemAvailableAt`, `itemBackAt`, `scheduleStateAt`, `liveAt`, `channelOf`, `normaliseChannels`, `backWords`, `resolveUntil` (needs ctx: reads hours).

## Hooks

- Defines none. `contract.ts` holds the public-menu types, the channel list and the schedule helpers.
- Registers on the ledger: `catalog.ts` calls `setCatalogResolver(resolveCatalogIds)` from `ledger/record` at import time.

## Config surface

- `menuConfig = z.object({})` — empty (spine). Venue settings: `menu_settings.new_items_shown_on`.
- Per-row settings live on the rows: menu `availableDays`, `availableFrom`/`availableTo`, `liveFrom`/`liveUntil`; section `isVisible`, `liveFrom`/`liveUntil`, `shownOn`; item `shownOn`, `channelPrices`, `posCatalogId`, allergens, dietary tags, etc.

## Jobs, schedules, events, templates, tools

- Jobs / schedules / templates: none. Schedules and sold-out returns are read-time comparisons.
- Events: `menu.edited` (entity now includes `settings`), `item.availability_changed`, `modifier.availability_changed`.
- Tools (`tools.ts`, all `venueScoped`): `menu_list` (read, `menu:read`; filters `search`, `only_unavailable`, `shown_on`; output per menu/section `schedule`, `live_from`, `live_until`, per section `new_items_shown_on`, per item `sold_out_until`, `shown_on`, `channel_prices`, plus `new_items_shown_on` for the venue); `menu_set_availability` (write, `menu:write`, kitchen; `until` is `end_of_service` | `tomorrow` | `until_changed` | an ISO time with offset); `menu_schedule` (write, manager; a menu or one section, `live_from` / `live_until` as venue-local "2026-10-10 08:00" or null); `menu_show_on` (write, manager; an item, or a section's default for new items; `show` / `hide` channel lists); `menu_set_channel_price` (write, manager; `price_cents` or null). Every write is `propose` + `commit` on the same service function the console calls.

## Console (`apps/web/src/app/(platform)/console/menu`)

Views All / Sold out / Hidden online / Scheduled / Retired; filters item, 86'd, "where it shows"
(`where=on:<channel>` / `off:<channel>`; the older `visibility` values are translated), menu state.
`?asOf=YYYY-MM-DDTHH:MM` (venue-local) previews the states as of then and hides every control.
Bulk bar: 86, put back, Show on…, Hide from… (the shared `BulkActionDef.choice` select). The 86
control offers end of service / tomorrow / a time / until put back. Menu and section dialogs take
go-live and retire; section and item forms tick the five channels; the item form takes a delivery
and a pickup price. "Where new items show" dialog = `updateMenuSettings`. Kitchen screen:
`/kitchen/api/menu` returns `backAt` + `backWords` and takes `until`.

## Fixtures and tests

- No seeder of its own: `packages/fixtures/src/base.ts` inserts the rows directly (defaults: every channel).
- Tests `packages/modules/test/commerce/menu.test.ts` (wave 1) and `menu-depth.test.ts` (this pass). Browser: `tests/e2e/26-console-menu.e2e.ts`, `65-console-menu-depth.e2e.ts`.

## Simulated vs real

No ports or adapters. POS catalogue ids come in through `pos_catalog_id` on items, set by whoever edits the item.

## Known gaps

- Ordering (`ordering/pricing.ts`) passes `online` for pickup and delivery: channel prices and per-channel hiding do not yet reach a pickup or delivery order (see "The five channels"). The venue site's order page shows the website menu too (`apps/web/src/components/site/order-pages.tsx`).
- Price lists are per channel only; per-venue overrides within a group, service-period pricing and a staged price rollout are not built.
- A section's `shown_on` is a default for new items, never a filter on existing ones.
- No POS-side menu sync.
