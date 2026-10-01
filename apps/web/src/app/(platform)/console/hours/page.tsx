import { addDays, localDate } from '@ros/core';
import { tenancy } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { ActionForm, Badge, Card, Field, Input, PageHeader, Select, SubmitButton, Table, Td, Th, dayLabel } from '@/ui';
import { InlineAction } from '@/components/console/confirm';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { addException, removeException, saveTradingHours, saveVenue } from './actions';

export const metadata = { title: 'Hours · Pipedline' };

// Monday first, as the week is read in Australia. dayOfWeek is 0 = Sunday.
const WEEK = [
  [1, 'Monday'],
  [2, 'Tuesday'],
  [3, 'Wednesday'],
  [4, 'Thursday'],
  [5, 'Friday'],
  [6, 'Saturday'],
  [0, 'Sunday'],
] as const;

const hhmm = (t: string | null | undefined) => (t ? t.slice(0, 5) : '');
const weekday = (date: string) => new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: 'short' }).format(new Date(`${date}T00:00:00Z`));

export default async function HoursPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Hours">Trading hours are set by a manager. The venue&apos;s site shows them to guests.</NotForYourRole>;
  const r = await read(async (ctx) => {
    const today = localDate(ctx.now(), c.venue.timezone);
    return {
      today,
      venue: await tenancy.getVenue(ctx, c.venue.id),
      hours: await tenancy.getTradingHours(ctx, c.venue.id),
      exceptions: await tenancy.listHourExceptions(ctx, c.venue.id, today, addDays(today, 400)),
    };
  });
  if (!r.ok) {
    return (
      <>
        <PageHeader title="Hours" />
        <ReadError message={r.error} />
      </>
    );
  }
  const { today, venue, hours, exceptions } = r.data;
  const input = 'h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink';

  return (
    <>
      <PageHeader title="Hours" description={`When ${venue.name} is open. Online ordering, pickup slots, the site and “86 until end of service” all read these. Times are ${venue.timezone.replace('_', ' ')}.`} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card title="Weekly hours" description="A day with no periods is closed. A period that ends after midnight closes the next morning (e.g. 17:00 to 01:00).">
          <ActionForm action={saveTradingHours}>
            <div className="space-y-4">
              {WEEK.map(([d, name]) => {
                const periods = hours.filter((h) => h.dayOfWeek === d);
                const rows = [...periods, { dayOfWeek: d, opensAt: '', closesAt: '', serviceType: '' }];
                return (
                  <fieldset key={d} className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)]">
                    <legend className="sr-only">{name}</legend>
                    <p className="pt-2 text-sm font-medium text-ink">
                      {name}
                      {periods.length === 0 ? <span className="ml-2 text-xs font-normal text-ink-3">closed</span> : null}
                    </p>
                    <div className="space-y-2">
                      {rows.map((h, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="day" value={d} />
                          <label className="sr-only" htmlFor={`o-${d}-${i}`}>
                            {name} period {i + 1} opens
                          </label>
                          <input id={`o-${d}-${i}`} type="time" name="opensAt" defaultValue={hhmm(h.opensAt)} className={input} />
                          <span className="text-sm text-ink-3">to</span>
                          <label className="sr-only" htmlFor={`c-${d}-${i}`}>
                            {name} period {i + 1} closes
                          </label>
                          <input id={`c-${d}-${i}`} type="time" name="closesAt" defaultValue={hhmm(h.closesAt)} className={input} />
                          <label className="sr-only" htmlFor={`s-${d}-${i}`}>
                            {name} period {i + 1} service
                          </label>
                          <input id={`s-${d}-${i}`} name="serviceType" defaultValue={h.serviceType === 'all' ? '' : h.serviceType} placeholder={i === periods.length ? 'add a period' : 'service'} className={`${input} w-32`} />
                        </div>
                      ))}
                    </div>
                  </fieldset>
                );
              })}
            </div>
            <p className="mt-4 text-xs text-ink-3">Clear both times of a period to remove it. The service name (lunch, dinner) is optional.</p>
            <div className="mt-4 flex justify-end">
              <SubmitButton>Save weekly hours</SubmitButton>
            </div>
          </ActionForm>
        </Card>

        <div className="space-y-6">
          <Card title="Exceptions" description="A public holiday, a private event, a closure. An exception replaces the weekly hours for that date." padded={false}>
            {exceptions.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-2">No exceptions coming up.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Hours</Th>
                    <Th>
                      <span className="sr-only">Remove</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {exceptions.map((e) => (
                    <tr key={e.date} data-testid={`exception-${e.date}`}>
                      <Td className="whitespace-nowrap">
                        {weekday(e.date)} {dayLabel(e.date)} {e.date.slice(0, 4)}
                        {e.date === today ? <span className="ml-1 text-xs text-ink-3">today</span> : null}
                      </Td>
                      <Td>
                        {e.closed ? <Badge tone="warn">Closed</Badge> : `${hhmm(e.opensAt)}–${hhmm(e.closesAt)}`}
                        {e.reason ? <span className="mt-0.5 block text-xs text-ink-2">{e.reason}</span> : null}
                      </Td>
                      <Td align="right">
                        <InlineAction action={removeException} hidden={{ date: e.date }} label="Remove" pendingLabel="…" />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <div className="border-t border-line p-5">
              <ActionForm action={addException} resetOnSuccess>
                <p className="mb-3 text-sm font-medium text-ink">Add an exception</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Date">
                    <Input type="date" name="date" required min={today} />
                  </Field>
                  <Field label="That day">
                    <Select name="mode" defaultValue="closed">
                      <option value="closed">Closed all day</option>
                      <option value="open">Open, with these hours</option>
                    </Select>
                  </Field>
                  <Field label="Opens" hint="Only if open.">
                    <Input type="time" name="opensAt" />
                  </Field>
                  <Field label="Closes">
                    <Input type="time" name="closesAt" />
                  </Field>
                </div>
                <Field label="Why" hint="Shown to guests on the site, e.g. “Christmas Day”." className="mt-3">
                  <Input name="reason" maxLength={200} />
                </Field>
                <div className="mt-4 flex justify-end">
                  <SubmitButton>Add exception</SubmitButton>
                </div>
              </ActionForm>
            </div>
          </Card>

          <Card title="Venue details" description="Shown on the site, in structured data search engines read, and on receipts.">
            <ActionForm action={saveVenue}>
              <div className="space-y-3">
                <Field label="Name">
                  <Input name="name" required maxLength={200} defaultValue={venue.name} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Phone">
                    <Input name="phone" type="tel" defaultValue={venue.phone ?? ''} />
                  </Field>
                  <Field label="Email">
                    <Input name="email" type="email" defaultValue={venue.email ?? ''} />
                  </Field>
                </div>
                <Field label="Address">
                  <Input name="addressLine1" defaultValue={venue.addressLine1 ?? ''} />
                </Field>
                <Field label="Address, second line">
                  <Input name="addressLine2" defaultValue={venue.addressLine2 ?? ''} />
                </Field>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Suburb">
                    <Input name="suburb" defaultValue={venue.suburb ?? ''} />
                  </Field>
                  <Field label="State">
                    <Input name="state" defaultValue={venue.state ?? ''} />
                  </Field>
                  <Field label="Postcode">
                    <Input name="postcode" inputMode="numeric" defaultValue={venue.postcode ?? ''} />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Seats">
                    <Input name="capacity" type="number" min={1} defaultValue={venue.capacity ?? ''} />
                  </Field>
                  <Field label="Price band (1–4)">
                    <Input name="priceBand" type="number" min={1} max={4} defaultValue={venue.priceBand ?? ''} />
                  </Field>
                </div>
              </div>
              <div className="mt-4 flex justify-end">
                <SubmitButton>Save details</SubmitButton>
              </div>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  );
}
