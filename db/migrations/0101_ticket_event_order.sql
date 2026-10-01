-- ticket_events is the sync unit for the kitchen screen (docs/modules/kds.md section 9): a
-- ticket's state is the fold of its events in the order they happened. Two taps can carry the
-- same instant (a batch replayed after an outage), so arrival order breaks the tie.
alter table ticket_events add column seq bigint generated always as identity;

select app.apply_tenant_rls();
