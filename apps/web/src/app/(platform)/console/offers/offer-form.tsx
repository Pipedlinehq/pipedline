import type { offers } from '@ros/modules';
import type { ConsoleContext } from '@/lib/console';
import { ActionForm, Checkbox, Field, Input, Select, SubmitButton, Textarea } from '@/ui';
import { saveOfferAction } from './actions';

export const OFFER_KINDS: Record<string, string> = {
  manual: 'Hand-issued',
  voucher: 'Voucher',
  welcome: 'Welcome',
  comeback: 'Come back',
  birthday: 'Birthday',
  creator: 'Creator',
};

const CHANNELS: Array<[string, string]> = [
  ['pickup', 'Pickup'],
  ['delivery', 'Delivery'],
  ['dine-in-qr', 'Table ordering'],
];

const dollars = (c: number | null | undefined) => (c ? (c / 100).toFixed(2) : '');

/** Create or change an offer. Org-wide; the service is the judge of what is valid. */
export function OfferForm({ offer: o, c }: { offer?: offers.OfferView; c: ConsoleContext }) {
  return (
    <ActionForm action={saveOfferAction} className="space-y-5">
      {o ? <input type="hidden" name="id" value={o.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" hint="Guests see this.">
          <Input name="name" required maxLength={120} defaultValue={o?.name ?? ''} />
        </Field>
        <Field label="Kind">
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
        <Field label="Minimum spend" hint="Dollars; empty for none.">
          <Input name="minSpend" inputMode="decimal" defaultValue={dollars(o?.minSpendCents)} />
        </Field>
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
      <Field label="Description">
        <Textarea name="description" maxLength={1000} defaultValue={o?.description ?? ''} />
      </Field>
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
        <Checkbox name="isActive" label="Switched on" hint="Off stops new codes. Codes already with guests stay good until they expire." defaultChecked={o ? o.isActive : true} />
      </div>
      <SubmitButton>{o ? 'Save offer' : 'Create offer'}</SubmitButton>
    </ActionForm>
  );
}
