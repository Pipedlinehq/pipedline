-- Foundation: extensions, the tenant role, and the helper that applies tenant isolation.
--
-- Tenant code runs inside a transaction as role app_tenant with app.org_id set
-- (packages/core/src/tenant.ts). Platform code runs as the table owner and is not
-- subject to row-level security. See docs/THREAT_MODEL.md section 5.

create extension if not exists pgcrypto;
create extension if not exists citext;

create schema if not exists app;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_tenant') then
    create role app_tenant nologin;
  end if;
end $$;

grant usage on schema public to app_tenant;
grant usage on schema app to app_tenant;

-- The org the current transaction is acting for. NULL outside a tenant transaction,
-- which makes every tenant policy evaluate to false.
create or replace function app.current_org() returns uuid
language sql stable as $$
  select nullif(current_setting('app.org_id', true), '')::uuid
$$;

create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Applies tenant isolation to every table in public. Idempotent; call it at the end of
-- any migration that adds a table. A table is classified by a tag in its comment:
--
--   (no tag, has org_id)  tenant table: full read/write within the org
--   @append_only          tenant table: read and insert only (ledgers, logs, histories)
--   @shared_read          org_id is nullable; NULL rows are platform defaults every org may read
--   @reference            no org_id; every org may read, only the platform writes
--   @platform             no tenant access at all
--
-- A table with no org_id and no tag gets no tenant access (same as @platform).
create or replace function app.apply_tenant_rls() returns void
language plpgsql as $$
declare
  t record;
  tag text;
  has_org boolean;
  has_updated boolean;
begin
  for t in
    select c.oid, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname <> 'schema_migrations'
  loop
    tag := coalesce(obj_description(t.oid, 'pg_class'), '');
    has_org := exists (
      select 1 from pg_attribute a
      where a.attrelid = t.oid and a.attname = 'org_id' and not a.attisdropped
    );
    has_updated := exists (
      select 1 from pg_attribute a
      where a.attrelid = t.oid and a.attname = 'updated_at' and not a.attisdropped
    );

    execute format('alter table public.%I enable row level security', t.relname);
    execute format('drop policy if exists tenant_isolation on public.%I', t.relname);
    execute format('drop policy if exists tenant_read_shared on public.%I', t.relname);
    execute format('revoke all on public.%I from app_tenant', t.relname);

    if has_updated then
      execute format('drop trigger if exists touch_updated_at on public.%I', t.relname);
      execute format(
        'create trigger touch_updated_at before update on public.%I for each row execute function app.touch_updated_at()',
        t.relname);
    end if;

    if tag like '%@platform%' then
      continue;
    end if;

    if t.relname = 'orgs' then
      execute 'create policy tenant_isolation on public.orgs for all to app_tenant using (id = app.current_org()) with check (id = app.current_org())';
      execute 'grant select, update on public.orgs to app_tenant';
      continue;
    end if;

    if tag like '%@reference%' then
      execute format('create policy tenant_isolation on public.%I for select to app_tenant using (true)', t.relname);
      execute format('grant select on public.%I to app_tenant', t.relname);
      continue;
    end if;

    if not has_org then
      continue;
    end if;

    if tag like '%@shared_read%' then
      execute format(
        'create policy tenant_read_shared on public.%I for select to app_tenant using (org_id is null or org_id = app.current_org())',
        t.relname);
      execute format(
        'create policy tenant_isolation on public.%I for all to app_tenant using (org_id = app.current_org()) with check (org_id = app.current_org())',
        t.relname);
      execute format('grant select, insert, update, delete on public.%I to app_tenant', t.relname);
    elsif tag like '%@append_only%' then
      execute format(
        'create policy tenant_isolation on public.%I for all to app_tenant using (org_id = app.current_org()) with check (org_id = app.current_org())',
        t.relname);
      execute format('grant select, insert on public.%I to app_tenant', t.relname);
    else
      execute format(
        'create policy tenant_isolation on public.%I for all to app_tenant using (org_id = app.current_org()) with check (org_id = app.current_org())',
        t.relname);
      execute format('grant select, insert, update, delete on public.%I to app_tenant', t.relname);
    end if;
  end loop;

  grant usage, select on all sequences in schema public to app_tenant;

  -- Supabase ships anon/authenticated roles that PostgREST exposes to browsers. Nothing in
  -- this schema is ever reachable that way.
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema public from authenticated';
  end if;
end $$;
