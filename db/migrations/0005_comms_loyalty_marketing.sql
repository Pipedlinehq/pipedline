-- Comms outbox, loyalty ledger, offers (click-to-claim and vouchers), lifecycle flows,
-- campaigns, the approvals queue and reviews.
-- docs/modules/comms.md · docs/modules/loyalty.md

create type msg_channel as enum ('email', 'sms');
create type msg_kind as enum ('transactional', 'marketing');
create type msg_status as enum ('queued', 'sending', 'sent', 'delivered', 'bounced', 'failed', 'suppressed', 'cancelled');
create type suppression_reason as enum ('unsubscribed', 'bounced_hard', 'complained', 'manual');
create type loyalty_txn_kind as enum ('earn', 'burn', 'adjust', 'expire', 'transfer', 'reverse', 'bonus');
create type redemption_status as enum ('issued', 'redeemed', 'expired', 'voided');
create type offer_kind as enum ('welcome', 'comeback', 'voucher', 'birthday', 'creator', 'manual');
create type discount_kind as enum ('fixed', 'percent', 'free_item');
create type offer_code_status as enum ('issued', 'claimed', 'redeemed', 'expired', 'voided');
create type flow_mode as enum ('off', 'shadow', 'supervised', 'autonomous');
create type enrollment_status as enum ('active', 'completed', 'exited', 'cancelled');
create type campaign_status as enum ('draft', 'pending_approval', 'approved', 'scheduled', 'sending', 'sent', 'cancelled');
create type approval_status as enum ('pending', 'approved', 'rejected', 'expired');
create type review_reply_status as enum ('none', 'drafted', 'pending_approval', 'posted', 'failed');

-- ── Comms ──────────────────────────────────────────────────────────────────

create table sending_identities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  channel msg_channel not null,
  kind msg_kind not null,
  domain text,
  from_email text,
  from_name text,
  sms_sender_id text,
  provider text not null,
  provider_domain_id text,
  dns_records jsonb,
  verified_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'verified', 'failed', 'suspended')),
  created_at timestamptz not null default now()
);
create index sending_identities_org on sending_identities (org_id, channel, kind);

create table templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs(id),                     -- NULL = the platform default
  template_key text not null,
  channel msg_channel not null,
  subject text,
  body text not null,                                  -- handlebars-style {{vars}}; rendered in the worker
  version integer not null default 1,
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);
create unique index templates_key on templates
  (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), template_key, channel);
comment on table templates is '@shared_read';

create table messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid references venues(id),
  customer_id uuid references customers(id),
  channel msg_channel not null,
  kind msg_kind not null,
  template_key text not null,
  payload jsonb not null default '{}',
  to_address citext not null,
  from_identity_id uuid references sending_identities(id),
  subject text,
  rendered_body text,                                  -- snapshot of what was actually sent
  status msg_status not null default 'queued',
  provider text,
  provider_message_id text,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  error text,
  idempotency_key text not null,
  campaign_id uuid,
  flow_id uuid,
  cost_cents integer,
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  unique (org_id, idempotency_key)
);
create index messages_queue on messages (status, next_attempt_at) where status in ('queued', 'sending');
create index messages_customer on messages (org_id, customer_id, queued_at);
create index messages_campaign on messages (org_id, campaign_id) where campaign_id is not null;
create index messages_provider on messages (provider, provider_message_id) where provider_message_id is not null;

create table message_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  message_id uuid not null references messages(id) on delete cascade,
  event text not null check (event in ('sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'unsubscribed', 'failed')),
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'
);
create index message_events_message on message_events (org_id, message_id, occurred_at);
comment on table message_events is '@append_only';

create table suppressions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  channel msg_channel not null,
  value citext not null,
  reason suppression_reason not null,
  created_at timestamptz not null default now(),
  unique (org_id, channel, value)
);

-- ── Loyalty ────────────────────────────────────────────────────────────────

