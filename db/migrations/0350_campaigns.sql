-- Campaigns: lifecycle flow enrolments belong to a venue (the batch a manager approves is one
-- venue's, and a venue that switches the module off stops sending), and a guest may pass through
-- the same flow more than once (a second win-back a season later, a birthday each year).
-- packages/modules/src/campaigns/flows.ts

alter table flow_enrollments
  add column venue_id uuid references venues(id),
  add column cycle integer not null default 1;

create index flow_enrollments_venue_due on flow_enrollments (org_id, flow_id, venue_id, status, next_at);
create index flow_enrollments_customer on flow_enrollments (org_id, customer_id);

select app.apply_tenant_rls();
