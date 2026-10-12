-- Menu depth pass (docs/CONSOLE_IA.md section 9, wave 2, patterns 11 and 12; docs/modules/ordering.md
-- section 1 "as built"): scheduled menus and sections, "where it shows" per channel, and a price
-- per channel. The 86 state is unchanged: "sold out until" is the existing unavailable_until, read
-- back at request time, so nothing has to run for an item to come back.

-- The five places a menu item can show. 'online' and 'in_venue' in code are aliases for
-- 'website' and 'qr' (the two switches that existed before).
create type menu_channel as enum ('website', 'qr', 'pickup', 'delivery', 'assistants');

-- A menu goes live at an instant and may retire at another. Both are instants worked out from a
-- venue-local date and time when the manager sets them, so daylight saving cannot move them.
alter table menus
  add column live_from timestamptz,
  add column live_until timestamptz;

-- Sets of channels are text[] checked against the enum's values, not menu_channel[]: the
-- database driver hands an array of a custom enum back as one unparsed string.
create or replace function app.menu_channels_ok(list text[]) returns boolean
  language sql immutable as $$ select list <@ array['website', 'qr', 'pickup', 'delivery', 'assistants']::text[] $$;

-- A section may be scheduled the same way, and carries the default "where it shows" for items
-- added to it (null = the venue's own default for new items).
alter table menu_sections
  add column live_from timestamptz,
  add column live_until timestamptz,
  add column shown_on text[] check (shown_on is null or app.menu_channels_ok(shown_on));

-- Where an item shows. Filled from the two old switches: online = website, pickup, delivery and
-- assistants; in venue = the QR menu. The old columns stay and are kept in step by the module.
alter table menu_items
  add column shown_on text[] not null default '{website,qr,pickup,delivery,assistants}' check (app.menu_channels_ok(shown_on));
update menu_items
set shown_on =
  (case when is_visible_online then array['website', 'pickup', 'delivery', 'assistants'] else '{}'::text[] end)
  || (case when is_visible_in_venue then array['qr'] else '{}'::text[] end);

-- The three columns never disagree, whoever writes the row. A change to shown_on sets the two
-- old switches (website, qr). A change to an old switch alone, from a writer that predates
-- shown_on, moves the channels it stood for: online = website, pickup, delivery, assistants;
-- in venue = qr. On insert a switch left false takes its own channel off.
create or replace function app.menu_items_shown_on_sync() returns trigger
  language plpgsql as $$
declare
  all_channels text[] := array['website', 'qr', 'pickup', 'delivery', 'assistants'];
  online_channels text[] := array['website', 'pickup', 'delivery', 'assistants'];
  list text[] := coalesce(new.shown_on, all_channels);
begin
  if tg_op = 'UPDATE' and new.shown_on is distinct from old.shown_on then
    new.is_visible_online := 'website' = any(new.shown_on);
    new.is_visible_in_venue := 'qr' = any(new.shown_on);
    return new;
  end if;
  if tg_op = 'INSERT' then
    if not new.is_visible_online then list := array_remove(list, 'website'); end if;
    if not new.is_visible_in_venue then list := array_remove(list, 'qr'); end if;
  else
    if new.is_visible_online is distinct from old.is_visible_online then
      if new.is_visible_online then list := list || online_channels;
      else list := array(select c from unnest(list) c where not (c = any(online_channels))); end if;
    end if;
    if new.is_visible_in_venue is distinct from old.is_visible_in_venue then
      if new.is_visible_in_venue then list := list || array['qr'];
      else list := array_remove(list, 'qr'); end if;
    end if;
  end if;
  new.shown_on := array(select c from unnest(all_channels) c where c = any(list));
  new.is_visible_online := 'website' = any(new.shown_on);
  new.is_visible_in_venue := 'qr' = any(new.shown_on);
  return new;
end $$;
create trigger menu_items_shown_on_sync before insert or update on menu_items
  for each row execute function app.menu_items_shown_on_sync();

-- A price for one item on one channel (the delivery menu +15%), over the item's own price.
create table menu_item_prices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  item_id uuid not null references menu_items(id) on delete cascade,
  channel menu_channel not null,
  price_cents integer not null check (price_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id, channel)
);
create index menu_item_prices_venue on menu_item_prices (org_id, venue_id, item_id);

-- The venue's menu settings: which channels a new item goes on when nothing says otherwise.
-- One row per venue; no row means every channel.
create table menu_settings (
  org_id uuid not null references orgs(id),
  venue_id uuid primary key references venues(id),
  new_items_shown_on text[] not null default '{website,qr,pickup,delivery,assistants}' check (app.menu_channels_ok(new_items_shown_on)),
  updated_at timestamptz not null default now()
);
create index menu_settings_org on menu_settings (org_id, venue_id);

select app.apply_tenant_rls();
