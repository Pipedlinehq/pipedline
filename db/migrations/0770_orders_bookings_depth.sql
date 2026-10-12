-- Console depth pass, wave 2, Orders + Bookings (docs/CONSOLE_IA.md section 9; patterns 2, 7
-- and 10 of docs/COMMERCE_ADMIN_PATTERNS.md section 3).
--
-- Three status axes on an order (kitchen, money, how it leaves) are derived from the columns
-- that already exist (status, payment_status, channel). What was missing is "where it came
-- from", the record of an unfinished order (abandoned, nudged, recovered, purged) and what a
-- phone or function order needs (a hold date, a pay link, paid by other means). Bookings get the
-- same unfinished-record columns.

-- Where an order came from. 'website' is the venue's own order page, 'qr' a table code,
-- 'phone' an order staff built by hand (phone, in person, a function), 'assistant' a guest's
-- own assistant through the guest plugin (paid on the venue's page), 'square' the venue's till.
create type order_source as enum ('website', 'qr', 'phone', 'assistant', 'square');

alter table orders add column source order_source not null default 'website';
update orders set source = 'qr' where channel = 'dine-in-qr';

-- Phone and function orders (drafts): kept, and payable by the link, until this instant.
alter table orders add column hold_until timestamptz;
-- The last time staff sent the guest a link to pay for a draft.
alter table orders add column pay_link_sent_at timestamptz;
-- A draft marked paid by other means: 'cash', 'bank' or 'other'. Null for a card payment.
alter table orders add column paid_by text check (paid_by in ('cash', 'bank', 'other'));

-- Unfinished orders ("Didn't finish"): cancelled because it was never paid (the hold ran out);
-- counted as abandoned by the detection job; one nudge at most; recovered when the guest later
-- paid this order or a new one; purged (personal details removed) after three months.
alter table orders add column lapsed_at timestamptz;
alter table orders add column abandoned_at timestamptz;
alter table orders add column nudge_sent_at timestamptz;
alter table orders add column nudge_message_id uuid;
-- 'queued' or 'suppressed:<reason>' as the outbox answered; null until a nudge was sent.
alter table orders add column nudge_status text check (char_length(nudge_status) <= 60);
alter table orders add column recovered_at timestamptz;
alter table orders add column recovered_order_id uuid references orders(id);
alter table orders add column purged_at timestamptz;

create index orders_source on orders (org_id, venue_id, source, created_at);
create index orders_abandoned on orders (org_id, venue_id, abandoned_at) where abandoned_at is not null and purged_at is null;
create index orders_hold on orders (org_id, venue_id, hold_until) where hold_until is not null;

-- Bookings: a request the venue never answered inside its window is unfinished too.
alter table bookings add column abandoned_at timestamptz;
alter table bookings add column nudge_sent_at timestamptz;
alter table bookings add column nudge_message_id uuid;
alter table bookings add column nudge_status text check (char_length(nudge_status) <= 60);
alter table bookings add column recovered_at timestamptz;
alter table bookings add column purged_at timestamptz;

create index bookings_abandoned on bookings (org_id, venue_id, abandoned_at) where abandoned_at is not null and purged_at is null;

select app.apply_tenant_rls();
