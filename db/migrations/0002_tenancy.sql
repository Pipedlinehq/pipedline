-- Tenancy, people, access and the infrastructure tables every module leans on.
-- docs/SCHEMA.md sections 1, 5, 7, 8 · docs/ARCHITECTURE.md section 1 · docs/modules/hub.md section 4

create type org_status as enum ('onboarding', 'live', 'paused', 'closed');
create type venue_status as enum ('setup', 'live', 'paused', 'closed');
create type staff_status as enum ('invited', 'active', 'disabled');
create type staff_role as enum ('owner', 'manager', 'host', 'kitchen', 'front_of_house', 'read_only');
create type session_kind as enum ('staff', 'guest', 'platform');
create type otp_purpose as enum ('staff_login', 'guest_login', 'platform_login');
create type device_purpose as enum ('kitchen', 'counter');
create type connection_status as enum ('pending', 'connected', 'unhealthy', 'revoked');
create type job_status as enum ('queued', 'running', 'succeeded', 'failed', 'dead');
create type side_effect_status as enum ('started', 'succeeded', 'failed');

-- ── Tenancy ────────────────────────────────────────────────────────────────

create table orgs (
  id uuid primary key default gen_random_uuid(),
  slug citext not null unique,
  legal_name text not null,
  trading_name text not null,
  abn text,
  country text not null default 'AU',
  currency text not null default 'AUD',
  timezone text not null default 'Australia/Sydney',
  tax_inclusive boolean not null default true,
  tax_rate_bp integer not null default 1000,           -- basis points; 1000 = 10% GST
  status org_status not null default 'onboarding',
  plan text not null default 'free',
  cuisine_tags text[] not null default '{}',
  price_band smallint,
  benchmark_opt_in boolean not null default false,     -- docs/THREAT_MODEL.md section 4 (Commercial)
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table venues (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  slug citext not null,
  name text not null,
  timezone text not null default 'Australia/Sydney',
  address_line1 text,
  address_line2 text,
  suburb text,
  state text,
  postcode text,
  lat double precision,
  lng double precision,
  phone text,
  email citext,
  status venue_status not null default 'setup',
  capacity integer,
  cuisine_tags text[] not null default '{}',
  price_band smallint,
  settings jsonb not null default '{}',
  opened_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, slug)
);
create index venues_org on venues (org_id);

create table domains (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid references venues(id),                 -- NULL = the org-level (group brand) site
  host citext not null unique,
  kind text not null default 'subdomain' check (kind in ('subdomain', 'custom')),
  is_primary boolean not null default false,
  provider_domain_id text,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
create index domains_org on domains (org_id);

create table trading_hours (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  day_of_week smallint not null check (day_of_week between 0 and 6),   -- 0 = Sunday
  opens_at time not null,
  closes_at time not null,
  service_type text not null default 'all'
);
create index trading_hours_venue on trading_hours (org_id, venue_id, day_of_week);

create table hour_exceptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  date date not null,
  closed boolean not null default true,
  opens_at time,
  closes_at time,
  reason text,
  created_at timestamptz not null default now(),
  unique (venue_id, date)
);
create index hour_exceptions_venue on hour_exceptions (org_id, venue_id, date);

create table venue_modules (
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  module_key text not null,
  enabled boolean not null default false,
  config jsonb not null default '{}',
  config_version integer not null default 1,
  enabled_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (venue_id, module_key)
);
create index venue_modules_org on venue_modules (org_id, venue_id);

create table feature_flags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs(id),                     -- NULL = every org
  key text not null,
  enabled boolean not null default false,
  owner text not null,
  expires_at timestamptz not null,                     -- docs/DEPLOYMENT.md section 3: a flag has an expiry
  created_at timestamptz not null default now()
);
create unique index feature_flags_key on feature_flags (key, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid));
comment on table feature_flags is '@shared_read';

-- ── People ─────────────────────────────────────────────────────────────────

-- A person who can sign in to the console. Platform-level: one person may be staff at two orgs.
create table users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  phone text,
  name text,
  totp_secret_ref uuid,
  created_at timestamptz not null default now()
);
comment on table users is '@platform';

create table platform_admins (
  user_id uuid primary key references users(id),
  role text not null default 'admin',
  created_at timestamptz not null default now()
);
comment on table platform_admins is '@platform';

