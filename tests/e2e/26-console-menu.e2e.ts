import { afterAll, describe, expect, it } from 'vitest';
import { BASE, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff } from './helpers';

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

/** An item that is on right now at the diner, to 86 and bring back. */
async function availableItem(venueId: string) {
  return db()
    .selectFrom('menu_items')
    .select(['id', 'name'])
    .where('venue_id', '=', venueId)
    .where('deleted_at', 'is', null)
    .where('is_available', '=', true)
    .orderBy('name')
    .executeTakeFirstOrThrow();
}

describe('console: menu and QR codes', () => {
  it('kitchen staff 86 an item until someone puts it back, see it marked off, and bring it back', async () => {
    const { venueId } = await orgBySlug('oak-diner');
    const item = await availableItem(venueId);
    const v = await newVisitor();
    await signInStaff(v.page, 'kitchen@oak-diner.test');
    await v.page.goto(`${BASE()}/console/menu?q=${encodeURIComponent(item.name)}`);
    const row = v.page.locator(`[data-testid=item-row-${item.id}]`);
    await row.getByText('Available').waitFor();

    await row.locator('select[name=until]').selectOption('');
    await row.getByRole('button', { name: '86 it' }).click();
    await row.getByText("86'd").waitFor();
    await row.getByText('until put back').waitFor();

    const off = await eventually(
      () => db().selectFrom('menu_items').select(['is_available', 'unavailable_until']).where('id', '=', item.id).where('is_available', '=', false).executeTakeFirst(),
      'the item marked unavailable',
    );
    expect(off.unavailable_until).toBeNull();
    const audit86 = await db().selectFrom('audit_log').select(['actor_kind', 'venue_id']).where('action', '=', 'menu.item_86').where('entity_id', '=', item.id).orderBy('occurred_at', 'desc').executeTakeFirstOrThrow();
    expect(audit86).toMatchObject({ actor_kind: 'staff', venue_id: venueId });
    // The event every guest surface listens to.
    const event = await db().selectFrom('events').select(['properties']).where('name', '=', 'item.availability_changed').where('venue_id', '=', venueId).orderBy('occurred_at', 'desc').executeTakeFirstOrThrow();
    expect(event.properties as { menu_item_id: string; available: boolean }).toMatchObject({ menu_item_id: item.id, available: false });

    // The "only what is off" filter shows it.
    await v.page.goto(`${BASE()}/console/menu?show=86`);
    await v.page.locator(`[data-testid=item-row-${item.id}]`).waitFor();

    await v.page.locator(`[data-testid=item-row-${item.id}]`).getByRole('button', { name: 'Bring back' }).click();
    await eventually(() => db().selectFrom('menu_items').select('id').where('id', '=', item.id).where('is_available', '=', true).executeTakeFirst(), 'the item available again');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('"until end of service" sets a time the item comes back by itself', async () => {
    const { venueId } = await orgBySlug('oak-diner');
    const item = await availableItem(venueId);
    const v = await newVisitor();
    await signInStaff(v.page, 'host@oak-diner.test');
    await v.page.goto(`${BASE()}/console/menu?q=${encodeURIComponent(item.name)}`);
    const row = v.page.locator(`[data-testid=item-row-${item.id}]`);
    await row.locator('select[name=until]').selectOption('end_of_service');
    await row.getByRole('button', { name: '86 it' }).click();
    await row.getByText(/^back /).waitFor();
    const off = await db().selectFrom('menu_items').select(['is_available', 'unavailable_until']).where('id', '=', item.id).executeTakeFirstOrThrow();
    expect(off.is_available).toBe(false);
    expect(off.unavailable_until).not.toBeNull();
    await row.getByRole('button', { name: 'Bring back' }).click();
    await eventually(() => db().selectFrom('menu_items').select('id').where('id', '=', item.id).where('is_available', '=', true).executeTakeFirst(), 'the item back on');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('read-only staff see the menu with no way to change it', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'accounts@oak-group.test');
    await v.page.goto(`${BASE()}/console/menu`);
    await v.page.getByRole('heading', { name: 'Menu', exact: true }).waitFor();
    expect(await v.page.getByRole('button', { name: '86 it' }).count()).toBe(0);
    expect(await v.page.getByRole('button', { name: 'New menu' }).count()).toBe(0);
    expect(await v.page.getByRole('button', { name: 'Add item' }).count()).toBe(0);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a manager adds an item to a section, edits its price, and removes it after confirming', async () => {
    const { venueId } = await orgBySlug('oak-diner');
    const name = `E2E special ${Date.now().toString(36)}`;
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/menu`);
    await v.page.getByRole('button', { name: 'Add item' }).first().click();
    const dialog = v.page.locator('dialog[open]');
    await dialog.locator('input[name=name]').fill(name);
    await dialog.locator('input[name=price]').fill('19.50');
    await dialog.locator('input[name=allergens]').fill('gluten, egg');
    await dialog.getByRole('button', { name: 'Add item' }).click();
    await dialog.getByText(`${name} added.`).waitFor();

    const row = await db().selectFrom('menu_items').select(['id', 'price_cents', 'allergens', 'venue_id']).where('name', '=', name).where('deleted_at', 'is', null).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ price_cents: 1950, allergens: ['gluten', 'egg'], venue_id: venueId });

    await v.page.goto(`${BASE()}/console/menu/items/${row.id}`);
    await v.page.locator('input[name=price]').fill('21');
    await v.page.getByRole('button', { name: 'Save item' }).click();
    await v.page.getByText('Item saved.').waitFor();
    expect((await db().selectFrom('menu_items').select('price_cents').where('id', '=', row.id).executeTakeFirstOrThrow()).price_cents).toBe(2100);
    const priceAudit = await db().selectFrom('audit_log').select(['before', 'after']).where('action', '=', 'menu.item_updated').where('entity_id', '=', row.id).executeTakeFirstOrThrow();
    expect(JSON.stringify(priceAudit.after)).toContain('2100');

    await v.page.getByRole('button', { name: 'Remove item' }).click();
    await v.page.locator('dialog[open]').getByText('Past orders, receipts and sales keep their record of it').waitFor();
    await v.page.locator('dialog[open]').getByRole('button', { name: 'Remove item' }).click();
    await v.page.waitForURL(/\/console\/menu$/);
    await eventually(() => db().selectFrom('menu_items').select('id').where('id', '=', row.id).where('deleted_at', 'is not', null).executeTakeFirst(), 'the item soft-deleted');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a manager makes table codes: each shows its address and an inline QR image, and can be switched off', async () => {
    const { venueId } = await orgBySlug('oak-diner');
    // Letters only, so "<tag>1-<tag>2" reads as a range of two tables.
    const tag = `E${Date.now().toString(36).slice(-5).replace(/\d/g, (d) => 'abcdefghij'[Number(d)]!)}`;
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/qr`);
    await v.page.getByRole('button', { name: 'Table codes' }).click();
    const dialog = v.page.locator('dialog[open]');
    await dialog.locator('input[name=labels]').fill(`${tag}1-${tag}2`);
    await dialog.locator('input[name=printBatch]').fill(`batch-${tag}`);
    await dialog.getByRole('button', { name: 'Make codes' }).click();
    await dialog.getByText('2 table codes ready.', { exact: false }).waitFor();

    const codes = await db().selectFrom('qr_codes').select(['id', 'code', 'label', 'kind', 'is_active']).where('venue_id', '=', venueId).where('print_batch', '=', `batch-${tag}`).orderBy('label').execute();
    expect(codes.map((c) => c.label)).toEqual([`${tag}1`, `${tag}2`]);
    expect(codes.every((c) => c.kind === 'table' && c.is_active)).toBe(true);

    await v.page.reload();
    const card = v.page.locator(`[data-testid=qr-card-${codes[0]!.id}]`);
    await expect(card.locator('[data-testid=qr-url]').textContent()).resolves.toContain(`/q/${codes[0]!.code}`);
    const svg = card.locator('svg[data-testid=qr-svg] path');
    expect(((await svg.getAttribute('d')) ?? '').length).toBeGreaterThan(200);
    expect(await v.page.locator('img[src*="/q/"]').count()).toBe(0);

    await card.getByRole('button', { name: 'Switch off' }).click();
    await v.page.locator('dialog[open]').getByRole('button', { name: 'Switch off' }).click();
    await eventually(() => db().selectFrom('qr_codes').select('id').where('id', '=', codes[0]!.id).where('is_active', '=', false).executeTakeFirst(), 'the code switched off');

    // The print sheet has the remaining code of the batch, and not the switched-off one.
    await v.page.goto(`${BASE()}/console/qr/print?batch=batch-${tag}`);
    await v.page.getByText(`Table ${tag}2`, { exact: true }).waitFor();
    expect(await v.page.getByText(`Table ${tag}1`, { exact: true }).count()).toBe(0);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
