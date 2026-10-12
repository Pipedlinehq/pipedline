/**
 * The menu as other modules and the web app see it. The menu module implements functions that
 * return these shapes (`getPublicMenu`); the website, QR, ordering and the structured-data
 * builders consume them. One menu model serves every surface (docs/modules/ordering.md section 1).
 */

/**
 * The five places a menu item can show ("where it shows", docs/CONSOLE_IA.md section 9 pattern
 * 12). A price list may exist per channel. The order here is the order the console lists them.
 */
export const MENU_CHANNELS = ['website', 'qr', 'pickup', 'delivery', 'assistants'] as const;
export type MenuChannel = (typeof MENU_CHANNELS)[number];

/** The words a venue sees for each channel. */
export const MENU_CHANNEL_WORDS: Record<MenuChannel, string> = {
  website: 'Website',
  qr: 'QR menu',
  pickup: 'Pickup',
  delivery: 'Delivery',
  assistants: 'Inside assistants',
};

/** The channels the old "shown online" switch stood for. "Shown on the QR menu" stood for `qr`. */
export const ONLINE_CHANNELS: readonly MenuChannel[] = ['website', 'pickup', 'delivery', 'assistants'];

/**
 * Which surface is asking. One of the five channels, or one of the two older names kept so
 * existing callers keep working: `online` is the website, `in_venue` is the QR menu.
 */
export type MenuSurface = MenuChannel | 'online' | 'in_venue';

export function channelOf(surface: MenuSurface): MenuChannel {
  if (surface === 'online') return 'website';
  if (surface === 'in_venue') return 'qr';
  return surface;
}

/** Channels in their listed order, each once; anything that is not a channel is dropped. */
export function normaliseChannels(list: readonly string[]): MenuChannel[] {
  return MENU_CHANNELS.filter((c) => list.includes(c));
}

/**
 * A menu or a section is scheduled when it has not gone live yet and retired once its retire
 * time has passed (pattern 11). `not_active` is the menu's own switch, which wins over the dates.
 */
export type ScheduleState = 'not_active' | 'scheduled' | 'live' | 'retired';

export interface Scheduled {
  isActive?: boolean;
  liveFrom: Date | null;
  liveUntil: Date | null;
}

export function scheduleStateAt(row: Scheduled, at: Date): ScheduleState {
  if (row.isActive === false) return 'not_active';
  if (row.liveFrom && row.liveFrom.getTime() > at.getTime()) return 'scheduled';
  if (row.liveUntil && row.liveUntil.getTime() <= at.getTime()) return 'retired';
  return 'live';
}

/** True when the dates (not the active switch) allow it at `at`. */
export function liveAt(row: { live_from: Date | null; live_until: Date | null }, at: Date): boolean {
  return scheduleStateAt({ liveFrom: row.live_from, liveUntil: row.live_until }, at) === 'live';
}

export interface PublicModifier {
  id: string;
  name: string;
  priceDeltaCents: number;
  isDefault: boolean;
  isAvailable: boolean;
}

export interface PublicModifierGroup {
  id: string;
  name: string;
  selectionType: 'single' | 'multi';
  minSelections: number;
  maxSelections: number;
  isRequired: boolean;
  modifiers: PublicModifier[];
}

export interface PublicMenuItem {
  id: string;
  name: string;
  description: string | null;
  /** The price on the surface asked for: the channel's own price when the venue set one, else the item's. */
  priceCents: number;
  imageUrl: string | null;
  /** False while the item is 86'd. It is still listed, shown as unavailable. */
  isAvailable: boolean;
  /** When a sold-out item comes back on its own, or null for "until someone puts it back". Null when available. */
  availableFrom?: Date | null;
  dietaryTags: string[];
  /** A safety field. Always shown, never truncated. */
  allergens: string[];
  spiceLevel: number | null;
  calories: number | null;
  prepMinutes: number;
  maxPerOrder: number | null;
  isAlcohol: boolean;
  modifierGroups: PublicModifierGroup[];
}

export interface PublicMenuSection {
  id: string;
  name: string;
  description: string | null;
  items: PublicMenuItem[];
}

export interface PublicMenu {
  venueId: string;
  currency: string;
  /** Prices include tax when true (Australia). */
  taxInclusive: boolean;
  /** The channel the prices and the item list are for. */
  channel?: MenuChannel;
  /** The menus active at the requested time (e.g. "Lunch"), in display order. */
  menus: Array<{ id: string; name: string; sections: PublicMenuSection[] }>;
  generatedAt: string;
}
