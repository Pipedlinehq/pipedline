/**
 * The menu as other modules and the web app see it. The menu module implements functions that
 * return these shapes (`getPublicMenu`); the website, QR, ordering and the structured-data
 * builders consume them. One menu model serves every surface (docs/modules/ordering.md section 1).
 */

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
  priceCents: number;
  imageUrl: string | null;
  /** False while the item is 86'd. It is still listed, shown as unavailable. */
  isAvailable: boolean;
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
  /** The menus active at the requested time (e.g. "Lunch"), in display order. */
  menus: Array<{ id: string; name: string; sections: PublicMenuSection[] }>;
  generatedAt: string;
}

/** Which surface is asking. Decides between is_visible_online and is_visible_in_venue. */
export type MenuSurface = 'online' | 'in_venue';
