import { describe, expect, it } from 'vitest';
import { listActivity, listEntityAudit } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { events } from '@ros/modules';

/**
 * The console's shared pieces (docs/CONSOLE_IA.md section 9, wave 1): saved views per venue,
 * staff notes with @mentions on a record, and the record's own history. Every write is read
 * back from the database; the negative cases are the venue next door, the org next door, and
 * a role that may look but not change.
 */
describe('events: saved console views', () => {
  const t = useTestEnv();

  it('a host saves, renames and deletes a view at their venue; the other venue and the other org never see it; read-only cannot save', async () => {
    const { diner, group } = t.fixture;
    const host = await diner.as('host');
    const saved = await t.app.tenant(diner.orgId, host, (ctx) => events.saveConsoleView(ctx, { venueId: diner.venueId, page: 'orders', name: 'Big pickups', filters: { channel: 'pickup', status: 'live' } }));
    const row = await t.db.selectFrom('console_views').selectAll().where('id', '=', saved.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ org_id: diner.orgId, venue_id: diner.venueId, page: 'orders', name: 'Big pickups', filters: { channel: 'pickup', status: 'live' }, created_by_id: diner.staff.host!.staffId });

    const listed = await t.app.tenant(diner.orgId, host, (ctx) => events.listConsoleViews(ctx, { venueId: diner.venueId, page: 'orders' }));
    expect(listed.map((v) => v.name)).toContain('Big pickups');
    expect(await t.app.tenant(diner.orgId, host, (ctx) => events.listConsoleViews(ctx, { venueId: diner.venueId, page: 'menu' }))).toEqual([]);

    // The same name twice at one venue and page is refused; the same name at another page is fine.
    await expect(t.app.tenant(diner.orgId, host, (ctx) => events.saveConsoleView(ctx, { venueId: diner.venueId, page: 'orders', name: 'big pickups', filters: {} }))).rejects.toMatchObject({ code: 'invalid' });
    await t.app.tenant(diner.orgId, host, (ctx) => events.saveConsoleView(ctx, { venueId: diner.venueId, page: 'menu', name: 'Big pickups', filters: { availability: 'off' } }));

    const renamed = await t.app.tenant(diner.orgId, host, (ctx) => events.renameConsoleView(ctx, { id: saved.id, name: 'Pickups in progress' }));
    expect(renamed.name).toBe('Pickups in progress');
    expect((await t.db.selectFrom('console_views').select('name').where('id', '=', saved.id).executeTakeFirstOrThrow()).name).toBe('Pickups in progress');
    const audited = await t.db.selectFrom('audit_log').select('action').where('entity_id', '=', saved.id).orderBy('occurred_at').execute();
    expect(audited.map((a) => a.action)).toEqual(['console.view_saved', 'console.view_renamed']);

    // The group's manager, at a venue of their own: nothing of the diner's, and the diner's id is not found.
    const groupManager = await group.as('manager');
    expect(await t.app.tenant(group.orgId, groupManager, (ctx) => events.listConsoleViews(ctx, { venueId: group.venues.cbd!.id, page: 'orders' }))).toEqual([]);
    await expect(t.app.tenant(group.orgId, groupManager, (ctx) => events.deleteConsoleView(ctx, saved.id))).rejects.toMatchObject({ code: 'not_found' });
    // A view at CBD is not a view at Newtown.
    const cbd = await t.app.tenant(group.orgId, groupManager, (ctx) => events.saveConsoleView(ctx, { venueId: group.venues.cbd!.id, page: 'bookings', name: 'Big tables', filters: { status: 'confirmed' } }));
    expect((await t.app.tenant(group.orgId, groupManager, (ctx) => events.listConsoleViews(ctx, { venueId: group.venues.newtown!.id, page: 'bookings' }))).map((v) => v.id)).not.toContain(cbd.id);
    // Read-only looks but cannot save.
    const accounts = await group.as('accounts');
    expect((await t.app.tenant(group.orgId, accounts, (ctx) => events.listConsoleViews(ctx, { venueId: group.venues.cbd!.id, page: 'bookings' }))).map((v) => v.id)).toContain(cbd.id);
    await expect(t.app.tenant(group.orgId, accounts, (ctx) => events.saveConsoleView(ctx, { venueId: group.venues.cbd!.id, page: 'bookings', name: 'Mine', filters: {} }))).rejects.toMatchObject({ code: 'forbidden' });

    await t.app.tenant(diner.orgId, host, (ctx) => events.deleteConsoleView(ctx, saved.id));
    expect(await t.db.selectFrom('console_views').select('id').where('id', '=', saved.id).executeTakeFirst()).toBeUndefined();
  });
});

