-- First-party delivery (docs/modules/delivery.md part A) on top of the 0004 tables, and the
-- hardening of ordering's payments: unknown-outcome reconciliation and orders flagged for staff.

-- ── Deliveries ───────────────────────────────────────────────────────────────

-- Who the delivery is for, so it follows a merge and is erased with the guest. Set when the
-- quote is attached to an order; never read to decide anything about money.
alter table deliveries add column customer_id uuid references customers(id);
-- The connection the courier was requested through: its secret verifies the courier's webhooks.
alter table deliveries add column connection_id uuid references connections(id);
alter table deliveries add column contains_alcohol boolean not null default false;
-- What the guest ordered, in cents, as told to the courier (insurance, ID checks).
alter table deliveries add column order_value_cents integer not null default 0;
-- When the courier is to be asked for (timed to the prep time), and when it was.
alter table deliveries add column request_at timestamptz;
alter table deliveries add column requested_at timestamptz;
alter table deliveries add column delivered_at timestamptz;
-- The last time the provider was asked about this delivery (webhook re-fetch or reconciliation).
alter table deliveries add column last_checked_at timestamptz;
-- Plain words for a failed, returned or cancelled delivery, e.g. 'no_courier'.
alter table deliveries add column failure_reason text;
-- Providers asked for a courier for this delivery, in order.
alter table deliveries add column attempted_providers text[] not null default '{}';

create index deliveries_in_flight on deliveries (org_id, status, updated_at);
create index deliveries_customer on deliveries (org_id, customer_id) where customer_id is not null;
-- Courier webhooks arrive before the org is known: found by the provider's own id.
create index deliveries_provider_ref on deliveries (provider, external_ref) where external_ref is not null;

-- ── Orders: something staff must look at ─────────────────────────────────────

-- e.g. a discount the venue absorbed because its code was used by another order between
-- pricing and payment, or a POS that could not take the order.
alter table orders add column attention_reason text;
alter table orders add column attention_at timestamptz;
alter table orders add column absorbed_discount_cents integer not null default 0;
alter table orders add column absorbed_codes text[] not null default '{}';
create index orders_attention on orders (org_id, venue_id, attention_at) where attention_at is not null;

-- ── Payments whose outcome was never heard ───────────────────────────────────

-- The last time the processor was asked about a payment or refund still pending.
alter table payments add column checked_at timestamptz;
alter table refunds add column checked_at timestamptz;
create index payments_pending on payments (org_id, created_at) where status = 'pending';
create index refunds_pending on refunds (org_id, created_at) where status = 'pending';

select app.apply_tenant_rls();
