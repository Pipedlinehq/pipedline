import type { offers } from '@ros/modules';
import { localParts } from '@ros/core';
import type { ConsoleContext } from '@/lib/console';
import { GuardedForm } from '@/components/console/save-bar';
import { Checkbox, Field, Input, Select, Textarea } from '@/ui';
import { saveOfferAction } from './actions';

export const OFFER_KINDS: Record<string, string> = {
  manual: 'Special',
  voucher: 'Voucher',
  welcome: 'Welcome',
  comeback: 'Come back',
  birthday: 'Birthday',
  creator: 'Creator',
};

export const METHODS: Record<string, string> = { code: 'By code', automatic: 'Automatic' };
export const APPLIES_TO: Record<string, string> = { bill: 'The whole bill', category: 'A menu category', item: 'One dish', delivery: 'The delivery fee' };
export const AUDIENCES: Record<string, string> = { everyone: 'Everyone', list: 'A guest list', new_guests: 'New guests', loyalty_members: 'Loyalty members' };
export const STATUS_WORDS: Record<offers.OfferStatus, { label: string; tone: 'good' | 'accent' | 'neutral' | 'warn' }> = {
  active: { label: 'Active', tone: 'good' },
  scheduled: { label: 'Scheduled', tone: 'accent' },
  expired: { label: 'Expired', tone: 'neutral' },
  off: { label: 'Switched off', tone: 'warn' },
};

const CHANNELS: Array<[string, string]> = [
  ['pickup', 'Pickup'],
  ['delivery', 'Delivery'],
  ['dine-in-qr', 'Table ordering'],
];
const DAYS: Array<[number, string]> = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [0, 'Sun'],
];

const dollars = (c: number | null | undefined) => (c ? (c / 100).toFixed(2) : '');
/** An instant as a datetime-local value in the venue's zone. */
const local = (at: Date | null | undefined, tz: string) => {
  if (!at) return '';
  const p = localParts(at, tz);
  return `${p.date}T${p.time.slice(0, 5)}`;
};

/**
 * Create or change an offer (docs/CONSOLE_IA.md section 9, pattern 6): method × what it applies
 * to × who, when, what it combines with, limits. Org-wide; the service is the judge of what is
 * valid and writes the plain-words summary the page shows back.
 */
