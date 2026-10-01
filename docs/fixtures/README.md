# FIXTURES — Development tenants

Every module is built and tested against seeded fixtures. **Two of them**, and the second one
matters as much as the first. Real data comes from a first real venue as a read-only shadow tenant
; it complements the fixtures and does not replace them, because it has no
tables, no dine-in and one site.

## `oak-diner` — single venue

A generic mid-market Australian restaurant. Dine-in + pickup, ~60 covers, one kitchen with
four stations.

- 1 org, 1 venue, Sydney timezone
- Brand tokens: warm/earthy palette, `hero-photo` skeleton
- Floor plan: 3 areas (dining 14 tables, terrace 6, bar 4 stools), realistic labels
  ("1–14", "T1–T6", "B1–B4"), 5 declared table combinations
- Menu: 4 sections, ~30 items, modifier groups (cook temp, sides, milk), dietary tags,
  allergens, prep times spanning 3–18 min so coursing/fire-time logic is exercised
- Stations: grill, larder, fry, pass — with item-level routing overrides
- Service periods: lunch Tue–Sun, dinner Tue–Sat, turn times by party size
- ~400 customers with a realistic long-tail visit distribution
- ~3,000 transactions over 18 months, mixed dine-in/pickup, seasonal
- Loyalty program with tiers and a spread of balances
- Mixed acquisition sources including Criota creator attributions

## `oak-group` — multi-venue

The same brand with **three venues**, so group behaviour is proven from day one rather than
retrofitted.

Exercises specifically: a customer earning loyalty at venue A and burning at venue B ·
per-venue menu divergence · per-venue floor plans · a venue-level brand override · group-level
reporting rollup · staff with roles at two of the three venues · a venue with dine-in disabled
(pickup only) so module toggling is exercised.

## Rules

- **Every module ships seeds for both fixtures.** A module tested only against the single-venue
  fixture will break on groups, and you will find out at the customer.
- Fixtures are deterministic — seeded RNG, fixed dates relative to a passed-in "today" — so
  tests are reproducible.
- `seed.mjs` is idempotent: re-running resets to a known state.
- Fixture data is obviously fake (no real names, no real addresses) but realistically *shaped* —
  a uniform distribution of visits will hide every bug that matters in RFM and loyalty.
