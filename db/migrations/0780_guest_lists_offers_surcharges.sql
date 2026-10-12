-- Console depth pass, wave 2, Guests + Offers (docs/CONSOLE_IA.md section 9, patterns 5 and 6).
--
--   - a guest's suburb and postcode on the guest record, so a list can ask "suburb is Newtown"
--     (a guest list is a plain-words query over the identity spine; see identity/list-grammar.ts,
--     stored in campaigns' `segments.definition` as {"query": "…"}, no new table)
--   - the offer model: method (code or automatic), what it applies to (a dish, a category, the
--     whole bill, the delivery fee), who may use it (everyone, a guest list, new guests, loyalty
--     members), when (dates, days, services, a daily window), what it may combine with, limits
--   - uses of automatic offers (code offers are already counted through offer_codes)
--   - surcharges as their own object: public holiday, Sunday and other day-based surcharges.
--     A card-payment surcharge is refused in code (surcharges.ts): banned from 1 Oct 2026 for
--     eftpos, Mastercard and Visa (RBA, Review of Retail Payments Regulation, March 2026).

alter table customers
  add column suburb text,
  add column postcode text;

-- ── Offers: the model ───────────────────────────────────────────────────────

create type offer_method as enum ('code', 'automatic');
create type offer_applies_to as enum ('item', 'category', 'bill', 'delivery');
create type offer_audience as enum ('everyone', 'list', 'new_guests', 'loyalty_members');

alter table offers
  add column method offer_method not null default 'code',
  add column applies_to offer_applies_to not null default 'bill',
  -- The menu category an item-class offer covers, by name as the menu shows it (applies_to = 'category').
  add column category text,
  add column audience offer_audience not null default 'everyone',
  -- The guest list (a campaigns segment) when audience = 'list'.
  add column segment_id uuid references segments(id),
  -- Null = no start / no end.
  add column starts_at timestamptz,
  add column ends_at timestamptz,
  -- Days of the week, 0 = Sunday … 6 = Saturday, in the venue's own zone. Null = any day.
  add column days smallint[],
  -- Services by the name the venue's hours use (lunch, dinner …). Null = any service.
  add column services text[],
  -- A daily window, venue-local. Null = all day.
  add column time_from time,
  add column time_to time,
  -- What this offer may be used together with. Both offers must allow it.
  add column combine_item boolean not null default false,
  add column combine_bill boolean not null default false,
  add column combine_delivery boolean not null default false,
  -- How many times one guest may use it, and how many times in total. Null = no limit.
  add column per_guest_limit integer check (per_guest_limit is null or per_guest_limit >= 1),
  add column total_limit integer check (total_limit is null or total_limit >= 1);

create index offers_segment on offers (org_id, segment_id) where segment_id is not null;
create index offers_dates on offers (org_id, is_active, starts_at, ends_at);

-- One use of an automatic offer: on an online order (recorded when the order is paid) or on a
-- till sale whose discount carried the offer's name. Released, not deleted, when the sale is
-- refunded in full, so the count a venue sees is honest either way.
create table offer_uses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  offer_id uuid not null references offers(id),
  venue_id uuid not null references venues(id),
  customer_id uuid references customers(id),
  order_id uuid references orders(id),
  transaction_id uuid references transactions(id),
  discount_cents integer not null check (discount_cents >= 0),
  used_at timestamptz not null,
  released_at timestamptz,
  created_at timestamptz not null default now()
);
create index offer_uses_offer on offer_uses (org_id, offer_id, used_at desc);
create index offer_uses_customer on offer_uses (org_id, customer_id, offer_id) where customer_id is not null;
-- The same order or sale uses an offer once, however often the confirmation is replayed.
create unique index offer_uses_order on offer_uses (org_id, offer_id, order_id) where order_id is not null;
create unique index offer_uses_transaction on offer_uses (org_id, offer_id, transaction_id) where transaction_id is not null;

-- ── Surcharges ───────────────────────────────────────────────────────────────

-- 'public_holiday': the national public holidays plus the venue's own dates; 'sunday'; 'days':
-- the days listed. There is deliberately no kind for a payment method.
create type surcharge_kind as enum ('public_holiday', 'sunday', 'days');

create table surcharges (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  -- Null = every venue of the organisation.
  venue_id uuid references venues(id),
  name text not null check (char_length(name) between 1 and 80),
  kind surcharge_kind not null,
  -- Percent of the bill after discounts, in basis points: 1000 = 10%.
  percent_bp integer not null check (percent_bp between 1 and 10000),
  -- For kind 'days': 0 = Sunday … 6 = Saturday.
  days smallint[],
  -- For kind 'public_holiday': the venue's own public-holiday dates (state holidays differ).
  dates date[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index surcharges_org on surcharges (org_id, venue_id, is_active);

select app.apply_tenant_rls();