create table loyalty_programs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  name text not null,
  is_active boolean not null default true,
  earn_model text not null default 'points_per_dollar' check (earn_model in ('points_per_dollar', 'visits', 'stamps')),
  points_per_dollar numeric(8, 3) not null default 1,
  points_rounding text not null default 'floor' check (points_rounding in ('floor', 'round', 'ceil')),
  point_value_cents numeric(8, 3) not null default 2,  -- what one point is worth on redemption
  expiry_months integer,
  expiry_policy text not null default 'none' check (expiry_policy in ('rolling', 'fixed', 'none')),
  enrolment_bonus integer not null default 0,
  birthday_bonus integer not null default 0,
  terms_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index loyalty_programs_one_active on loyalty_programs (org_id) where is_active;

create table loyalty_tiers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  program_id uuid not null references loyalty_programs(id) on delete cascade,
  name text not null,
  threshold_points integer not null default 0,
  threshold_window_months integer not null default 12,
  multiplier numeric(4, 2) not null default 1,
  perks jsonb not null default '[]',
  sort_order integer not null default 0
);
create index loyalty_tiers_program on loyalty_tiers (org_id, program_id, sort_order);

create table loyalty_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  program_id uuid not null references loyalty_programs(id),
  customer_id uuid not null references customers(id),
  tier_id uuid references loyalty_tiers(id),
  member_code text not null,                           -- what the membership QR encodes
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  enrolled_at timestamptz not null default now(),
  enrolled_venue_id uuid references venues(id),
  unique (program_id, customer_id),
  unique (org_id, member_code)
);
create index loyalty_accounts_customer on loyalty_accounts (org_id, customer_id);

-- Balance is SUM(points). There is no stored balance column anywhere, on purpose.
create table loyalty_transactions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  account_id uuid not null references loyalty_accounts(id),
  occurred_at timestamptz not null default now(),
  kind loyalty_txn_kind not null,
  points integer not null,                             -- signed
  source_transaction_id uuid references transactions(id),
  order_id uuid,
  redemption_id uuid,
  venue_id uuid references venues(id),
  staff_id uuid references staff(id),
  idempotency_key text not null,
  note text,
  created_at timestamptz not null default now(),
  unique (org_id, idempotency_key)
);
create index loyalty_transactions_account on loyalty_transactions (org_id, account_id, occurred_at);
comment on table loyalty_transactions is '@append_only';

create table rewards (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  program_id uuid not null references loyalty_programs(id) on delete cascade,
  name text not null,
  description text,
  image_url text,
  cost_points integer not null check (cost_points > 0),
  kind discount_kind not null,
  value_cents integer,
  percent_off integer,
  menu_item_id uuid references menu_items(id),
  min_spend_cents integer not null default 0,
  valid_venue_ids uuid[],
  valid_days smallint[],
  valid_from timestamptz,
  valid_to timestamptz,
  max_redemptions_total integer,
  max_redemptions_per_customer integer,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index rewards_program on rewards (org_id, program_id);

create table redemptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  account_id uuid not null references loyalty_accounts(id),
  reward_id uuid not null references rewards(id),
  code text not null,                                  -- single-use, short expiry
  status redemption_status not null default 'issued',
  points integer not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  redeemed_venue_id uuid references venues(id),
  redeemed_staff_id uuid references staff(id),
  transaction_id uuid references transactions(id),
  order_id uuid references orders(id),
  forced boolean not null default false,
  force_reason text,
  unique (org_id, code)
);
create index redemptions_account on redemptions (org_id, account_id, issued_at);

-- ── Offers: unique per-customer codes (click-to-claim), vouchers, creator offers ──

