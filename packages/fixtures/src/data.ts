/** Static fixture content: obviously fake, realistically shaped. */

export interface FixtureItem {
  name: string;
  price: number; // cents
  prep: number;
  tags?: string[];
  allergens?: string[];
  alcohol?: boolean;
  groups?: string[];
  weight: number; // relative popularity
  description?: string;
}

export interface FixtureSection {
  name: string;
  items: FixtureItem[];
}

export const MODIFIER_GROUPS: Record<string, { selection: 'single' | 'multi'; required: boolean; min: number; max: number; options: Array<[string, number]> }> = {
  'Cook temperature': { selection: 'single', required: true, min: 1, max: 1, options: [['Rare', 0], ['Medium rare', 0], ['Medium', 0], ['Medium well', 0], ['Well done', 0]] },
  'Choose a side': { selection: 'single', required: true, min: 1, max: 1, options: [['Fries', 0], ['Green salad', 0], ['Mash', 0], ['Truffle fries', 300]] },
  'Add extras': { selection: 'multi', required: false, min: 0, max: 3, options: [['Fried egg', 300], ['Bacon', 400], ['Avocado', 450], ['Extra sauce', 150]] },
  Milk: { selection: 'single', required: false, min: 0, max: 1, options: [['Full cream', 0], ['Skim', 0], ['Oat', 80], ['Almond', 80], ['Soy', 80]] },
};

export const DINER_MENU: FixtureSection[] = [
  {
    name: 'Starters',
    items: [
      { name: 'Grilled sourdough, cultured butter', price: 900, prep: 4, tags: ['v'], allergens: ['gluten', 'milk'], weight: 9 },
      { name: 'Burrata, heirloom tomato, basil', price: 2200, prep: 5, tags: ['v', 'gf'], allergens: ['milk'], weight: 7 },
      { name: 'Kingfish crudo, finger lime', price: 2600, prep: 6, tags: ['gf', 'df'], allergens: ['fish'], weight: 5 },
      { name: 'Salt and pepper squid', price: 2100, prep: 7, tags: ['df'], allergens: ['molluscs', 'gluten'], weight: 8 },
      { name: 'Charred corn ribs, chipotle', price: 1600, prep: 8, tags: ['vg', 'gf'], weight: 5 },
      { name: 'Beef tartare, egg yolk, crisps', price: 2400, prep: 6, tags: ['df'], allergens: ['egg', 'gluten'], weight: 4 },
    ],
  },
  {
    name: 'Mains',
    items: [
      { name: 'Wagyu rump 250g', price: 4800, prep: 16, tags: ['gf'], groups: ['Cook temperature', 'Choose a side'], weight: 10, description: 'Grain-fed, marble score 7.' },
      { name: 'Scotch fillet 300g', price: 5400, prep: 18, tags: ['gf'], groups: ['Cook temperature', 'Choose a side'], weight: 8 },
      { name: 'Cheeseburger, pickles, fries', price: 2600, prep: 12, allergens: ['gluten', 'milk', 'egg'], groups: ['Add extras'], weight: 12 },
      { name: 'Barramundi, fennel, lemon', price: 3800, prep: 14, tags: ['gf'], allergens: ['fish', 'milk'], weight: 7 },
      { name: 'Rigatoni, slow-cooked ragu', price: 3200, prep: 11, allergens: ['gluten', 'milk'], weight: 9 },
      { name: 'Roast chicken, jus, greens', price: 3400, prep: 15, tags: ['gf'], allergens: ['milk'], weight: 6 },
      { name: 'Mushroom risotto', price: 2900, prep: 13, tags: ['v', 'gf'], allergens: ['milk'], weight: 5 },
      { name: 'Cauliflower steak, romesco', price: 2800, prep: 12, tags: ['vg', 'gf'], allergens: ['tree nuts'], weight: 3 },
    ],
  },
  {
    name: 'Sides',
    items: [
      { name: 'Fries, aioli', price: 1100, prep: 5, tags: ['v'], allergens: ['egg'], weight: 11 },
      { name: 'Truffle fries, pecorino', price: 1500, prep: 5, tags: ['v'], allergens: ['milk', 'egg'], weight: 6 },
      { name: 'Green salad', price: 1100, prep: 3, tags: ['vg', 'gf'], weight: 6 },
      { name: 'Broccolini, almond, chilli', price: 1400, prep: 6, tags: ['vg', 'gf'], allergens: ['tree nuts'], weight: 5 },
      { name: 'Mash, brown butter', price: 1200, prep: 4, tags: ['v', 'gf'], allergens: ['milk'], weight: 5 },
    ],
  },
  {
    name: 'Desserts',
    items: [
      { name: 'Basque cheesecake', price: 1600, prep: 3, tags: ['v'], allergens: ['milk', 'egg', 'gluten'], weight: 6 },
      { name: 'Chocolate mousse, olive oil', price: 1500, prep: 3, tags: ['v', 'gf'], allergens: ['milk', 'egg'], weight: 5 },
      { name: 'Lemon sorbet', price: 1100, prep: 3, tags: ['vg', 'gf'], weight: 3 },
      { name: 'Affogato', price: 1200, prep: 3, tags: ['v', 'gf'], allergens: ['milk'], weight: 3 },
    ],
  },
  {
    name: 'Drinks',
    items: [
      { name: 'Flat white', price: 500, prep: 3, tags: ['v'], allergens: ['milk'], groups: ['Milk'], weight: 9 },
      { name: 'Sparkling water 750ml', price: 900, prep: 1, tags: ['vg', 'gf'], weight: 7 },
      { name: 'Fresh lemonade', price: 800, prep: 2, tags: ['vg', 'gf'], weight: 5 },
      { name: 'Pale ale', price: 1200, prep: 1, alcohol: true, allergens: ['gluten'], weight: 8 },
      { name: 'House red, glass', price: 1500, prep: 1, alcohol: true, tags: ['gf'], allergens: ['sulphites'], weight: 9 },
      { name: 'House white, glass', price: 1500, prep: 1, alcohol: true, tags: ['gf'], allergens: ['sulphites'], weight: 7 },
      { name: 'Negroni', price: 2200, prep: 3, alcohol: true, tags: ['gf'], weight: 5 },
      { name: 'Espresso martini', price: 2300, prep: 4, alcohol: true, tags: ['gf'], weight: 5 },
    ],
  },
];

export const FIRST_NAMES = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Avery', 'Quinn', 'Harper', 'Rowan', 'Charlie', 'Frankie', 'Dylan', 'Reese', 'Emerson', 'Finley', 'Hayden', 'Kai', 'Noa', 'Priya', 'Mei', 'Arjun', 'Layla', 'Omar', 'Sofia', 'Mateo', 'Yuki', 'Aroha'];
export const LAST_NAMES = ['Example', 'Sample', 'Testa', 'Fixture', 'Mockford', 'Placeholder', 'Demo', 'Specimen', 'Dummy', 'Trial', 'Pattern', 'Template', 'Proxy', 'Standin', 'Model'];

export const CREATORS = ['creator_sydney_eats', 'creator_wagyu_wes', 'creator_inner_west_bites'] as const;
export const CAMPAIGNS = ['camp_winter_steak', 'camp_spring_launch'] as const;
