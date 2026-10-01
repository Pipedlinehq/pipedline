-- Website content, the hub (assistant access and plugs), analytics facts, onboarding.
-- docs/modules/website.md · docs/modules/hub.md · docs/ONBOARDING.md

-- ── Website ────────────────────────────────────────────────────────────────

create table brands (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid references venues(id),                 -- set = a per-venue override
  tokens jsonb not null default '{}',
  logo_svg_url text,
  logo_raster_url text,
  logo_mark_url text,
  layout_skeleton text not null default 'hero-photo',
  tone_of_voice text,
  updated_at timestamptz not null default now()
);
create unique index brands_scope on brands (org_id, coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table pages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid references venues(id),
  slug text not null,
  title text not null,
  blocks jsonb not null default '[]',                  -- typed blocks rendered as data, never as markup
  seo_title text,
  seo_description text,
  og_image_url text,
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index pages_scope on pages (org_id, coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);

create table media (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  kind text not null default 'image',
  storage_key text not null,
  url text not null,
  alt text,
  width integer,
  height integer,
  bytes integer,
  content_type text,
  created_at timestamptz not null default now()
);
create index media_org on media (org_id, created_at);

create table redirects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  from_path text not null,
  to_path text not null,
  status_code integer not null default 301,
  hits integer not null default 0,
  created_at timestamptz not null default now(),
  unique (org_id, from_path)
);

-- ── Hub ────────────────────────────────────────────────────────────────────

create table agent_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  staff_id uuid not null references staff(id),
  name text not null,
  key_prefix text not null,                            -- shown in lists so a key can be recognised
  key_hash bytea not null unique,
  scopes text[] not null default '{}',
  venue_ids uuid[],                                    -- NULL = every venue the staff member can see
  can_write boolean not null default false,
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index agent_keys_staff on agent_keys (org_id, staff_id);

create table agent_calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  key_id uuid references agent_keys(id),
  actor_kind text not null default 'agent_key',        -- 'agent_key' | 'hosted_agent'
  plug_key text not null default 'os',
  tool text not null,
  effect text not null check (effect in ('read', 'write')),
  outcome text not null,                               -- never the arguments, never the result
  duration_ms integer,
  occurred_at timestamptz not null default now()
);
create index agent_calls_org on agent_calls (org_id, occurred_at desc);
create index agent_calls_key on agent_calls (org_id, key_id, occurred_at desc);
comment on table agent_calls is '@append_only';

create table agent_confirmations (
  nonce text primary key,
  org_id uuid not null references orgs(id),
  key_id uuid not null references agent_keys(id),
  tool text not null,
  args_digest text not null,
  question_digest text not null,
  expires_at timestamptz not null,
  spent_at timestamptz,
  created_at timestamptz not null default now()
);
create index agent_confirmations_org on agent_confirmations (org_id, expires_at);

-- The reviewed tool list of each remote plug. A plug whose live list no longer matches is withdrawn.
create table plug_reviews (
  plug_key text primary key,
  tools_digest text not null,
  tool_list jsonb not null,
  reviewed_by text not null,
  reviewed_at timestamptz not null default now()
);
comment on table plug_reviews is '@reference';

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid references venues(id),
  agent_key text not null,                             -- 'winback_drafter' | 'review_replier' | 'weekly_digest' | ...
  template_version text not null,
  mode flow_mode not null,
  trigger text not null,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'skipped')),
  summary text,
  output jsonb,
  error text,
  tokens_in integer,
  tokens_out integer,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index agent_runs_org on agent_runs (org_id, agent_key, started_at desc);

-- ── Analytics: derived, re-derivable facts. Never authoritative. ───────────

create table fact_sales_daily (
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  day date not null,                                   -- in the venue's own time zone
  channel txn_channel not null,
  source txn_source not null,
  orders integer not null default 0,
  gross_cents bigint not null default 0,               -- total incl. tax and tips
  net_cents bigint not null default 0,                 -- total less tax, tips and refunds
  discount_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  tip_cents bigint not null default 0,
  refunded_cents bigint not null default 0,
  items numeric(14, 3) not null default 0,
  identified_orders integer not null default 0,        -- orders tied to a known customer
  new_customer_orders integer not null default 0,
  returning_customer_orders integer not null default 0,
  computed_at timestamptz not null default now(),
  primary key (org_id, venue_id, day, channel, source)
);

create table fact_sales_hourly (
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  day date not null,
  hour smallint not null check (hour between 0 and 23),
  orders integer not null default 0,
  net_cents bigint not null default 0,
  computed_at timestamptz not null default now(),
  primary key (org_id, venue_id, day, hour)
);

create table fact_item_daily (
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  day date not null,
  item_key text not null,                              -- menu_item_id when known, else the name snapshot
  menu_item_id uuid,
  item_name text not null,
  category text,
  qty numeric(14, 3) not null default 0,
  revenue_cents bigint not null default 0,
  orders integer not null default 0,
  computed_at timestamptz not null default now(),
  primary key (org_id, venue_id, day, item_key)
);