export function OfferForm({ offer: o, c, lists }: { offer?: offers.OfferView; c: ConsoleContext; lists: Array<{ id: string; name: string }> }) {
  const tz = c.venue.timezone;
  return (
    <GuardedForm action={saveOfferAction} className="space-y-6" submitLabel={o ? 'Save offer' : 'Create offer'} testId="offer-form">
      {o ? <input type="hidden" name="id" value={o.id} /> : null}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-ink">What it is</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" hint="Guests see this.">
            <Input name="name" required maxLength={120} defaultValue={o?.name ?? ''} />
          </Field>
          <Field label="How it is used" hint="By code: each guest holds a single-use code. Automatic: applied by itself at checkout and matched from the till.">
            <Select name="method" defaultValue={o?.method ?? 'code'}>
              {Object.entries(METHODS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Kind" hint="For code offers: what the code is for.">
            <Select name="kind" defaultValue={o?.kind ?? 'manual'}>
              {Object.entries(OFFER_KINDS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Gives">
            <Select name="discountKind" defaultValue={o?.discountKind ?? 'fixed'}>
              <option value="fixed">Dollars off</option>
              <option value="percent">Percentage off</option>
              <option value="free_item">A free item</option>
            </Select>
          </Field>
          <Field label="Dollars off, or the free item's value" hint="e.g. 10.00">
            <Input name="value" inputMode="decimal" defaultValue={dollars(o?.valueCents)} />
          </Field>
          <Field label="Percentage off" hint="For a percentage offer.">
            <Input name="percentOff" type="number" min={1} max={100} defaultValue={o?.percentOff ?? ''} />
          </Field>
          <Field label="Comes off">
            <Select name="appliesTo" defaultValue={o?.appliesTo ?? 'bill'}>
              {Object.entries(APPLIES_TO).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Menu category" hint="For a category offer, as the menu names it, e.g. Mains.">
            <Input name="category" maxLength={80} defaultValue={o?.category ?? ''} />
          </Field>
          <Field label="Dish" hint="For a one-dish or free-item offer: the item's id from the menu page.">
            <Input name="menuItemId" defaultValue={o?.menuItemId ?? ''} />
          </Field>
          <Field label="Minimum spend" hint="Dollars; empty for none.">
            <Input name="minSpend" inputMode="decimal" defaultValue={dollars(o?.minSpendCents)} />
          </Field>
        </div>
        <Field label="Description">
          <Textarea name="description" maxLength={1000} defaultValue={o?.description ?? ''} />
        </Field>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-ink">Who</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="For">
            <Select name="audience" defaultValue={o?.audience ?? 'everyone'}>
              {Object.entries(AUDIENCES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Guest list" hint="When it is for a guest list.">
            <Select name="segmentId" defaultValue={o?.segmentId ?? ''}>
              <option value="">Choose a list…</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-ink">When</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts" hint={`Venue time (${tz}). Empty: now.`}>
            <Input name="startsAt" type="datetime-local" defaultValue={local(o?.startsAt, tz)} />
          </Field>
          <Field label="Ends" hint="Empty: no end.">
            <Input name="endsAt" type="datetime-local" defaultValue={local(o?.endsAt, tz)} />
          </Field>
          <Field label="Services" hint="As your hours name them, e.g. lunch, dinner. Empty: any.">
            <Input name="services" defaultValue={o?.services?.join(', ') ?? ''} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="From (daily)" hint="e.g. 16:00">
              <Input name="timeFrom" type="time" defaultValue={o?.timeFrom ?? ''} />
            </Field>
            <Field label="To (daily)" hint="e.g. 18:00">
              <Input name="timeTo" type="time" defaultValue={o?.timeTo ?? ''} />
            </Field>
          </div>
        </div>
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Days</legend>
          <p className="mb-2 text-xs text-ink-3">Tick none for every day.</p>
          <div className="flex flex-wrap gap-4">
            {DAYS.map(([d, label]) => (
              <Checkbox key={d} name="days" value={String(d)} label={label} defaultChecked={!!o?.days?.includes(d)} />
            ))}
          </div>
        </fieldset>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-ink">Limits and combining</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Per guest" hint="Times one guest may use it. Empty: no limit.">
            <Input name="perGuestLimit" type="number" min={1} defaultValue={o?.perGuestLimit ?? ''} />
          </Field>
          <Field label="In total" hint="Times it may be used in total. Empty: no limit.">
            <Input name="totalLimit" type="number" min={1} defaultValue={o?.totalLimit ?? ''} />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Can be used together with</legend>
          <p className="mb-2 text-xs text-ink-3">Both offers have to allow it. Tick none for “not with other offers”.</p>
          <div className="flex flex-wrap gap-4">
            <Checkbox name="combineItem" label="Dish and category offers" defaultChecked={!!o?.combineItem} />
            <Checkbox name="combineBill" label="Whole-bill offers" defaultChecked={!!o?.combineBill} />
            <Checkbox name="combineDelivery" label="Delivery offers" defaultChecked={!!o?.combineDelivery} />
          </div>
        </fieldset>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-ink">Codes</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code lasts (days)">
            <Input name="validityDays" type="number" min={1} max={1825} defaultValue={o?.validityDays ?? 30} required />
          </Field>
          <Field label="Code prefix" hint="2 to 8 letters or numbers, e.g. OAK-W">
            <Input name="codePrefix" maxLength={13} defaultValue={o?.codePrefix ?? ''} className="uppercase" />
          </Field>
          <Field label="Most codes in total" hint="Empty for no limit.">
            <Input name="maxCodes" type="number" min={1} defaultValue={o?.maxCodes ?? ''} />
          </Field>
          <Field label="Guest pays for a voucher" hint="Dollars; empty or 0 for free.">
            <Input name="price" inputMode="decimal" defaultValue={dollars(o?.priceCents)} />
          </Field>
          <Field label="Creator" hint="Needed for a creator offer.">
            <Input name="creatorId" maxLength={120} defaultValue={o?.creatorId ?? ''} />
          </Field>
          <Field label="Campaign" hint="Optional.">
            <Input name="campaignId" maxLength={120} defaultValue={o?.campaignId ?? ''} />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Works on online orders for</legend>
          <p className="mb-2 text-xs text-ink-3">Codes always work at the till.</p>
          <div className="flex flex-wrap gap-4">
            {CHANNELS.map(([k, v]) => (
              <Checkbox key={k} name="channels" value={k} label={v} defaultChecked={!o || o.channels.includes(k as never)} />
            ))}
          </div>
        </fieldset>
        {c.venues.length > 1 ? (
          <fieldset>
            <legend className="mb-1 text-sm font-medium">Venues</legend>
            <p className="mb-2 text-xs text-ink-3">Tick none for every venue.</p>
            <div className="flex flex-wrap gap-4">
              {c.venues.map((v) => (
                <Checkbox key={v.id} name="validVenueIds" value={v.id} label={v.name} defaultChecked={!!o?.validVenueIds?.includes(v.id)} />
              ))}
            </div>
          </fieldset>
        ) : null}
        <div className="space-y-2">
          <Checkbox name="requiresClaim" label="Guests claim the code first" hint="Off: a code is ready to use as soon as it is issued." defaultChecked={o ? o.requiresClaim : true} />
          <Checkbox name="isActive" label="Switched on" hint="Off stops it applying and stops new codes. Codes already with guests stay good until they expire." defaultChecked={o ? o.isActive : true} />
        </div>
      </section>
    </GuardedForm>
  );
}
