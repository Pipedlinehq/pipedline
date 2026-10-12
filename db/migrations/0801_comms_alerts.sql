-- Console depth pass, wave 2 (docs/CONSOLE_IA.md section 9, pattern 13): alerts to the team.
-- One row per (venue, event, channel, recipient): who at the venue is told, and how, when a new
-- order arrives, a booking is made or cancelled, a review is posted, the assistant needs a yes, a
-- delivery goes wrong, or the daily or weekly digest is ready. Owned by the comms module: every
-- alert is delivered through the outbox as a transactional message to a staff member, never to
-- a guest and never as marketing. Quiet hours are an org setting (orgs.settings.alerts).
create table alert_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  -- One of comms/alerts.ts ALERT_EVENTS: order.new, booking.new, booking.cancelled, review.posted,
  -- assistant.needs_yes, delivery.problem, digest.daily, digest.weekly.
  event text not null check (char_length(event) between 1 and 40),
  channel msg_channel not null,
  -- 'staff' with a staff id, or 'role' with a role name: everyone holding that role at the venue.
  recipient_kind text not null check (recipient_kind in ('staff', 'role')),
  recipient text not null check (char_length(recipient) between 1 and 60),
  enabled boolean not null default true,
  created_by_id uuid references staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index alert_rules_one on alert_rules (org_id, venue_id, event, channel, recipient_kind, recipient);
create index alert_rules_event on alert_rules (org_id, venue_id, event) where enabled;

-- Where the alert dispatcher has read the activity stream up to, per organisation. Events before
-- the watermark were considered; each alert's idempotency key names the event and the rule, so a
-- re-read never sends twice.
create table alert_cursors (
  org_id uuid primary key references orgs(id),
  -- The occurred_at of the last event considered.
  read_through timestamptz not null,
  updated_at timestamptz not null default now()
);

select app.apply_tenant_rls();
