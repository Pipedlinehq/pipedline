-- Console depth pass, wave 1 (docs/CONSOLE_IA.md section 9): the shared pieces every index and
-- detail page uses. Saved list views per venue, and staff notes on a record (the timeline).
-- Both are owned by the events module (the activity stream): a note is part of a record's
-- history, and a view is the console's memory of how a list was last looked at.

-- A saved view of one index page (orders, bookings, customers, menu, offers, activity) at one
-- venue: a name and the filter tokens the URL carries. The default views ("Needs accepting",
-- "Today", "All") are code, not rows, so they cannot be renamed or deleted.
create table console_views (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  page text not null check (char_length(page) between 1 and 40),
  name text not null check (char_length(name) between 1 and 60),
  -- The filters as the URL carries them, e.g. {"status": "placed", "channel": "pickup"}.
  filters jsonb not null default '{}'::jsonb,
  position integer not null default 0,
  created_by_id uuid references staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index console_views_name on console_views (org_id, venue_id, page, lower(name));
create index console_views_page on console_views (org_id, venue_id, page, position, created_at);

-- A note staff leave for each other on an order, a booking or a guest. Never shown to the guest.
-- Keyed to the venue the console was looking at, so one venue's notes stay its own.
create table staff_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  -- 'order', 'booking' or 'customer', and that row's id.
  entity_type text not null check (char_length(entity_type) between 1 and 40),
  entity_id uuid not null,
  body text not null check (char_length(body) between 1 and 2000),
  -- Staff ids named with @ in the body, as a JSON array of uuids.
  mentions jsonb not null default '[]'::jsonb,
  -- Who wrote it: 'staff' with the staff id, or 'agent' (an assistant acting for a staff member).
  author_kind text not null,
  author_id text,
  created_at timestamptz not null default now(),
  -- A removed note stays on the record, hidden.
  deleted_at timestamptz
);
create index staff_notes_entity on staff_notes (org_id, venue_id, entity_type, entity_id, created_at desc);

-- The timeline reads a record's own audit entries newest first.
create index audit_log_entity_time on audit_log (org_id, entity_type, entity_id, occurred_at desc);

select app.apply_tenant_rls();
