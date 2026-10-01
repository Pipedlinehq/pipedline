import { AppError } from '@ros/core';
import { readJson, route } from '@/lib/http';
import * as dev from '@/lib/ops-dev';

export const dynamic = 'force-dynamic';

/**
 * JSON equivalents of the /dev control page, for end-to-end tests. Development only: a 404
 * unless providers are simulated.
 *
 *   GET  /api/dev/ops/clock            the app's clock (it cannot be jumped: canJump is false)
 *   GET  /api/dev/ops/venues           every venue, for picking one
 *   GET  /api/dev/ops/sales            recent sales on the simulated POS
 *   GET  /api/dev/ops/messages         recent messages the simulated providers sent
 *   GET  /api/dev/ops/domains          domains registered with the simulated host / email provider
 *   GET  /api/dev/ops/pos-signin       what the simulated sign-in provider has seen: accounts, grants, revokes (no tokens)
 *   POST /api/dev/ops/sale             { venueId, customerEmail?, customerName?, card?, cardName?, discountCode?, discountCents?, tipCents?, deliver?: 'signed'|'forged'|'none' }
 *   POST /api/dev/ops/replay           { eventId? }  the same POS webhook again, byte for byte
 *   POST /api/dev/ops/refund           { paymentId, amountCents? }
 *   POST /api/dev/ops/pos-health       { venueId, ok, failNext? }
 *   POST /api/dev/ops/pos-seed         { accountRef, locationRef, name?, salesDaysAgo? }  a location at the simulated provider, with past sales
 *   POST /api/dev/ops/pos-signin-decide   { state, decision: allow|deny, account? }  the URL the provider would send the browser back to
 *   POST /api/dev/ops/pos-signin-withdraw { accountRef }  the seller removes the app at the provider
 *   POST /api/dev/ops/pos-signin-renew    { venueId }  run the token renewal for the venue's sign-in connection now
 *   POST /api/dev/ops/model-answer     { purpose, answer }  what the simulated model answers for a purpose
 *   POST /api/dev/ops/site-bust        { orgId }  expire what the venue site has cached for an org
 *   POST /api/dev/ops/site-tags        { on }  the deployment switch for third-party tags on venue sites, for this process
 *   POST /api/dev/ops/message-event    { messageId | providerMessageId, event: delivered|bounced|complained|unsubscribed, hard? }
 *   POST /api/dev/ops/verify-domain    { kind: hosting|sending, name }
 *   POST /api/dev/ops/criota           { action: issue|connect|describe|add|reset, … }
 *   POST /api/dev/ops/pairing-code     { venueId, name? }
 *   POST /api/dev/ops/order            { venueId, table?, guestName?, note?, items? }
 */
const GETS: Record<string, () => Promise<unknown> | unknown> = {
  clock: () => dev.serverNow(),
  venues: () => dev.devVenues(),
  sales: () => dev.recentSales(50),
  messages: () => dev.sentMessages(100),
  domains: () => dev.pendingDomains(),
  'pos-signin': () => dev.posSignInState(),
};

const POSTS: Record<string, (body: never) => Promise<unknown> | unknown> = {
  sale: dev.ringUpSale,
  replay: dev.replayPosWebhook,
  refund: dev.refundSale,
  'pos-health': dev.setPosHealth,
  'pos-seed': dev.seedPosLocation,
  'pos-signin-decide': dev.decidePosSignIn,
  'pos-signin-withdraw': dev.withdrawPosSignIn,
  'pos-signin-renew': dev.renewPosSignIn,
  'model-answer': dev.setModelAnswer,
  'site-bust': dev.bustSiteCache,
  'site-tags': dev.setSiteTags,
  'message-event': dev.deliverMessageEvent,
  'verify-domain': dev.verifyDomain,
  criota: dev.criota,
  'pairing-code': dev.kitchenPairingCode,
  order: dev.placeDevOrder,
};

type Ctx = { params: Promise<{ action: string }> };

const missing = () => new AppError('not_found', 'Not found');
// Checked before route(): next/navigation's notFound() is not an AppError, and route() would answer it as a 500.
const guard = <A extends unknown[]>(h: (req: Request, ...a: A) => Promise<Response>) => (req: Request, ...a: A) => (dev.devToolsAvailable() ? h(req, ...a) : Promise.resolve(new Response('Not found', { status: 404 })));

export const GET = guard(
  route(async (_req, { params }: Ctx) => {
    const fn = GETS[(await params).action];
    if (!fn) throw missing();
    return { data: await fn() };
  }),
);

export const POST = guard(
  route(async (req, { params }: Ctx) => {
    const fn = POSTS[(await params).action];
    if (!fn) throw missing();
    const body = await readJson(req);
    return { data: await fn(body as never) };
  }),
);
