-- Self-serve start (docs/PIPEDLINE.md "What has to change" section 1): a person who has proved
-- their email starts their own organisation, with no platform admin involved.
--
-- `origin` says who opened the onboarding. A self-serve one is provisioned from a short intake
-- (a name and an owner; the rest is filled in afterwards, by the owner or their assistant) and
-- is taken live by its own owner. A platform one is as before.
create type onboarding_origin as enum ('platform', 'self_serve');
alter table onboardings add column origin onboarding_origin not null default 'platform';

-- The person who started it, so a second start by the same person finds the first: one draft
-- organisation per email. Null for platform-led onboardings.
alter table onboardings add column started_by_user_id uuid references users(id);
create index onboardings_started_by on onboardings (started_by_user_id) where started_by_user_id is not null;

select app.apply_tenant_rls();
