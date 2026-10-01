import { requireSim } from '@/lib/dev';
import { route } from '@/lib/http';

/** The simulated outbox as JSON, for end-to-end tests: GET /api/dev/sim?to=<address>. Development only. */
export const GET = route(async (req) => {
  const s = requireSim();
  const to = new URL(req.url).searchParams.get('to')?.toLowerCase();
  const pick = (list: typeof s.email.sent) =>
    list
      .filter((m) => !to || m.to.toLowerCase() === to)
      .map((m) => ({ to: m.to, channel: m.channel, kind: m.kind, subject: m.subject ?? null, body: m.body, unsubscribeUrl: m.unsubscribeUrl ?? null, at: m.at.toISOString() }));
  return { email: pick(s.email.sent), sms: pick(s.sms.sent) };
});
