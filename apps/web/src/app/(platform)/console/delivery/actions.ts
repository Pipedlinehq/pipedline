'use server';

import { delivery } from '@ros/modules';
import { act, bool, cents, int, text } from '@/lib/console-actions';
import type { FormState } from '@/ui/client';

/**
 * Delivery settings and zones. The venue is always the one selected in the console; the service
 * checks that the person manages it. Amounts are typed in dollars and stored in cents.
 */
const PATH = '/console/delivery';
const ok = (r: FormState & { data?: unknown }): FormState => (r && r.ok ? { ok: true, message: r.message } : r);

type Base = { kind: 'pass_through' } | { kind: 'flat'; cents: number } | { kind: 'subsidised'; venue_pays_up_to_cents: number };
type Rule = Base | { kind: 'free_above'; threshold_cents: number; otherwise: Base };

/** The fee rule a FeeRuleFields control describes. `null` = follow the venue (zones only). A string is what is wrong, in words. */
function feeRuleFrom(fd: FormData, prefix: string): Rule | null | string {
  const kind = text(fd, `${prefix}Kind`);
  if (kind === 'inherit') return null;
  const amount = (name: string, label: string): number | string => {
    const v = cents(fd, name);
    return v === undefined || Number.isNaN(v) || v < 0 ? `${label}: enter an amount in dollars, like 6.50.` : v;
  };
  let base: Base;
  if (kind === 'flat') {
    const v = amount(`${prefix}Flat`, 'Flat fee');
    if (typeof v === 'string') return v;
    base = { kind: 'flat', cents: v };
  } else if (kind === 'subsidised') {
    const v = amount(`${prefix}Subsidy`, 'We pay up to');
    if (typeof v === 'string') return v;
    base = { kind: 'subsidised', venue_pays_up_to_cents: v };
  } else if (kind === 'pass_through') {
    base = { kind: 'pass_through' };
  } else {
    return 'Choose what the guest pays for delivery.';
  }
  if (!bool(fd, `${prefix}FreeAbove`)) return base;
  const threshold = amount(`${prefix}Threshold`, 'Free at or above');
  if (typeof threshold === 'string') return threshold;
  return { kind: 'free_above', threshold_cents: threshold, otherwise: base };
}

const ONE_OF = <T extends string>(v: string, options: readonly T[]): T | undefined => (options as readonly string[]).includes(v) ? (v as T) : undefined;

export async function saveDeliverySettings(_: FormState, fd: FormData): Promise<FormState> {
  const rule = feeRuleFrom(fd, 'fee');
  if (typeof rule === 'string') return { ok: false, error: rule };
  if (rule === null) return { ok: false, error: 'Choose what the guest pays for delivery.' };
  const minOrder = cents(fd, 'minOrder') ?? 0;
  const lead = int(fd, 'leadMinutes');
  const radiusKm = Number(text(fd, 'maxRadiusKm'));
  if (Number.isNaN(minOrder) || minOrder < 0) return { ok: false, error: 'Smallest order: enter an amount in dollars, or leave it empty for none.' };
  if (lead === undefined || Number.isNaN(lead)) return { ok: false, error: 'Say how many minutes before the food is ready a courier is asked for.' };
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) return { ok: false, error: 'Furthest delivery: enter a distance in kilometres.' };
  // Couriers in the order chosen, preferred first. The service refuses a name that is not a courier.
  const providers = [...new Set([1, 2, 3, 4, 5].map((n) => text(fd, `provider${n}`)).filter(Boolean))];
  const config = {
    delivery_enabled: bool(fd, 'deliveryEnabled'),
    providers,
    fee_rule: rule,
    min_order_cents: minOrder,
    courier_request_lead_minutes: lead,
    failover_to_next_provider: bool(fd, 'failover'),
    no_courier_fallback: ONE_OF(text(fd, 'noCourier'), ['refund', 'offer_pickup'] as const),
    failed_delivery_refund: ONE_OF(text(fd, 'failedRefund'), ['full', 'delivery_fee', 'none'] as const),
    cancellation_fee_policy: ONE_OF(text(fd, 'cancellationFee'), ['venue_absorbs', 'deduct_from_refund'] as const),
    alcohol_enabled: bool(fd, 'alcohol'),
    max_radius_m: Math.round(radiusKm * 1000),
    tracking_channel: ONE_OF(text(fd, 'tracking'), ['auto', 'email', 'sms', 'none'] as const),
  };
  return ok(
    await act((ctx, c) => delivery.updateDeliverySettings(ctx, { venueId: c.venue.id, config }), {
      success: (s) => (s.config.delivery_enabled ? 'Delivery settings saved.' : 'Delivery settings saved. Delivery is paused: guests are not offered it at checkout.'),
      revalidate: PATH,
    }),
  );
}

export async function saveZone(_: FormState, fd: FormData): Promise<FormState> {
  const rule = feeRuleFrom(fd, 'zoneFee');
  if (typeof rule === 'string') return { ok: false, error: rule };
  const km = Number(text(fd, 'radiusKm'));
  if (!Number.isFinite(km) || km <= 0) return { ok: false, error: 'Distance: enter how far from the venue this zone reaches, in kilometres.' };
  const minOrder = cents(fd, 'minOrder') ?? 0;
  if (Number.isNaN(minOrder) || minOrder < 0) return { ok: false, error: 'Smallest order: enter an amount in dollars, or leave it empty for none.' };
  const zoneId = text(fd, 'zoneId') || undefined;
  return ok(
    await act(
      (ctx, c) =>
        delivery.saveZone(ctx, {
          venueId: c.venue.id,
          zoneId,
          name: text(fd, 'name'),
          kind: 'radius',
          radiusM: Math.round(km * 1000),
          minOrderCents: minOrder,
          feeRule: rule,
          isActive: true,
        }),
      { success: (z) => (zoneId ? `Zone “${z.name}” saved.` : `Zone “${z.name}” added. Guests inside it are offered delivery.`), revalidate: PATH },
    ),
  );
}

export async function deactivateZone(_: FormState, fd: FormData): Promise<FormState> {
  return ok(await act((ctx) => delivery.deactivateZone(ctx, text(fd, 'zoneId')), { success: (z) => `Delivery to “${z.name}” has stopped. Past deliveries there stay on record.`, revalidate: PATH }));
}
