import { offers } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { ConfirmAction } from '@/components/console/confirm';
import { ModuleOff, NotForYourRole, ReadError } from '@/components/console/states';
import { ActionForm, Badge, Card, Checkbox, EmptyState, Field, Input, LinkButton, PageHeader, Select, SubmitButton, Table, Td, Th } from '@/ui';
import { deleteSurchargeAction, saveSurchargeAction } from '../actions';

export const metadata = { title: 'Surcharges · Pipedline' };

const KINDS: Record<offers.SurchargeKind, string> = { public_holiday: 'Public holidays', sunday: 'Sundays', days: 'Particular days' };
const DAYS: Array<[number, string]> = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [0, 'Sun'],
];

/**
 * Surcharges (docs/CONSOLE_IA.md section 9, pattern 6): public holiday, Sunday and named-day
 * surcharges as their own object, with the legal line menus and dockets carry. A card-payment
 * surcharge cannot be made here; the page says why, with the date and the source.
 */
export default async function SurchargesPage() {
  const c = await getConsole();
  const manager = atLeast(c.role, 'manager');
  if (!(await moduleOn('offers'))) return <ModuleOff title="Surcharges" what="Offers" canManage={manager} />;
  if (!manager) return <NotForYourRole title="Surcharges">A manager sets surcharges.</NotForYourRole>;
  const [list, notice] = await Promise.all([read((ctx) => offers.listSurcharges(ctx, { venueId: c.venue.id, includeInactive: true })), read((ctx) => offers.surchargeNotice(ctx, c.venue.id))]);
  return (
    <>
      <PageHeader
        title="Surcharges"
        description={`A percentage added to the bill after offers, on public holidays, Sundays or the days you choose, at ${c.venue.name} or every venue. Menus and dockets carry the line the law asks for.`}
        actions={<LinkButton href="/console/offers">Offers</LinkButton>}
      />
      <div className="mb-6 rounded-md border border-line bg-sunken px-4 py-3 text-sm text-ink-2" data-testid="card-surcharge-note">
        <strong className="text-ink">No card surcharges.</strong> From {new Date(offers.CARD_SURCHARGE_BAN_DATE).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })} a business in Australia may not add a surcharge for paying by eftpos, Mastercard or Visa, so there is no way to set one up here. Put the cost of taking cards into your prices instead.{' '}
        <a href={offers.CARD_SURCHARGE_BAN_SOURCE} className="text-accent hover:underline" rel="noreferrer" target="_blank">
          Source: Reserve Bank of Australia, Review of Retail Payments Regulation (March 2026)
        </a>
        .
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-6">
          {!list.ok ? (
            <ReadError message={list.error} />
          ) : list.data.length === 0 ? (
            <EmptyState title="No surcharges">Add one on the right. Until you do, menus and dockets carry no surcharge line.</EmptyState>
          ) : (
            <Card padded={false}>
              <Table label="Surcharges">
                <thead>
                  <tr>
                    <Th>Surcharge</Th>
                    <Th>When</Th>
                    <Th align="right">Adds</Th>
                    <Th>Where</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {list.data.map((s) => (
                    <tr key={s.id} data-testid="surcharge-row">
                      <Td>
                        <span className="font-medium">{s.name}</span> {s.isActive ? null : <Badge>Off</Badge>}
                        <span className="block text-xs text-ink-3" data-testid="surcharge-notice">
                          {s.notice}
                        </span>
                      </Td>
                      <Td>
                        {KINDS[s.kind]}
                        {s.kind === 'public_holiday' && s.dates.length ? <span className="block text-xs text-ink-3">plus {s.dates.length} of your own dates</span> : null}
                        {s.kind === 'days' && s.days ? <span className="block text-xs text-ink-3">{s.days.map((d) => DAYS.find(([n]) => n === d)?.[1]).join(', ')}</span> : null}
                      </Td>
                      <Td numeric>{offers.percentWords(s.percentBp)}</Td>
                      <Td>{s.venueId ? (c.venues.find((v) => v.id === s.venueId)?.name ?? 'A venue') : 'Every venue'}</Td>
                      <Td align="right">
                        <ConfirmAction trigger="Remove" title={`Remove “${s.name}”?`} action={deleteSurchargeAction} hidden={{ id: s.id }} confirmLabel="Remove surcharge">
                          The surcharge stops applying and its line comes off menus and dockets. Sales already recorded are not changed.
                        </ConfirmAction>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
          {notice.ok && notice.data ? (
            <Card title="What menus and dockets say">
              <p className="text-sm text-ink" data-testid="surcharge-menu-line">
                {notice.data}
              </p>
            </Card>
          ) : null}
        </div>
        <Card title="Add a surcharge" description="Name it for when it applies, not how the guest pays.">
          <ActionForm action={saveSurchargeAction} className="space-y-4">
            <Field label="Name" hint="e.g. Public holiday surcharge">
              <Input name="name" required maxLength={80} />
            </Field>
            <Field label="Applies on">
              <Select name="kind" defaultValue="public_holiday">
                {Object.entries(KINDS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Percent" hint="Of the bill after offers, e.g. 10 or 15">
              <Input name="percent" inputMode="decimal" required />
            </Field>
            <fieldset>
              <legend className="mb-1 text-sm font-medium">Days (for “particular days”)</legend>
              <div className="flex flex-wrap gap-3">
                {DAYS.map(([d, label]) => (
                  <Checkbox key={d} name="days" value={String(d)} label={label} />
                ))}
              </div>
            </fieldset>
            <Field label="Your state's public holidays" hint="Dates, one per line or comma-separated, e.g. 2026-10-05 (Labour Day in NSW). National days are built in.">
              <Input name="dates" placeholder="2026-10-05, 2027-06-14" />
            </Field>
            <div className="space-y-2">
              <Checkbox name="everyVenue" label="At every venue of the organisation" hint={`Off: ${c.venue.name} only.`} />
              <Checkbox name="isActive" label="Switched on" defaultChecked />
            </div>
            <SubmitButton pendingLabel="Saving…">Add surcharge</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
