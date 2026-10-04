import { createHmac, randomBytes } from 'node:crypto';
import { type Ctx, safeEqual } from '@ros/core';

/**
 * The two signed things the guest connection hands out. Neither is stored: each carries what it
 * stands for, an expiry, and a signature made with the venue organisation's own key
 * (`secrets.orgKey(org, 'assistant_links')`), separated by purpose, so a token minted for one
 * organisation, or for one purpose, verifies for no other.
 *
 *   proposal  `p1.<claims>.<sig>`  what a guest was asked to agree to (a booking or a cart):
 *             the venue, a digest of the details, a digest of the words they were shown, and a
 *             short expiry. Signed, not sealed: it holds digests, never the guest's details.
 *   cart      `c1.<cart>.<sig>`    the items, options and pickup slot for the venue's order page.
 *             No prices (the page prices it again) and nothing personal (no name, no notes).
 */

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const SIG_BYTES = 16;

async function sign(ctx: Ctx, purpose: 'proposal' | 'cart', body: string): Promise<string> {
  const key = await ctx.app.secrets.orgKey(ctx.orgId, 'assistant_links');
  return createHmac('sha256', key).update(`guest-plugin.${purpose}.v1\0${body}`).digest().subarray(0, SIG_BYTES).toString('base64url');
}

/** A uuid as 22 base64url characters, to keep cart links short. */
export function packId(uuid: string): string {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url');
}

export function unpackId(packed: unknown): string | null {
  if (typeof packed !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(packed)) return null;
  const hex = Buffer.from(packed, 'base64url').toString('hex');
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function split(token: unknown, prefix: string): { body: string; sig: string; json: unknown } | null {
  if (typeof token !== 'string' || token.length > 4000) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== prefix || !/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]{22}$/.test(parts[2]!)) return null;
  try {
    return { body: parts[1]!, sig: parts[2]!, json: JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) };
  } catch {
    return null;
  }
}

// ── Proposals ────────────────────────────────────────────────────────────────

export interface ProposalClaims {
  kind: 'booking' | 'order';
  venueId: string;
  /** Digest of the details asked about. */
  args: string;
  /** Digest of the words the guest was shown. */
  asked: string;
}

export type Read<T> = { ok: true; value: T; expiresAt: Date } | { ok: false; why: 'invalid' | 'expired' };

export async function mintProposal(ctx: Ctx, claims: ProposalClaims, ttlMinutes: number): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(ctx.now().getTime() + ttlMinutes * 60_000);
  const body = b64(JSON.stringify({ k: claims.kind, v: packId(claims.venueId), a: claims.args, q: claims.asked, e: expiresAt.getTime(), n: randomBytes(9).toString('base64url') }));
  return { token: `p1.${body}.${await sign(ctx, 'proposal', body)}`, expiresAt };
}

/** A proposal minted by this organisation, unaltered. Expiry is judged by the platform clock. */
export async function readProposal(ctx: Ctx, token: unknown): Promise<Read<ProposalClaims>> {
  const parts = split(token, 'p1');
  if (!parts) return { ok: false, why: 'invalid' };
  if (!safeEqual(await sign(ctx, 'proposal', parts.body), parts.sig)) return { ok: false, why: 'invalid' };
  const c = parts.json as { k?: unknown; v?: unknown; a?: unknown; q?: unknown; e?: unknown };
  const venueId = unpackId(c.v);
  if ((c.k !== 'booking' && c.k !== 'order') || !venueId || typeof c.a !== 'string' || typeof c.q !== 'string' || typeof c.e !== 'number') return { ok: false, why: 'invalid' };
  if (c.e <= ctx.now().getTime()) return { ok: false, why: 'expired' };
  return { ok: true, value: { kind: c.k, venueId, args: c.a, asked: c.q }, expiresAt: new Date(c.e) };
}

// ── Cart links ───────────────────────────────────────────────────────────────

export interface CartClaims {
  venueId: string;
  lines: Array<{ menuItemId: string; qty: number; modifierIds: string[] }>;
  /** The start of the chosen pickup slot, or null for as soon as possible. */
  slotStart: Date | null;
}

export async function mintCartToken(ctx: Ctx, cart: CartClaims, ttlMinutes: number): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(ctx.now().getTime() + ttlMinutes * 60_000);
  const body = b64(
    JSON.stringify({
      v: packId(cart.venueId),
      l: cart.lines.map((l) => [packId(l.menuItemId), l.qty, l.modifierIds.map(packId)]),
      s: cart.slotStart ? cart.slotStart.getTime() : null,
      e: expiresAt.getTime(),
      n: randomBytes(6).toString('base64url'),
    }),
  );
  return { token: `c1.${body}.${await sign(ctx, 'cart', body)}`, expiresAt };
}

/** A cart minted by this organisation, unaltered and unexpired. Anything malformed is `invalid`. */
export async function readCartToken(ctx: Ctx, token: unknown): Promise<Read<CartClaims>> {
  const parts = split(token, 'c1');
  if (!parts) return { ok: false, why: 'invalid' };
  if (!safeEqual(await sign(ctx, 'cart', parts.body), parts.sig)) return { ok: false, why: 'invalid' };
  const c = parts.json as { v?: unknown; l?: unknown; s?: unknown; e?: unknown };
  const venueId = unpackId(c.v);
  if (!venueId || !Array.isArray(c.l) || !c.l.length || c.l.length > 60 || typeof c.e !== 'number') return { ok: false, why: 'invalid' };
  if (c.s !== null && typeof c.s !== 'number') return { ok: false, why: 'invalid' };
  const lines: CartClaims['lines'] = [];
  for (const raw of c.l) {
    if (!Array.isArray(raw) || raw.length !== 3) return { ok: false, why: 'invalid' };
    const [item, qty, mods] = raw as [unknown, unknown, unknown];
    const menuItemId = unpackId(item);
    if (!menuItemId || typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > 99 || !Array.isArray(mods) || mods.length > 30) return { ok: false, why: 'invalid' };
    const modifierIds = mods.map(unpackId);
    if (modifierIds.some((m) => m === null)) return { ok: false, why: 'invalid' };
    lines.push({ menuItemId, qty, modifierIds: modifierIds as string[] });
  }
  if (c.e <= ctx.now().getTime()) return { ok: false, why: 'expired' };
  return { ok: true, value: { venueId, lines, slotStart: typeof c.s === 'number' ? new Date(c.s) : null }, expiresAt: new Date(c.e) };
}