describe('events: staff notes and a record\'s history', () => {
  const t = useTestEnv();

  it('a note with an @mention is kept against the venue, names the person mentioned, and is not seen from another venue; the author or a manager removes it', async () => {
    const { diner, group } = t.fixture;
    const host = await diner.as('host');
    const manager = await diner.as('manager');
    const guest = await t.db.selectFrom('customers').select('id').where('org_id', '=', diner.orgId).where('status', '=', 'active').executeTakeFirstOrThrow();

    const people = await t.app.tenant(diner.orgId, host, (ctx) => events.listMentionableStaff(ctx, { venueId: diner.venueId }));
    expect(people.map((p) => p.name)).toEqual(expect.arrayContaining(['Morgan Manager', 'Harper Host']));

    const note = await t.app.tenant(diner.orgId, host, (ctx) => events.addStaffNote(ctx, { venueId: diner.venueId, entityType: 'customer', entityId: guest.id, body: 'Prefers the window table. @Morgan can you check the birthday? <b>not markup</b>' }));
    expect(note.mentions).toEqual([diner.staff.manager!.staffId]);
    expect(note.authorName).toBe('Harper Host');
    const row = await t.db.selectFrom('staff_notes').selectAll().where('id', '=', note.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ org_id: diner.orgId, venue_id: diner.venueId, entity_type: 'customer', entity_id: guest.id, author_kind: 'staff', author_id: diner.staff.host!.staffId, deleted_at: null });
    expect(row.mentions).toEqual([diner.staff.manager!.staffId]);

    const listed = await t.app.tenant(diner.orgId, manager, (ctx) => events.listStaffNotes(ctx, { venueId: diner.venueId, entityType: 'customer', entityId: guest.id }));
    expect(listed.map((n) => n.id)).toContain(note.id);

    // Another venue, even in an org that could see the same guest, has no such note; another org's id is not found.
    const groupManager = await group.as('manager');
    expect(await t.app.tenant(group.orgId, groupManager, (ctx) => events.listStaffNotes(ctx, { venueId: group.venues.cbd!.id, entityType: 'customer', entityId: guest.id }))).toEqual([]);
    await expect(t.app.tenant(group.orgId, groupManager, (ctx) => events.deleteStaffNote(ctx, note.id))).rejects.toMatchObject({ code: 'not_found' });
    // Read-only may not write.
    const accounts = await group.as('accounts');
    await expect(t.app.tenant(group.orgId, accounts, (ctx) => events.addStaffNote(ctx, { venueId: group.venues.cbd!.id, entityType: 'customer', entityId: guest.id, body: 'x' }))).rejects.toMatchObject({ code: 'forbidden' });
    // The kitchen did not write it and is not a manager: cannot remove it. The manager can.
    const kitchen = await diner.as('kitchen');
    await expect(t.app.tenant(diner.orgId, kitchen, (ctx) => events.deleteStaffNote(ctx, note.id))).rejects.toMatchObject({ code: 'forbidden' });
    await t.app.tenant(diner.orgId, manager, (ctx) => events.deleteStaffNote(ctx, note.id));
    expect((await t.db.selectFrom('staff_notes').select('deleted_at').where('id', '=', note.id).executeTakeFirstOrThrow()).deleted_at).not.toBeNull();
    expect(await t.app.tenant(diner.orgId, host, (ctx) => events.listStaffNotes(ctx, { venueId: diner.venueId, entityType: 'customer', entityId: guest.id }))).toEqual([]);
    const audited = await t.db.selectFrom('audit_log').select(['action', 'actor_id']).where('entity_id', '=', guest.id).where('action', '=', 'note.removed').executeTakeFirstOrThrow();
    expect(audited.actor_id).toBe(diner.staff.manager!.staffId);
  });

  it('a record\'s audit entries are read by any staff role at its venue; the activity log by managers for their venues and owners for everything', async () => {
    const { diner, group } = t.fixture;
    const manager = await diner.as('manager');
    const kitchen = await diner.as('kitchen');
    const order = await t.db.selectFrom('orders').select('id').where('org_id', '=', diner.orgId).where('status', 'not in', ['draft', 'pending_payment']).executeTakeFirstOrThrow();
    t.clock.advanceMinutes(1);
    const saved = await t.app.tenant(diner.orgId, manager, (ctx) => events.saveConsoleView(ctx, { venueId: diner.venueId, page: 'orders', name: `History ${Date.now()}`, filters: {} }));

    // The kitchen may read an order's own history at its venue, but not the venue's whole log.
    const own = await t.app.tenant(diner.orgId, kitchen, (ctx) => listEntityAudit(ctx, { entityType: 'order', entityId: order.id, venueId: diner.venueId }));
    expect(Array.isArray(own)).toBe(true);
    await expect(t.app.tenant(diner.orgId, kitchen, (ctx) => listActivity(ctx, { venueId: diner.venueId }))).rejects.toMatchObject({ code: 'forbidden' });

    const log = await t.app.tenant(diner.orgId, manager, (ctx) => listActivity(ctx, { venueId: diner.venueId, actorKinds: ['staff'], limit: 50 }));
    expect(log[0]).toMatchObject({ action: 'console.view_saved', entityId: saved.id, actorKind: 'staff', actorName: 'Morgan Manager', venueId: diner.venueId });
    expect(log.every((e) => e.actorKind === 'staff')).toBe(true);
    // Narrowed to another kind of actor, the person's change is not there.
    expect((await t.app.tenant(diner.orgId, manager, (ctx) => listActivity(ctx, { venueId: diner.venueId, actorKinds: ['agent'], limit: 50 }))).some((e) => e.entityId === saved.id)).toBe(false);

    // The group's manager sees nothing of the diner's, and only what is at venues they manage or org-wide.
    const groupManager = await group.as('manager');
    const theirs = await t.app.tenant(group.orgId, groupManager, (ctx) => listActivity(ctx, { limit: 200 }));
    expect(theirs.some((e) => e.action === 'console.view_saved' && e.venueId === diner.venueId)).toBe(false);
    expect(theirs.every((e) => e.venueId === null || e.venueId === group.venues.cbd!.id || e.venueId === group.venues.newtown!.id)).toBe(true);
  });
});
