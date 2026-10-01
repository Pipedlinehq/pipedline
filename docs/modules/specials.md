# MODULE — `specials` (the specials board)

> Built 2026-10-02 as the worked example of `PLUGINS.md`. Small on purpose.

A venue's daily or weekly specials. A manager posts a special with a name, a description, a
price and the days it runs. Guests see the ones running today. The venue's assistant can list
them, post one and take one down, asking first each time.

A special is a notice. It is not a menu item: it has no modifiers, no availability and no stock,
and it cannot be ordered online. A venue that wants a special to be orderable adds it to the menu.

## 1. Data

```sql
specials(id, org_id, venue_id,
         name, description,
         price_cents,             -- integer cents, typed by a manager
         starts_on, ends_on,      -- venue-local calendar days, both inclusive
         ended_at NULL,           -- set when a manager takes it down; rows are never deleted
         created_by_kind, created_by_id, created_at, updated_at)
```

Migration `db/migrations/0700_specials.sql`. One special per name and first day while it is not
ended (a partial unique index), so the same post made twice is one special.

## 2. Who may do what

| Action | Who | Function |
|---|---|---|
| Post a special | manager at the venue | `postSpecial` |
| Take one down | manager at the venue | `endSpecial` |
| See the board with history | any staff at the venue | `listSpecials` |
| See today's specials | anyone, including an anonymous visitor | `getCurrentSpecials` |

A venue the caller has no role at, and any id from another organisation, is not found. With the
module switched off, all four answer not found and the rows are kept.

## 3. Rules

- **Today is the venue's day.** A special runs from `starts_on` to `ends_on` in the venue's own
  time zone. Nothing is scheduled: whether a special is running is worked out when it is read.
- **The price is the manager's.** `price_cents` is set only by `postSpecial`, which needs a
  manager. The guest-facing read takes a venue id and nothing else.
- **Days that have passed cannot be posted.** A special may start in the future.
- **Ending is final.** An ended special is not put back; it is posted again. Ending twice has
  one effect.
- **Every change is on the record.** `specials.posted` and `specials.ended` in the audit log;
  `special.posted` and `special.ended` in the event stream.

## 4. Config surface

| Setting | Default | Meaning |
|---|---|---|
| `heading` | "Specials" | The heading guests see above the list |
| `show_prices` | true | Whether guests see prices; staff always do |
| `max_running` | 10 | Most specials running or scheduled at once (1–50) |
| `max_days` | 31 | Longest one special may run, in days (1–366) |

## 5. Assistant tools

| Tool | Effect | Scope | Role |
|---|---|---|---|
| `specials_list` | read | `specials:read` | any staff |
| `special_post` | write (asks first) | `specials:write` | manager |
| `special_end` | write (asks first) | `specials:write` | manager |

The question for a post names the special, the price in dollars, the venue and the days, for
example: `Post "Beef cheek" at $32.50 on the specials board at Oak Diner, from 2026-09-30 to
2026-10-01 (2 days)? Guests see it on those days.`

## 6. Not built

- The page. `getCurrentSpecials` is ready for the public menu page and the QR menu to call;
  neither does yet.
- A console screen for posting. Today a special is posted through the assistant tools or by
  code. The settings do appear on the console's Features page, which is generated from the
  config schema.
- Editing a special, recurring specials ("every Tuesday"), photos, and a link to a menu item.
