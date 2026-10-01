import { describe, expect, it } from 'vitest';
import { useTestEnv } from '@ros/testkit';
import { offers } from '@ros/modules';
import { ANON } from './helpers';

/** What the venue's own site may show of an offer on its sign-up and claim pages. */
describe('offers: the public view of an offer', () => {
  const t = useTestEnv();

  it('shows an active offer in plain words to anyone, and says whether sign-up is open', async () => {
    const diner = t.fixture.diner;
    const rows = await t.db.selectFrom('offers').select(['id', 'kind', 'name', 'creator_id', 'campaign_id']).where('org_id', '=', diner.orgId).where('is_active', '=', true).execute();
    const welcome = rows.find((r) => r.kind === 'welcome')!;
    const creator = rows.find((r) => r.kind === 'creator')!;
    const comeback = rows.find((r) => r.kind === 'comeback')!;

    const w = await t.app.tenant(diner.orgId, ANON, (ctx) => offers.getPublicOffer(ctx, welcome.id));
    expect(w).toMatchObject({ id: welcome.id, kind: 'welcome', name: welcome.name, summary: '$10 off when you spend $40 or more', signupOpen: true });
    const c = await t.app.tenant(diner.orgId, ANON, (ctx) => offers.getPublicOffer(ctx, creator.id));
    expect(c).toMatchObject({ creatorId: creator.creator_id, campaignId: creator.campaign_id, signupOpen: true });
    const back = await t.app.tenant(diner.orgId, ANON, (ctx) => offers.getPublicOffer(ctx, comeback.id));
    expect(back.signupOpen).toBe(false);
    // Nothing about who holds codes, and no internal fields.
    expect(Object.keys(w).sort()).toEqual(['campaignId', 'channels', 'creatorId', 'description', 'id', 'kind', 'minSpendCents', 'name', 'signupOpen', 'summary', 'validityDays']);
  });

  it('another org\'s offer, an inactive offer and a malformed id are all not found', async () => {
    const diner = t.fixture.diner;
    const group = t.fixture.group;
    const theirs = await t.db.selectFrom('offers').select('id').where('org_id', '=', group.orgId).executeTakeFirstOrThrow();
    await expect(t.app.tenant(diner.orgId, ANON, (ctx) => offers.getPublicOffer(ctx, theirs.id))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(diner.orgId, ANON, (ctx) => offers.getPublicOffer(ctx, 'nope'))).rejects.toMatchObject({ code: 'not_found' });
    const manager = await diner.as('manager');
    const off = await t.app.tenant(diner.orgId, manager, (ctx) => offers.saveOffer(ctx, { kind: 'welcome', name: 'Old welcome', discountKind: 'fixed', valueCents: 500, isActive: false }));
    await expect(t.app.tenant(diner.orgId, ANON, (ctx) => offers.getPublicOffer(ctx, off.id))).rejects.toMatchObject({ code: 'not_found' });
  });
});
