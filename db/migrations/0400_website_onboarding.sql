-- Website content and onboarding: additions to 0006.
-- docs/modules/website.md section 3 · docs/ONBOARDING.md sections 2, 3, 5

-- A page keeps serving what was published while the next version is being edited. `blocks`,
-- `title` and the seo columns are the published version; `draft` is the working copy
-- ({ title, blocks, seoTitle, seoDescription, ogImageUrl }) and is never shown to the public.
alter table pages add column draft jsonb;

-- An onboarding starts at "sold", before the org exists: the intake is what the org is created
-- from. Until the first provisioning step creates the org these rows have no org and are
-- reachable by platform code only (a NULL org_id matches no tenant policy).
alter table onboardings alter column org_id drop not null;
alter table provisioning_steps alter column org_id drop not null;

alter table onboardings add column intake_version integer not null default 1;
-- What the owner has confirmed for go-live, by check key: { "<key>": { at, staffId } }.
alter table onboardings add column confirmations jsonb not null default '{}';

-- Every piece of hands-on time we spend on an onboarding. The sum is onboardings.manual_touch_minutes,
-- the number docs/ONBOARDING.md section 5 says to drive down.
create table onboarding_touches (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references onboardings(id) on delete cascade,
  admin_user_id uuid references users(id),
  minutes integer not null check (minutes > 0),
  note text not null,
  recorded_at timestamptz not null default now()
);
create index onboarding_touches_onboarding on onboarding_touches (onboarding_id, recorded_at);
comment on table onboarding_touches is '@platform';

select app.apply_tenant_rls();
