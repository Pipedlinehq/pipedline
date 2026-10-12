# The console, section by section

A short tour for a venue owner. The console is where you see what is happening, set things up,
and say yes. Your assistant (Claude, ChatGPT, or another that speaks MCP) does the work: it reads
the same records and calls the same functions these screens do, and asks you before it changes
anything. The spec this follows is `CONSOLE_IA.md`.

Pick the venue at the top of the sidebar; your organisation's name sits above it. On a phone the
sidebar becomes a bar along the bottom: Home, Orders, Bookings, Menu, and More for the rest.
What you see follows your role at the venue you have picked: a host sees the book; a kitchen
screen does not; only managers and owners see Marketing, Channels, Plugins, Assistant and Settings.

## Home

Today's service first: covers booked, orders in progress, sales so far against what is usual for
this weekday at this time, and anything that needs a look. Then what is waiting for your yes
(campaign sends, batches of messages, changes your assistant proposed), with Approve and Reject
right there. Then this week against last, with Monday's digest in a sentence. Until your venue is
live, a card shows the setup steps done and the next thing to do. At the bottom: what your
assistant did this week.

## How every list works: views

Orders, Bookings, Customers, Menu, Offers and Activity are lists with **views**: a row of tabs
above the list. The first few are ours and cannot be renamed or deleted (Orders: Live · Needs
accepting · In the kitchen · Ready · Today · All · Needs attention · Tables; Bookings: Today ·
Tomorrow · Needs confirming · This week; Customers: All · Regulars · New this month · Said yes to email ·
Lapsed 60+ days; Menu: All · Sold out · Hidden online; Offers: Active · Switched off · All;
Activity: Everything · The team · Assistants · Connected services · Today). Under the tabs is the
filter row; what you choose there becomes tokens you can take off one at a time, and lives in the
page's address, so a view is a link you can send to anyone at the venue. Change the filters and
"Save view as…" keeps them under a name of your own, as a tab everyone at the venue sees; on one
of your own views, "Update view", "Rename" and "Delete view" appear. Sort order is never saved.
Read-only roles see the views and cannot save one.

## Doing things to several at once

Tick the rows and a bar appears: "3 selected · Accept · Start preparing · Mark ready · Complete ·
Cancel". Each asks first in words that repeat the verb ("Accept 3 orders?" → **Accept orders**;
"Cancel 3 orders?" → **Cancel orders**, with the reason the guests are told), does them one by one,
and says what happened in a message at the bottom of the screen; any that could not be done is
named with the reason. Orders: accept, start preparing, mark ready, complete, cancel (managers).
Bookings: confirm, seat, finish, decline, cancel. Menu: 86 until end of service, put back.

## Unsaved changes

On a form that edits settings (booking rules, a plugin's settings, the weekly hours, venue
details), the moment you change a field a bar appears with Discard and Save. A link elsewhere
asks "Leave without saving?" first; closing the tab asks too. Discard puts every field back.

## Timeline

Every order, booking and guest page has a timeline: what happened and who did it, newest first,
from the record itself (the audit log and the activity stream) and from the team's notes. A person
is named; your assistant is badged **Assistant**; an agent Pipedline runs is badged with its name;
a connected service with its name. "Leave a note for the team…" adds a note; type @ to name
someone at the venue. Notes are for the team and never shown to the guest, and a note left at one
venue is that venue's.

## Orders

Online orders, pickup and table orders, delivery, and the kitchen screens, as one list with views.
Live orders, the ones needing attention (a discount the venue absorbed, a delivery that failed),
the tables ordering now, and the full list, filtered by kitchen status, how it leaves, when it was
placed and its reference.

## Bookings

The book, one day at a time (or a run of days): covers per service against the cap, every booking
in time order, and the host's actions on each: confirm or decline a request, seat, mark a no-show,
finish, cancel, singly or several at once. The reference opens the booking's own page with its
timeline. "Add a booking" takes a phone booking at any time inside a service. Booking rules
(managers) are the services, caps, party size, lead time, cut-off, automatic confirmation and the
note guests see; every rule is checked before it is saved and refused with the reason if it
cannot work.

## Menu

Menus, sections, items and modifiers, specials, what is 86'd, and menu import from a link or file.
Views for what is sold out and what is hidden online; a search by item name; 86 or put back
several items at once.

## Customers

Guests as a list with views (regulars, new this month, said yes to email, lapsed), a search by
name, email or phone, their consent, loyalty members, and reviews. Hosts and front of house see
guests; kitchen and read-only roles see the loyalty and review screens only.

## Marketing

Campaigns, lifecycle flows, and Approvals: everything that waits for a person before it goes.

## Offers

Offers and vouchers, and the loyalty rules.

## Website

Pages and the brand kit, opening hours, and QR codes.

## Analytics

Sales, the overview, menu performance, customer insight, marketing, saved views, the weekly
digest and the data dictionary. Every figure says which dates it covers, what it is compared
with and where it was read from.

