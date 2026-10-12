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
this weekday at this time, and **what needs attention**, by type and count: "4 orders to accept ·
2 bookings to confirm · 1 thing waiting for your yes · 3 reviews to reply to · 2 items sold out".
Each count is a link that opens the page filtered to exactly those rows (the Orders *Needs
accepting* view, the book's *Needs confirming*, Approvals, reviews without a reply, the menu's
*Sold out*), and each is counted by the same function that page uses, so the two never disagree.
Then **Suggestions** (managers; at most five): an order left waiting, a service that stopped, or a
figure in last week's digest that moved beyond normal variation, each worked out from your records
and never a model's opinion. Where a tool exists for it, *Accept it* runs that one step after your
yes, once; *Not now* puts it away with your reason and it is not suggested again at that venue.
Then what is waiting for your yes (campaign sends, batches of messages, changes your assistant
proposed), with Approve and Reject right there. Then this week against last, with Monday's digest
in a sentence. Until your venue is live, a card shows the setup steps done and the next thing to
do. Guidance cards ("Connect your assistant", "Tell the team when something happens") can be put
away; each person's choice is their own. At the bottom: what your assistant did this week.

## How every list works: views

Orders, Bookings, Customers, Menu, Offers and Activity are lists with **views**: a row of tabs
above the list. The first few are ours and cannot be renamed or deleted (Orders: Live · Needs
accepting · In the kitchen · Ready · Today · All · Needs attention · Tables; Bookings: Today ·
Tomorrow · Needs confirming · This week; Customers: All · Regulars · New this month · Said yes to email ·
Lapsed 60+ days; Menu: All · Sold out · Hidden online; Offers: Active · Scheduled · Expired ·
Switched off · All; Activity: Everything · The team · Assistants · Connected services · Today). Under the tabs is the
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

Online orders, pickup and table orders, delivery, phone and function orders, and the kitchen
screens, as one list with views. Every order wears four badges, and each is a filter token:
**Kitchen** (New · Accepted · Cooking · Ready · Collected, Delivered or Served; "Not with the
kitchen yet" for an unpaid checkout or a draft; "Taken off" for one rejected, cancelled or
refunded), **Money** (Unpaid · Due · Paid · Partly refunded · Refunded · Voided), **How it leaves**
(Pickup · Table · Delivery) and **Came from** (Website · QR · Phone · Inside assistants · Square).
They are never fused: a docket can be Cooking, Paid, Pickup, from the website. The default views
are Live, Needs accepting, In the kitchen, Ready, Today, All, **Unpaid** (unpaid and due together),
**Didn't finish**, **Phone and function orders**, Needs attention and (with QR on) Tables.

**Didn't finish** lists orders a guest started, gave an email or phone for, and did not pay, once
they have waited the venue's threshold (10 minutes by default; a plugin setting). Each shows when
it was started, whether it can still be paid or has lapsed, an **Email status** and a **Recovery
status**. "Send a nudge" sends one message about the guest's own order (what was in it and where
to finish or start again): never an offer, never a second one, and never to an address that has
bounced or complained. The row says **Recovered** when the guest pays that order or places and
pays a new one. Three months on, the guest's details are removed and the order leaves the list.

