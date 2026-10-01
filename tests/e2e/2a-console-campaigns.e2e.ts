import { afterAll, describe, expect, it } from 'vitest';
import { BASE, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff } from './helpers';

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

const messagesFor = async (campaignId: string) =>
  Number((await db().selectFrom('messages').select((eb) => eb.fn.countAll<string>().as('n')).where('campaign_id', '=', campaignId).executeTakeFirstOrThrow()).n);

describe('console: campaigns', () => {
  it('a manager drafts a campaign to a segment, sees how many guests it reaches, submits it, and it goes only after approval', async () => {
    const diner = await orgBySlug('oak-diner');
    const name = `E2E winter menu ${Date.now()}`;
    const body = `Hi {{first_name}}, the winter menu starts Friday. ${name}`;
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');

    // Draft: choose the segment, count the audience before writing a word to anyone.
    await v.page.goto(`${BASE()}/console/campaigns/new`);
    await v.page.fill('input[name=name]', name);
    const regulars = await v.page.locator('select[name=segmentId] option', { hasText: 'Regulars' }).first().getAttribute('value');
    await v.page.selectOption('select[name=segmentId]', regulars!);
    await v.page.locator('[data-testid=check-audience]').click();
    const counted = await v.page.locator('[data-testid=audience-count]').innerText();
    expect(counted).toMatch(/\d+ guests in this segment call this venue home\. \d+ can be emailed/);
    await v.page.fill('input[name=subject]', `Winter menu ${name}`);
    await v.page.fill('textarea[name=body]', body);
    await v.page.getByRole('button', { name: 'Create draft' }).click();
    await v.page.waitForURL(/\/console\/campaigns\/[0-9a-f-]{36}\?created=1/);
    const id = new URL(v.page.url()).pathname.split('/').pop()!;

    const draft = await db().selectFrom('campaigns').select(['status', 'venue_id', 'audience_count', 'channel', 'body', 'created_by_kind']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(draft).toMatchObject({ status: 'draft', venue_id: diner.venueId, channel: 'email', body, created_by_kind: 'staff' });
    expect(draft.audience_count).toBeGreaterThan(0);
    expect(counted).toContain(`${draft.audience_count} can be emailed`);
    expect(await messagesFor(id)).toBe(0);

    // Submit: the dialog says exactly how many guests, on which channel, and that nothing goes yet.
    await v.page.locator('[data-testid=submit-campaign]').click();
    const dialog = v.page.getByRole('dialog', { name: 'Send this campaign for approval?' });
    const says = await dialog.innerText();
    expect(says).toContain(`${draft.audience_count} guests`);
    expect(says).toContain('will be sent this email from Oak Diner');
    expect(says).toContain('Nothing goes until a manager approves it in Approvals');
    await dialog.getByRole('button', { name: 'Send for approval' }).click();
    await v.page.getByText('Waiting for a manager in').waitFor();

    const submitted = await db().selectFrom('campaigns').select('status').where('id', '=', id).executeTakeFirstOrThrow();
    expect(submitted.status).toBe('pending_approval');
    const approval = await db().selectFrom('approvals').select(['id', 'status', 'summary', 'venue_id']).where('kind', '=', 'campaigns.campaign_send').where('subject_id', '=', id).executeTakeFirstOrThrow();
    expect(approval).toMatchObject({ status: 'pending', venue_id: diner.venueId });
    expect(approval.summary).toContain(`to the ${draft.audience_count} guests in "Regulars"`);
    // Waiting is not sending: give the worker time to prove it does nothing.
    await new Promise((r) => setTimeout(r, 2500));
    expect(await messagesFor(id)).toBe(0);

    // Approve on the Approvals screen, after reading what will go.
    await v.page.goto(`${BASE()}/console/approvals/${approval.id}`);
    const details = await v.page.locator('[data-testid=approval-campaign]').innerText();
    expect(details).toContain(body);
    expect(details).toContain('Regulars');
    await v.page.locator(`[data-testid=approve-${approval.id}]`).click();
    await v.page.getByRole('dialog', { name: 'Approve this?' }).getByRole('button', { name: 'Approve' }).click();

    await eventually(async () => (await db().selectFrom('campaigns').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status === 'sent', 'the campaign to be sent');
    const decided = await db().selectFrom('approvals').select(['status', 'decided_by_staff_id']).where('id', '=', approval.id).executeTakeFirstOrThrow();
    expect(decided.status).toBe('approved');
    expect(decided.decided_by_staff_id).not.toBeNull();
    const sent = await db().selectFrom('campaigns').select(['audience_count', 'approved_by_staff_id', 'sent_at']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(sent.approved_by_staff_id).toBe(decided.decided_by_staff_id);
    expect(await messagesFor(id)).toBe(sent.audience_count);
    const kinds = await db().selectFrom('messages').select(['kind', 'channel']).where('campaign_id', '=', id).distinct().execute();
    expect(kinds).toEqual([{ kind: 'marketing', channel: 'email' }]);
    const audits = await db().selectFrom('audit_log').select('action').where('entity_type', '=', 'campaign').where('entity_id', '=', id).execute();
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['campaign.drafted', 'campaign.submitted', 'campaign.approved']));

    // The campaign's page now shows results, as totals.
    await v.page.goto(`${BASE()}/console/campaigns/${id}`);
    expect(await v.page.locator('[data-testid=campaign-results]').innerText()).toContain('aligned with the campaign, not proof it caused them');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a manager defines a segment by conditions and counts it before saving', async () => {
    const diner = await orgBySlug('oak-diner');
    const name = `E2E two-plus ${Date.now()}`;
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/campaigns/segments/new`);
    await v.page.fill('input[name=name]', name);
    const row = v.page.locator('[data-testid=segment-condition]').first();
    await row.getByLabel('Field').selectOption('orders');
    await row.getByLabel('At least').fill('2');
    expect(await v.page.locator('[data-testid=segment-words]').innerText()).toContain('has at least 2 orders');
    await v.page.getByRole('button', { name: 'Count guests' }).click();
    expect(await v.page.locator('[data-testid=segment-count]').innerText()).toMatch(/^\d[\d,]* guests match at this venue/);
    await v.page.getByRole('button', { name: 'Create segment' }).click();
    await v.page.waitForURL(/\/console\/campaigns\/segments\/[0-9a-f-]{36}\?created=1/);

    const seg = await db().selectFrom('segments').select(['id', 'definition', 'is_system']).where('org_id', '=', diner.orgId).where('name', '=', name).executeTakeFirstOrThrow();
    expect(seg).toMatchObject({ definition: { field: 'orders', min: 2 }, is_system: false });

    // Delete asks first, then the segment is gone.
    await v.page.locator('[data-testid=delete-segment]').click();
    await v.page.getByRole('dialog').getByRole('button', { name: 'Delete the segment' }).click();
    await v.page.waitForURL(/\/console\/campaigns\/segments\?deleted=1/);
    expect(await db().selectFrom('segments').select('id').where('id', '=', seg.id).executeTakeFirst()).toBeUndefined();
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('front of house and read-only staff can see campaigns but cannot draft, and flows are for managers', async () => {
    for (const email of ['host@oak-diner.test', 'accounts@oak-group.test']) {
      const v = await newVisitor();
      await signInStaff(v.page, email);
      await v.page.goto(`${BASE()}/console/campaigns`);
      expect(await v.page.locator('h1').innerText()).toBe('Campaigns');
      expect(await v.page.getByRole('link', { name: 'New campaign' }).count()).toBe(0);
      await v.page.goto(`${BASE()}/console/campaigns/new`);
      expect(await v.page.locator('main').innerText()).toContain('Your role does not include this');
      expect(await v.page.locator('main form').count()).toBe(0);
      await v.page.goto(`${BASE()}/console/campaigns/flows`);
      expect(await v.page.locator('main').innerText()).toContain('Your role does not include this');
      await v.page.goto(`${BASE()}/console/campaigns/segments`);
      expect(await v.page.getByRole('link', { name: 'New segment' }).count()).toBe(0);
      expect(v.problems).toEqual([]);
      await v.context.close();
    }
  });
});
