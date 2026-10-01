-- Menu, online and QR ordering, payments, the kitchen order screen, first-party delivery.
-- docs/modules/ordering.md · docs/modules/qr.md · docs/modules/delivery.md

create type selection_type as enum ('single', 'multi');
create type order_channel as enum ('pickup', 'delivery', 'dine-in-qr');
create type order_status as enum (
  'draft', 'pending_payment', 'placed', 'accepted', 'preparing', 'ready', 'completed',
  'rejected', 'cancelled', 'refunded'
);
create type order_payment_status as enum ('unpaid', 'paid', 'refunded', 'partially_refunded', 'failed');
create type payment_status as enum ('pending', 'completed', 'failed', 'refunded', 'partially_refunded');
create type ticket_status as enum ('new', 'acknowledged', 'ready', 'bumped', 'cancelled');
create type qr_kind as enum ('menu', 'table', 'counter', 'campaign');
create type delivery_status as enum (
  'quoted', 'requested', 'courier_assigned', 'picked_up', 'delivered', 'failed', 'returned', 'cancelled'
);

-- ── Menu: one model for the website, QR, ordering and later the POS ────────

create table menus (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  name text not null,
  is_active boolean not null default true,
  available_days smallint[] not null default '{0,1,2,3,4,5,6}',
  available_from time,
  available_to time,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index menus_venue on menus (org_id, venue_id);

create table menu_sections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  menu_id uuid not null references menus(id) on delete cascade,
  name text not null,
  description text,
  sort_order integer not null default 0,
  is_visible boolean not null default true
);
create index menu_sections_menu on menu_sections (org_id, menu_id, sort_order);

create table menu_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  section_id uuid not null references menu_sections(id) on delete cascade,
  name text not null,
  description text,
  price_cents integer not null check (price_cents >= 0),
  image_url text,
  sort_order integer not null default 0,
  is_available boolean not null default true,
  unavailable_until timestamptz,                       -- the 86 button
  dietary_tags text[] not null default '{}',
  allergens text[] not null default '{}',
  spice_level smallint,
  calories integer,
  prep_minutes integer not null default 10,
  max_per_order integer,
  is_alcohol boolean not null default false,
  is_visible_online boolean not null default true,
  is_visible_in_venue boolean not null default true,
  pos_catalog_id text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index menu_items_section on menu_items (org_id, section_id, sort_order);
create index menu_items_venue on menu_items (org_id, venue_id);

create table modifier_groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  name text not null,
  selection_type selection_type not null default 'single',
  min_selections integer not null default 0,
  max_selections integer not null default 1,
  is_required boolean not null default false,
  sort_order integer not null default 0
);
create index modifier_groups_venue on modifier_groups (org_id, venue_id);

create table modifiers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  group_id uuid not null references modifier_groups(id) on delete cascade,
  name text not null,
  price_delta_cents integer not null default 0,
  is_default boolean not null default false,
  is_available boolean not null default true,
  sort_order integer not null default 0
);
create index modifiers_group on modifiers (org_id, group_id, sort_order);

create table item_modifier_groups (
  org_id uuid not null references orgs(id),
  item_id uuid not null references menu_items(id) on delete cascade,
  group_id uuid not null references modifier_groups(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (item_id, group_id)
);
create index item_modifier_groups_org on item_modifier_groups (org_id, item_id);

-- ── QR ─────────────────────────────────────────────────────────────────────

create table qr_codes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  code citext not null unique,                         -- random slug; the QR encodes /q/<code>
  kind qr_kind not null,
  label text,                                          -- the venue's own: "12", "T4", "Bar"
  area text,
  target_path text not null default '/menu',
  campaign_id text,
  creator_id text,
  offer_id uuid,
  is_active boolean not null default true,
  print_batch text,
  scan_count integer not null default 0,
  created_at timestamptz not null default now()
);
create index qr_codes_venue on qr_codes (org_id, venue_id, kind);

create table table_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  qr_code_id uuid references qr_codes(id),
  table_label text not null,
  covers integer,
  opened_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  closed_at timestamptz
);
create index table_sessions_open on table_sessions (org_id, venue_id, table_label) where closed_at is null;

-- ── Orders ─────────────────────────────────────────────────────────────────

create table orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  customer_id uuid references customers(id),
  reference text not null,                             -- short, human, unique per venue
  channel order_channel not null,
  status order_status not null default 'draft',
  payment_status order_payment_status not null default 'unpaid',
  requested_asap boolean not null default true,
  pickup_slot_start timestamptz,
  pickup_slot_end timestamptz,
  promised_at timestamptz,
  table_session_id uuid references table_sessions(id),
  table_label text,
  qr_code_id uuid references qr_codes(id),
  subtotal_cents integer not null default 0,
  discount_cents integer not null default 0,
  tax_cents integer not null default 0,
  tip_cents integer not null default 0,
  delivery_fee_cents integer not null default 0,
  total_cents integer not null default 0,
  currency text not null default 'AUD',
  promo_code text,
  offer_code_id uuid,
  loyalty_redemption_id uuid,
  customer_name text,
  customer_email citext,
  customer_phone text,
  customer_note text,
  session_id uuid,                                     -- visitor session, for attribution
  idempotency_key text not null,
  transaction_id uuid references transactions(id),
  pos_order_ref text,
  rejected_reason text,
  placed_at timestamptz,
  accepted_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, idempotency_key),
  unique (venue_id, reference)
);
create index orders_venue_status on orders (org_id, venue_id, status, created_at);
create index orders_customer on orders (org_id, customer_id, created_at);
create index orders_slot on orders (org_id, venue_id, pickup_slot_start) where pickup_slot_start is not null;

