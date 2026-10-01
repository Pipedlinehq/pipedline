-- Analytics: extra fact columns, the roll-up signature, and the indexes the roll-ups lean on.
-- Facts stay derived and re-derivable (packages/modules/src/analytics/rollup.ts); nothing here
-- is authoritative.

-- Counts the daily fact needs so refund rate, discount rate and identified share can be served
-- from it without going back to the ledger.
alter table fact_sales_daily
  add column refunded_orders integer not null default 0,
  add column discounted_orders integer not null default 0,
  add column identified_gross_cents bigint not null default 0;

-- The hourly fact carries the same measures as the daily one, so hour, daypart and day-of-week
-- splits are served by one reader.
alter table fact_sales_hourly
  add column gross_cents bigint not null default 0,
  add column discount_cents bigint not null default 0,
  add column tax_cents bigint not null default 0,
  add column tip_cents bigint not null default 0,
  add column refunded_cents bigint not null default 0,
  add column items numeric(14, 3) not null default 0,
  add column identified_orders integer not null default 0,
  add column new_customer_orders integer not null default 0,
  add column returning_customer_orders integer not null default 0,
  add column refunded_orders integer not null default 0,
  add column discounted_orders integer not null default 0,
  add column identified_gross_cents bigint not null default 0;

-- What the day's facts were computed from: sale count and latest change, event, session and
-- customer counts. A day whose signature still matches is not rewritten.
alter table rollup_state add column signature text;

-- The snapshot is compared by venue-local dates, so keep them beside the instants.
alter table fact_customer
  add column first_order_day date,
  add column last_order_day date;

-- The roll-up cursor walks sales by when they last changed (a refund, a late-linked customer).
create index transactions_org_updated on transactions (org_id, updated_at);
create index visitor_sessions_org_campaign on visitor_sessions (org_id, campaign_id, creator_id)
  where campaign_id is not null or creator_id is not null;
create index customers_org_campaign on customers (org_id, acquisition_campaign_id, acquisition_creator_id)
  where acquisition_campaign_id is not null or acquisition_creator_id is not null;
create index insight_digests_recent on insight_digests (org_id, period, period_start desc);

select app.apply_tenant_rls();
