-- Specials: a venue's daily or weekly specials board (docs/modules/specials.md).
-- A special is a notice a manager posts: a name, a description, a price and the days it runs.
-- It is not a menu item and cannot be ordered.

create table specials (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  name text not null check (char_length(name) between 1 and 80),
  description text,
  price_cents integer not null check (price_cents >= 0),
  -- Venue-local calendar days, both inclusive.
  starts_on date not null,
  ends_on date not null,
  -- Set when a manager takes it down before (or after) its last day. Rows are never deleted.
  ended_at timestamptz,
  created_by_kind text not null,
  created_by_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index specials_venue_days on specials (org_id, venue_id, starts_on, ends_on);
-- The same special posted twice for the same first day is one special, not two.
create unique index specials_one_per_name_and_day on specials (org_id, venue_id, lower(name), starts_on) where ended_at is null;

select app.apply_tenant_rls();
