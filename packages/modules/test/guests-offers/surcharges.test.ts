import { describe, expect, it } from 'vitest';
import { useTestEnv } from '@ros/testkit';
import { offers } from '@ros/modules';
import { CHRISTMAS, DINNER_WED, LUNCH_SUN, WORKER, auditRows } from './helpers';

/**
 * Surcharges as their own object (docs/CONSOLE_IA.md section 9, pattern 6): Sunday, public
 * holiday and named-day percentages on the bill, the line a docket and a menu carry, and the
 * refusal of a card-payment surcharge with the date and source of the ban.
 */
describe('offers: surcharges', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;

  it('a manager sets a Sunday surcharge; it applies on a Sunday, not on a Wednesday; the docket says what the law asks', async () => {
    const manager = await diner().as('manager');
    const s = await t.app.tenant(diner().orgId, manager, (ctx) => offers.saveSurcharge(ctx, { venueId: diner().venueId, name: 'Sunday surcharge', kind: 'sunday', percent: 10 }));
    expect(s).toMatchObject({ percentBp: 1000, kind: 'sunday', notice: 'A surcharge of 10% applies on Sundays.', isActive: true });
    expect(await t.db.selectFrom('surcharges').select(['name', 'percent_bp', 'kind', 'venue_id']).where('id', '=', s.id).execute()).toEqual([{ name: 'Sunday surcharge', percent_bp: 1000, kind: 'sunday', venue_id: diner().venueId }]);
    expect(await auditRows(t, diner().orgId, 'surcharge.set', s.id)).toHaveLength(1);

    const onSunday = await t.app.tenant(diner().orgId, WORKER, (ctx) => offers.applicableSurcharges(ctx, diner().venueId, LUNCH_SUN));
    expect(onSunday).toMatchObject([{ id: s.id, name: 'Sunday surcharge', percentBp: 1000, reason: 'Sunday', notice: 'A surcharge of 10% applies on Sundays.' }]);
    expect(await t.app.tenant(diner().orgId, WORKER, (ctx) => offers.applicableSurcharges(ctx, diner().venueId, DINNER_WED))).toEqual([]);

    // On a $59 bill after discounts: $5.90, one line per surcharge, then the notice.
    const docket = offers.surchargeDocketLines(onSunday, 5900);
    expect(docket).toEqual({ lines: [{ label: 'Sunday surcharge (10%, Sunday)', amountCents: 590 }], notices: ['A surcharge of 10% applies on Sundays.'], totalCents: 590 });
    expect(offers.surchargeDocketText(onSunday, 5900)).toEqual(['Sunday surcharge (10%, Sunday)  $5.90', 'A surcharge of 10% applies on Sundays.']);
    expect(offers.surchargeAmountCents(1234, 1250)).toBe(154);
    expect(await t.app.tenant(diner().orgId, WORKER, (ctx) => offers.surchargeNotice(ctx, diner().venueId))).toBe('A surcharge of 10% applies on Sundays.');
  });

  it('public holidays: the national days are built in, a venue adds its state\'s own dates, and the menu line joins every surcharge', async () => {
    const manager = await diner().as('manager');
    const ph = await t.app.tenant(diner().orgId, manager, (ctx) => offers.saveSurcharge(ctx, { venueId: null, name: 'Public holiday surcharge', kind: 'public_holiday', percent: 15, dates: ['2026-10-05'] }));
    expect(ph.dates).toEqual(['2026-10-05']);
    const xmas = await t.app.tenant(diner().orgId, WORKER, (ctx) => offers.applicableSurcharges(ctx, diner().venueId, CHRISTMAS));
    expect(xmas.map((s) => [s.name, s.reason])).toEqual([['Public holiday surcharge', 'Christmas Day']]);
    const labourDay = await t.app.tenant(diner().orgId, WORKER, (ctx) => offers.applicableSurcharges(ctx, diner().venueId, new Date('2026-10-05T02:00:00.000Z')));
    expect(labourDay.map((s) => s.reason)).toEqual(['Public holiday']);
    expect(offers.publicHolidayName('2027-04-25')).toBe('Anzac Day');
    expect(offers.publicHolidayName('2026-10-06')).toBeNull();
    // Both the Sunday and the holiday surcharge are on the menu line, each once.
    expect(await t.app.tenant(diner().orgId, WORKER, (ctx) => offers.surchargeNotice(ctx, diner().venueId))).toBe('A surcharge of 10% applies on Sundays. A surcharge of 15% applies on public holidays.');
    // Named days.
    const fri = await t.app.tenant(diner().orgId, manager, (ctx) => offers.saveSurcharge(ctx, { venueId: diner().venueId, name: 'Friday late surcharge', kind: 'days', percent: 5, days: [5, 6] }));
    expect(fri.notice).toBe('A surcharge of 5% applies on Fridays and Saturdays.');
    await expect(t.app.tenant(diner().orgId, manager, (ctx) => offers.saveSurcharge(ctx, { venueId: diner().venueId, name: 'Some days', kind: 'days', percent: 5 }))).rejects.toMatchObject({ code: 'invalid', message: /which days/ });
    // Switched off, it stops applying; removed, it is gone and audited.
    await t.app.tenant(diner().orgId, manager, (ctx) => offers.saveSurcharge(ctx, { id: fri.id, venueId: diner().venueId, name: fri.name, kind: 'days', percent: 5, days: [5, 6], isActive: false }));
    const friday = new Date('2026-10-02T09:00:00.000Z');
    expect((await t.app.tenant(diner().orgId, WORKER, (ctx) => offers.applicableSurcharges(ctx, diner().venueId, friday))).map((s) => s.id)).not.toContain(fri.id);
    await t.app.tenant(diner().orgId, manager, (ctx) => offers.deleteSurcharge(ctx, fri.id));
    expect(await t.db.selectFrom('surcharges').select('id').where('id', '=', fri.id).execute()).toEqual([]);
    expect(await auditRows(t, diner().orgId, 'surcharge.deleted', fri.id)).toHaveLength(1);
  });

  it('a card-payment surcharge is refused, with the date and the source of the ban, by the service and by the tool', async () => {
    const manager = await diner().as('manager');
    for (const name of ['Card surcharge', 'EFTPOS fee', 'Visa and Mastercard surcharge', 'Credit card 1.5%', 'Payment surcharge', 'Tap and go']) {
      await expect(t.app.tenant(diner().orgId, manager, (ctx) => offers.saveSurcharge(ctx, { venueId: diner().venueId, name, kind: 'days', percent: 1.5, days: [0, 1, 2, 3, 4, 5, 6] }))).rejects.toMatchObject({
        code: 'invalid',
        message: expect.stringContaining('1 October 2026'),
      });
    }
    expect(offers.CARD_SURCHARGE_REFUSAL).toContain('eftpos, Mastercard or Visa');
    expect(offers.CARD_SURCHARGE_REFUSAL).toContain('Reserve Bank of Australia');
    expect(offers.CARD_SURCHARGE_BAN_DATE).toBe('2026-10-01');
    expect(offers.CARD_SURCHARGE_BAN_SOURCE).toMatch(/^https:\/\/www\.rba\.gov\.au\//);
    expect(offers.isCardSurchargeName('Public holiday surcharge')).toBe(false);
    expect(await t.db.selectFrom('surcharges').select('id').where('org_id', '=', diner().orgId).where('name', 'ilike', '%card%').execute()).toEqual([]);

    const tool = offers.surchargeSetTool as unknown as { propose: (c: { ctx: unknown; venueId: string }, i: Record<string, unknown>) => Promise<unknown> };
    await expect(t.app.tenant(diner().orgId, manager, (ctx) => tool.propose({ ctx, venueId: diner().venueId }, { name: 'Card surcharge', kind: 'sunday', percent: 1.5, every_venue: false, switched_on: true }))).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('1 October 2026'),
    });
  });

  it('roles and tenancy: a host cannot set one; another org\'s venue is not found; a venue surcharge stays at its venue', async () => {
    const host = await diner().as('host');
    await expect(t.app.tenant(diner().orgId, host, (ctx) => offers.saveSurcharge(ctx, { venueId: diner().venueId, name: 'Sunday', kind: 'sunday', percent: 10 }))).rejects.toMatchObject({ code: 'forbidden' });
    const gm = await group().as('manager');
    await expect(t.app.tenant(group().orgId, gm, (ctx) => offers.saveSurcharge(ctx, { venueId: diner().venueId, name: 'Sunday', kind: 'sunday', percent: 10 }))).rejects.toMatchObject({ code: 'not_found' });
    const cbd = group().venues.cbd!.id;
    const newtown = group().venues.newtown!.id;
    const s = await t.app.tenant(group().orgId, gm, (ctx) => offers.saveSurcharge(ctx, { venueId: cbd, name: 'CBD Sunday', kind: 'sunday', percent: 12.5 }));
    expect(s.notice).toBe('A surcharge of 12.5% applies on Sundays.');
    expect((await t.app.tenant(group().orgId, WORKER, (ctx) => offers.applicableSurcharges(ctx, cbd, LUNCH_SUN))).map((x) => x.id)).toEqual([s.id]);
    expect(await t.app.tenant(group().orgId, WORKER, (ctx) => offers.applicableSurcharges(ctx, newtown, LUNCH_SUN))).toEqual([]);
    expect((await t.app.tenant(group().orgId, gm, (ctx) => offers.listSurcharges(ctx, { venueId: newtown }))).map((x) => x.id)).not.toContain(s.id);
    // The diner's surcharges are not the group's.
    expect((await t.app.tenant(group().orgId, gm, (ctx) => offers.listSurcharges(ctx))).map((x) => x.name)).not.toContain('Sunday surcharge');
  });
});
