-- Bookings v1: capacity-based table bookings without a floor plan (docs/modules/bookings.md,
-- "v1 as built"). A booking holds covers against the venue's pacing caps; no table is assigned.
-- Availability is computed from the module's config, the venue's hours and these rows; it is
-- never stored.

create type booking_status as enum ('requested', 'confirmed', 'declined', 'cancelled', 'seated', 'no_show', 'completed');
create type booking_source as enum ('web', 'assistant', 'phone', 'staff');

create table bookings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  -- The guest, when they gave an email or phone (or were signed in). Null for a name-only phone booking.
  customer_id uuid references customers(id),
  -- Short, random, read aloud over the phone. Unique per venue.
  reference text not null,
  -- The sitting time.
  booked_for timestamptz not null,
  -- The venue-local day and service the booking belongs to (a late service may run past midnight).
  service_date date not null,
  service_name text not null,
  party_size integer not null check (party_size between 1 and 500),
  duration_minutes integer not null check (duration_minutes between 15 and 720),
  status booking_status not null,
  source booking_source not null,
  -- What the guest (or staff, for a phone booking) gave. Cleared when the guest is erased.
  guest_name text check (char_length(guest_name) <= 100),
  guest_email text,
  guest_phone text,
  -- Guest-written, untrusted. Rendered as text; labelled when handed to an assistant.
  guest_note text check (char_length(guest_note) <= 500),
  -- Written by staff. Never shown to the guest.
  staff_note text check (char_length(staff_note) <= 500),
  -- Staff took it past the venue's caps on purpose.
  over_capacity boolean not null default false,
  -- The guest's client-made key: the same key twice is one booking.
  request_key text,
  -- Why it was declined or cancelled (staff words), and by whom it was cancelled.
  status_reason text check (char_length(status_reason) <= 300),
  cancelled_by text check (cancelled_by in ('guest', 'staff')),
  decided_at timestamptz,
  cancelled_at timestamptz,
  seated_at timestamptz,
  finished_at timestamptz,
  reminded_at timestamptz,
  created_by_kind text not null,
  created_by_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index bookings_reference on bookings (org_id, venue_id, reference);
create unique index bookings_request_key on bookings (org_id, request_key) where request_key is not null;
create index bookings_venue_time on bookings (org_id, venue_id, booked_for);
create index bookings_venue_service on bookings (org_id, venue_id, service_date, service_name);
create index bookings_customer on bookings (org_id, customer_id) where customer_id is not null;

create table booking_status_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  booking_id uuid not null references bookings(id),
  from_status booking_status,
  to_status booking_status not null,
  at timestamptz not null,
  by_kind text not null,
  by_id text
);
comment on table booking_status_history is '@append_only';
create index booking_status_history_booking on booking_status_history (org_id, booking_id, at);

select app.apply_tenant_rls();
