/**
 * Provider smoke check: for every provider configured in the environment, ONE harmless,
 * read-only call that proves the credentials work. Nothing is written, sent, charged or
 * dispatched, and no secret is printed.
 *
 *   pnpm smoke:live            reads the environment (and .env in the repo root, if present)
 *
 * Exit code 0 when nothing failed, 1 when any check failed. A skipped check is not a failure:
 * it means the provider is not configured, or cannot be checked without a venue's own
 * credentials (docs/GOING_LIVE.md says how to check those).
 *
 * UNVERIFIED LIVE, like the adapters it calls: this script has never been run with real
 * credentials. Its first real run is the verification.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { anthropicCheckKey, createHttpRemoteMcpAdapter, createSquareAdapter, resendListDomains, twilioGetAccount, vercelListProjectDomains } from '@ros/adapters';
import type { ConnectionHandle } from '@ros/core';
import { type Env, PROVIDERS, type ProviderId, adapterMode, liveRequirements, readProviderEnv } from '../packages/runtime/src/env';

export interface SmokeResult {
  provider: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}

export interface SmokeDeps {
  fetch?: typeof fetch;
  /** Replaced in tests. Runs `select 1` against DATABASE_URL. */
  pingDatabase?: (url: string) => Promise<string>;
}

async function pingDatabase(url: string): Promise<string> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const r = await client.query<{ db: string; migrated: boolean }>("select current_database() as db, to_regclass('public.orgs') is not null as migrated");
    return `connected to "${r.rows[0]!.db}"${r.rows[0]!.migrated ? '' : ' (no orgs table: migrations have not been applied)'}`;
  } finally {
    await client.end();
  }
}

/** A connection handle for a provider whose credentials are per venue, built from smoke-only variables. */
const handle = (plugKey: string, credentials: Record<string, string>, config: Record<string, unknown> = {}): ConnectionHandle => ({
  id: 'smoke',
  orgId: 'smoke',
  venueId: null,
  plugKey,
  externalAccountId: 'smoke',
  scopes: [],
  config,
  credentials,
});

/** Error messages from the adapters name a status and a code, never a credential. Anything else is cut short. */
const why = (e: unknown) => ((e as Error)?.message ?? String(e)).split('\n')[0]!.slice(0, 200);