**Phone and function orders** are built by hand: menu items (and, for a manager, a custom item
with its own name and price), the guest's name and contact, pickup or a table, when it is wanted
(a pickup time or the function's date), and a hold date. Nothing is charged. "Send a pay link"
sends the guest a link to the venue's own order page, where they pay the full amount with the same
checkout every online order uses; the link works until the hold date. A manager can instead "Mark
as paid by cash or bank" with a reason, and the order enters the sales record and goes to the
kitchen like any paid order. Drafts untouched for a year are cleared. Deposits ("deposit now,
balance on the day") are not offered: the pay link is for the whole amount.

## Bookings

The book, one day at a time (or a run of days): covers per service against the cap, every booking
in time order, and the host's actions on each: confirm or decline a request, seat, mark a no-show,
finish, cancel, singly or several at once. Each row says where the booking **came from** (Website ·
Inside assistants · Phone · Staff) and, for a guest with a record of not turning up, how many
**no-shows** they have had (read-only, across the organisation). The reference opens the booking's
own page with its timeline. "Add a booking" takes a phone booking at any time inside a service.
Booking rules (managers) are the services, caps, party size, lead time, cut-off, automatic
confirmation, the note guests see, and how long a request may wait for a yes; every rule is
checked before it is saved and refused with the reason if it cannot work.

**Didn't finish** on Bookings is the request the venue never answered: a booking still waiting for
a yes when the booking rules' window ran out (24 hours by default) or when its time arrived. The
booking flow records no "started" step (a request is written whole, and a guest's assistant holds
its proposal as a signed note, not a row), so this is the unfinished booking. Confirm or decline
it if you can; "Send a nudge" sends the guest one message saying the request is still waiting, how
to reach the venue, and their own link to cancel. **Recovered** when it is confirmed after all;
the guest's details are removed after three months if it never was.

## Menu

Menus, sections, items and modifiers, specials, what is 86'd, and menu import from a link or file.
Views for what is sold out, what is hidden online, what is scheduled and what is retired; a search
by item name; a filter for where an item shows. A menu or a section can be set to go live at a date
and time and to retire at another, in the venue's own time ("Brunch goes live Saturday 8:00"), and
the page can be previewed as of any date and time. 86 an item until the end of service, until
tomorrow, until a time you pick, or until someone puts it back; it comes back on its own. Each item
says where it shows (Website · QR menu · Pickup · Delivery · Inside assistants) with a venue default
for new items, and can carry a delivery or pickup price over its own. 86, put back, show on and hide
from several items at once.

## Customers

Guests as a list with views (regulars, new this month, said yes to email, lapsed), a search by
name, email or phone, their consent, loyalty members, and reviews. Hosts and front of house see
guests; kitchen and read-only roles see the loyalty and review screens only.

**Guest lists** (managers) are groups of guests described in plain words: "last visit more than
60 days ago and said yes to email", or "(spend more than $500 or visits more than 10) and suburb
is Newtown". Pick the conditions from a field, an operator and a value, or write the rule as a
sentence; the two say the same thing and either turns into the other. The fields are last visit,
first visit, visits, spend, average spend, said yes to email, said yes to texts, loyalty member,
no-shows, suburb and source; the operators more than, less than, is, is not, within the last N
days and more than N days ago; join with and / or and brackets, up to ten conditions. Five lists
come built in and cannot be changed or deleted: Regulars, New this month, Said yes to email, Lapsed
60+ days and Big spenders; yours are saved for the whole organisation. Each list shows how many
guests it holds at this venue, how many can be emailed or texted, a few of the most recent, and
where it is used (which campaigns and which offers). The Customers list can show a list's guests
("In the list"), so a saved view can be a list. Campaigns go to a list; an offer can be for a list.
A list never bypasses consent: a send still checks each guest at the moment it goes.

## Marketing

Campaigns, lifecycle flows, and Approvals: everything that waits for a person before it goes.

## Offers

Offers and vouchers, surcharges, and the loyalty rules.

An offer is used **by code** (each guest holds a single-use code: welcome, come-back, voucher,
birthday, creator) or **automatically** (applied by itself at checkout when the order qualifies; a
till discount carrying the offer's name counts as a use). It comes off one dish, a menu category,
the whole bill or the delivery fee; gives dollars or a percentage off, or a free item; is for
everyone, a guest list, new guests or loyalty members; runs between dates, on certain days, in
certain services (lunch, dinner) or a daily window, in the venue's own time; can be used with dish
offers, whole-bill offers or delivery offers only when both sides allow it; and is limited per
guest and in total. The sentence guests see is written by Pipedline from what you set ("$10 off any
main for Lapsed 60+ days, Tuesday to Thursday dinner, until 30 Nov, one per guest"), and the
assistant asks you with that same sentence. Views: Active · Scheduled · Expired · Switched off ·
All, worked out from the dates right now; each offer shows its uses, what it gave away and the sales
it sat on (alignment, not proof). Switch off stops it applying; codes guests already hold stay good.

**Surcharges** are their own thing, not negative offers: a percentage added to the bill after
offers on public holidays, Sundays or the days you choose, at one venue or every venue, with the
line menus and dockets carry: "A surcharge of 10% applies on Sundays." The national public
holidays are built in; add your state's own dates. There is no card surcharge: from 1 October 2026
a business may not add one for paying by eftpos, Mastercard or Visa (Reserve Bank of Australia),
and the page refuses to make one and says so.

## Website

Pages and the brand kit, opening hours, and QR codes.

## Analytics

Sales, **Reports**, the overview, menu performance, customer insight, marketing, saved views, the
weekly digest and the data dictionary. Every figure says which dates it covers, what it is
compared with and where it was read from.

**Reports** is a catalogue by category (Sales · Guests · Bookings · Menu · Delivery · Marketing ·
Team), each report "Created by Pipedline" or by someone on your team. A report page is one shape:
the date range, what to compare with (the previous period, or the same period last year), a chart,
the table with the change column, *Download CSV* (owners), and *Save as…* to keep it as your own
under a name and a category. Every number is the metric catalogue's own, run afresh: the page draws
and never recomputes, and your assistant's `report_run` gives the same figure. *Repeat-visit
cohorts* shows, of the guests who first came in a month, the share who came back in each month
after. A **target** is a number per metric per month ("net sales, October, $120,000"), shown as a
meter with where the month should be by today. **Marked dates** ("Menu change", "Public holiday")
are drawn on every report chart whose dates cover them. A category with no reports yet says so:
the catalogue has no measures for it, which is not the same as nothing happening.

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

Every card opens a **page of its own** (`/console/plugins/<key>`): what it reads and writes, the
tools it gives your assistant and when each was last used (from the call log, which holds the tool
and how it went, never what was said), Configure, and for a connected service its connection and
health with *Reconnect* and *Disconnect*, and in plain words what leaves the venue: Criota is sent
each venue's campaign totals above the minimum group size and never anything about one guest;
Square posts sales in and is sent online orders; an email platform is sent the profiles of guests
who said yes to email. A connected service that has neither read nor written for 30 days carries a
note suggesting you disconnect it.

## Assistant

Where your assistant connects (one address; sign in from the assistant, or paste a key made
here), the per-tool approval reminder, every connection, what the assistant did (each call, and
for owners each change with its before and after), what it is waiting for your yes on, and the
hosted agents with their modes: off, shadow, supervised or autonomous.

## Settings

The team and their roles, **Notifications**, kitchen screens, the Activity log, and for owners
privacy and records.

**Notifications** are alerts to the team. For each event (a new order, a new booking, a booking
cancelled, a review posted, the assistant needs a yes, a delivery problem, the daily digest, the
weekly digest) you choose who is told, by name or by role ("every host at the venue"), and how, by
email or text; each rule switches on and off and has *Send a test*, which delivers one message the
way the real one arrives. Quiet hours hold alerts that are not urgent until the morning, in the
venue's own time; a new order and a delivery problem always go at once. Alerts are plain messages
to your team with a link to where to act: never to a guest, and never carrying what a guest wrote.
The weekly digest goes to whoever is listed for it, or to the owners when nobody is.

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
  confirmLabel?(nouns), body?(n, nouns), destructive?, reason?, choice?, pendingLabel? }`; `choice`
  (`{ label, options[{ value, label }] }`) puts one select in the dialog, posted as `choice` (the
  Menu's "Show on… / Hide from…" picks the channel with it). The server action
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
- **Guest lists**: the grammar is `identity.parseListQuery` / `listText` / `listWords`
  (`packages/modules/src/identity/list-grammar.ts`, pure); the builder is
  `components/console/list-builder.tsx` with `BUILDER_FIELDS` and `describeQuery` from
  `console/customers/lists/rows.ts`. Filter the Customers index by a list with
  `identity.listCustomers({ query })`; count with `campaigns.previewSegment({ query })`.
- **Offers and surcharges**: `offers.offerSummary` writes the sentence; `offers.offerStatus` the
  status; `STATUS_WORDS`, `METHODS`, `APPLIES_TO`, `AUDIENCES` in `console/offers/offer-form.tsx`
  are the console's words for them.
