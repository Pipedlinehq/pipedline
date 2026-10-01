import { randomBytes } from 'node:crypto';
import { type ConnectionHandle, type OAuthPort, type PaymentAdapter, type PosAdapter, OAuthRefusedError } from '@ros/core';
import type { SimPaymentAdapter } from './payment';
import { type SimPosAdapter, simPosToken } from './pos';

/**
 * A simulated sign-in provider (OAuth authorisation-code flow) for a point of sale, so the
 * console's "connect by signing in" flow can be driven end to end with no real provider.
 *
 * It stands in for one sign-in plug (Square) and is never part of the default simulator set:
 * the runtime adds it only when ROS_SIM_SQUARE_OAUTH is switched on, never in production, never
 * with ROS_ADAPTERS=live, and never when real Square credentials are configured
 * (packages/runtime/src/index.ts). Three adapters are registered under the plug's key:
 *
 *   oauth    this provider. Its authorize URL is a development page on the platform host
 *            (/dev/pos-signin) with Allow and Deny, which redirects back to the console's real
 *            callback route with a `code` or an `error`, as the provider would.
 *   pos      the simulated POS (sim/pos.ts), which also refuses an account whose access has
 *            been withdrawn, the way a real provider answers 401 after a seller removes the app.
 *   payment  the simulated card processor, so a venue connected this way can still take payment.
 *
 * The access token it issues is the one the simulated POS accepts for the account
 * (`simPosToken`). It is one token per account, so revoking a single token (`everything: false`)
 * is recorded but changes nothing; ending the whole grant stops the account being served.
 */
export const SIM_SIGNIN_PAGE = '/dev/pos-signin';
const DAY = 86_400_000;

export interface SimSignIn extends OAuthPort {
  /** The person pressed Allow for this merchant account: a single-use authorisation code. */
  approve(accountRef: string): string;
  /** The seller removed the application in their own account: every token for it stops working. */
  withdraw(accountRef: string): void;
  /** True while the provider honours tokens for the account. */
  granted(accountRef: string): boolean;
  /** Accounts that have ever approved, and whether each is still granted. No tokens. */
  accounts(): Array<{ accountRef: string; granted: boolean }>;
  /** Every revoke call received, oldest first. No tokens. */
  readonly revocations: Array<{ accountRef: string | null; everything: boolean; at: Date }>;
  reset(): void;
}

export function createSimSignIn(opts: { key: string; /** `scheme://host` of the platform. */ baseUrl: string; clock?: () => Date }): SimSignIn {
  const now = () => (opts.clock ? opts.clock() : new Date());
  const codes = new Map<string, string>();
  const refreshTokens = new Map<string, string>();
  const accessTokens = new Map<string, string>();
  const grants = new Map<string, boolean>();
  const revocations: SimSignIn['revocations'] = [];

  const tokensFor = (accountRef: string, refreshToken: string) => ({
    accessToken: simPosToken(accountRef),
    refreshToken,
    expiresAt: new Date(now().getTime() + 30 * DAY),
    externalAccountId: accountRef,
  });

  return {
    key: opts.key,
    refreshAheadMs: 23 * DAY,
    revocations,

    authorizeUrl({ state, scopes }) {
      const url = new URL(SIM_SIGNIN_PAGE, opts.baseUrl);
      url.searchParams.set('plug', opts.key);
      url.searchParams.set('scope', scopes.join(' '));
      url.searchParams.set('state', state);
      return url.toString();
    },

    async exchangeCode({ code }) {
      const accountRef = codes.get(code);
      // Single use, as a real provider's codes are.
      codes.delete(code);
      if (!accountRef || !grants.get(accountRef)) throw new OAuthRefusedError('sim sign-in: 401 the authorisation code was not accepted');
      const refreshToken = `simsignin-refresh-${randomBytes(18).toString('base64url')}`;
      refreshTokens.set(refreshToken, accountRef);
      accessTokens.set(simPosToken(accountRef), accountRef);
      return tokensFor(accountRef, refreshToken);
    },

    async refresh({ refreshToken }) {
      const accountRef = refreshTokens.get(refreshToken);
      if (!accountRef || !grants.get(accountRef)) throw new OAuthRefusedError('sim sign-in: 401 the refresh token was not accepted');
      return tokensFor(accountRef, refreshToken);
    },

    async revoke({ accessToken, everything }) {
      const accountRef = accessTokens.get(accessToken) ?? null;
      revocations.push({ accountRef, everything, at: now() });
      if (!accountRef || !everything) return;
      grants.set(accountRef, false);
      for (const [token, account] of refreshTokens) if (account === accountRef) refreshTokens.delete(token);
    },

    connectionDefaults() {
      return { credentials: { webhookSecret: `sim-signin-whsec-${opts.key}` }, config: { environment: 'simulated' } };
    },

    approve(accountRef) {
      const code = `simsignin-code-${randomBytes(18).toString('base64url')}`;
      codes.set(code, accountRef);
      grants.set(accountRef, true);
      return code;
    },

    withdraw(accountRef) {
      grants.set(accountRef, false);
      for (const [token, account] of refreshTokens) if (account === accountRef) refreshTokens.delete(token);
    },

    granted(accountRef) {
      return grants.get(accountRef) === true;
    },

    accounts() {
      return [...grants].map(([accountRef, granted]) => ({ accountRef, granted }));
    },

    reset() {
      codes.clear();
      refreshTokens.clear();
      accessTokens.clear();
      grants.clear();
      revocations.length = 0;
    },
  };
}

/**
 * The simulated POS under the sign-in plug's key. Same memory as `pos` (a location seeded there
 * is the location found here); every API call first asks whether the account still grants access.
 */
export function simSignInPos(pos: SimPosAdapter, signIn: SimSignIn): PosAdapter {
  const check = (conn: ConnectionHandle) => {
    if (signIn.granted(conn.externalAccountId)) return;
    // `status` is what the ledger reads to tell "not accepted" from "down".
    throw Object.assign(new Error('sim sign-in: 401 access to this account has been withdrawn'), { status: 401 });
  };
  const guarded: Pick<PosAdapter, 'listLocations' | 'listTransactions' | 'getTransaction' | 'pushOrder' | 'applyDiscount'> = {
    listLocations: async (conn) => (check(conn), pos.listLocations(conn)),
    listTransactions: async (conn, args) => (check(conn), pos.listTransactions(conn, args)),
    getTransaction: async (conn, ref) => (check(conn), pos.getTransaction(conn, ref)),
    pushOrder: async (conn, order) => (check(conn), pos.pushOrder!(conn, order)),
    applyDiscount: async (conn, args) => (check(conn), pos.applyDiscount!(conn, args)),
  };
  // Everything else (capabilities, webhook verification and parsing) is the simulated POS's own, live.
  return Object.assign(Object.create(pos) as PosAdapter, guarded, { key: signIn.key });
}

/** The simulated card processor under the sign-in plug's key. */
export function simSignInPayment(payment: SimPaymentAdapter, key: string): PaymentAdapter {
  return Object.assign(Object.create(payment) as PaymentAdapter, { key });
}