create table staff (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  user_id uuid not null references users(id),
  first_name text not null,
  last_name text,
  email citext not null,
  phone text,
  is_owner boolean not null default false,
  status staff_status not null default 'invited',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index staff_org on staff (org_id);

create table staff_venues (
  org_id uuid not null references orgs(id),
  staff_id uuid not null references staff(id) on delete cascade,
  venue_id uuid not null references venues(id),
  role staff_role not null,
  primary key (staff_id, venue_id)
);
create index staff_venues_org on staff_venues (org_id, venue_id);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash bytea not null unique,
  kind session_kind not null,
  user_id uuid references users(id),
  org_id uuid references orgs(id),                     -- staff: the one active org for this session
  customer_id uuid,                                    -- guest sessions
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  ip inet,
  user_agent text
);
comment on table sessions is '@platform';

create table otp_codes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs(id),
  purpose otp_purpose not null,
  destination citext not null,
  code_hash bytea not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index otp_codes_lookup on otp_codes (destination, purpose, created_at desc);
comment on table otp_codes is '@platform';

create table devices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  name text not null,
  purpose device_purpose not null,
  token_hash bytea unique,
  pairing_code_hash bytea,
  pairing_expires_at timestamptz,
  paired_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index devices_org on devices (org_id, venue_id);

-- ── Connections and secrets ────────────────────────────────────────────────

-- Envelope-encrypted provider tokens and per-org keys. Tenants never read this table;
-- the platform resolves a secret_ref on their behalf (packages/core/src/secrets.ts).
create table secrets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  purpose text not null,
  ciphertext bytea not null,
  nonce bytea not null,
  key_version integer not null default 1,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);
create index secrets_org on secrets (org_id, purpose);
-- Per-org singleton keys (purpose 'org:<name>'), e.g. the key that hashes card identifiers.
create unique index secrets_org_singleton on secrets (org_id, purpose) where purpose like 'org:%';
comment on table secrets is '@platform';

create table connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid references venues(id),
  plug_key text not null,
  status connection_status not null default 'pending',
  scopes text[] not null default '{}',
  secret_ref uuid references secrets(id),
  external_account_id text not null default '',
  config jsonb not null default '{}',
  connected_by_staff_id uuid references staff(id),
  connected_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index connections_unique on connections
  (org_id, coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid), plug_key, external_account_id);
create index connections_lookup on connections (plug_key, external_account_id);

-- ── Infrastructure ─────────────────────────────────────────────────────────

create table jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs(id),                     -- NULL = a platform job
  kind text not null,
  payload jsonb not null default '{}',
  payload_version integer not null default 1,
  run_at timestamptz not null default now(),
  status job_status not null default 'queued',
  attempts integer not null default 0,
  max_attempts integer not null default 8,
  last_error text,
  idempotency_key text,
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index jobs_due on jobs (status, run_at) where status = 'queued';
create unique index jobs_idempotency on jobs (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, idempotency_key)
  where idempotency_key is not null;
create index jobs_org on jobs (org_id, kind, created_at desc);
comment on table jobs is '@append_only';

-- The exactly-once ledger for anything that leaves the building (a send, a charge, a courier).
create table side_effects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  key text not null,
  kind text not null,
  status side_effect_status not null default 'started',
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, key)
);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid,
  actor_kind text not null,
  actor_id text,
  action text not null,
  entity_type text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  ip inet,
  request_id text,
  occurred_at timestamptz not null default now()
);
create index audit_log_org on audit_log (org_id, occurred_at desc);
create index audit_log_entity on audit_log (org_id, entity_type, entity_id);
comment on table audit_log is '@append_only';

-- Our own access to a tenant, recorded where the venue owner can read it.
create table support_access (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  admin_user_id uuid not null references users(id),
  reason text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index support_access_org on support_access (org_id, started_at desc);
comment on table support_access is '@append_only';

create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  org_id uuid references orgs(id),
  connection_id uuid references connections(id),
  event_type text,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  payload_digest text,
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_id)
);
comment on table webhook_events is '@platform';

create table rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);
comment on table rate_limits is '@platform';

select app.apply_tenant_rls();