export async function runSmoke(env: Env, deps: SmokeDeps = {}): Promise<SmokeResult[]> {
  const out: SmokeResult[] = [];
  const read = readProviderEnv(env);
  const p = read.providers;
  const configured = (id: ProviderId) => p[id] !== null;
  const name = (id: ProviderId) => PROVIDERS.find((s) => s.id === id)!.name;

  async function check(provider: string, fn: () => Promise<string>): Promise<void> {
    try {
      out.push({ provider, status: 'pass', detail: await fn() });
    } catch (e) {
      out.push({ provider, status: 'fail', detail: why(e) });
    }
  }
  const skip = (provider: string, detail: string) => void out.push({ provider, status: 'skip', detail });

  // Configuration mistakes first: a half-set provider is reported, not silently skipped.
  for (const problem of read.problems) out.push({ provider: 'configuration', status: 'fail', detail: problem });
  if ((env.ROS_ADAPTERS ?? '') !== '' && adapterMode(env) === 'live') {
    for (const problem of liveRequirements(env, read, (env.ROS_ENV ?? env.NODE_ENV) === 'production')) out.push({ provider: 'configuration', status: 'fail', detail: problem });
  }

  if (env.DATABASE_URL) await check('Database', () => (deps.pingDatabase ?? pingDatabase)(env.DATABASE_URL!));
  else skip('Database', 'DATABASE_URL is not set');

  if (p.resend) {
    await check(name('resend'), async () => {
      const domains = await resendListDomains({ apiKey: p.resend!.RESEND_API_KEY, fetch: deps.fetch });
      const want = env.ROS_PLATFORM_SENDING_DOMAIN;
      const mine = want ? domains.find((d) => d.name.toLowerCase() === want.toLowerCase()) : undefined;
      const platform = !want ? 'ROS_PLATFORM_SENDING_DOMAIN is not set' : mine ? `${want} is ${mine.status}` : `${want} is NOT among them: add and verify it at Resend`;
      return `key accepted; ${domains.length} domain(s); ${platform}`;
    });
  } else if (!read.problems.some((x) => x.startsWith('RESEND_'))) skip(name('resend'), 'not configured');

  if (p.twilio) {
    await check(name('twilio'), async () => {
      const a = await twilioGetAccount({ accountSid: p.twilio!.TWILIO_ACCOUNT_SID, authToken: p.twilio!.TWILIO_AUTH_TOKEN, fetch: deps.fetch });
      if (a.status !== 'active') throw new Error(`the account is ${a.status}, not active`);
      return `credentials accepted; account is active (${a.type})`;
    });
  } else if (!read.problems.some((x) => x.startsWith('TWILIO_'))) skip(name('twilio'), 'not configured');

  if (p.vercel) {
    await check(name('vercel'), async () => {
      const domains = await vercelListProjectDomains({ token: p.vercel!.VERCEL_API_TOKEN, projectId: p.vercel!.VERCEL_PROJECT_ID, teamId: p.vercel!.VERCEL_TEAM_ID, fetch: deps.fetch });
      return `token and project accepted; ${domains.length} domain(s) on the project, ${domains.filter((d) => d.verified).length} verified`;
    });
  } else if (!read.problems.some((x) => x.startsWith('VERCEL_'))) skip(name('vercel'), 'not configured');

  if (p.square) {
    // The application id and secret can only be exercised by a seller signing in. A seller's
    // (or the sandbox test account's) access token proves the API side.
    const token = env.SQUARE_SMOKE_ACCESS_TOKEN;
    if (token) {
      await check(name('square'), async () => {
        const locations = await createSquareAdapter({ fetch: deps.fetch }).listLocations(handle('square', { accessToken: token }, { environment: p.square!.SQUARE_ENVIRONMENT }));
        return `access token accepted (${p.square!.SQUARE_ENVIRONMENT}); ${locations.length} location(s)${p.square!.SQUARE_WEBHOOK_SIGNATURE_KEY ? '' : '; SQUARE_WEBHOOK_SIGNATURE_KEY is not set, so Square webhooks will be refused (polling still works)'}`;
      });
    } else {
      skip(name('square'), 'application id and secret are set, but only a sign-in exercises them. Set SQUARE_SMOKE_ACCESS_TOKEN (a sandbox test account token) to check the API, or connect a venue in the console');
    }
  } else if (!read.problems.some((x) => x.startsWith('SQUARE_'))) skip(name('square'), 'not configured');

  if (p.anthropic) {
    await check(name('anthropic'), async () => {
      const { models } = await anthropicCheckKey(p.anthropic!.ANTHROPIC_API_KEY, { fetch: deps.fetch });
      return `key accepted; models are listed (${models ? 'ok' : 'none returned'})`;
    });
  } else skip(name('anthropic'), 'not configured: model features answer "not set up"');

  if (p.criota) {
    const key = env.CRIOTA_SMOKE_ACCESS_KEY;
    if (key) {
      await check(name('criota'), async () => {
        const tools = await createHttpRemoteMcpAdapter({ key: 'criota', url: p.criota!.CRIOTA_MCP_URL, asksBeforeWriting: true, ...(deps.fetch ? { fetch: deps.fetch } : {}) }).listTools(handle('criota', { token: key }), { timeoutMs: 15_000 });
        return `server reached and key accepted; ${tools.length} tool(s) offered (listing only: no tool was called)`;
      });
    } else {
      skip(name('criota'), 'URL is set; access keys are per venue. Set CRIOTA_SMOKE_ACCESS_KEY to list its tools');
    }
  } else if (!read.problems.some((x) => x.startsWith('CRIOTA_'))) skip(name('criota'), 'not configured');

  // No platform credentials exist for these: each venue's connection carries its own, and
  // none of them offers a call that is both read-only and meaningful without one.
  for (const id of ['uberDirect', 'doordashDrive', 'klaviyo', 'metaCapi'] as const) {
    skip(name(id), configured(id) ? 'switched on; credentials are per venue and are checked when a venue connects (docs/GOING_LIVE.md)' : 'not switched on');
  }
  return out;
}

export function formatSmoke(results: SmokeResult[]): string {
  const mark = { pass: 'PASS', fail: 'FAIL', skip: 'skip' } as const;
  const width = Math.max(...results.map((r) => r.provider.length));
  const lines = results.map((r) => `${mark[r.status]}  ${r.provider.padEnd(width)}  ${r.detail}`);
  const count = (s: SmokeResult['status']) => results.filter((r) => r.status === s).length;
  return `${lines.join('\n')}\n\n${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped. Read-only: nothing was written or sent.`;
}

const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invokedDirectly) {
  const dotenv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  // Variables already in the environment win over the file.
  if (existsSync(dotenv)) process.loadEnvFile(dotenv);
  const results = await runSmoke(process.env);
  console.log(formatSmoke(results));
  process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
}
