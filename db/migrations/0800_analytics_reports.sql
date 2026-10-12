-- Console depth pass, wave 2 (docs/CONSOLE_IA.md section 9, pattern 9): Reports. The default
-- reports are code (analytics/reports.ts); these tables hold what a venue adds on top: its own
-- report definitions, a target per metric per month, and the annotations drawn on a chart.
-- Owned by the analytics module. Nothing here is a number: every figure is computed by
-- queryMetrics from the catalogue when the report is run.

-- A report the venue saved: a name, a category and the metric question it asks. The question
-- is stored as given (relative periods stay relative); running it asks queryMetrics again as
-- whoever is running it, so a report can never show someone a venue they cannot see.
create table report_definitions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  name text not null check (char_length(name) between 1 and 80),
  description text check (char_length(description) <= 400),
  category text not null check (category in ('sales', 'guests', 'bookings', 'menu', 'delivery', 'marketing', 'team')),
  -- The metric query (metrics, dimensions, filters, grain) without its period: the page supplies that.
  query jsonb not null,
  -- How the page draws it: line, bars, rank, cohort or tiles.
  chart text not null default 'line' check (chart in ('line', 'bars', 'rank', 'cohort', 'tiles')),
  created_by_id uuid references staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index report_definitions_name on report_definitions (org_id, lower(name));
create index report_definitions_category on report_definitions (org_id, category, name);

-- A number the venue is aiming for: one metric, one calendar month, one venue (or the whole
-- organisation when venue_id is null). Progress is worked out against the catalogue's own value
-- for that month when it is asked for; nothing is stored about how it went.
create table report_targets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid references venues(id),
  metric text not null check (char_length(metric) between 1 and 60),
  -- The first day of the month, as a date.
  month date not null check (extract(day from month) = 1),
  target numeric not null check (target >= 0),
  created_by_id uuid references staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index report_targets_one on report_targets (org_id, coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid), metric, month);
create index report_targets_month on report_targets (org_id, month);

-- A mark on a date a reader should know about ("Menu change", "Public holiday", "The review went
-- round"). Drawn on every report chart whose period covers the date; for one venue or for all.
create table report_annotations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid references venues(id),
  on_date date not null,
  label text not null check (char_length(label) between 1 and 80),
  created_by_id uuid references staff(id),
  created_at timestamptz not null default now()
);
create index report_annotations_date on report_annotations (org_id, on_date);

select app.apply_tenant_rls();
