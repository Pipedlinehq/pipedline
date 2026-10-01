import { Checkbox, Field, Input, Select, Textarea } from '@/ui';

/** Form fields for the menu editor. The menu service validates every value again. */

const DAYS = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [0, 'Sun'],
] as const;

export const dollars = (cents: number) => (cents / 100).toFixed(2);

export function MenuFields({ m }: { m?: { name: string; isActive: boolean; availableDays: number[]; availableFrom: string | null; availableTo: string | null; sortOrder: number } }) {
  const days = m?.availableDays ?? [0, 1, 2, 3, 4, 5, 6];
  return (
    <div className="space-y-4">
      <Field label="Name">
        <Input name="name" required maxLength={200} defaultValue={m?.name ?? ''} placeholder="Dinner" />
      </Field>
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-ink">Days served</legend>
        <div className="flex flex-wrap gap-3">
          {DAYS.map(([d, label]) => (
            <Checkbox key={d} name="days" value={String(d)} label={label} defaultChecked={days.includes(d)} />
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <Field label="From" hint="Leave both empty for all day.">
          <Input name="availableFrom" type="time" defaultValue={m?.availableFrom?.slice(0, 5) ?? ''} />
        </Field>
        <Field label="To">
          <Input name="availableTo" type="time" defaultValue={m?.availableTo?.slice(0, 5) ?? ''} />
        </Field>
      </div>
      <div className="grid grid-cols-2 items-end gap-3">
        <Field label="Order on the page">
          <Input name="sortOrder" type="number" min={0} defaultValue={m?.sortOrder ?? 0} />
        </Field>
        <Checkbox name="isActive" label="Active" defaultChecked={m?.isActive ?? true} className="pb-2" />
      </div>
    </div>
  );
}

export function SectionFields({ s }: { s?: { name: string; description: string | null; sortOrder: number; isVisible: boolean } }) {
  return (
    <div className="space-y-4">
      <Field label="Name">
        <Input name="name" required maxLength={200} defaultValue={s?.name ?? ''} placeholder="Mains" />
      </Field>
      <Field label="Description" hint="Optional. Shown under the section name.">
        <Textarea name="description" maxLength={2000} defaultValue={s?.description ?? ''} />
      </Field>
      <div className="grid grid-cols-2 items-end gap-3">
        <Field label="Order on the menu">
          <Input name="sortOrder" type="number" min={0} defaultValue={s?.sortOrder ?? 0} />
        </Field>
        <Checkbox name="isVisible" label="Shown to guests" defaultChecked={s?.isVisible ?? true} className="pb-2" />
      </div>
    </div>
  );
}

export interface ItemDefaults {
  name: string;
  description: string | null;
  priceCents: number;
  imageUrl: string | null;
  sortOrder: number;
  dietaryTags: string[];
  allergens: string[];
  spiceLevel: number | null;
  calories: number | null;
  prepMinutes: number;
  maxPerOrder: number | null;
  isAlcohol: boolean;
  isVisibleOnline: boolean;
  isVisibleInVenue: boolean;
  posCatalogId: string | null;
  sectionId: string;
}

export function ItemFields({ i, sections }: { i?: ItemDefaults; sections?: Array<{ id: string; label: string }> }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
        <Field label="Name">
          <Input name="name" required maxLength={200} defaultValue={i?.name ?? ''} />
        </Field>
        <Field label="Price ($)">
          <Input name="price" required inputMode="decimal" pattern="\$?[0-9]+(\.[0-9]{1,2})?" defaultValue={i ? dollars(i.priceCents) : ''} placeholder="24.50" />
        </Field>
      </div>
      {sections ? (
        <Field label="Section">
          <Select name="sectionId" defaultValue={i?.sectionId}>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label="Description">
        <Textarea name="description" maxLength={2000} defaultValue={i?.description ?? ''} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Allergens" hint="Comma-separated. Shown everywhere, and on the kitchen ticket.">
          <Input name="allergens" defaultValue={i?.allergens.join(', ') ?? ''} placeholder="gluten, dairy" />
        </Field>
        <Field label="Dietary tags" hint="Comma-separated.">
          <Input name="dietaryTags" defaultValue={i?.dietaryTags.join(', ') ?? ''} placeholder="vegetarian, gf" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Prep minutes">
          <Input name="prepMinutes" type="number" min={0} max={600} defaultValue={i?.prepMinutes ?? 10} />
        </Field>
        <Field label="Most per order">
          <Input name="maxPerOrder" type="number" min={1} defaultValue={i?.maxPerOrder ?? ''} />
        </Field>
        <Field label="Spice (0–5)">
          <Input name="spiceLevel" type="number" min={0} max={5} defaultValue={i?.spiceLevel ?? ''} />
        </Field>
        <Field label="Calories">
          <Input name="calories" type="number" min={0} defaultValue={i?.calories ?? ''} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Image address" hint="Optional. A full https:// address.">
          <Input name="imageUrl" type="url" defaultValue={i?.imageUrl ?? ''} />
        </Field>
        <Field label="POS catalogue id" hint="Links this item to the till's item, for the ledger.">
          <Input name="posCatalogId" defaultValue={i?.posCatalogId ?? ''} />
        </Field>
      </div>
      <Field label="Order in the section">
        <Input name="sortOrder" type="number" min={0} defaultValue={i?.sortOrder ?? 0} className="max-w-32" />
      </Field>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Checkbox name="isVisibleOnline" label="Shown online" defaultChecked={i?.isVisibleOnline ?? true} />
        <Checkbox name="isVisibleInVenue" label="Shown on the QR menu" defaultChecked={i?.isVisibleInVenue ?? true} />
        <Checkbox name="isAlcohol" label="Contains alcohol" defaultChecked={i?.isAlcohol ?? false} />
      </div>
    </div>
  );
}

export function GroupFields({ g }: { g?: { name: string; selectionType: 'single' | 'multi'; minSelections: number; maxSelections: number; isRequired: boolean; sortOrder: number } }) {
  return (
    <div className="space-y-4">
      <Field label="Name" hint="What the guest is asked, e.g. “How would you like it cooked?”">
        <Input name="name" required maxLength={200} defaultValue={g?.name ?? ''} />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Guest picks">
          <Select name="selectionType" defaultValue={g?.selectionType ?? 'single'}>
            <option value="single">One</option>
            <option value="multi">Several</option>
          </Select>
        </Field>
        <Field label="At least">
          <Input name="minSelections" type="number" min={0} max={50} defaultValue={g?.minSelections ?? 0} />
        </Field>
        <Field label="At most">
          <Input name="maxSelections" type="number" min={1} max={50} defaultValue={g?.maxSelections ?? 1} />
        </Field>
      </div>
      <div className="grid grid-cols-2 items-end gap-3">
        <Field label="Order">
          <Input name="sortOrder" type="number" min={0} defaultValue={g?.sortOrder ?? 0} />
        </Field>
        <Checkbox name="isRequired" label="Required" defaultChecked={g?.isRequired ?? false} className="pb-2" />
      </div>
    </div>
  );
}

export function ModifierFields({ m }: { m?: { name: string; priceDeltaCents: number; isDefault: boolean; sortOrder: number } }) {
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_6rem]">
      <Field label="Choice">
        <Input name="name" required maxLength={200} defaultValue={m?.name ?? ''} />
      </Field>
      <Field label="Price change ($)">
        <Input name="priceDelta" inputMode="decimal" defaultValue={m ? dollars(m.priceDeltaCents) : '0.00'} />
      </Field>
      <Field label="Order">
        <Input name="sortOrder" type="number" min={0} defaultValue={m?.sortOrder ?? 0} />
      </Field>
      <Checkbox name="isDefault" label="Chosen by default" defaultChecked={m?.isDefault ?? false} />
    </div>
  );
}