## Channels

Every place guests find and buy from the venue, one card each: Website, QR menu, Online
ordering, Delivery, Bookings and Inside assistants. Each shows on or off, whether it is live, its
public address, and Configure. "Inside assistants" is the venue inside other people's assistants:
a guest using ChatGPT or Claude can find the venue, read the menu and hours, book a table and
start a pickup order paid on your own order page. In Australia no payment is taken inside the chat.

## Plugins

The catalogue: every module and every connected service, grouped by what it is for. Each card
says what it needs, what it reads and writes, what it means for guests' consent, and whether it
is on. Configure opens a form built from the plugin's own settings and their descriptions, the
same words your assistant reads. A service somebody else runs (Square, Klaviyo, Criota) connects
under Connected services, which is linked from each card. Features and Connected services stay
where they were.

## Assistant

Where your assistant connects (one address; sign in from the assistant, or paste a key made
here), the per-tool approval reminder, every connection, what the assistant did (each call, and
for owners each change with its before and after), what it is waiting for your yes on, and the
hosted agents with their modes: off, shadow, supervised or autonomous.

## Settings

The team and their roles, kitchen screens, the Activity log, and for owners privacy and records.

## Activity

Who did what and when, in plain words: "Morgan Manager 86'd “Barramundi” 19:40 · Assistant
checked whether the venue is open · Square posted sales into the record". The team's changes
come from the audit log, your assistant's from its calls (which tool and how it went; never what
was said), and connected services from what they posted. Views for everything, the team,
assistants, connected services and today; filters by who, when, and a word. Managers see the
venues they manage; owners the whole organisation. Linked from Settings and from Assistant.

## Search

Ctrl/Cmd+K anywhere, or the search box at the top of the sidebar: orders by reference, guests by
name, email or phone, menu items by name, bookings by name or reference, at the venue you are
looking at. Results are links; narrow by category. Only what your role may see is found.

## For builders (wave 2 and later)

The shared pieces live in `apps/web/src/components/console/` and `apps/web/src/lib/`:

- **Views**: declare a `ViewSpec` (`lib/console-views.ts`: `page`, `path`, `defaults[]` with `key`,
  `label`, `filters`, the `landing` key, `fields[]` of kind select/text/date), call
  `resolveView(spec, searchParams, savedRows)` on the server with
  `events.listConsoleViews(ctx, { venueId, page })`, render `<IndexViews page path resolved fields
  canSave saveAction={saveView} renameAction={renameView} deleteAction={deleteView} aside? keep? />`
  (`components/console/views.tsx`; actions from `console/views-actions.ts`), and apply
  `resolved.filters` through the service. URL grammar: `?view=<key|saved:<id>>&f=1&<filter>=…`;
  filters are read only when `f=1`. `whenRange(value, now, tz)` and `WHEN_OPTIONS` give the usual
  date windows. Add a page to `events.CONSOLE_VIEW_PAGES` and `VIEW_PAGE_PATHS` first.
- **Bulk**: wrap the table in `<BulkSelection noun={{one, many}} actions={BulkActionDef[]}
  action={serverAction} testId>` with `<SelectAllBox />` in the header and `<RowBox id label name />`
  per row (`components/console/bulk.tsx`). A `BulkActionDef` is `{ key, verb, title?(n, nouns),
  confirmLabel?(nouns), body?(n, nouns), destructive?, reason?, pendingLabel? }`. The server action
  calls `bulkAct(fd, (ctx, c, id) => service(...), { done: (n) => words, revalidate })`
  (`lib/console-actions.ts`), which runs the service once per id and words the outcome.
- **Save bar**: `<GuardedForm action submitLabel pendingLabel testId>` in place of `ActionForm`
  (`components/console/save-bar.tsx`); fields stay uncontrolled. `useUnsavedGuard(dirty)` alone for
  a custom form.
- **Timeline**: `<Timeline entityType="order|booking|customer" entityId venueId steps?
  title? testId? description? />` (`components/console/timeline.tsx`); `steps` are the record's own
  moments as `TimelineStep { kind, label, detail?, at, tone? }`. Words for audit actions, events and
  tool calls are in `lib/console-activity-words.ts` (`describeAudit`, `describeEvent`,
  `describeToolCall`, `describeActor`): add a line there for any new action or event. Notes:
  `events.addStaffNote / listStaffNotes / deleteStaffNote / listMentionableStaff`.
- **History reads**: core `listEntityAudit(ctx, { entityType, entityId, venueId })` (any staff
  role at the venue) and `listActivity(ctx, { venueId?, actorKinds?, from?, to?, limit })`
  (manager+; owner sees everything); `events.listEntityEvents(ctx, { venueId, entityType, entityId })`.
- **Search**: add a group in `console/search-actions.ts`; it must go through the service the page
  uses.
