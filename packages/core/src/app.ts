import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Database, Tx } from './db';
import type { Principal } from './principal';
import { type Clock, systemClock } from './time';
import type { AdapterRegistry } from './ports/registry';
import type { SecretStore } from './secrets';

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export const consoleLogger: Logger = {
  info: (msg, f) => console.log(JSON.stringify({ level: 'info', msg, ...f })),
  warn: (msg, f) => console.warn(JSON.stringify({ level: 'warn', msg, ...f })),
  error: (msg, f) => console.error(JSON.stringify({ level: 'error', msg, ...f })),
};

export interface AppConfig {
  /** The registrable domain tenant sites live under, e.g. "tables.example". */
  tenantRootDomain: string;
  /** The host the console, the hub and the platform admin live on. A different registrable domain. */
  platformHost: string;
  /** 32 bytes. Seals provider tokens and per-org keys (packages/core/src/secrets.ts). */
  masterKey: Buffer;
  /** Signs short-lived state such as assistant confirmations. */
  signingKey: Buffer;
  env: 'test' | 'development' | 'production';
  /** 'https' everywhere except local development. */
  scheme: 'http' | 'https';
  comms: {
    /** Adapter keys (ports/messaging.ts) used for sending. */
    emailAdapter: string;
    smsAdapter: string;
    /** Transactional mail goes out as <org-slug>@<this domain>; reputation stays with the platform. */
    platformSendingDomain: string;
    platformSmsSender: string;
    /** adapter key → the secret its webhooks are signed with. */
    webhookSecrets: Record<string, string>;
  };
}

/** The tenant transaction every service function runs inside. Row-level security is on. */
export interface Ctx {
  readonly app: App;
  readonly db: Tx;
  readonly orgId: string;
  readonly principal: Principal;
  readonly requestId: string;
  readonly ip?: string;
  now(): Date;
  /** Runs after the transaction commits (cache revalidation, waking the worker). Never for business writes. */
  afterCommit(fn: () => void | Promise<void>): void;
}

/** Platform code: no tenant scoping, not subject to row-level security. Keep its use narrow. */
export interface PlatformCtx {
  readonly app: App;
  readonly db: Tx;
  readonly reason: string;
  now(): Date;
}

export interface TenantOptions {
  requestId?: string;
  ip?: string;
}

export interface App {
  readonly db: Database;
  readonly config: AppConfig;
  readonly clock: Clock;
  readonly log: Logger;
  readonly adapters: AdapterRegistry;
  readonly secrets: SecretStore;
  /**
   * Opens a short transaction acting for one org as one principal. Everything a module does to
   * tenant data happens inside one of these. Do not make provider calls inside it: read and mark
   * in one transaction, call the provider, record the outcome in a second.
   */
  tenant<T>(orgId: string, principal: Principal, fn: (ctx: Ctx) => Promise<T>, opts?: TenantOptions): Promise<T>;
  /** Platform-level work: host resolution, provisioning, schedulers, webhook de-duplication. */
  platform<T>(reason: string, fn: (pctx: PlatformCtx) => Promise<T>): Promise<T>;
}

export interface CreateAppArgs {
  db: Database;
  config: AppConfig;
  adapters: AdapterRegistry;
  secrets: (app: App) => SecretStore;
  clock?: Clock;
  log?: Logger;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApp(args: CreateAppArgs): App {
  const clock = args.clock ?? systemClock;
  const log = args.log ?? silentLogger;

  const app: App = {
    db: args.db,
    config: args.config,
    clock,
    log,
    adapters: args.adapters,
    secrets: undefined as unknown as SecretStore,

    async tenant(orgId, principal, fn, opts = {}) {
      if (!UUID_RE.test(orgId)) throw new Error('tenant(): orgId must be a uuid');
      const after: Array<() => void | Promise<void>> = [];
      const result = await args.db.transaction().execute(async (trx) => {
        // SET LOCAL ROLE + the org this transaction acts for. Both vanish at commit/rollback.
        await sql`select set_config('role', 'app_tenant', true), set_config('app.org_id', ${orgId}, true)`.execute(trx);
        const ctx: Ctx = {
          app,
          db: trx,
          orgId,
          principal,
          requestId: opts.requestId ?? randomUUID(),
          ip: opts.ip,
          now: clock,
          afterCommit: (f) => void after.push(f),
        };
        return fn(ctx);
      });
      for (const f of after) {
        try {
          await f();
        } catch (e) {
          log.error('afterCommit hook failed', { error: (e as Error).message });
        }
      }
      return result;
    },

    async platform(reason, fn) {
      return args.db.transaction().execute(async (trx) => fn({ app, db: trx, reason, now: clock }));
    },
  };

  (app as { secrets: SecretStore }).secrets = args.secrets(app);
  return app;
}
