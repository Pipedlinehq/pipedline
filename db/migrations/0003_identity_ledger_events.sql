-- The spine: who a guest is, what they bought, what they did.
-- docs/SCHEMA.md sections 2, 2a, 3, 4

create type identity_kind as enum ('email', 'phone', 'card_fingerprint', 'card_par', 'loyalty_qr', 'pos_customer_id', 'device_id');
create type customer_status as enum ('active', 'merged', 'deleted');
create type consent_purpose as enum ('card_recognition', 'marketing_email', 'marketing_sms', 'ad_platform_sharing');
create type consent_status as enum ('granted', 'revoked');
create type txn_source as enum ('square', 'lightspeed', 'online-order', 'pos', 'manual', 'aggregator', 'sim');
create type txn_channel as enum ('dine-in', 'pickup', 'delivery', 'catering', 'retail');
create type txn_status as enum ('pending', 'completed', 'refunded', 'partially_refunded', 'voided');
create type event_source as enum ('web', 'server', 'pos', 'comms', 'agent', 'import');

-- ── Identity ───────────────────────────────────────────────────────────────

create table customers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  primary_email citext,
  primary_phone text,
  first_name text,
  last_name text,
  birthday date,
  first_seen_venue_id uuid references venues(id),
  allergy_notes text,                                  -- a safety field, never truncated
  notes text,
  status customer_status not null default 'active',
  merged_into_id uuid references customers(id),
  -- Attribution: stamped once at creation, never updated (trigger below).
  acquisition_source text not null default 'organic',
  acquisition_creator_id text,
  acquisition_campaign_id text,
  acquisition_code text,
  acquisition_landing_path text,
  acquisition_qr_code_id uuid,
  acquisition_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customers_org_created on customers (org_id, created_at);
create index customers_org_email on customers (org_id, primary_email);
create index customers_org_phone on customers (org_id, primary_phone);
create index customers_org_acq on customers (org_id, acquisition_source, acquisition_creator_id);

create or replace function app.customers_acquisition_write_once() returns trigger
language plpgsql as $$
begin
  if new.acquisition_source is distinct from old.acquisition_source
     or new.acquisition_creator_id is distinct from old.acquisition_creator_id
     or new.acquisition_campaign_id is distinct from old.acquisition_campaign_id
     or new.acquisition_code is distinct from old.acquisition_code
     or new.acquisition_landing_path is distinct from old.acquisition_landing_path
     or new.acquisition_qr_code_id is distinct from old.acquisition_qr_code_id
     or new.acquisition_at is distinct from old.acquisition_at then
    raise exception 'customers.acquisition_* is write-once (docs/SCHEMA.md section 2)'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger customers_acquisition_write_once before update on customers
  for each row execute function app.customers_acquisition_write_once();

create table customer_identities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  customer_id uuid not null references customers(id),
  kind identity_kind not null,
  value text not null,
  verified_at timestamptz,
  source text,
  created_at timestamptz not null default now(),
  unique (org_id, kind, value),
  -- Card kinds hold a per-org keyed hash (64 hex chars), never a raw provider value.
  -- docs/SCHEMA.md section 2a rule 2.
  constraint card_identity_is_hashed check (
    kind not in ('card_fingerprint', 'card_par') or value ~ '^[0-9a-f]{64}$'
  )
);
create index customer_identities_customer on customer_identities (org_id, customer_id);

create table customer_merges (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  winner_customer_id uuid not null references customers(id),
  loser_customer_id uuid not null references customers(id),
  merged_at timestamptz not null default now(),
  merged_by text,
  reason text
);
create index customer_merges_org on customer_merges (org_id, merged_at);
comment on table customer_merges is '@append_only';

create table customer_touchpoints (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  customer_id uuid not null references customers(id),
  occurred_at timestamptz not null default now(),
  channel text not null,
  campaign_id text,
  creator_id text,
  code text,
  metadata jsonb not null default '{}'
);
create index customer_touchpoints_customer on customer_touchpoints (org_id, customer_id, occurred_at);
comment on table customer_touchpoints is '@append_only';

-- The current state per purpose. consent_events below is the proof trail.
create table consents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  customer_id uuid not null references customers(id),
  purpose consent_purpose not null,
  status consent_status not null,
  wording_version text not null,
  source text not null,
  source_detail text,
  ip inet,
  consented_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, customer_id, purpose)
);

