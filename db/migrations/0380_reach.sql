-- Reach: reviews from connected listings (and the replies drafted for a person to approve),
-- the connected email platform (docs/modules/comms.md section 7), and server-side purchase
-- conversions to an ad platform.

create type review_draft_status as enum ('shadow', 'blocked', 'pending', 'approved', 'rejected', 'posted', 'failed');
create type review_draft_author as enum ('agent', 'assistant', 'staff');
create type ad_conversion_status as enum ('queued', 'sent', 'skipped', 'failed');

-- ── Reviews ────────────────────────────────────────────────────────────────

alter table reviews
  add column connection_id uuid references connections(id);

-- Where each listing connection has read up to.
create table review_sync_state (
  connection_id uuid primary key references connections(id) on delete cascade,
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  cursor text,
  synced_through timestamptz,
  insights_through date,
  last_run_at timestamptz,
  last_count integer,
  last_error text,
  updated_at timestamptz not null default now()
);
create index review_sync_state_org on review_sync_state (org_id, venue_id);

-- Every reply that was drafted, by whom, and what became of it. A reply is posted only from a
-- row a person approved.
create table review_reply_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  review_id uuid not null references reviews(id),
  body text not null,
  author review_draft_author not null,
  status review_draft_status not null,
  blocked_reasons text[] not null default '{}',
  approval_id uuid,
  agent_run_id uuid,
  template_version text,
  created_by_kind text not null,
  created_by_id text,
  approved_by_staff_id uuid,
  error text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  posted_at timestamptz,
  updated_at timestamptz not null default now()
);
create index review_reply_drafts_review on review_reply_drafts (org_id, review_id, created_at);
create index review_reply_drafts_status on review_reply_drafts (org_id, venue_id, status);

-- Daily listing insights, for analytics to read through reviews.listingInsights().
create table review_listing_insights (
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  connection_id uuid not null references connections(id) on delete cascade,
  day date not null,
  directions integer not null default 0,
  calls integer not null default 0,
  searches integer not null default 0,
  website_clicks integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (connection_id, day)
);
create index review_listing_insights_org on review_listing_insights (org_id, venue_id, day);

-- ── Connected email platform (comms) ───────────────────────────────────────

create table esp_sync_state (
  connection_id uuid primary key references connections(id) on delete cascade,
  org_id uuid not null references orgs(id),
  profiles_through timestamptz,
  orders_through timestamptz,
  points_through timestamptz,
  suppressions_pulled_through timestamptz,
  suppressions_pushed_through timestamptz,
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  last_counts jsonb,
  updated_at timestamptz not null default now()
);
create index esp_sync_state_org on esp_sync_state (org_id);

-- What was last pushed for each guest, so a replayed sync sends nothing new. `state` records
-- whether the platform holds them as subscribed or only as a suppression.
create table esp_sync_profiles (
  connection_id uuid not null references connections(id) on delete cascade,
  org_id uuid not null references orgs(id),
  customer_id uuid not null references customers(id),
  digest text not null,
  state text not null check (state in ('subscribed', 'suppressed')),
  pushed_at timestamptz not null,
  primary key (connection_id, customer_id)
);
create index esp_sync_profiles_org on esp_sync_profiles (org_id, customer_id);

-- ── Ad-platform conversions (comms) ────────────────────────────────────────

-- One row per sale per ads connection. Holds no contact details and no hashes: those are
-- computed at send time from the customer record, and only with consent.
create table ad_conversions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  connection_id uuid not null references connections(id) on delete cascade,
  transaction_id uuid not null references transactions(id),
  customer_id uuid references customers(id),
  event_id text not null,
  source text not null check (source in ('website', 'physical_store')),
  value_cents integer not null,
  currency text not null,
  status ad_conversion_status not null default 'queued',
  reason text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, connection_id, transaction_id)
);
create index ad_conversions_status on ad_conversions (org_id, connection_id, status, created_at);

select app.apply_tenant_rls();
