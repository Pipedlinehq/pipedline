import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, type ConnectionRow, type Principal, invalid, listConnections, markConnectionHealth, notFound, resolveConnection } from '@ros/core';
import { SIM_PAY_TOKENS, SIM_WEBHOOK_SECRET, type Sim, type SimSignIn, simPosToken } from '@ros/adapters';
import { auth, hub, ledger, menu, ordering } from '@ros/modules';
import { posSignInCallbackPath } from './pos-signin';
import { requireSim } from './dev';
import { app, sim } from './runtime';
import { bustSite } from './site-revalidate';

/**
 * The development tools behind /dev and /api/dev/ops/*: steer the simulated providers so a
 * person (or an end-to-end test) can exercise the whole system by hand. Every entry point calls
 * requireSim() first, which is a 404 unless providers are simulated and the environment is not
 * production.
 *
 * These tools act as a named worker principal inside the org they touch, the way a provider's
 * own system or a background job would. Provider-side effects (a sale at the till, a bounce)
 * reach the application only as signed webhooks delivered over HTTP to the real routes.
 */
/** Whether the development tools exist in this process (simulated providers, not production). */
export function devToolsAvailable(): boolean {
  return !!sim() && app().config.env !== 'production';
}

const DEV: Principal = { kind: 'worker', job: 'dev-tools' };

export interface DevVenue {
  orgId: string;
  orgSlug: string;
  orgName: string;
  venueId: string;
  venueName: string;
}

/** Every venue, for the pickers. Development only: a platform read across orgs. */
export async function devVenues(): Promise<DevVenue[]> {
  requireSim();
  const rows = await app()
    .db.selectFrom('venues as v')
    .innerJoin('orgs as o', 'o.id', 'v.org_id')
    .select(['o.id as orgId', 'o.slug as orgSlug', 'o.trading_name as orgName', 'v.id as venueId', 'v.name as venueName'])
    .where('o.status', '!=', 'closed')
    .orderBy('o.trading_name')
    .orderBy('v.name')
    .execute();
  return rows;
}

async function venue(venueId: string): Promise<DevVenue> {
  if (!z.string().uuid().safeParse(venueId).success) throw notFound('Venue not found');
  const v = (await devVenues()).find((x) => x.venueId === venueId);
  if (!v) throw notFound('Venue not found');
  return v;
}

/** The simulated POS connection of a venue, with what signing and ringing up a sale need. */
async function posConnection(venueId: string): Promise<{ v: DevVenue; row: ConnectionRow; accountRef: string; locationRef: string; secret: string }> {
  const v = await venue(venueId);
  const row = await app().tenant(v.orgId, DEV, async (ctx) => (await listConnections(ctx, { venueId, plugKey: 'sim-pos' })).find((c) => c.status !== 'revoked'));
  if (!row) throw invalid(`${v.venueName} has no simulated POS connected.`);
  const handle = await resolveConnection(app(), row);
  const locationRef = String((handle.config as { locationRef?: unknown }).locationRef ?? '');
  const secret = handle.credentials.webhookSecret;
  if (!locationRef || !secret) throw invalid('That POS connection has no location or webhook secret.');
  return { v, row, accountRef: row.external_account_id, locationRef, secret };
}

export interface Delivery {
  url: string;
  status: number;
  body: unknown;
}

/** POST a webhook to this app's own route, over HTTP, exactly as a provider would. */
async function deliver(path: string, w: { rawBody: string; headers: Record<string, string> }): Promise<Delivery> {
  const a = app();
  const url = `${a.config.scheme}://${a.config.platformHost}${path}`;
  const res = await fetch(url, { method: 'POST', body: w.rawBody, headers: w.headers, cache: 'no-store' });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { url, status: res.status, body };
}

// ── Point of sale ──────────────────────────────────────────────────────────────────────────

export const saleInput = z.object({
  venueId: z.string().uuid(),
  /** A known guest: the sale carries their details as the POS's customer record. */
  customerEmail: z.string().email().optional(),
  customerName: z.string().max(80).optional(),
  /** Pay by card; name the card to pay twice with "the same card". */
  card: z.boolean().default(true),
  cardName: z.string().max(40).optional(),
  discountCode: z.string().max(40).optional(),
  discountCents: z.number().int().min(0).max(100_000).optional(),
  tipCents: z.number().int().min(0).max(100_000).optional(),
  /** 'signed' (default) delivers the webhook; 'forged' signs it with the wrong secret; 'none' only rings it up. */
  deliver: z.enum(['signed', 'forged', 'none']).default('signed'),
});

