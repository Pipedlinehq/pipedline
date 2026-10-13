-- Ordering: surcharges on an order (docs/CONSOLE_IA.md section 9; the offers module's surcharges,
-- pattern 6, reaching online totals).
--
-- A Sunday, public-holiday or named-day surcharge is a percentage of the bill after discounts,
-- shown as its own line with the notice the law asks for. The venue can change or remove the
-- surcharge later, so what was charged is frozen onto the order when it is priced, the way the
-- adjustments (discounts) already are: one jsonb list of { id, name, percentBp, reason, notice,
-- amountCents } and the total they add. Nothing here changes an existing total.

alter table orders add column surcharge_cents integer not null default 0;
alter table orders add column surcharges jsonb not null default '[]';

select app.apply_tenant_rls();
