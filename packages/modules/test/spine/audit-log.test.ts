import { describe, expect, it } from 'vitest';
import { audit, listAuditLog } from '@ros/core';
import { useTestEnv } from '@ros/testkit';

describe('core: the audit log, read back for the owner (listAuditLog)', () => {
  const t = useTestEnv();

  it('an owner reads the org\'s entries newest first with the person\'s name; filters and paging work; others are refused; another org is invisible', async () => {
    const { diner, group } = t.fixture;
    const owner = await diner.as('owner');
    const manager = await diner.as('manager');
    await t.app.tenant(diner.orgId, manager, (ctx) => audit(ctx, { action: 'test.first', entityType: 'test_thing', entityId: 'a', venueId: diner.venueId, after: { n: 1 } }));
    t.clock.advanceMinutes(1);
    await t.app.tenant(diner.orgId, manager, (ctx) => audit(ctx, { action: 'test.second', entityType: 'test_thing', entityId: 'b', after: { n: 2 } }));

    const page = await t.app.tenant(diner.orgId, owner, (ctx) => listAuditLog(ctx, { entityType: 'test_thing' }));
    expect(page.map((e) => e.action)).toEqual(['test.second', 'test.first']);
    expect(page[1]).toMatchObject({ actorKind: 'staff', actorId: diner.staff.manager!.staffId, actorName: 'Morgan Manager', entityId: 'a', venueId: diner.venueId, after: { n: 1 } });

    const byAction = await t.app.tenant(diner.orgId, owner, (ctx) => listAuditLog(ctx, { action: 'test.first' }));
    expect(byAction.map((e) => e.entityId)).toEqual(['a']);
    const older = await t.app.tenant(diner.orgId, owner, (ctx) => listAuditLog(ctx, { entityType: 'test_thing', before: page[0]!.occurredAt }));
    expect(older.map((e) => e.action)).toEqual(['test.first']);

    await expect(t.app.tenant(diner.orgId, manager, (ctx) => listAuditLog(ctx))).rejects.toMatchObject({ code: 'forbidden' });
    const groupOwner = await group.as('owner');
    const theirs = await t.app.tenant(group.orgId, groupOwner, (ctx) => listAuditLog(ctx, { entityType: 'test_thing' }));
    expect(theirs).toEqual([]);
  });
});
