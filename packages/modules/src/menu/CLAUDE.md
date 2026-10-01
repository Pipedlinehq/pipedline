# menu — module guide

## What it owns

One menu model read by the website, the QR menu, ordering and the ledger: menus, sections,
items, modifier groups, modifiers, and the 86 (sold-out) state. Nothing is hard-deleted; removed
rows get `deleted_at` so past orders and ledger lines still resolve.

- Tables (`menuModule.tables`): `menus`, `menu_sections`, `menu_items`, `modifier_groups`, `modifiers`, `item_modifier_groups`.
- Spine (`spine: true`): always on, so no `assertModule` call anywhere in the module.
- `dependsOn: []`. Reads `tenancy` (`getVenue`, `getOrg`, `openWindows` for end of service).

## Public functions by purpose

Console (manager at the venue, `requireStaff` `minRole: 'manager'`; each change is audited as
`menu.<entity>_<action>` and tracked as `menu.edited`):
- `createMenu(ctx, input)`, `updateMenu(ctx, menuId, input)`, `deleteMenu(ctx, menuId)` — delete also soft-deletes its sections and items.
- `createSection(ctx, input)`, `updateSection(ctx, sectionId, input)`, `deleteSection(ctx, sectionId)` — delete also soft-deletes its items.
- `createItem(ctx, input)`, `updateItem(ctx, itemId, input)`, `deleteItem(ctx, itemId)` — `menu.edited` carries `price_changed` on update.
- `setItemModifierGroups(ctx, itemId, groupIds)` — replaces the item's groups, in order.
- `createModifierGroup` / `updateModifierGroup` / `deleteModifierGroup`, `createModifier` / `updateModifier` / `deleteModifier`.
- `getMenuEditor(ctx, venueId)` — the whole editable tree; `minRole: 'read_only'`.
- Input schemas exported alongside: `menuInput`, `sectionInput`, `itemInput`, `modifierGroupInput`, `modifierInput` and their `update*Input` partials.

Kitchen screen (`requireDevice(ctx, venueId, 'kitchen')`: a paired kitchen device, or staff with role `kitchen` or above):
- `setItemAvailability(ctx, { itemId, available, until? })` — the 86 button. `until` is `'end_of_service'` (end of the current or next trading window, else local midnight), an ISO time, or null. Audits `menu.item_86` / `menu.item_restored`, tracks `item.availability_changed`.
- `setModifierAvailability(ctx, { modifierId, available })` — same for one modifier; audits `menu.modifier_86` / `menu.modifier_restored`.

Guest-facing / public (no role check; org comes from the host):
- `getPublicMenu(ctx, venueId, { surface?, at? })` — returns `PublicMenu` (types in `contract.ts`). Only menus served at `at` (days + from/to window, which may cross midnight); hidden sections, items hidden on the surface (`online` vs `in_venue`) and removed rows left out; an 86'd item is listed with `isAvailable: false`.

Other modules:
- `getOrderableItems(ctx, venueId, itemIds, { surface, at? })` — for ordering: server price, `isAvailable`, `isServed`, allergens, alcohol, prep minutes, `maxPerOrder`, `posCatalogId`, modifier groups. Ids not visible on that surface are absent (caller answers not-found).
- `resolveCatalogIds(ctx, venueId, externalItemIds)` — maps `menu:<item id>` or a POS `pos_catalog_id` to `{ menuItemId, category }`; removed items still resolve, a live item wins.
- `menuItemRef(id)`, `MENU_REF_PREFIX` (`'menu:'`) — how ordering names its ledger lines.
- Pure helpers: `menuServedAt(menu, localParts)`, `itemAvailableAt(item, at)`.

## Hooks

- Defines none. `contract.ts` holds only the public-menu types (`PublicMenu`, `PublicMenuItem`, `MenuSurface`, ...).
- Registers on the ledger: `catalog.ts` calls `setCatalogResolver(resolveCatalogIds)` from `ledger/record` at import time.

## Config surface

- `menuConfig = z.object({})` — empty. No org-level settings namespace.
- Per-row settings live on the rows: menu `availableDays` (0 = Sunday, venue zone), `availableFrom`/`availableTo`; item `isVisibleOnline`, `isVisibleInVenue`, `posCatalogId`, allergens, dietary tags, etc.

## Jobs, schedules, events, templates, tools

- Jobs / schedules / templates: none.
- Events: `menu.edited`, `item.availability_changed`, `modifier.availability_changed`.
- Tools (`tools.ts`): `menu_list` (read, scope `menu:read`, search / only-unavailable filters); `menu_set_availability` (write, scope `menu:write`, `minRole: 'kitchen'`, `propose` + `commit` calling `setItemAvailability`; `until` is `end_of_service` or `until_changed`).

## Simulated vs real

No ports or adapters. POS catalogue ids come in through `pos_catalog_id` on items, set by whoever edits the item.

## Known gaps

- Config schema is empty; nothing about the menu is configurable per venue yet beyond the rows themselves.
- A timed 86 is never cleared on the row: `is_available` stays false and `itemAvailableAt` treats a passed `unavailable_until` as available at read time.
- The module description says "later the POS": there is no POS-side menu sync here.