create table order_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  order_id uuid not null references orders(id) on delete cascade,
  menu_item_id uuid references menu_items(id),
  name_snapshot text not null,
  category_snapshot text,
  qty integer not null check (qty > 0),
  unit_price_cents integer not null,
  modifiers jsonb not null default '[]',               -- [{group, name, price_delta_cents}] frozen at order time
  note text,
  allergens text[] not null default '{}',
  is_alcohol boolean not null default false,
  prep_minutes integer not null default 10,
  line_total_cents integer not null
);
create index order_items_order on order_items (org_id, order_id);

create table order_status_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  order_id uuid not null references orders(id) on delete cascade,
  from_status order_status,
  to_status order_status not null,
  at timestamptz not null default now(),
  by_kind text not null,
  by_id text,
  reason text
);
create index order_status_history_order on order_status_history (org_id, order_id, at);
comment on table order_status_history is '@append_only';

create table payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  order_id uuid references orders(id),
  provider text not null,
  external_ref text,
  amount_cents integer not null,
  tip_cents integer not null default 0,
  refunded_cents integer not null default 0,
  currency text not null default 'AUD',
  status payment_status not null default 'pending',
  idempotency_key text not null,
  card_brand text,
  card_last4 text,
  failure_reason text,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, idempotency_key),
  constraint payment_raw_has_no_card_identifier check (
    raw is null or not (raw::text ~* '"(fingerprint|payment_account_reference|par|card_fingerprint)"\s*:')
  )
);
create unique index payments_external on payments (org_id, provider, external_ref) where external_ref is not null;
create index payments_order on payments (org_id, order_id);

create table refunds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  payment_id uuid not null references payments(id),
  order_id uuid references orders(id),
  amount_cents integer not null check (amount_cents > 0),
  reason text not null,
  status payment_status not null default 'pending',
  external_ref text,
  staff_id uuid references staff(id),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, idempotency_key)
);
create index refunds_payment on refunds (org_id, payment_id);

-- ── The kitchen order screen (Stage 2). ticket_events is the sync unit so the full
--    KDS can be added later without reshaping this. docs/modules/kds.md section 9.

create table kitchen_tickets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  order_id uuid not null references orders(id) on delete cascade,
  ticket_number integer not null,                      -- venue-scoped, resets daily
  service_date date not null,
  status ticket_status not null default 'new',
  channel order_channel not null,
  table_label text,
  guest_name text,
  notes text,
  allergen_flags text[] not null default '{}',
  target_ready_at timestamptz,
  received_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  ready_at timestamptz,
  bumped_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (venue_id, service_date, ticket_number),
  unique (order_id)
);
create index kitchen_tickets_live on kitchen_tickets (org_id, venue_id, status, received_at);

create table ticket_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  ticket_id uuid not null references kitchen_tickets(id) on delete cascade,
  event text not null check (event in ('received', 'viewed', 'acknowledged', 'ready', 'bumped', 'recalled', 'cancelled')),
  device_id uuid,
  staff_id uuid,
  idempotency_key text not null,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}',
  unique (org_id, idempotency_key)
);
create index ticket_events_ticket on ticket_events (org_id, ticket_id, occurred_at);
comment on table ticket_events is '@append_only';

-- ── Delivery (first-party) ─────────────────────────────────────────────────

create table delivery_zones (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  name text not null,
  kind text not null default 'radius' check (kind in ('radius', 'polygon')),
  radius_m integer,
  polygon jsonb,
  min_order_cents integer not null default 0,
  fee_rule jsonb not null default '{"kind":"pass_through"}',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index delivery_zones_venue on delivery_zones (org_id, venue_id);

create table deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  order_id uuid references orders(id),
  provider text not null,
  external_ref text,
  quote_id text,
  quote_expires_at timestamptz,
  courier_fee_cents integer not null default 0,
  customer_fee_cents integer not null default 0,
  status delivery_status not null default 'quoted',
  pickup_eta timestamptz,
  dropoff_eta timestamptz,
  tracking_url text,
  dropoff_address jsonb not null,
  dropoff_lat double precision,
  dropoff_lng double precision,
  dropoff_notes text,
  courier_name text,
  proof jsonb,
  cancellation_fee_cents integer not null default 0,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, idempotency_key)
);
create index deliveries_order on deliveries (org_id, order_id);
create unique index deliveries_external on deliveries (org_id, provider, external_ref) where external_ref is not null;

create table delivery_status_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  delivery_id uuid not null references deliveries(id) on delete cascade,
  from_status delivery_status,
  to_status delivery_status not null,
  at timestamptz not null default now(),
  source text not null,
  raw jsonb
);
create index delivery_status_history_delivery on delivery_status_history (org_id, delivery_id, at);
comment on table delivery_status_history is '@append_only';

select app.apply_tenant_rls();
