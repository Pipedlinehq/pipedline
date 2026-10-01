-- Menu, ordering, the kitchen order screen and QR: columns the Stage 2 build needs on top of
-- 0004. docs/modules/ordering.md · docs/modules/qr.md · docs/modules/kds.md section 9.

-- Menu edits never delete a row a past order or receipt still points at.
alter table menus add column deleted_at timestamptz;
alter table menu_sections add column deleted_at timestamptz;
alter table modifier_groups add column deleted_at timestamptz;
alter table modifiers add column deleted_at timestamptz;

-- What each code took off the order, as priced by the server (ordering/contract.ts Adjustment[]).
alter table orders add column adjustments jsonb not null default '[]';
-- Choices the guest made at checkout that another module acts on, e.g. 'loyalty_join'.
alter table orders add column flags text[] not null default '{}';
-- The guest's handle on their own order: random, unguessable, shown once in the confirmation link.
alter table orders add column tracking_token text;
-- Units in the order, for max_items_per_slot pacing without a join.
alter table orders add column item_count integer not null default 0;
alter table orders add column cancelled_at timestamptz;
create unique index orders_tracking_token on orders (org_id, tracking_token) where tracking_token is not null;
create index orders_table_session on orders (org_id, table_session_id) where table_session_id is not null;

alter table order_items add column line_no integer not null default 0;
-- The ids chosen, kept beside the frozen names so a reorder can be rebuilt.
alter table order_items add column modifier_ids uuid[] not null default '{}';

alter table refunds add column failure_reason text;

-- New-ticket alerting repeats until acknowledged; first view is kept for the timing metrics.
alter table kitchen_tickets add column first_viewed_at timestamptz;

alter table qr_codes add column last_scanned_at timestamptz;

select app.apply_tenant_rls();
