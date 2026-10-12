import { z } from 'zod';
import { defineTool, formatMoney, invalid } from '@ros/core';
import { getVenue } from '../tenancy/venues';
import { UNTIL_CHOICES, resolveUntil, setItemAvailability } from './availability';
import { type MenuChannel, MENU_CHANNELS, MENU_CHANNEL_WORDS } from './contract';
import { type MenuEditorView, getMenuEditor, setItemChannelPrice, setItemChannels, updateMenu, updateSection } from './edit';
import { itemAvailableAt, itemBackAt } from './public';

/**
 * The menu's assistant tools (docs/modules/hub.md section 2). Each is pinned to the service
 * function the console uses; each write is `propose` (changes nothing, returns the question in
 * plain words) and `commit`.
 */

const CHANNEL = z.enum(MENU_CHANNELS);
const SCHEDULE = z.enum(['live', 'scheduled', 'retired', 'not_active']);
/** A venue-local date and time an assistant gives: "2026-10-10T08:00" or "2026-10-10 08:00". */
const LOCAL_DT = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}[T ]([01]\d|2[0-3]):[0-5]\d$/, 'Use the venue\'s local date and time, such as 2026-10-10 08:00.')
  .transform((s) => s.replace(' ', 'T'));

const channelWords = (list: readonly MenuChannel[]) => (list.length ? list.map((c) => MENU_CHANNEL_WORDS[c]).join(', ') : 'nowhere');

/** "Sat 10 Oct 2026, 8:00 am" in the venue's zone. */
function whenWords(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    .format(at)
    .replace(' at ', ', ')
    .replace(/^(\w+),/, '$1');
}

type EditorItem = MenuEditorView['menus'][number]['sections'][number]['items'][number];
type EditorMenu = MenuEditorView['menus'][number];
type EditorSection = EditorMenu['sections'][number];

/** One item by id or exact name; refuses in words when none or several match. */
function findItem(editor: MenuEditorView, text: string): EditorItem {
  const wanted = text.trim().toLowerCase();
  const all = editor.menus.flatMap((m) => m.sections.flatMap((s) => s.items));
  const matches = all.filter((i) => i.id === wanted || i.name.toLowerCase() === wanted);
  if (!matches.length) throw invalid('No item on this menu has that id or exact name. Use menu_list to find it.');
  if (matches.length > 1) throw invalid('More than one item has that name. Use the item id from menu_list.');
  return matches[0]!;
}

function findMenu(editor: MenuEditorView, text: string): EditorMenu {
  const wanted = text.trim().toLowerCase();
  const matches = editor.menus.filter((m) => m.id === wanted || m.name.toLowerCase() === wanted);
  if (!matches.length) throw invalid('No menu has that id or exact name. Use menu_list to find it.');
  if (matches.length > 1) throw invalid('More than one menu has that name. Use the menu id from menu_list.');
  return matches[0]!;
}

