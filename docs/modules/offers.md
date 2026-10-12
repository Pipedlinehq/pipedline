# offers — as built (2026-10-13)

The offers plugin: what a venue gives away, to whom, when, and the surcharges it adds. Built in
the console depth pass, wave 2 (`CONSOLE_IA.md` section 9, patterns 5 and 6), on the codes and
flows of the first build. The module guide is `packages/modules/src/offers/CLAUDE.md`; this is the
owner's and the integrator's view.

## 1. The offer model

Every offer answers six questions, and the server writes the answers as one sentence a guest
could read ("$10 off any main for Lapsed 60+ days, Tuesday to Thursday dinner, until 30 Nov, one
per guest").

| Question | Choices | Stored as |
|---|---|---|
| How is it used? | **By code**: each guest holds a single-use code (welcome, come-back, voucher, birthday, creator, special). **Automatic**: applied by itself at checkout when the order qualifies; a till discount carrying the offer's name counts as a use. | `method` |
| What does it come off? | One dish · a menu category ("any main") · the whole bill · the delivery fee | `applies_to`, `menu_item_id`, `category` |
| What does it give? | Dollars off · a percentage off · a free item; a minimum spend | `discount_kind`, `value_cents`, `percent_off`, `min_spend_cents` |
| Who is it for? | Everyone · a guest list · new guests (no paid visit yet) · loyalty members | `audience`, `segment_id` |
| When? | Start and end (venue time) · days of the week · services as the venue's hours name them (lunch, dinner) · a daily window (4pm to 6pm) | `starts_at`, `ends_at`, `days`, `services`, `time_from`, `time_to` |
| With what, and how often? | Combines with dish offers / whole-bill offers / delivery offers (both sides must allow it) · per guest · in total | `combine_item`, `combine_bill`, `combine_delivery`, `per_guest_limit`, `total_limit` |

**Status** is never stored: Active, Scheduled (starts later), Expired (ended) or Switched off, from
the dates and `is_active` at the moment of reading. The console's Offers views are exactly these.

**Uses and sales attributed.** A use is a redeemed code or an automatic application (`offer_uses`),
less any released by a full refund. "Sales they sat on" is the total of the sales those uses were
part of, net of refunds. It is alignment, not proof the sale would not have happened anyway, and
the console says so.

**The offers of before** (welcome with a 30-day code, come-back, vouchers, creator codes) are the
same object with method `code`, applies to `bill`, audience `everyone` and no dates; their
summaries, messages and tests are unchanged.

## 2. Where offers are enforced

One function, `offerBlockedReason`, answers whether an offer may be used here and now, and every
path asks it: a code at online checkout (`offersAdjuster.quote`), a code shown at the counter, a
code on a till sale, and an automatic offer being priced. It checks on/off and dates, the day and
the daily window in the venue's zone, the service (from the venue's hours), who it is for (the
guest list's live membership, first-visit status, loyalty membership) and the limits.

Automatic offers are priced by `automaticAdjustments(ctx, draft, applied)`, which returns ordinary
checkout `Adjustment`s, largest first when two cannot sit together. **Ordering has to call it**
from `buildCart`, after the code adjusters and before tax, and hand the result to
`offersAdjuster.commit` when the order is paid; this module does not edit ordering. Until it
does, automatic offers count at the till (by name) and are priced, but do not come off an online
total. The same applies to `codeCombinesWith` (two codes on one order).

## 3. Guest lists as "who"

An offer for a list points at a campaigns segment (`segment_id`). The list is the plain-words rule
built under Customers → Guest lists (`identity/list-grammar.ts`); membership is evaluated live when
the offer is checked, so a guest who drops out of the list drops out of the offer. The list page
shows the offers that use it, and a list an offer uses cannot be deleted.

## 4. Surcharges

A surcharge is its own object, not a negative offer: it applies **after** offers and has its own
display rule. Kinds: public holiday (the national days are built in for 2026–2028; a venue adds its
state's own dates), Sunday, or named days. Each carries a percentage of the bill after discounts
and the line menus and dockets show: "A surcharge of 10% applies on Sundays."

`applicableSurcharges(ctx, venueId, at)` gives the surcharges in force at an instant, in the
venue's day, with the reason ("Sunday", "Christmas Day") and the notice. **Ordering has to call it**
after discounts and before tax and add `surchargeAmountCents` per surcharge; `surchargeDocketLines`
gives the docket lines, `surchargeNotice` the menu line. This module does not edit ordering.

**No card surcharges.** From 1 October 2026 a business in Australia may not add a surcharge for
paying by eftpos, Mastercard or Visa (Reserve Bank of Australia, Review of Retail Payments
Regulation, conclusions paper, March 2026:
https://www.rba.gov.au/payments-and-infrastructure/review-of-retail-payments-regulation/2026-03/conclusions-paper/faqs/).
There is no kind for a payment method, and a surcharge named for one ("card", "eftpos", "Visa",
"credit", "payment", "tap") is refused by the service, the console and the assistant tool with
that explanation. Service and booking fees are outside the rule and outside this module.

## 5. The assistant

Every write exists as a tool with propose then commit, pinned to the console's functions:
`offer_set` (create or change; the question is the server-written summary), `offer_switch`,
`surcharge_set` (refuses a card surcharge before asking). Reads: `offers_summary` (now with uses,
status, method and summary) and `surcharges_list`. Guest lists have `guest_list_set` and
`guest_list_preview` (campaigns).

## 6. Tests

`packages/modules/test/guests-offers/`: `offers-model.test.ts` (summary, eligibility by list,
dates, days, services, limits; automatic against code; combinability; uses and sales attributed;
the offers of before), `surcharges.test.ts` (Sunday, public holidays, named days, docket lines,
the card refusal, roles and tenancy), `tools.test.ts` (propose changes nothing, commit once,
replay once, through the hub), `lists.test.ts` (the grammar). Browser:
`tests/e2e/64-console-guests-offers.e2e.ts`. The earlier `loyalty-offers/` suites still pass.