export interface SaleResult {
  paymentId: string;
  orgId: string;
  venueId: string;
  totalCents: number;
  eventId: string | null;
  delivery: Delivery | null;
}

export async function ringUpSale(raw: z.input<typeof saleInput>): Promise<SaleResult> {
  const s = requireSim();
  const input = saleInput.parse(raw);
  const p = await posConnection(input.venueId);
  const [first, ...rest] = (input.customerName ?? '').trim().split(/\s+/);
  const sale = s.pos.createSale({
    accountRef: p.accountRef,
    locationRef: p.locationRef,
    tender: input.card ? 'card' : 'cash',
    ...(input.card ? { card: input.cardName ? { fingerprint: `devcard-${input.cardName}` } : {} } : {}),
    ...(input.customerEmail ? { customer: { email: input.customerEmail, firstName: first || null, lastName: rest.join(' ') || null } } : {}),
    ...(input.discountCents ? { discount: { name: input.discountCode ? `Code ${input.discountCode}` : 'Discount', code: input.discountCode ?? null, amountCents: input.discountCents } } : {}),
    tipCents: input.tipCents,
  });
  const out: SaleResult = { paymentId: sale.id, orgId: p.v.orgId, venueId: p.v.venueId, totalCents: sale.total_money.amount, eventId: null, delivery: null };
  if (input.deliver !== 'none') {
    const w = s.pos.webhook(input.deliver === 'forged' ? `forged-${randomUUID()}` : p.secret, { accountRef: p.accountRef, paymentIds: [sale.id] });
    out.eventId = w.eventId;
    out.delivery = await deliver('/webhooks/pos/sim-pos', w);
  }
  return out;
}

/** The same webhook again, byte for byte: a provider retry. */
export async function replayPosWebhook(raw: { eventId?: string }): Promise<Delivery> {
  const s = requireSim();
  const w = s.pos.duplicate(raw.eventId || undefined);
  return deliver('/webhooks/pos/sim-pos', w);
}

export const refundInput = z.object({ paymentId: z.string().min(1).max(100), amountCents: z.number().int().positive().optional() });

/** Refund a sale at the till and deliver the provider's webhook for it. */
export async function refundSale(raw: z.input<typeof refundInput>): Promise<{ paymentId: string; refundedCents: number; delivery: Delivery }> {
  const s = requireSim();
  const input = refundInput.parse(raw);
  const sale = s.pos.get(input.paymentId);
  if (!sale) throw notFound('No such sale on the simulated POS.');
  const conns = await devVenues();
  let secret: string | null = null;
  for (const v of conns) {
    try {
      const p = await posConnection(v.venueId);
      if (p.accountRef === sale.account_id && p.locationRef === sale.location_id) {
        secret = p.secret;
        break;
      }
    } catch {
      // venue without a simulated POS
    }
  }
  if (!secret) throw invalid('No connection maps that sale.');
  const refunded = s.pos.refund(input.paymentId, input.amountCents);
  const w = s.pos.webhook(secret, { accountRef: sale.account_id, paymentIds: [sale.id], type: 'refund.updated' });
  return { paymentId: sale.id, refundedCents: refunded.refunded_money.amount, delivery: await deliver('/webhooks/pos/sim-pos', w) };
}

export const posSeedInput = z.object({
  /** A merchant account at the simulated POS provider. Made on first use. */
  accountRef: z.string().regex(/^[a-z0-9-]{3,80}$/),
  locationRef: z.string().regex(/^[a-z0-9-]{3,80}$/),
  name: z.string().min(1).max(80).default('Simulated location'),
  /** Sales already taken at that location, each this many days ago. They sit at the provider until a connection fetches them. */
  salesDaysAgo: z.array(z.number().min(0).max(1000)).max(50).default([]),
});

/**
 * Stand up a location at the simulated POS provider, with some past sales, before anything is
 * connected to it: what a venue's existing till looks like on the day it connects.
 */
export function seedPosLocation(raw: z.input<typeof posSeedInput>): { accountRef: string; locationRef: string; paymentIds: string[] } {
  const s = requireSim();
  const input = posSeedInput.parse(raw);
  s.pos.addLocation(input.accountRef, { ref: input.locationRef, name: input.name, timezone: 'Australia/Sydney' });
  const now = app().clock().getTime();
  const paymentIds = input.salesDaysAgo.map((d) => s.pos.createSale({ accountRef: input.accountRef, locationRef: input.locationRef, tender: 'card', card: {}, at: new Date(now - d * 86_400_000) }).id);
  return { accountRef: input.accountRef, locationRef: input.locationRef, paymentIds };
}

