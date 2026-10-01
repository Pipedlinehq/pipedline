-- Menu import: what the review needs beyond 0006's menu_imports. The proposal itself stays in
-- menu_imports.extracted, one entry per item with its own review state.
alter table menu_imports add column error text;
alter table menu_imports add column model text;
alter table menu_imports add column source_chars integer;
alter table menu_imports add column confirmed_by_staff_id uuid references staff(id);

select app.apply_tenant_rls();
