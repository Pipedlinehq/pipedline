import { type App, AppError, hashToken, newNumericCode, once, rateLimit, safeEqual } from '@ros/core';
import { normaliseEmail, normalisePhone } from '../identity/normalise';
import { OTP_MAX_ATTEMPTS, OTP_TTL_MINUTES } from './module';

export type OtpPurpose = 'staff_login' | 'guest_login' | 'platform_login';

export interface Destination {
  channel: 'email' | 'sms';
  value: string;
}

export function parseDestination(raw: string): Destination | null {
  const email = raw.includes('@') ? normaliseEmail(raw) : null;
  if (email) return { channel: 'email', value: email };
  const phone = normalisePhone(raw);
  return phone ? { channel: 'sms', value: phone } : null;
}

/**
 * Issue a one-time code and send it. The code is hashed at rest and goes straight to the
 * provider: it is never written to the outbox, where staff could read it.
 */
export async function issueOtp(
  app: App,
  args: { purpose: OtpPurpose; destination: Destination; orgId: string | null; senderName: string; senderSlug: string; ip?: string },
): Promise<void> {
  // Per destination and per caller, so neither a mailbox nor the endpoint can be hammered.
  await rateLimit(app, `otp:dest:${args.destination.value}`, { limit: 5, windowSeconds: 900 }, 'Too many codes requested. Try again in a few minutes.');
  if (args.ip) await rateLimit(app, `otp:ip:${args.ip}`, { limit: 30, windowSeconds: 900 }, 'Too many codes requested. Try again in a few minutes.');

  const code = newNumericCode(6);
  const now = app.clock();
  const row = await app.db
    .insertInto('otp_codes')
    .values({
      org_id: args.orgId,
      purpose: args.purpose,
      destination: args.destination.value,
      code_hash: hashToken(`${args.destination.value}:${code}`),
      expires_at: new Date(now.getTime() + OTP_TTL_MINUTES * 60_000),
      created_at: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const cfg = app.config.comms;
  const text = `Your ${args.senderName} sign-in code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes. If you did not ask for it, you can ignore this message.`;
  const adapter = app.adapters.get('message', args.destination.channel === 'email' ? cfg.emailAdapter : cfg.smsAdapter);
  const send = () =>
    adapter.send(null, {
      idempotencyKey: `otp:${row.id}`,
      channel: args.destination.channel,
      kind: 'transactional',
      to: args.destination.value,
      from:
        args.destination.channel === 'email'
          ? { email: `${args.senderSlug}@${cfg.platformSendingDomain}`, name: args.senderName }
          : { smsSenderId: cfg.platformSmsSender },
      subject: args.destination.channel === 'email' ? `${code} is your ${args.senderName} sign-in code` : null,
      body: text,
    });
  if (args.orgId) await once(app, { orgId: args.orgId, key: `otp:${row.id}`, kind: 'otp' }, send);
  else await send();
}

/** Check a code. Consumes it on success; counts the attempt on failure; the same answer either way to the caller. */
export async function verifyOtp(
  app: App,
  args: { purpose: OtpPurpose; destination: Destination; orgId: string | null; code: string },
): Promise<boolean> {
  const now = app.clock();
  const candidate = await app.db
    .selectFrom('otp_codes')
    .select(['id', 'code_hash', 'attempts'])
    .where('destination', '=', args.destination.value)
    .where('purpose', '=', args.purpose)
    .where((eb) => (args.orgId ? eb('org_id', '=', args.orgId) : eb('org_id', 'is', null)))
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', now)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!candidate || candidate.attempts >= OTP_MAX_ATTEMPTS) return false;

  const ok = /^\d{6}$/.test(args.code) && safeEqual(candidate.code_hash, hashToken(`${args.destination.value}:${args.code}`));
  if (!ok) {
    await app.db.updateTable('otp_codes').set((eb) => ({ attempts: eb('attempts', '+', 1) })).where('id', '=', candidate.id).execute();
    return false;
  }
  // Single use: the update only succeeds for whoever consumes it first.
  const consumed = await app.db
    .updateTable('otp_codes')
    .set({ consumed_at: now })
    .where('id', '=', candidate.id)
    .where('consumed_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  return !!consumed;
}

export const badCode = () => new AppError('unauthenticated', 'That code is not right, or it has expired. Ask for a new one.');