create table offers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  kind offer_kind not null,
  name text not null,
  description text,
  discount_kind discount_kind not null,
  value_cents integer,
  percent_off integer,
  menu_item_id uuid references menu_items(id),
  price_cents integer not null default 0,              -- what the guest pays for a voucher (0 = free)
  min_spend_cents integer not null default 0,
  validity_days integer not null default 30,
  requires_claim boolean not null default true,        -- click-to-claim, never auto-applied
  channels order_channel[] not null default '{pickup,delivery,dine-in-qr}',
  valid_venue_ids uuid[],
  max_codes integer,
  code_prefix text not null default 'ROS',
  campaign_id text,
  creator_id text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index offers_org on offers (org_id, kind);

create table offer_codes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  offer_id uuid not null references offers(id),
  customer_id uuid references customers(id),
  code citext not null,
  status offer_code_status not null default 'issued',
  source text,                                         -- 'flow:welcome', 'campaign:<id>', 'qr:<id>', 'staff'
  issued_at timestamptz not null default now(),
  claimed_at timestamptz,
  redeemed_at timestamptz,
  expires_at timestamptz not null,
  redeemed_order_id uuid references orders(id),
  redeemed_transaction_id uuid references transactions(id),
  redeemed_venue_id uuid references venues(id),
  discount_applied_cents integer,
  unique (org_id, code)
);
create index offer_codes_customer on offer_codes (org_id, customer_id, status);
create index offer_codes_offer on offer_codes (org_id, offer_id, status);

-- ── Segments, flows, campaigns ─────────────────────────────────────────────

create table segments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  name text not null,
  description text,
  definition jsonb not null,                           -- a declarative rule tree, never SQL
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

create table flows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  key text not null,                                   -- 'welcome' | 'post_purchase' | 'winback' | 'vip' | 'birthday'
  name text not null,
  mode flow_mode not null default 'off',               -- shadow → supervised → autonomous
  template_version text not null default '1.0.0',      -- pinned per org; docs/DEPLOYMENT.md section 9
  config jsonb not null default '{}',
  offer_id uuid references offers(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, key)
);

create table flow_enrollments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  flow_id uuid not null references flows(id) on delete cascade,
  customer_id uuid not null references customers(id),
  step integer not null default 0,
  status enrollment_status not null default 'active',
  next_at timestamptz,
  enrolled_at timestamptz not null default now(),
  completed_at timestamptz,
  context jsonb not null default '{}',
  unique (flow_id, customer_id)
);
create index flow_enrollments_due on flow_enrollments (org_id, status, next_at);

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid references venues(id),
  name text not null,
  channel msg_channel not null,
  segment_id uuid references segments(id),
  template_key text,
  subject text,
  body text,
  offer_id uuid references offers(id),
  status campaign_status not null default 'draft',
  scheduled_at timestamptz,
  audience_count integer,
  stats jsonb not null default '{}',
  created_by_kind text not null default 'staff',
  created_by_id text,
  approved_by_staff_id uuid references staff(id),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index campaigns_org on campaigns (org_id, status, created_at);

-- One queue for everything a person must say yes to before it happens.
create table approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid references venues(id),
  kind text not null,                                  -- 'campaign_send' | 'flow_batch' | 'review_reply' | 'agent_action' | 'refund'
  subject_type text not null,
  subject_id text not null,
  summary text not null,
  payload jsonb not null default '{}',
  status approval_status not null default 'pending',
  requested_by_kind text not null,
  requested_by_id text,
  decided_by_staff_id uuid references staff(id),
  decided_at timestamptz,
  decision_note text,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index approvals_pending on approvals (org_id, status, created_at);

-- ── Reviews ────────────────────────────────────────────────────────────────

create table reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  source text not null,                                -- 'google' | 'sim' | 'internal'
  external_id text not null,
  rating smallint check (rating between 1 and 5),
  body text,                                           -- guest-written: untrusted input
  author_name text,
  reviewed_at timestamptz not null,
  customer_id uuid references customers(id),
  reply_body text,
  reply_status review_reply_status not null default 'none',
  replied_at timestamptz,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, source, external_id)
);
create index reviews_venue on reviews (org_id, venue_id, reviewed_at);

select app.apply_tenant_rls();