/** Recent sales on the simulated POS across every connected account, newest first, for the control page. */
export async function recentSales(limit = 12): Promise<Array<{ id: string; venueName: string; totalCents: number; refundedCents: number; at: string; status: string }>> {
  const s = requireSim();
  const out: Array<{ id: string; venueName: string; totalCents: number; refundedCents: number; at: string; status: string }> = [];
  for (const v of await devVenues()) {
    let p: Awaited<ReturnType<typeof posConnection>>;
    try {
      p = await posConnection(v.venueId);
    } catch {
      continue;
    }
    for (const sale of s.pos.sales({ accountRef: p.accountRef, locationRef: p.locationRef })) {
      out.push({ id: sale.id, venueName: v.venueName, totalCents: sale.total_money.amount, refundedCents: sale.refunded_money.amount, at: sale.created_at, status: sale.status });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

export const posHealthInput = z.object({
  venueId: z.string().uuid(),
  ok: z.boolean(),
  /** Also make the next n calls to the simulated POS fail, as an outage would. */
  failNext: z.number().int().min(0).max(50).default(0),
});

/** Drop (or restore) a venue's POS connection health, as a failed sync would. */
export async function setPosHealth(raw: z.input<typeof posHealthInput>): Promise<{ connectionId: string; status: string }> {
  const s = requireSim();
  const input = posHealthInput.parse(raw);
  const p = await posConnection(input.venueId);
  if (input.failNext) s.pos.failNext(input.failNext, 'Simulated POS outage');
  await markConnectionHealth(app(), p.row.id, input.ok ? { ok: true } : { ok: false, error: 'Simulated outage: the point of sale is not answering.' });
  return { connectionId: p.row.id, status: input.ok ? 'connected' : 'unhealthy' };
}

// ── Simulated sign-in at a point of sale (the stand-in for Square's sign-in page) ──────────

/** The simulated sign-in provider, when this process has one (ROS_SIM_SQUARE_OAUTH). Null otherwise. */
export function simPosSignIn(): SimSignIn | null {
  return devToolsAvailable() ? (sim()?.posSignIn ?? null) : null;
}

function requirePosSignIn(): { s: Sim; signIn: SimSignIn } {
  const s = requireSim();
  if (!s.posSignIn) throw notFound('No simulated sign-in is switched on in this process (ROS_SIM_SQUARE_OAUTH=1).');
  return { s, signIn: s.posSignIn };
}

const accountRef = z.string().regex(/^[a-z0-9-]{3,80}$/, 'A merchant account is 3 to 80 lowercase letters, digits and hyphens.');
export const posSignInDecisionInput = z.object({ state: z.string().min(1).max(4000), decision: z.enum(['allow', 'deny']), account: z.string().optional() });

/**
 * What the provider does when the person presses Allow or Deny on its sign-in page: the URL it
 * sends the browser back to, on the console's real callback route. Allow carries a single-use
 * code for the merchant account named; Deny carries the error a provider sends.
 */
export async function decidePosSignIn(raw: z.input<typeof posSignInDecisionInput>): Promise<{ redirectTo: string }> {
  const { s, signIn } = requirePosSignIn();
  const input = posSignInDecisionInput.parse(raw);
  const a = app();
  const url = new URL(posSignInCallbackPath(signIn.key), `${a.config.scheme}://${a.config.platformHost}`);
  if (input.decision === 'deny') {
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'user_denied');
  } else {
    const account = accountRef.parse((input.account ?? '').trim());
    // A merchant account always has somewhere it trades: one nobody seeded gets a single location.
    const known = await s.pos.listLocations({ id: 'dev', orgId: 'dev', venueId: null, plugKey: 'sim-pos', externalAccountId: account, scopes: [], config: {}, credentials: { accessToken: simPosToken(account) } });
    if (!known.length) s.pos.addLocation(account, { ref: `${account}-main`, name: 'Main counter', timezone: 'Australia/Sydney' });
    url.searchParams.set('code', signIn.approve(account));
    url.searchParams.set('response_type', 'code');
  }
  url.searchParams.set('state', input.state);
  return { redirectTo: url.toString() };
}

/** What the simulated sign-in provider has seen: who approved, who is still granted, every revoke. No tokens. */
export function posSignInState(): { plugKey: string; accounts: Array<{ accountRef: string; granted: boolean }>; revocations: Array<{ accountRef: string | null; everything: boolean }> } {
  const { signIn } = requirePosSignIn();
  return { plugKey: signIn.key, accounts: signIn.accounts(), revocations: signIn.revocations.map((r) => ({ accountRef: r.accountRef, everything: r.everything })) };
}

/** The seller removes the application in their own account at the provider: every token for the account stops working. */
export function withdrawPosSignIn(raw: { accountRef?: unknown }): { accountRef: string; granted: false } {
  const { signIn } = requirePosSignIn();
  const account = accountRef.parse(raw.accountRef);
  signIn.withdraw(account);
  return { accountRef: account, granted: false };
}

/** Run the token renewal for a venue's sign-in connection now, as the six-hourly sweep would. */
export async function renewPosSignIn(raw: { venueId: string }): Promise<{ connectionId: string; outcome: ledger.PosOAuthRefresh }> {
  const { signIn } = requirePosSignIn();
  const v = await venue(raw.venueId);
  const row = await app().tenant(v.orgId, DEV, async (ctx) => (await listConnections(ctx, { venueId: v.venueId, plugKey: signIn.key })).find((c) => c.status !== 'revoked'));
  if (!row) throw invalid(`${v.venueName} has no sign-in connection.`);
  return { connectionId: row.id, outcome: await ledger.refreshPosOAuth(app(), { orgId: v.orgId, connectionId: row.id, force: true }) };
}

// ── Messages ───────────────────────────────────────────────────────────────────────────────

export const messageEventInput = z.object({
  /** Our message id (messages.id) or the provider's. */
  messageId: z.string().max(200).optional(),
  providerMessageId: z.string().max(200).optional(),
  event: z.enum(['delivered', 'bounced', 'complained', 'unsubscribed']),
  /** A bounce is hard (the address does not exist) unless this is false. */
  hard: z.boolean().default(true),
});

export interface SentMessageView {
  providerMessageId: string;
  adapter: string;
  channel: string;
  to: string;
  subject: string | null;
  kind: string;
  at: string;
}

export function sentMessages(limit = 25): SentMessageView[] {
  const s = requireSim();
  const pick = (adapter: Sim['email']) =>
    adapter.sent.map((m) => ({ providerMessageId: m.providerMessageId, adapter: adapter.key, channel: m.channel, to: m.to, subject: m.subject ?? null, kind: m.kind, at: m.at.toISOString() }));
  return [...pick(s.email), ...pick(s.sms)].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** Deliver a provider event (delivered, bounce, complaint, STOP) for one sent message, as a signed webhook. */
export async function deliverMessageEvent(raw: z.input<typeof messageEventInput>): Promise<Delivery & { providerMessageId: string }> {
  const s = requireSim();
  const input = messageEventInput.parse(raw);
  let providerMessageId = input.providerMessageId ?? null;
  if (!providerMessageId && input.messageId) {
    if (!z.string().uuid().safeParse(input.messageId).success) throw notFound('Message not found');
    // Development lookup of a message by its id, across orgs, to find what the provider called it.
    const row = await app().db.selectFrom('messages').select(['provider_message_id']).where('id', '=', input.messageId).executeTakeFirst();
    providerMessageId = row?.provider_message_id ?? null;
  }
  if (!providerMessageId) throw invalid('That message has not been sent yet (it has no provider id).');
  const adapter = [s.email, s.sms].find((a) => a.sent.some((m) => m.providerMessageId === providerMessageId));
  if (!adapter) throw notFound('The simulated providers did not send that message.');
  const sent = adapter.sent.find((m) => m.providerMessageId === providerMessageId)!;
  const w = adapter.webhook(SIM_WEBHOOK_SECRET, [
    { providerMessageId, event: input.event, hardBounce: input.event === 'bounced' ? input.hard : false, accountRef: sent.accountRef, address: sent.to, metadata: {} },
  ]);
  return { providerMessageId, ...(await deliver(`/webhooks/messages/${adapter.key}`, w)) };
}

// ── Domains ────────────────────────────────────────────────────────────────────────────────

export function pendingDomains(): Array<{ kind: 'hosting' | 'sending'; name: string; verified: boolean }> {
  const s = requireSim();
  const list = (kind: 'hosting' | 'sending', m: Sim['hosting']['domains']) => [...m.values()].filter((d) => !d.removed).map((d) => ({ kind, name: d.name, verified: d.verified }));
  return [...list('hosting', s.hosting.domains), ...list('sending', s.sendingDomains.domains)];
}

export const verifyDomainInput = z.object({ kind: z.enum(['hosting', 'sending']), name: z.string().min(3).max(253) });

/** Act as the venue adding its DNS records: the provider's next check finds the domain verified. */
export function verifyDomain(raw: z.input<typeof verifyDomainInput>): { kind: string; name: string; verified: true } {
  const s = requireSim();
  const input = verifyDomainInput.parse(raw);
  try {
    (input.kind === 'hosting' ? s.hosting : s.sendingDomains).verify(input.name.toLowerCase());
  } catch (e) {
    throw invalid((e as Error).message);
  }
  return { kind: input.kind, name: input.name, verified: true };
}

// ── Criota (remote MCP plug) ───────────────────────────────────────────────────────────────

export const criotaInput = z.discriminatedUnion('action', [
  /** What the venue would do in Criota's own settings: make an access key to paste into the console. */
  z.object({ action: z.literal('issue'), account: z.string().max(80).optional() }),
  z.object({ action: z.literal('connect'), orgId: z.string().uuid(), account: z.string().max(80).optional() }),
  z.object({ action: z.literal('describe'), tool: z.string().min(1).max(80), description: z.string().min(1).max(500) }),
  z.object({ action: z.literal('add'), tool: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/), description: z.string().min(1).max(500) }),
  z.object({ action: z.literal('reset') }),
]);

/** Change what the simulated Criota server offers, or connect an org to it. A changed tool list withdraws the plug until it is reviewed again. */
export async function criota(raw: z.input<typeof criotaInput>): Promise<Record<string, unknown>> {
  const s = requireSim();
  const input = criotaInput.parse(raw);
  switch (input.action) {
    case 'issue':
      return { accessKey: s.criota.issueKey(input.account ?? 'Oak Diner') };
    case 'connect': {
      const key = s.criota.issueKey(input.account ?? 'Oak Diner');
      const row = await app().tenant(input.orgId, DEV, (ctx) => hub.connectMcpPlug(ctx, { plugKey: 'criota-sim', accessKey: key, account: input.account ?? 'Oak Diner' }));
      const checks = await hub.checkPlugConnections(app(), input.orgId);
      return { connectionId: row.id, checks };
    }
    case 'describe':
      s.criota.setDescription(input.tool, input.description);
      return { changed: input.tool };
    case 'add':
      s.criota.addTool(input.tool, input.description);
      return { added: input.tool };
    case 'reset':
      s.criota.reset();
      return { reset: true };
  }
}

// ── The venue site's cache ─────────────────────────────────────────────────────────────────

/**
 * Expire what the venue site has cached for one org, as a publish made in this process would.
 * For a change made from outside it (a script, another process), which cannot reach this cache.
 */
export function bustSiteCache(raw: { orgId?: string }): { busted: string } {
  requireSim();
  const orgId = z.string().uuid().parse(raw.orgId);
  bustSite(orgId);
  return { busted: orgId };
}

/**
 * The deployment switch for third-party tags on venue sites (ROS_SITE_TAGS), flipped for this
 * process. It is off unless a deployment sets it; a scenario turns it on to prove the visitor's
 * choice gates the tags, and off again.
 */
export function setSiteTags(raw: { on?: unknown }): { on: boolean } {
  requireSim();
  const on = raw.on === true;
  if (on) process.env.ROS_SITE_TAGS = '1';
  else delete process.env.ROS_SITE_TAGS;
  return { on };
}

// ── The model ──────────────────────────────────────────────────────────────────────────────

export const modelAnswerInput = z.object({ purpose: z.string().min(1).max(100), answer: z.unknown() });

/**
 * Script what the simulated model answers for one purpose (the menu a menu import "reads").
 * The answer still passes through the caller's own schema, as a real model's would.
 */
export function setModelAnswer(raw: z.input<typeof modelAnswerInput>): { purpose: string } {
  const s = requireSim();
  const input = modelAnswerInput.parse(raw);
  if (typeof (s.llm as { respond?: unknown }).respond !== 'function') throw invalid('A real model is configured here; its answers cannot be scripted.');
  s.llm.respond(input.purpose, () => input.answer);
  return { purpose: input.purpose };
}

// ── Kitchen ────────────────────────────────────────────────────────────────────────────────

/** A pairing code for a kitchen screen at a venue, as a manager would make in the console. */
export async function kitchenPairingCode(raw: { venueId: string; name?: string }): Promise<{ code: string; deviceId: string; expiresAt: Date; venueName: string }> {
  requireSim();
  const v = await venue(raw.venueId);
  const r = await app().tenant(v.orgId, DEV, (ctx) => auth.createDevicePairing(ctx, { venueId: v.venueId, name: raw.name?.trim() || 'Kitchen screen (dev)', purpose: 'kitchen' }));
  return { ...r, venueName: v.venueName };
}

export const devOrderInput = z.object({
  venueId: z.string().uuid(),
  /** A table order (through one of the venue's table QR codes) instead of a pickup. */
  table: z.boolean().default(false),
  guestName: z.string().max(80).optional(),
  /** Where the guest's confirmation goes. A fresh address by default. */
  guestEmail: z.string().email().optional(),
  note: z.string().max(300).optional(),
  /** Menu item names (prefix match). Default: two dishes that carry allergens. */
  items: z.array(z.string().max(100)).max(10).optional(),
});

/**
 * Place and pay an order at a venue as a guest would, through the ordering service and the
 * simulated card processor. The paid order reaches the kitchen screen like any other.
 */
export async function placeDevOrder(raw: z.input<typeof devOrderInput>): Promise<{ orderId: string; reference: string; status: string; ticketExpected: boolean }> {
  requireSim();
  const input = devOrderInput.parse(raw);
  const v = await venue(input.venueId);
  const a = app();
  const anon: Principal = { kind: 'anon' };
  const qrCode = input.table
    ? await a.tenant(v.orgId, DEV, async (ctx) =>
        (await ctx.db.selectFrom('qr_codes').select('code').where('venue_id', '=', v.venueId).where('kind', '=', 'table').where('is_active', '=', true).orderBy('label').executeTakeFirst())?.code ?? null,
      )
    : null;
  if (input.table && !qrCode) throw invalid(`${v.venueName} has no table QR codes.`);
  const surface = input.table ? 'in_venue' : 'online';
  const m = await a.tenant(v.orgId, anon, (ctx) => menu.getPublicMenu(ctx, v.venueId, { surface }));
  const all = m.menus.flatMap((x) => x.sections.flatMap((s) => s.items)).filter((i) => i.isAvailable && !i.isAlcohol && !i.modifierGroups.some((g) => g.isRequired || g.minSelections > 0));
  if (!all.length) throw invalid(`Nothing on ${v.venueName}'s menu can be ordered right now.`);
  const wanted = input.items?.length ? input.items : null;
  const picked = wanted
    ? wanted.map((name) => {
        const hit = all.find((i) => i.name.toLowerCase().startsWith(name.toLowerCase()));
        if (!hit) throw invalid(`No orderable item starting "${name}".`);
        return hit;
      })
    : [...all.filter((i) => i.allergens.length).slice(0, 2), ...all.filter((i) => !i.allergens.length).slice(0, 1)].slice(0, 3);
  const order = await a.tenant(v.orgId, anon, (ctx) =>
    ordering.createOrder(ctx, {
      venueId: v.venueId,
      channel: input.table ? 'dine-in-qr' : 'pickup',
      qrCode,
      lines: picked.map((i, n) => ({ menuItemId: i.id, qty: n === 0 ? 2 : 1 })),
      idempotencyKey: `dev-order-${randomUUID()}`,
      customer: input.table ? {} : { name: input.guestName ?? 'Dev Guest', email: input.guestEmail ?? `dev.${randomUUID().slice(0, 8)}@example.com` },
      note: input.note ?? null,
    }),
  );
  const paid = await ordering.payOrder(a, { orgId: v.orgId, principal: anon }, { trackingToken: order.trackingToken!, sourceToken: `${SIM_PAY_TOKENS.ok}:dev-${randomUUID()}` });
  if (paid.status !== 'paid') throw new AppError('conflict', `The simulated card was declined: ${paid.message}`);
  return { orderId: order.id, reference: order.reference, status: paid.order.status, ticketExpected: true };
}

/** The app's clock. The runtime's clock only runs forward from ROS_CLOCK_START; it cannot be jumped. */
export function serverNow(): { now: string; canJump: false } {
  requireSim();
  return { now: app().clock().toISOString(), canJump: false };
}
