-- Loyalty and offers: what the counter-redemption seam and one-live-code-per-guest need.
-- docs/modules/loyalty.md section 3

create type redemption_channel as enum ('counter', 'online');

-- A counter redemption is matched to the sale that arrives in the ledger by venue, time window
-- and discount, so the row has to remember where it was issued and what it should take off.
alter table redemptions
  add column channel redemption_channel not null default 'counter',
  add column issued_venue_id uuid references venues(id),
  add column issued_staff_id uuid references staff(id),
  add column discount_cents integer,                   -- expected at issue (fixed rewards); what was applied once redeemed
  add column voided_at timestamptz,
  add column void_reason text;

create index redemptions_open on redemptions (org_id, status, expires_at) where status = 'issued';
create index redemptions_transaction on redemptions (org_id, transaction_id) where transaction_id is not null;
create index redemptions_order on redemptions (org_id, order_id) where order_id is not null;
create index redemptions_reward on redemptions (org_id, reward_id, status);

-- Earning is looked up by the sale it came from (idempotency, refunds, earn coverage).
create index loyalty_transactions_source on loyalty_transactions (org_id, source_transaction_id)
  where source_transaction_id is not null;

alter table offer_codes
  add column voided_at timestamptz,
  add column void_reason text;

-- One live code per guest per offer, enforced by the database rather than by a read-then-write.
create unique index offer_codes_one_live on offer_codes (org_id, offer_id, customer_id)
  where status in ('issued', 'claimed');
create index offer_codes_expiry on offer_codes (org_id, status, expires_at) where status in ('issued', 'claimed');
create index offer_codes_transaction on offer_codes (org_id, redeemed_transaction_id) where redeemed_transaction_id is not null;
create index offer_codes_order on offer_codes (org_id, redeemed_order_id) where redeemed_order_id is not null;

select app.apply_tenant_rls();
