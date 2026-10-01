# specials — the specials board

The worked example of `docs/PLUGINS.md`. Spec: `docs/modules/specials.md`.

A manager posts a special (name, description, price in cents, the venue-local days it runs) and
may take it down. Guests read the ones running today. A special is a notice: it is not a menu
item and cannot be ordered.

**Toggleable** per venue (key `specials`). `dependsOn: []`. Owns `specials` (migration 0700).
Uses `tenancy/venues` `getVenue` (name and time zone). Nothing else.

## Public functions by purpose

Console (all call `assertModule(ctx, venueId, specialsModule)`):
- `postSpecial(ctx, specialInput)` manager. `priceCents` is integer cents. `startsOn` defaults to
  the venue's today, `endsOn` to `startsOn`. Refused: last day before first, days already passed,
  longer than `max_days`, board already at `max_running`, same name and first day already on the
  board (`conflict`). Audits `specials.posted`, tracks `special.posted`.
- `checkSpecial(ctx, specialInput)` manager. Every check `postSpecial` makes, without the write.
  Returns a `SpecialPlan` with the dates filled in. The assistant tool builds its question from it.
- `endSpecial(ctx, { specialId })` manager at the special's venue. Sets `ended_at`; the row is
  kept. Ending an ended special changes nothing and is not an error. Audits `specials.ended`,
  tracks `special.ended` (`early` = it had not passed its last day).
- `listSpecials(ctx, { venueId, show?, limit? })` read_only and above. `show`: `open` (running or
  scheduled, the default) or `all`. Each has `status`: `upcoming | running | over | ended`.

Guest-facing / public:
- `getCurrentSpecials(ctx, venueId)` no role check; an anonymous visitor may call it. Returns
  `{ heading, specials: [{ id, name, description, price, priceCents, lastDay }] }` for the venue's
  own calendar day. `price` and `priceCents` are null when `show_prices` is off. Another
  organisation's venue, or the module off: not found. It takes no other argument.

## Hooks

Registers none. Defines none.

## Config surface (`specialsConfig`, per venue)

- `heading` — what guests see above the list. Default "Specials".
- `show_prices` — whether guests see prices. Default true. Staff always do.
- `max_running` — most specials running or scheduled at once (1–50, default 10).
- `max_days` — longest one special may run (1–366, default 31).

Every setting has a `.describe()`; that text is what `plugins_list` gives an assistant.
No org-level settings namespace.

## Jobs, schedules, events, templates, tools

- Jobs and schedules: none. "Running today" is worked out at read time from the dates.
- Events: `special.posted` (`special_id`, `price_cents`, `days`), `special.ended` (`special_id`, `early`).
- Templates: none.
- Tools: `specials_list` (read, `specials:read`), `special_post` (write, `specials:write`,
  manager), `special_end` (write, `specials:write`, manager; takes the id or the exact name).

## Fixtures and tests

- Seeder `packages/fixtures/src/seeders/45-specials.ts`: on at every fixture venue, one special
  running today and one starting tomorrow.
- Tests `packages/modules/test/specials/specials.test.ts`.

## Simulated vs real

No ports or adapters.

## Known gaps

- No page shows it yet. The public menu page (`apps/web`) does not call `getCurrentSpecials`, and
  the console has no specials screen beyond the generated settings form on the Features page.
- No edit: a wrong special is ended and posted again.
- A special is not linked to a menu item and cannot be ordered or counted in sales.