create table consent_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  customer_id uuid not null references customers(id),
  purpose consent_purpose not null,
  action consent_status not null,
  wording_version text not null,
  source text not null,
  source_detail text,
  ip inet,
  occurred_at timestamptz not null default now()
);
create index consent_events_customer on consent_events (org_id, customer_id, occurred_at);
comment on table consent_events is '@append_only';

create table consent_wordings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs(id),                     -- NULL = the platform default wording
  purpose consent_purpose not null,
  version text not null,
  body text not null,
  effective_from timestamptz not null default now()
);
create unique index consent_wordings_key on consent_wordings
  (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), purpose, version);
comment on table consent_wordings is '@shared_read';

-- ── Ledger ─────────────────────────────────────────────────────────────────

create table transactions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  occurred_at timestamptz not null,
  source txn_source not null,
  external_ref text not null,
  customer_id uuid references customers(id),
  channel txn_channel not null,
  subtotal_cents integer not null default 0,
  discount_cents integer not null default 0,
  tax_cents integer not null default 0,
  tip_cents integer not null default 0,
  total_cents integer not null,
  refunded_cents integer not null default 0,
  currency text not null default 'AUD',
  tender_type text,
  staff_ref text,
  table_label text,
  order_id uuid,                                       -- our own order, when the sale began online
  status txn_status not null default 'completed',
  raw jsonb,                                           -- provider payload with card identifiers stripped
  ingested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, source, external_ref),               -- the idempotency guarantee
  -- docs/SCHEMA.md section 2a rule 3: no handle on a card survives in the stored payload.
  constraint raw_has_no_card_identifier check (
    raw is null or not (raw::text ~* '"(fingerprint|payment_account_reference|par|card_fingerprint)"\s*:')
  )
);
create index transactions_org_time on transactions (org_id, occurred_at);
create index transactions_venue_time on transactions (org_id, venue_id, occurred_at);
create index transactions_customer on transactions (org_id, customer_id, occurred_at);

create table transaction_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  transaction_id uuid not null references transactions(id) on delete cascade,
  line_no integer not null,
  menu_item_id uuid,
  name_snapshot text not null,
  category_snapshot text,
  qty numeric(10, 3) not null default 1,
  unit_price_cents integer not null default 0,
  modifiers jsonb not null default '[]',
  discount_cents integer not null default 0,
  tax_cents integer not null default 0,
  total_cents integer not null default 0,
  unique (transaction_id, line_no)
);
create index transaction_lines_txn on transaction_lines (org_id, transaction_id);
create index transaction_lines_item on transaction_lines (org_id, menu_item_id);

-- Separate from the ledger so attribution can be re-run and versioned without touching it.
create table transaction_attributions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  transaction_id uuid not null references transactions(id) on delete cascade,
  customer_id uuid references customers(id),
  creator_id text,
  campaign_id text,
  code text,
  channel text,
  model text not null,
  model_version integer not null default 1,
  confidence numeric(4, 3) not null default 1,
  attributed_at timestamptz not null default now(),
  unique (org_id, transaction_id, model, model_version)
);
create index transaction_attributions_campaign on transaction_attributions (org_id, campaign_id, creator_id);

create table ingest_cursors (
  org_id uuid not null references orgs(id),
  connection_id uuid not null references connections(id) on delete cascade,
  stream text not null,
  cursor text,
  synced_through timestamptz,
  last_run_at timestamptz,
  last_count integer,
  updated_at timestamptz not null default now(),
  primary key (connection_id, stream)
);

-- ── Events ─────────────────────────────────────────────────────────────────

create table visitor_sessions (
  id uuid primary key,                                 -- generated on the device
  org_id uuid not null references orgs(id),
  venue_id uuid references venues(id),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  landing_path text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  creator_id text,
  campaign_id text,
  code text,
  qr_code_id uuid,
  device_class text,
  customer_id uuid references customers(id)
);
create index visitor_sessions_org on visitor_sessions (org_id, first_seen_at);

create table events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid,
  customer_id uuid,
  session_id uuid,
  name text not null,
  occurred_at timestamptz not null default now(),
  source event_source not null default 'server',
  properties jsonb not null default '{}',
  utm_source text,
  utm_medium text,
  utm_campaign text,
  creator_id text,
  campaign_id text,
  code text
);
create index events_org_name_time on events (org_id, name, occurred_at);
create index events_org_time on events (org_id, occurred_at);
create index events_org_customer on events (org_id, customer_id, occurred_at) where customer_id is not null;
create index events_org_session on events (org_id, session_id) where session_id is not null;
comment on table events is '@append_only';

select app.apply_tenant_rls();
