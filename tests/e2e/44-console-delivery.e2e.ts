import { mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { delivery } from '@ros/modules';
import { BASE, chooseVenue, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff } from './helpers';
import { SHOTS } from './ops-helpers';
import { asStaff, closeStaff } from './site-helpers';

/**
 * Delivery in the console, at the group's CBD venue (the fixture venue with a delivery history):
 * zones added, changed and stopped; the venue's delivery settings; recent deliveries without
 * guests' street addresses; and what a read-only role and a venue without delivery see.
 */

beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

afterAll(async () => {
  await closeBrowser();
  await closeStaff();
  await closeDb();
});

const run = Date.now().toString(36);
const CBD = 'Oak Group CBD';

async function cbd() {
  const group = await orgBySlug('oak-group');
  const venue = group.venues.find((x) => x.slug === 'cbd')!;
  return { orgId: group.orgId, venueId: venue.id, name: venue.name, bondi: group.venues.find((x) => x.slug === 'bondi')! };
}

const zoneRow = (venueId: string, name: string) => db().selectFrom('delivery_zones').select(['id', 'kind', 'radius_m', 'min_order_cents', 'fee_rule', 'is_active']).where('venue_id', '=', venueId).where('name', '=', name).executeTakeFirst();
const configOf = async (venueId: string) => (await db().selectFrom('venue_modules').select(['config', 'enabled']).where('venue_id', '=', venueId).where('module_key', '=', 'delivery').executeTakeFirstOrThrow()).config as Record<string, unknown>;

describe('console: delivery', () => {
  it('a manager adds a zone with its own fee, changes it to follow the venue, and stops delivering to it', async () => {
    const venue = await cbd();
    expect(venue.name).toBe(CBD);
    const name = `E2E riverside ${run}`;
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-group.test');
    await v.page.goto(`${BASE()}/console/delivery`);
    await chooseVenue(v.page, CBD);
    await v.page.getByRole('heading', { name: 'Where you deliver' }).waitFor();
    // The seeded zones are listed with what a guest pays, in words.
    await v.page.getByTestId('zone-Nearby').getByText('3 km from the venue').waitFor();
    await v.page.screenshot({ path: `${SHOTS}/console-delivery.png`, fullPage: true });
    expect(await v.page.getByTestId('zone-Wider area').innerText()).toContain('$12.00 flat');

    try {
      await v.page.getByRole('button', { name: 'Add a zone' }).click();
      const add = v.page.getByRole('dialog', { name: 'Add a delivery zone' });
      await add.locator('input[name=name]').fill(name);
      await add.locator('input[name=radiusKm]').fill('4.5');
      await add.locator('input[name=minOrder]').fill('25');
      await add.locator('select[name=zoneFeeKind]').selectOption('flat');
      await add.locator('input[name=zoneFeeFlat]').fill('7.50');
      await add.getByRole('button', { name: 'Add zone' }).click();
      await add.getByText(`Zone “${name}” added.`).waitFor();
      await add.getByRole('button', { name: 'Close' }).click();

      const created = await eventually(() => zoneRow(venue.venueId, name), 'the zone row');
      expect(created).toMatchObject({ kind: 'radius', radius_m: 4500, min_order_cents: 2500, is_active: true });
      expect(created.fee_rule).toEqual({ kind: 'flat', cents: 750 });
      expect(await db().selectFrom('audit_log').select('actor_kind').where('action', '=', 'delivery.zone_created').where('entity_id', '=', created.id).executeTakeFirstOrThrow()).toEqual({ actor_kind: 'staff' });
      const row = v.page.getByTestId(`zone-${name}`);
      await row.getByText('4.5 km from the venue').waitFor();
      expect(await row.innerText()).toContain('$25.00');
      expect(await row.innerText()).toContain('$7.50 flat');

      // A distance that is not a number is refused in words, and nothing is saved.
      await row.getByRole('button', { name: /^Edit/ }).click();
      const edit = v.page.getByRole('dialog', { name: `Edit zone “${name}”` });
      await edit.locator('input[name=radiusKm]').fill('far');
      await edit.getByRole('button', { name: 'Save zone' }).click();
      await edit.getByText('Distance: enter how far from the venue this zone reaches, in kilometres.').waitFor();
      expect((await zoneRow(venue.venueId, name))!.radius_m).toBe(4500);
      await edit.locator('input[name=radiusKm]').fill('5');
      await edit.locator('select[name=zoneFeeKind]').selectOption('inherit');
      await edit.getByRole('button', { name: 'Save zone' }).click();
      await edit.getByText(`Zone “${name}” saved.`).waitFor();
      await edit.getByRole('button', { name: 'Close' }).click();
      const changed = (await zoneRow(venue.venueId, name))!;
      expect(changed.radius_m).toBe(5000);
      expect(changed.fee_rule).toMatchObject({ inherit: true });
      await row.getByText('Follows the venue’s rule').waitFor();

      await v.page.getByTestId(`stop-zone-${name}`).click();
      const stop = v.page.getByRole('dialog', { name: `Stop delivering to “${name}”?` });
      await stop.getByText('past ones stay on record').waitFor();
      await stop.getByRole('button', { name: 'Stop delivering here' }).click();
      // The zone's row goes, and its dialog with it: the outcome is still said.
      await v.page.getByTestId('console-flash').getByText(`Delivery to “${name}” has stopped.`).waitFor();
      await row.waitFor({ state: 'detached' });
      expect((await zoneRow(venue.venueId, name))!.is_active).toBe(false);
      await v.page.getByText(new RegExp(`No longer delivered to: .*${name}`)).waitFor();
      expect(await db().selectFrom('audit_log').select('actor_kind').where('action', '=', 'delivery.zone_deactivated').where('entity_id', '=', created.id).executeTakeFirstOrThrow()).toEqual({ actor_kind: 'staff' });
    } finally {
      const left = await zoneRow(venue.venueId, name);
      if (left?.is_active) await asStaff('group', 'manager', (ctx) => delivery.deactivateZone(ctx, left.id));
    }
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a manager changes what guests pay and pauses delivery; the stored settings follow, validated whole', async () => {
    const venue = await cbd();
    const before = await configOf(venue.venueId);
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-group.test');
    await v.page.goto(`${BASE()}/console/delivery`);
    await chooseVenue(v.page, CBD);
    const form = v.page.locator('form', { has: v.page.getByTestId('delivery-settings') });
    await form.waitFor();
    // The form opens on what is stored.
    expect(await form.locator('select[name=feeKind]').inputValue()).toBe((before.fee_rule as { kind: string }).kind);
    expect(await form.locator('input[name=deliveryEnabled]').isChecked()).toBe(true);

    try {
      await form.locator('select[name=feeKind]').selectOption('flat');
      await form.locator('input[name=feeFlat]').fill('6');
      await form.locator('input[name=feeFreeAbove]').check();
      await form.locator('input[name=feeThreshold]').fill('60');
      await form.locator('input[name=minOrder]').fill('22.00');
      await form.locator('input[name=leadMinutes]').fill('15');
      await form.locator('select[name=noCourier]').selectOption('offer_pickup');
      await form.locator('input[name=deliveryEnabled]').uncheck();
      await form.getByRole('button', { name: 'Save delivery settings' }).click();
      await form.getByText('Delivery settings saved. Delivery is paused').waitFor();

      const saved = await configOf(venue.venueId);
      expect(saved).toMatchObject({
        delivery_enabled: false,
        fee_rule: { kind: 'free_above', threshold_cents: 6000, otherwise: { kind: 'flat', cents: 600 } },
        min_order_cents: 2200,
        courier_request_lead_minutes: 15,
        no_courier_fallback: 'offer_pickup',
        // What the form did not change is kept as it was.
        providers: before.providers,
        max_radius_m: before.max_radius_m,
        alcohol_enabled: before.alcohol_enabled,
      });
      const audit = await db().selectFrom('audit_log').select(['actor_kind', 'after']).where('action', '=', 'module.set').where('entity_id', '=', `${venue.venueId}:delivery`).orderBy('occurred_at', 'desc').executeTakeFirstOrThrow();
      expect(audit.actor_kind).toBe('staff');
      await v.page.reload();
      await v.page.getByText('Paused', { exact: true }).waitFor();

      // A limit the service enforces: nothing is delivered further than 50 km.
      const again = v.page.locator('form', { has: v.page.getByTestId('delivery-settings') });
      await again.locator('input[name=maxRadiusKm]').fill('80');
      await again.getByRole('button', { name: 'Save delivery settings' }).click();
      await again.locator('[role=alert]').waitFor();
      expect((await configOf(venue.venueId)).max_radius_m).toBe(before.max_radius_m);
    } finally {
      await asStaff('group', 'manager', (ctx) => delivery.updateDeliverySettings(ctx, { venueId: venue.venueId, config: before }));
    }
    expect(await configOf(venue.venueId)).toMatchObject({ delivery_enabled: true, fee_rule: before.fee_rule });
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('recent deliveries show suburb and status but no street address; read-only staff get no controls; a venue without delivery says so', async () => {
    const venue = await cbd();
    const rows = await db().selectFrom('deliveries').select(['id', 'status', 'dropoff_address']).where('venue_id', '=', venue.venueId).where('order_id', 'is not', null).orderBy('created_at', 'desc').limit(30).execute();
    expect(rows.length).toBeGreaterThan(3);
    const v = await newVisitor();
    await signInStaff(v.page, 'accounts@oak-group.test');
    await v.page.goto(`${BASE()}/console/delivery`);
    await chooseVenue(v.page, CBD);
    await v.page.getByRole('heading', { name: 'Recent deliveries' }).waitFor();
    for (const r of rows) await v.page.getByTestId(`delivery-${r.id}`).waitFor();
    const text = await v.page.locator('main').innerText();
    for (const r of rows) {
      const a = r.dropoff_address as { line1?: string; suburb?: string };
      if (a.line1) expect(text).not.toContain(a.line1);
      if (a.suburb) expect(text).toContain(a.suburb);
    }
    // One fixture delivery failed at the door, and the list says so in words.
    expect(rows.some((r) => r.status === 'failed')).toBe(true);
    await v.page.getByText('Not delivered').first().waitFor();
    // Read-only: the settings as words, no forms, nothing to press.
    expect(await v.page.locator('main form').count()).toBe(0);
    expect(await v.page.getByRole('button', { name: /Add a zone|Edit|Stop|Save/ }).count()).toBe(0);
    await v.page.getByText('A manager changes these.').waitFor();

    // Bondi has no delivery: its screen says so, and the navigation does not offer it.
    await chooseVenue(v.page, venue.bondi.name);
    await v.page.goto(`${BASE()}/console/delivery`);
    await v.page.screenshot({ path: `${SHOTS}/console-delivery-bondi.png`, fullPage: true });
    await v.page.getByText('Delivery is switched off at this venue').waitFor();
    expect(await v.page.locator('nav[aria-label=Console] a[href="/console/delivery"]').count()).toBe(0);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
