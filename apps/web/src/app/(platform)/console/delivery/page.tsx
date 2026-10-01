import Link from 'next/link';
import { getPlug, listConnections } from '@ros/core';
import { delivery } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { ConfirmAction } from '@/components/console/confirm';
import { FeeRuleFields, type FeeRuleValue } from '@/components/console/fee-rule';
import { ModuleOff, ReadError } from '@/components/console/states';
import { ActionForm, Badge, Card, Checkbox, Dialog, EmptyState, Field, Input, PageHeader, Select, SubmitButton, Table, Td, Th, dateTime, money } from '@/ui';
import { deactivateZone, saveDeliverySettings, saveZone } from './actions';

export const metadata = { title: 'Delivery · Pipedline' };

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';
const STATUS: Record<string, { label: string; tone: Tone }> = {
  quoted: { label: 'Waiting for the kitchen', tone: 'neutral' },
  requested: { label: 'Finding a courier', tone: 'warn' },
  courier_assigned: { label: 'Courier on the way', tone: 'accent' },
  picked_up: { label: 'On its way', tone: 'accent' },
  delivered: { label: 'Delivered', tone: 'good' },
  failed: { label: 'Not delivered', tone: 'bad' },
  returned: { label: 'Returned', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const plugName = (key: string) => {
  try {
    return getPlug(key).name;
  } catch {
    return key;
  }
};

const isCourier = (key: string) => {
  try {
    return !!getPlug(key).adapters.courier;
  } catch {
    return false;
  }
};

/** A fee rule in a sentence, as a guest would be charged. */
function feeWords(rule: FeeRuleValue | null, currency: string): string {
  if (!rule) return 'Follows the venue’s rule';
  switch (rule.kind) {
    case 'pass_through':
      return 'The guest pays what the courier charges';
    case 'flat':
      return `${money(rule.cents, currency)} flat`;
    case 'subsidised':
      return `We pay the first ${money(rule.venue_pays_up_to_cents, currency)} of the courier’s fee`;
    case 'free_above':
      return `Free at ${money(rule.threshold_cents, currency)} or more; otherwise ${feeWords(rule.otherwise, currency).replace(/^./, (ch) => ch.toLowerCase())}`;
  }
}

const km = (m: number | null) => (m === null ? '–' : `${(m / 1000).toLocaleString('en-AU', { maximumFractionDigits: 1 })} km`);

function ZoneFields({ zone, currency }: { zone?: delivery.ZoneView; currency: string }) {
  return (
    <div className="space-y-4">
      {zone ? <input type="hidden" name="zoneId" value={zone.id} /> : null}
      <Field label="Name" hint="For your own reference, e.g. “Nearby” or “North of the river”.">
        <Input name="name" required maxLength={80} defaultValue={zone?.name ?? ''} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Reaches this far from the venue (km)">
          <Input name="radiusKm" inputMode="decimal" required defaultValue={zone?.radiusM ? String(zone.radiusM / 1000) : ''} />
        </Field>
        <Field label={`Smallest order (${currency === 'AUD' ? '$' : currency})`} hint="After discounts. Leave empty for none.">
          <Input name="minOrder" inputMode="decimal" defaultValue={zone?.minOrderCents ? (zone.minOrderCents / 100).toFixed(2) : ''} />
        </Field>
      </div>
      <FeeRuleFields value={zone?.feeRule ?? null} allowInherit prefix="zoneFee" />
    </div>
  );
}

/**
 * Delivery for orders placed on the venue's own site: whether it is offered, how far, what the
 * guest pays, which couriers are asked, and what happened to recent deliveries. Anyone at the
 * venue can read it; a manager changes it.
 */
export default async function DeliveryPage() {
  const c = await getConsole();
  const manager = atLeast(c.role, 'manager');
  const settings = await read((ctx) => delivery.getDeliverySettings(ctx, c.venue.id));
  if (!settings.ok) {
    return (
      <>
        <PageHeader title="Delivery" />
        <ReadError message={settings.error} />
      </>
    );
  }
  if (!settings.data.enabled) return <ModuleOff title="Delivery" what="Delivery" canManage={manager} />;

  const cfg = settings.data.config;
  const currency = c.org.currency;
  const tz = c.venue.timezone;
  const [zones, recent, connections] = await Promise.all([
    read((ctx) => delivery.listZones(ctx, c.venue.id, { includeInactive: true })),
    read((ctx) => delivery.listDeliveries(ctx, { venueId: c.venue.id, limit: 30 })),
    manager ? read((ctx) => listConnections(ctx, { venueId: c.venue.id })) : null,
  ]);
  // Courier services this venue can use: connected for the venue or for the whole organisation.
  const connected = connections?.ok ? connections.data.filter((r) => r.status !== 'revoked' && isCourier(r.plug_key)).map((r) => r.plug_key) : [];
  const courierOptions = [...new Set([...cfg.providers, ...connected])];
  const live = zones.ok ? zones.data.filter((z) => z.isActive) : [];
  const stopped = zones.ok ? zones.data.filter((z) => !z.isActive) : [];

  return (
    <>
      <PageHeader
        title="Delivery"
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <Badge tone={cfg.delivery_enabled ? 'good' : 'warn'}>{cfg.delivery_enabled ? 'Offered at checkout' : 'Paused'}</Badge>
            <span>
              Orders from {c.venue.name}’s own site, carried by a courier service. A courier is booked when the food is nearly ready, not when the order is placed.
            </span>
          </span>
        }
      />
      <div className="space-y-6">
        <Card
          title="Where you deliver"
          description={`A guest’s address must fall inside a zone, and never further than ${km(cfg.max_radius_m)} from the venue.`}
          padded={false}
          actions={
            manager ? (
              <Dialog trigger="Add a zone" title="Add a delivery zone">
                <ActionForm action={saveZone} resetOnSuccess>
                  <ZoneFields currency={currency} />
                  <div className="mt-4 flex justify-end">
                    <SubmitButton>Add zone</SubmitButton>
                  </div>
                </ActionForm>
              </Dialog>
            ) : undefined
          }
        >
          {!zones.ok ? (
            <div className="p-5">
              <ReadError message={zones.error} />
            </div>
          ) : live.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No delivery zones">Without a zone, no address can be delivered to. {manager ? 'Add one to start.' : 'A manager can add one.'}</EmptyState>
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Zone</Th>
                  <Th>Reaches</Th>
                  <Th align="right">Smallest order</Th>
                  <Th>Guest pays</Th>
                  {manager ? (
                    <Th>
                      <span className="sr-only">Change</span>
                    </Th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {live.map((z) => (
                  <tr key={z.id} data-testid={`zone-${z.name}`}>
                    <Td className="font-medium">{z.name}</Td>
                    <Td>{z.kind === 'radius' ? `${km(z.radiusM)} from the venue` : `A drawn area (${z.polygon?.length ?? 0} corners)`}</Td>
                    <Td numeric>{z.minOrderCents ? money(z.minOrderCents, currency) : 'None'}</Td>
                    <Td>{feeWords(z.feeRule, currency)}</Td>
                    {manager ? (
                      <Td align="right">
                        <div className="flex flex-wrap justify-end gap-2">
                          {z.kind === 'radius' ? (
                            <Dialog trigger={<>Edit<span className="sr-only"> {z.name}</span></>} title={`Edit zone “${z.name}”`} triggerSize="sm">
                              <ActionForm action={saveZone}>
                                <ZoneFields zone={z} currency={currency} />
                                <div className="mt-4 flex justify-end">
                                  <SubmitButton>Save zone</SubmitButton>
                                </div>
                              </ActionForm>
                            </Dialog>
                          ) : null}
                          <ConfirmAction trigger={<>Stop<span className="sr-only"> delivering to {z.name}</span></>} title={`Stop delivering to “${z.name}”?`} action={deactivateZone} hidden={{ zoneId: z.id }} confirmLabel="Stop delivering here" testId={`stop-zone-${z.name}`}>
                            Guests whose address is only inside this zone are no longer offered delivery. Deliveries already under way are not affected, and past ones stay on record.
                          </ConfirmAction>
                        </div>
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {stopped.length ? <p className="border-t border-line px-5 py-3 text-xs text-ink-2">No longer delivered to: {stopped.map((z) => z.name).join(', ')}.</p> : null}
        </Card>

        <Card title="Recent deliveries" description="Suburb and postcode only here; the full address is on the order for staff who deal with guests." padded={false}>
          {!recent.ok ? (
            <div className="p-5">
              <ReadError message={recent.error} />
            </div>
          ) : recent.data.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink-2">No deliveries yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>To</Th>
                  <Th>Courier</Th>
                  <Th align="right">Guest paid</Th>
                  <Th align="right">Courier charged</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {recent.data.map((d) => {
                  const s = STATUS[d.status] ?? { label: d.status, tone: 'neutral' as Tone };
                  return (
                    <tr key={d.id} data-testid={`delivery-${d.id}`}>
                      <Td className="whitespace-nowrap">
                        {d.orderId ? (
                          <Link href={`/console/orders/${d.orderId}`} className="font-medium text-accent underline-offset-2 hover:underline">
                            {dateTime(d.createdAt, tz)}
                          </Link>
                        ) : (
                          dateTime(d.createdAt, tz)
                        )}
                      </Td>
                      <Td>{d.dropoffArea || '–'}</Td>
                      <Td>
                        {plugName(d.provider)}
                        {d.attemptedProviders.length > 1 ? <span className="block text-xs text-ink-2">after trying {d.attemptedProviders.filter((p) => p !== d.provider).map(plugName).join(', ')}</span> : null}
                      </Td>
                      <Td numeric>{money(d.customerFeeCents, currency)}</Td>
                      <Td numeric>
                        {money(d.courierFeeCents, currency)}
                        {d.cancellationFeeCents ? <span className="block text-xs text-bad">+{money(d.cancellationFeeCents, currency)} cancellation</span> : null}
                      </Td>
                      <Td>
                        <Badge tone={s.tone}>{s.label}</Badge>
                        {d.failureReason ? <span className="mt-1 block max-w-56 text-xs text-ink-2">{d.failureReason}</span> : null}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>

        <Card title="Settings" description={manager ? `How delivery works at ${c.venue.name}.` : 'A manager changes these.'}>
          {manager ? (
            <ActionForm action={saveDeliverySettings}>
              <div className="grid gap-6 lg:grid-cols-2" data-testid="delivery-settings">
                <div className="space-y-4">
                  <Checkbox name="deliveryEnabled" defaultChecked={cfg.delivery_enabled} label="Offer delivery at checkout" hint="Untick to pause delivery without losing zones or history." />
                  <FeeRuleFields value={cfg.fee_rule} prefix="fee" />
                  <Field label="Smallest order ($)" hint="After discounts, where a zone sets none. Leave empty for none.">
                    <Input name="minOrder" inputMode="decimal" className="max-w-40" defaultValue={cfg.min_order_cents ? (cfg.min_order_cents / 100).toFixed(2) : ''} />
                  </Field>
                  <Field label="Furthest delivery (km)" hint="A food-safety limit: nothing goes further than this, whatever the zones say.">
                    <Input name="maxRadiusKm" inputMode="decimal" required className="max-w-40" defaultValue={String(cfg.max_radius_m / 1000)} />
                  </Field>
                  <Checkbox name="alcohol" defaultChecked={cfg.alcohol_enabled} label="Deliver alcohol" hint="Needs a courier that checks ID at the door. Off unless you are sure." />
                </div>
                <div className="space-y-4">
                  {[1, 2].map((n) => (
                    <Field key={n} label={n === 1 ? 'Courier asked first' : 'Courier asked next'} hint={n === 2 ? 'Asked when the first has no courier.' : courierOptions.length ? undefined : 'No courier service is connected. Connect one under Connected services.'}>
                      <Select name={`provider${n}`} defaultValue={cfg.providers[n - 1] ?? ''}>
                        <option value="">{n === 1 ? 'None' : 'No second courier'}</option>
                        {courierOptions.map((key) => (
                          <option key={key} value={key}>
                            {plugName(key)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ))}
                  <Checkbox name="failover" defaultChecked={cfg.failover_to_next_provider} label="Ask the next courier when the first has none" />
                  <Field label="Ask for a courier this many minutes before the food is ready">
                    <Input name="leadMinutes" type="number" min={0} max={180} required className="max-w-40" defaultValue={cfg.courier_request_lead_minutes} />
                  </Field>
                  <Field label="When no courier can be found">
                    <Select name="noCourier" defaultValue={cfg.no_courier_fallback}>
                      <option value="refund">Refund the order in full</option>
                      <option value="offer_pickup">Offer the guest pickup and refund the delivery fee</option>
                    </Select>
                  </Field>
                  <Field label="When a delivery fails after pickup, the guest gets back">
                    <Select name="failedRefund" defaultValue={cfg.failed_delivery_refund}>
                      <option value="full">Everything</option>
                      <option value="delivery_fee">The delivery fee</option>
                      <option value="none">Nothing</option>
                    </Select>
                  </Field>
                  <Field label="A courier’s cancellation fee">
                    <Select name="cancellationFee" defaultValue={cfg.cancellation_fee_policy}>
                      <option value="venue_absorbs">We pay it</option>
                      <option value="deduct_from_refund">Comes off the guest’s refund</option>
                    </Select>
                  </Field>
                  <Field label="Tracking link and updates go by">
                    <Select name="tracking" defaultValue={cfg.tracking_channel}>
                      <option value="auto">Email if the guest gave one, else SMS</option>
                      <option value="email">Email</option>
                      <option value="sms">SMS</option>
                      <option value="none">Do not send them</option>
                    </Select>
                  </Field>
                </div>
              </div>
              <div className="mt-6 flex justify-end">
                <SubmitButton>Save delivery settings</SubmitButton>
              </div>
            </ActionForm>
          ) : (
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              {(
                [
                  ['Guest pays', feeWords(cfg.fee_rule, currency)],
                  ['Smallest order', cfg.min_order_cents ? money(cfg.min_order_cents, currency) : 'None'],
                  ['Furthest delivery', km(cfg.max_radius_m)],
                  ['Couriers', cfg.providers.length ? cfg.providers.map(plugName).join(', then ') : 'None chosen'],
                  ['Alcohol', cfg.alcohol_enabled ? 'Delivered' : 'Not delivered'],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-ink-2">{k}</dt>
                  <dd className="text-ink">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
      </div>
    </>
  );
}