create table fact_customer (
  org_id uuid not null references orgs(id),
  customer_id uuid not null references customers(id) on delete cascade,
  first_order_at timestamptz,
  second_order_at timestamptz,
  last_order_at timestamptz,
  orders integer not null default 0,
  spend_cents bigint not null default 0,
  avg_order_cents integer not null default 0,
  days_to_second_order integer,
  recency_days integer,
  r_score smallint,
  f_score smallint,
  m_score smallint,
  segment text,                                        -- 'new' | 'one_timer' | 'repeater' | 'frequent' | 'loyal' | 'lapsed' | 'at_risk'
  favourite_channel txn_channel,
  favourite_venue_id uuid,
  computed_at timestamptz not null default now(),
  primary key (org_id, customer_id)
);
create index fact_customer_segment on fact_customer (org_id, segment);

create table fact_events_daily (
  org_id uuid not null references orgs(id),
  venue_key uuid not null default '00000000-0000-0000-0000-000000000000',   -- zero uuid = org-level
  day date not null,
  name text not null,
  utm_source text not null default '',
  creator_id text not null default '',
  campaign_id text not null default '',
  events integer not null default 0,
  sessions integer not null default 0,
  customers integer not null default 0,
  computed_at timestamptz not null default now(),
  primary key (org_id, venue_key, day, name, utm_source, creator_id, campaign_id)
);

create table fact_campaign_daily (
  org_id uuid not null references orgs(id),
  venue_key uuid not null default '00000000-0000-0000-0000-000000000000',
  day date not null,
  channel text not null default '',
  campaign_id text not null default '',
  creator_id text not null default '',
  sessions integer not null default 0,
  new_customers integer not null default 0,
  orders integer not null default 0,
  revenue_cents bigint not null default 0,
  repeat_orders integer not null default 0,
  computed_at timestamptz not null default now(),
  primary key (org_id, venue_key, day, channel, campaign_id, creator_id)
);

-- Tracks which org-days have been rolled up, so rollups are incremental and restartable.
create table rollup_state (
  org_id uuid not null references orgs(id),
  rollup text not null,
  day date not null,
  source_max_ingested_at timestamptz,
  computed_at timestamptz not null default now(),
  primary key (org_id, rollup, day)
);

create table insight_digests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid references venues(id),
  period text not null check (period in ('day', 'week', 'month')),
  period_start date not null,
  period_end date not null,
  payload jsonb not null,                              -- structured findings: metric, value, baseline, change, caveats
  summary text not null,                               -- the same findings in plain words, built from templates
  generated_at timestamptz not null default now()
);
create unique index insight_digests_period on insight_digests
  (org_id, coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid), period, period_start);

create table saved_views (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  name text not null,
  description text,
  query jsonb not null,                                -- a metric query, as the analytics module defines it
  is_pinned boolean not null default false,
  created_by_kind text not null default 'staff',
  created_by_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

-- Anonymous bands across orgs that opted in. Holds no org id and nothing below the minimum cohort.
create table benchmark_bands (
  id uuid primary key default gen_random_uuid(),
  metric text not null,
  cohort text not null,                                -- e.g. 'cuisine:italian|band:2|state:NSW'
  period_start date not null,
  period_end date not null,
  p25 numeric,
  p50 numeric,
  p75 numeric,
  n_orgs integer not null,
  computed_at timestamptz not null default now(),
  unique (metric, cohort, period_start, period_end)
);
comment on table benchmark_bands is '@reference';

-- ── Onboarding ─────────────────────────────────────────────────────────────

create table onboardings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  status text not null default 'intake' check (status in ('intake', 'provisioning', 'review', 'live', 'stalled')),
  intake jsonb not null default '{}',
  intake_progress jsonb not null default '{}',
  manual_touch_minutes integer not null default 0,     -- the metric docs/ONBOARDING.md section 5 tracks
  sold_at timestamptz not null default now(),
  live_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id)
);

create table provisioning_steps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  onboarding_id uuid not null references onboardings(id) on delete cascade,
  step text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'blocked', 'skipped')),
  attempts integer not null default 0,
  blocked_on text,
  error text,
  result jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  unique (onboarding_id, step)
);
create index provisioning_steps_org on provisioning_steps (org_id, onboarding_id);

create table menu_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  source_kind text not null check (source_kind in ('text', 'url', 'file')),
  source_ref text,
  status text not null default 'extracted' check (status in ('extracting', 'extracted', 'confirmed', 'discarded', 'failed')),
  extracted jsonb,                                     -- proposed sections/items, each awaiting a person's yes
  confirmed_item_count integer not null default 0,
  created_by_staff_id uuid references staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index menu_imports_venue on menu_imports (org_id, venue_id, created_at);

select app.apply_tenant_rls();
