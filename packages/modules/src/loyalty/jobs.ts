import { z } from 'zod';
import { type App, type Ctx, defineJob, defineSchedule, localParts, sql, track } from '@ros/core';
import { queueMessage } from '../comms/outbox';
import { getOrg } from '../tenancy/orgs';
import { loyaltyBonusAwarded, loyaltyExpired, loyaltyModule } from './module';
import { ACCOUNT_COLS, activeProgram, availablePoints, evaluateTier, lockAccount, monthsBefore, primaryHost, tiersOf, writePoints } from './points';
import { expireStaleRedemptions } from './redemption';
import { BIRTHDAY_TEMPLATE } from './templates';

const WORKER = { kind: 'worker' as const, job: 'loyalty' };

/**
 * Points expiry, by the programme's rule:
 *   fixed    each point lapses `expiry_months` after it was earned; spending uses the oldest first
 *   rolling  the whole balance lapses after `expiry_months` with no earning or redeeming
 * Points held by a live counter code are left alone. Idempotent per account per day.
 */
export async function expirePoints(ctx: Ctx): Promise<{ accounts: number; points: number }> {
  const program = await activeProgram(ctx);
  if (!program || program.expiry_policy === 'none' || !program.expiry_months) return { accounts: 0, points: 0 };
  const now = ctx.now();
  const cutoff = monthsBefore(now, program.expiry_months);
  const day = now.toISOString().slice(0, 10);

  const due = await sql<{ account_id: string }>`
    select lt.account_id
    from loyalty_transactions lt
    join loyalty_accounts a on a.id = lt.account_id
    where a.program_id = ${program.id} and a.status <> 'closed'
    group by lt.account_id
    having sum(lt.points) > 0
       and min(lt.occurred_at) < ${cutoff}`.execute(ctx.db);

  const result = { accounts: 0, points: 0 };
  for (const { account_id } of due.rows) {
    const account = await lockAccount(ctx, account_id);
    if (!account) continue;
    const t = (
      await sql<{ old_credits: number; debits: number; last_activity: Date | null }>`
        select coalesce(sum(points) filter (where points > 0 and occurred_at < ${cutoff}), 0)::int as old_credits,
               coalesce(-sum(points) filter (where points < 0), 0)::int as debits,
               max(occurred_at) filter (where kind in ('earn', 'burn')) as last_activity
        from loyalty_transactions
        where account_id = ${account.id}`.execute(ctx.db)
    ).rows[0]!;
    const { available } = await availablePoints(ctx, account.id);
    let lapse = 0;
    if (program.expiry_policy === 'fixed') lapse = Math.max(0, t.old_credits - t.debits);
    else if (!t.last_activity || t.last_activity < cutoff) lapse = available;
    lapse = Math.min(lapse, available);
    if (lapse <= 0) continue;
    const wrote = await writePoints(ctx, { accountId: account.id, kind: 'expire', points: -lapse, key: `expire:${account.id}:${day}`, note: `Expired after ${program.expiry_months} months` });
    if (!wrote) continue;
    result.accounts++;
    result.points += lapse;
    await track(ctx, loyaltyExpired, { account_id: account.id, points: lapse, policy: program.expiry_policy as 'rolling' | 'fixed' }, { customerId: account.customer_id });
  }
  return result;
}

/** Tiers are held over a rolling window, so they are re-worked as time passes, not only on a sale. */
export async function refreshTiers(ctx: Ctx): Promise<number> {
  const program = await activeProgram(ctx);
  if (!program) return 0;
  const tiers = await tiersOf(ctx, program.id);
  const accounts = await ctx.db.selectFrom('loyalty_accounts').select(ACCOUNT_COLS).where('program_id', '=', program.id).where('status', '=', 'active').execute();
  let changed = 0;
  for (const a of accounts) {
    const before = a.tier_id;
    await evaluateTier(ctx, a, undefined, tiers);
    if (a.tier_id !== before) changed++;
  }
  return changed;
}

/**
 * Birthday points, once a year, on the guest's birthday in the org's own time zone. The points
 * are given regardless; the message about them is marketing and goes only with consent.
 */