function findSection(editor: MenuEditorView, text: string, within?: EditorMenu): EditorSection {
  const wanted = text.trim().toLowerCase();
  const pool = (within ? [within] : editor.menus).flatMap((m) => m.sections);
  const matches = pool.filter((s) => s.id === wanted || s.name.toLowerCase() === wanted);
  if (!matches.length) throw invalid('No section has that id or exact name. Use menu_list to find it.');
  if (matches.length > 1) throw invalid('More than one section has that name. Name the menu too, or use the section id from menu_list.');
  return matches[0]!;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// ── menu_list ────────────────────────────────────────────────────────────────

export const menuListTool = defineTool({
  name: 'menu_list',
  module: 'menu',
  title: 'The menu',
  description:
    'The venue\'s menu as it stands now: every menu, section and item with its price, allergens, whether it is available or sold out (and when it is back), where it shows (website, QR menu, pickup, delivery, inside assistants), any price per channel, and whether each menu is live, scheduled or retired. Use it to answer "what is 86\'d?" or to find an item, menu or section before changing it.',
  effect: 'read',
  scope: 'menu:read',
  venueScoped: true,
  input: z.object({
    search: z.string().max(100).optional().describe('Only items whose name contains this text'),
    only_unavailable: z.boolean().optional().describe('True to list only what is sold out'),
    shown_on: CHANNEL.optional().describe('Only items that show on this channel'),
  }),
  output: z.object({
    currency_note: z.string(),
    menus: z.array(
      z.object({
        menu_id: z.string(),
        menu: z.string(),
        active: z.boolean(),
        schedule: SCHEDULE.describe('live, scheduled (not live yet), retired, or not_active (switched off)'),
        live_from: z.string().nullable().describe('When it goes live (ISO), or null for already'),
        live_until: z.string().nullable().describe('When it retires (ISO), or null for never'),
        sections: z.array(
          z.object({
            section_id: z.string(),
            section: z.string(),
            schedule: SCHEDULE,
            live_from: z.string().nullable(),
            live_until: z.string().nullable(),
            new_items_shown_on: z.array(CHANNEL).nullable().describe('Where a new item added here shows; null means the venue\'s default'),
            items: z.array(
              z.object({
                item_id: z.string(),
                name: z.string(),
                price: z.string(),
                price_cents: z.number().int(),
                available: z.boolean(),
                back_at: z.string().nullable(),
                sold_out_until: z.string().nullable().describe('The same as back_at: when a sold-out item is back on its own, or null for until someone puts it back'),
                allergens: z.array(z.string()),
                dietary: z.array(z.string()),
                alcohol: z.boolean(),
                shown_online: z.boolean(),
                shown_in_venue: z.boolean(),
                shown_on: z.array(CHANNEL).describe('Where it shows'),
                channel_prices: z.array(z.object({ channel: CHANNEL, price: z.string(), price_cents: z.number().int() })).describe('A price on a channel that differs from the item\'s own'),
              }),
            ),
          }),
        ),
      }),
    ),
    new_items_shown_on: z.array(CHANNEL).describe('The venue\'s default for where a new item shows'),
    item_count: z.number().int(),
  }),
  async run({ ctx, venueId }, input) {
    const editor = await getMenuEditor(ctx, venueId!);
    const now = ctx.now();
    const q = input.search?.trim().toLowerCase();
    let count = 0;
    const menus = editor.menus.map((m) => ({
      menu_id: m.id,
      menu: m.name,
      active: m.isActive,
      schedule: m.schedule,
      live_from: iso(m.liveFrom),
      live_until: iso(m.liveUntil),
      sections: m.sections
        .map((s) => ({
          section_id: s.id,
          section: s.name,
          schedule: s.schedule,
          live_from: iso(s.liveFrom),
          live_until: iso(s.liveUntil),
          new_items_shown_on: s.shownOn,
          items: s.items
            .map((i) => ({ i, available: itemAvailableAt({ is_available: i.isAvailable, unavailable_until: i.unavailableUntil }, now) }))
            .filter(({ i, available }) => (!q || i.name.toLowerCase().includes(q)) && (!input.only_unavailable || !available) && (!input.shown_on || i.shownOn.includes(input.shown_on)))
            .map(({ i, available }) => {
              count++;
              const back = iso(itemBackAt({ is_available: i.isAvailable, unavailable_until: i.unavailableUntil }, now));
              return {
                item_id: i.id,
                name: i.name,
                price: formatMoney(i.priceCents),
                price_cents: i.priceCents,
                available,
                back_at: back,
                sold_out_until: back,
                allergens: i.allergens,
                dietary: i.dietaryTags,
                alcohol: i.isAlcohol,
                shown_online: i.isVisibleOnline,
                shown_in_venue: i.isVisibleInVenue,
                shown_on: i.shownOn,
                channel_prices: MENU_CHANNELS.filter((c) => i.channelPrices[c] !== undefined).map((c) => ({ channel: c, price: formatMoney(i.channelPrices[c]!), price_cents: i.channelPrices[c]! })),
              };
            }),
        }))
        .filter((s) => s.items.length > 0),
    }));
    return { currency_note: 'Prices include tax where the venue\'s prices do.', menus, new_items_shown_on: editor.settings.newItemsShownOn, item_count: count };
  },
});

// ── menu_set_availability ────────────────────────────────────────────────────

export const menuSetAvailabilityTool = defineTool({
  name: 'menu_set_availability',
  module: 'menu',
  title: 'Mark an item sold out, or put it back',
  description:
    'The 86 button. Mark a menu item as sold out until the end of this service, until tomorrow, until a time you give, or until someone puts it back; or make it available again. It comes back on its own when the time passes. Shows on the website, the QR menu, ordering and inside assistants straight away.',
  effect: 'write',
  scope: 'menu:write',
  minRole: 'kitchen',
  venueScoped: true,
  input: z.object({
    item: z.string().min(1).max(200).describe('The item\'s id from menu_list, or its exact name'),
    available: z.boolean().describe('False to mark it sold out, true to put it back'),
    until: z
      .union([z.enum(UNTIL_CHOICES), z.string().datetime({ offset: true })])
      .default('end_of_service')
      .describe('For a sold-out item: end_of_service (back when this service ends), tomorrow (back when the venue opens tomorrow), an ISO time with its offset, or until_changed (only when someone puts it back)'),
  }),
  output: z.object({ item_id: z.string(), name: z.string(), available: z.boolean(), back_at: z.string().nullable() }),
  async propose({ ctx, venueId }, input) {
    const venue = await getVenue(ctx, venueId!);
    const editor = await getMenuEditor(ctx, venue.id);
    const item = findItem(editor, input.item);
    let question: string;
    if (input.available) {
      question = `Put "${item.name}" back on the menu at ${venue.name}? Guests will be able to order it straight away.`;
    } else {
      const back = await resolveUntil(ctx, venue.id, input.until);
      const forHowLong =
        input.until === 'end_of_service'
          ? 'until the end of this service'
          : input.until === 'until_changed'
            ? 'until someone puts it back'
            : input.until === 'tomorrow'
              ? `until tomorrow (back ${whenWords(back!, venue.timezone)})`
              : `until ${whenWords(back!, venue.timezone)}`;
      question = `Mark "${item.name}" as sold out at ${venue.name} ${forHowLong}? It will show as unavailable on the website, the QR menu and in ordering straight away.`;
    }
    return {
      question,
      commit: async () => {
        const r = await setItemAvailability(ctx, { itemId: item.id, available: input.available, until: input.available ? null : input.until });
        return { item_id: r.itemId, name: r.name, available: r.available, back_at: iso(r.until) };
      },
    };
  },
});

// ── menu_schedule ────────────────────────────────────────────────────────────

const scheduleOut = z.object({
  menu_id: z.string(),
  menu: z.string(),
  section_id: z.string().nullable(),
  section: z.string().nullable(),
  schedule: SCHEDULE,
  live_from: z.string().nullable(),
  live_until: z.string().nullable(),
});

export const menuScheduleTool = defineTool({
  name: 'menu_schedule',
  module: 'menu',
  title: 'Schedule a menu or section',
  description:
    'Set when a menu (or one section of it) goes live and when it retires, in the venue\'s own time ("Brunch goes live Saturday 8:00", "Winter menu from 1 June until 31 August"). Until it goes live it is scheduled and guests do not see it; after it retires they do not either. Give the times as the venue\'s local date and time, such as 2026-10-10 08:00; give null to clear one.',
  effect: 'write',
  scope: 'menu:write',
  minRole: 'manager',
  venueScoped: true,
  input: z
    .object({
      menu: z.string().min(1).max(200).describe('The menu\'s id from menu_list, or its exact name'),
      section: z.string().min(1).max(200).optional().describe('To schedule one section instead of the whole menu: its id or exact name within that menu'),
      live_from: LOCAL_DT.nullable().optional().describe('Venue-local date and time it goes live, "2026-10-10 08:00". Null: live straight away. Omitted: unchanged.'),
      live_until: LOCAL_DT.nullable().optional().describe('Venue-local date and time it retires. Null: never. Omitted: unchanged.'),
    })
    .refine((v) => v.live_from !== undefined || v.live_until !== undefined, { message: 'Give a go-live time, a retire time, or both.' }),
  output: scheduleOut,
  async propose({ ctx, venueId }, input) {
    const venue = await getVenue(ctx, venueId!);
    const editor = await getMenuEditor(ctx, venue.id);
    const menu = findMenu(editor, input.menu);
    const section = input.section ? findSection(editor, input.section, menu) : null;
    const target = section ? `the "${section.name}" section of the "${menu.name}" menu` : `the "${menu.name}" menu`;
    const local = (s: string) => `${s.slice(0, 10)} at ${s.slice(11)}`;
    const parts: string[] = [];
    if (input.live_from !== undefined) parts.push(input.live_from === null ? 'go live straight away' : `go live on ${local(input.live_from)}`);
    if (input.live_until !== undefined) parts.push(input.live_until === null ? 'never retire' : `retire on ${local(input.live_until)}`);
    const question = `Set ${target} at ${venue.name} to ${parts.join(' and ')} (${venue.name}'s own time)? Guests see it only while it is live.`;
    return {
      question,
      commit: async () => {
        const patch = { ...(input.live_from !== undefined ? { liveFrom: input.live_from } : {}), ...(input.live_until !== undefined ? { liveUntil: input.live_until } : {}) };
        if (section) {
          const r = await updateSection(ctx, section.id, patch);
          const fresh = findSection(await getMenuEditor(ctx, venue.id), r.id);
          return { menu_id: menu.id, menu: menu.name, section_id: r.id, section: r.name, schedule: fresh.schedule, live_from: iso(r.liveFrom), live_until: iso(r.liveUntil) };
        }
        const r = await updateMenu(ctx, menu.id, patch);
        const fresh = findMenu(await getMenuEditor(ctx, venue.id), r.id);
        return { menu_id: r.id, menu: r.name, section_id: null, section: null, schedule: fresh.schedule, live_from: iso(r.liveFrom), live_until: iso(r.liveUntil) };
      },
    };
  },
});

// ── menu_show_on ─────────────────────────────────────────────────────────────

export const menuShowOnTool = defineTool({
  name: 'menu_show_on',
  module: 'menu',
  title: 'Where an item shows',
  description:
    'Show an item on, or hide it from, any of the five channels: website, qr (the QR menu), pickup, delivery, assistants (inside guests\' assistants). Name an item to change it, or a section to change where new items added to that section show. Channels you do not name stay as they are.',
  effect: 'write',
  scope: 'menu:write',
  minRole: 'manager',
  venueScoped: true,
  input: z
    .object({
      item: z.string().min(1).max(200).optional().describe('The item\'s id from menu_list, or its exact name'),
      section: z.string().min(1).max(200).optional().describe('Instead of an item: a section\'s id or exact name, to set where new items added to it show'),
      show: z.array(CHANNEL).max(5).optional().describe('Channels to show it on'),
      hide: z.array(CHANNEL).max(5).optional().describe('Channels to hide it from'),
    })
    .refine((v) => (v.item ? 1 : 0) + (v.section ? 1 : 0) === 1, { message: 'Name an item or a section, not both.' })
    .refine((v) => (v.show?.length ?? 0) + (v.hide?.length ?? 0) > 0, { message: 'Say where to show it or where to hide it.' }),
  output: z.object({
    target: z.enum(['item', 'section']),
    id: z.string(),
    name: z.string(),
    shown_on: z.array(CHANNEL).describe('Where it shows now (for a section: where its new items will show)'),
  }),
  async propose({ ctx, venueId }, input) {
    const venue = await getVenue(ctx, venueId!);
    const editor = await getMenuEditor(ctx, venue.id);
    const hide = new Set(input.hide ?? []);
    const show = input.show ?? [];
    if (show.some((c) => hide.has(c))) throw invalid('A channel cannot be both shown and hidden.');
    const after = (current: readonly MenuChannel[]) => MENU_CHANNELS.filter((c) => (current.includes(c) || show.includes(c)) && !hide.has(c));
    const changes = [show.length ? `show it on ${channelWords(show)}` : null, hide.size ? `hide it from ${channelWords([...hide])}` : null].filter(Boolean).join(' and ');
    if (input.item) {
      const item = findItem(editor, input.item);
      const next = after(item.shownOn);
      return {
        question: `For "${item.name}" at ${venue.name}, ${changes}? It will then show on: ${channelWords(next)}.`,
        commit: async () => {
          const r = await setItemChannels(ctx, { itemId: item.id, show: input.show, hide: input.hide });
          return { target: 'item' as const, id: r.id, name: r.name, shown_on: r.shownOn };
        },
      };
    }
    const section = findSection(editor, input.section!);
    const current = section.shownOn ?? editor.settings.newItemsShownOn;
    const next = after(current);
    return {
      question: `For new items added to the "${section.name}" section at ${venue.name}, ${changes}? New items there will then show on: ${channelWords(next)}. Items already in the section are not changed.`,
      commit: async () => {
        const r = await updateSection(ctx, section.id, { shownOn: next });
        return { target: 'section' as const, id: r.id, name: r.name, shown_on: r.shownOn ?? editor.settings.newItemsShownOn };
      },
    };
  },
});

// ── menu_set_channel_price ───────────────────────────────────────────────────

export const menuSetChannelPriceTool = defineTool({
  name: 'menu_set_channel_price',
  module: 'menu',
  title: 'Set an item\'s price on one channel',
  description:
    'Give an item a different price on one channel (most often delivery, sometimes pickup) over its usual price. The channel\'s menu shows it and orders on that channel are charged it. Give price_cents null to take the channel price off so the usual price applies there again.',
  effect: 'write',
  scope: 'menu:write',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({
    item: z.string().min(1).max(200).describe('The item\'s id from menu_list, or its exact name'),
    channel: CHANNEL.describe('website, qr, pickup, delivery or assistants'),
    price_cents: z.number().int().min(0).max(10_000_000).nullable().describe('The price on that channel in cents, or null to take it off'),
  }),
  output: z.object({ item_id: z.string(), name: z.string(), channel: CHANNEL, price_cents: z.number().int().nullable(), price: z.string().nullable(), usual_price_cents: z.number().int() }),
  async propose({ ctx, venueId }, input) {
    const venue = await getVenue(ctx, venueId!);
    const editor = await getMenuEditor(ctx, venue.id);
    const item = findItem(editor, input.item);
    const where = MENU_CHANNEL_WORDS[input.channel];
    const current = item.channelPrices[input.channel];
    const question =
      input.price_cents === null
        ? current === undefined
          ? `"${item.name}" at ${venue.name} has no ${where} price of its own; its usual ${formatMoney(item.priceCents)} already applies there. Nothing would change. Go ahead anyway?`
          : `Take the ${where} price (${formatMoney(current)}) off "${item.name}" at ${venue.name}, so it costs its usual ${formatMoney(item.priceCents)} there?`
        : `Charge ${formatMoney(input.price_cents)} for "${item.name}" on ${where} at ${venue.name} (its usual price is ${formatMoney(item.priceCents)}${current !== undefined ? `, its ${where} price now ${formatMoney(current)}` : ''})? The ${where} menu shows it and ${where} orders are charged it.`;
    return {
      question,
      commit: async () => {
        const r = await setItemChannelPrice(ctx, { itemId: item.id, channel: input.channel, priceCents: input.price_cents });
        const cents = r.channelPrices[input.channel] ?? null;
        return { item_id: r.id, name: r.name, channel: input.channel, price_cents: cents, price: cents === null ? null : formatMoney(cents), usual_price_cents: r.priceCents };
      },
    };
  },
});

export const menuTools = [menuListTool, menuSetAvailabilityTool, menuScheduleTool, menuShowOnTool, menuSetChannelPriceTool];
