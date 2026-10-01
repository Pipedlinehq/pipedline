import { afterAll, describe, expect, it } from 'vitest';
import { approvals, campaigns } from '@ros/modules';
import { BASE, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff } from './helpers';
import { asStaff, closeStaff } from './site-helpers';

/**
 * Lifecycle flows in the console: who may set a flow to what, what "run now" does at each mode,
 * and a batch that waits in Approvals being turned down. Uses the group fixture, whose flows are
 * seeded in shadow with guests already due a message.
 */

afterAll(async () => {
  await closeBrowser();
  await closeStaff();
  await closeDb();
});

const flowRow = async (orgId: string, key: string) => db().selectFrom('flows').select(['id', 'key', 'mode']).where('org_id', '=', orgId).where('key', '=', key).executeTakeFirstOrThrow();
const pendingBatches = async (orgId: string, since: Date) =>
  db().selectFrom('approvals').select(['id', 'summary', 'venue_id', 'payload', 'status']).where('org_id', '=', orgId).where('kind', '=', 'campaigns.flow_batch').where('status', '=', 'pending').where('created_at', '>=', since).execute();

describe('console: lifecycle flows', () => {
  it('a manager may turn a flow down to off and back to shadow, but is not offered anything that sends to guests', async () => {
    const group = await orgBySlug('oak-group');
    expect((await flowRow(group.orgId, 'birthday')).mode).toBe('shadow');
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-group.test');
    await v.page.goto(`${BASE()}/console/campaigns/flows`);
    const card = v.page.getByTestId('flow-birthday');
    await card.waitFor();
    // Nothing that lets a flow write to guests is on a manager's screen.
    expect(await v.page.getByRole('button', { name: /Set to (supervised|autonomous)/ }).count()).toBe(0);
    await card.getByText('Only an owner can let a flow send to guests.').waitFor();

    try {
      await v.page.getByTestId('mode-birthday-off').click();
      const off = v.page.getByRole('dialog', { name: /Set .* to off\?/ });
      await off.getByText('nothing new is prepared or recorded').waitFor();
      await off.getByRole('button', { name: 'Set to off' }).click();
      // The button that opened the dialog no longer exists once the flow is off: the answer is said in the message area.
      await v.page.getByTestId('console-flash').getByText('is now set to off').waitFor();
      expect((await flowRow(group.orgId, 'birthday')).mode).toBe('off');

      await v.page.getByTestId('mode-birthday-shadow').click();
      const shadow = v.page.getByRole('dialog', { name: /Set .* to shadow\?/ });
      await shadow.getByRole('button', { name: 'Set to shadow' }).click();
      await v.page.getByTestId('console-flash').getByText('is now set to shadow').waitFor();
      expect((await flowRow(group.orgId, 'birthday')).mode).toBe('shadow');
    } finally {
      await asStaff('group', 'owner', (ctx) => campaigns.setFlowMode(ctx, { flowKey: 'birthday', mode: 'shadow' }));
    }
    const flow = await flowRow(group.orgId, 'birthday');
    const audits = await db().selectFrom('audit_log').select(['actor_kind', 'after']).where('org_id', '=', group.orgId).where('entity_id', '=', flow.id).orderBy('occurred_at', 'desc').limit(3).execute();
    expect(audits.filter((a) => a.actor_kind === 'staff').length).toBeGreaterThanOrEqual(2);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('an owner sets a flow to supervised; "run now" prepares batches that wait in Approvals and sends nothing; a rejected batch stays unsent', async () => {
    const group = await orgBySlug('oak-group');
    const started = new Date(Date.now() - 1000);
    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-group.test');
    await v.page.goto(`${BASE()}/console/campaigns/flows`);
    // The flow with the most guests due a message now.
    const due: Array<{ key: string; n: number }> = [];
    for (const key of campaigns.FLOW_KEYS) {
      const text = await v.page.getByTestId(`flow-${key}`).innerText();
      due.push({ key, n: Number(text.match(/(\d[\d,]*) due now/)?.[1]?.replace(/,/g, '') ?? 0) });
    }
    const pick = due.sort((a, b) => b.n - a.n)[0]!;
    expect(pick.n, `no fixture flow has guests due: ${JSON.stringify(due)}`).toBeGreaterThan(0);
    const key = pick.key as campaigns.FlowKey;
    const flow = await flowRow(group.orgId, key);
    expect(flow.mode).toBe('shadow');
    const messagesBefore = await db().selectFrom('messages').select('id').where('org_id', '=', group.orgId).where('flow_id', '=', flow.id).execute();

    try {
      await v.page.getByTestId(`mode-${key}-supervised`).click();
      const dialog = v.page.getByRole('dialog', { name: /Set .* to supervised\?/ });
      await dialog.getByText('Guests are written to only when a manager approves a batch.').waitFor();
      await dialog.getByRole('button', { name: 'Set to supervised' }).click();
      await v.page.getByTestId('console-flash').getByText('is now set to supervised').waitFor();
      expect((await flowRow(group.orgId, key)).mode).toBe('supervised');

      await v.page.getByTestId(`run-${key}`).getByRole('button', { name: 'Run now' }).click();
      const batches = await eventually(async () => {
        const rows = await pendingBatches(group.orgId, started);
        return rows.length ? rows : null;
      }, 'a batch waiting in Approvals', 60_000);
      // Waiting is not sending: nothing was queued for any guest.
      await new Promise((r) => setTimeout(r, 2000));
      expect((await db().selectFrom('messages').select('id').where('org_id', '=', group.orgId).where('flow_id', '=', flow.id).execute()).length).toBe(messagesBefore.length);

      // The batch is in Approvals, in words; the owner turns it down.
      const batch = batches[0]!;
      await v.page.goto(`${BASE()}/console/approvals`);
      await v.page.getByText(batch.summary).first().waitFor();
      await v.page.getByTestId(`reject-${batch.id}`).click();
      const reject = v.page.getByRole('dialog', { name: 'Reject this?' }).filter({ hasText: batch.summary });
      await reject.getByText('Nothing below will happen').waitFor();
      await reject.locator('textarea[name=reason]').fill('Not this week: the kitchen is closed for repairs.');
      await reject.getByRole('button', { name: 'Reject', exact: true }).click();
      // Its row leaves the waiting list, taking the dialog with it; the outcome is still said.
      await v.page.getByTestId('console-flash').getByText('Rejected. Nothing will happen.').waitFor();

      const decided = await db().selectFrom('approvals').select(['status', 'decision_note', 'decided_by_staff_id', 'decided_at']).where('id', '=', batch.id).executeTakeFirstOrThrow();
      expect(decided).toMatchObject({ status: 'rejected', decision_note: 'Not this week: the kitchen is closed for repairs.' });
      expect(decided.decided_by_staff_id).not.toBeNull();
      expect(await db().selectFrom('audit_log').select('actor_kind').where('entity_id', '=', batch.id).where('action', '=', 'approval.rejected').executeTakeFirstOrThrow()).toEqual({ actor_kind: 'staff' });
      // Rejected means unsent, including after the worker has had time to act on the decision.
      await new Promise((r) => setTimeout(r, 2500));
      expect((await db().selectFrom('messages').select('id').where('org_id', '=', group.orgId).where('flow_id', '=', flow.id).execute()).length).toBe(messagesBefore.length);
      // It is on the record under Rejected, and no longer offered for a decision.
      await v.page.goto(`${BASE()}/console/approvals?status=rejected`);
      await v.page.getByText(batch.summary).first().waitFor();
      expect(await v.page.getByTestId(`approve-${batch.id}`).count()).toBe(0);
    } finally {
      // Leave the fixture as other scenarios expect it: the flow in shadow, no batch of ours waiting.
      await asStaff('group', 'owner', async (ctx) => {
        await campaigns.setFlowMode(ctx, { flowKey: key, mode: 'shadow' });
        for (const b of await pendingBatches(group.orgId, started)) await approvals.decideApproval(ctx, b.id, { decision: 'rejected', note: 'e2e clean-up' });
      });
    }
    expect((await flowRow(group.orgId, key)).mode).toBe('shadow');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