export async function awardBirthdayBonuses(ctx: Ctx): Promise<number> {
  const program = await activeProgram(ctx);
  if (!program || program.birthday_bonus <= 0) return 0;
  const org = await getOrg(ctx);
  const today = localParts(ctx.now(), org.timezone);
  const days = [today.date.slice(5)];
  // Someone born on 29 February has a birthday every year.
  const leap = (today.year % 4 === 0 && today.year % 100 !== 0) || today.year % 400 === 0;
  if (days[0] === '02-28' && !leap) days.push('02-29');

  const due = await ctx.db
    .selectFrom('loyalty_accounts as a')
    .innerJoin('customers as c', 'c.id', 'a.customer_id')
    .select(['a.id', 'a.customer_id', 'c.first_name', 'c.primary_email', 'c.primary_phone'])
    .where('a.program_id', '=', program.id)
    .where('a.status', '=', 'active')
    .where('c.status', '=', 'active')
    .where('c.birthday', 'is not', null)
    .where(sql<string>`to_char(c.birthday, 'MM-DD')`, 'in', days)
    .execute();

  let awarded = 0;
  const host = due.length ? await primaryHost(ctx) : null;
  for (const m of due) {
    const wrote = await writePoints(ctx, { accountId: m.id, kind: 'bonus', points: program.birthday_bonus, key: `birthday:${m.id}:${today.year}`, note: 'Birthday bonus' });
    if (!wrote) continue;
    awarded++;
    await track(ctx, loyaltyBonusAwarded, { account_id: m.id, points: program.birthday_bonus, reason: 'birthday' }, { customerId: m.customer_id });
    const channel = m.primary_email ? 'email' : m.primary_phone ? 'sms' : null;
    if (channel) {
      await queueMessage(ctx, {
        templateKey: BIRTHDAY_TEMPLATE,
        channel,
        customerId: m.customer_id,
        idempotencyKey: `loyalty-birthday:${m.id}:${today.year}`,
        variables: { first_name: m.first_name ?? 'there', program_name: program.name, points: program.birthday_bonus, account_url: host ? `${host}/loyalty` : '' },
      });
    }
  }
  return awarded;
}

function orgOf(job: { orgId: string | null }, kind: string): string {
  if (!job.orgId) throw new Error(`${kind} needs an org`);
  return job.orgId;
}

/** A scheduler check, outside any tenant transaction: is loyalty on at any of this org's venues? */
async function loyaltyOnSomewhere(app: App, orgId: string): Promise<boolean> {
  const row = await app.db.selectFrom('venue_modules').select('venue_id').where('org_id', '=', orgId).where('module_key', '=', loyaltyModule.key).where('enabled', '=', true).limit(1).executeTakeFirst();
  return !!row;
}

const bucketPayload = z.object({ bucket: z.string() });

export const sweepRedemptionsJob = defineJob({
  kind: 'loyalty.sweep_redemptions',
  schema: bucketPayload,
  async handler(app, job) {
    await app.tenant(orgOf(job, 'loyalty.sweep_redemptions'), WORKER, (ctx) => expireStaleRedemptions(ctx));
  },
});

export const expirePointsJob = defineJob({
  kind: 'loyalty.expire_points',
  schema: bucketPayload,
  async handler(app, job) {
    const orgId = orgOf(job, 'loyalty.expire_points');
    await app.tenant(orgId, WORKER, (ctx) => expirePoints(ctx));
    await app.tenant(orgId, WORKER, (ctx) => refreshTiers(ctx));
  },
});

export const birthdayBonusJob = defineJob({
  kind: 'loyalty.birthday_bonus',
  schema: bucketPayload,
  async handler(app, job) {
    await app.tenant(orgOf(job, 'loyalty.birthday_bonus'), WORKER, (ctx) => awardBirthdayBonuses(ctx));
  },
});

export const sweepRedemptionsSchedule = defineSchedule({
  key: 'loyalty.sweep_redemptions',
  everyMinutes: 5,
  scope: 'org',
  job: sweepRedemptionsJob,
  payload: ({ bucket }) => ({ bucket: bucket.toISOString() }),
  appliesTo: loyaltyOnSomewhere,
});

export const expirePointsSchedule = defineSchedule({
  key: 'loyalty.expire_points',
  everyMinutes: 24 * 60,
  scope: 'org',
  job: expirePointsJob,
  payload: ({ bucket }) => ({ bucket: bucket.toISOString() }),
  appliesTo: loyaltyOnSomewhere,
});

/** Every three hours, so the bonus lands on the birthday in the org's own zone whichever side of UTC midnight that is. */
export const birthdayBonusSchedule = defineSchedule({
  key: 'loyalty.birthday_bonus',
  everyMinutes: 180,
  scope: 'org',
  job: birthdayBonusJob,
  payload: ({ bucket }) => ({ bucket: bucket.toISOString() }),
  appliesTo: loyaltyOnSomewhere,
});
