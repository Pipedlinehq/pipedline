import { z } from 'zod';

/**
 * Provider configuration, read from the environment and checked before anything starts.
 *
 * A provider is "configured" when the variables that switch it on are set. A provider that is
 * half set (an account id without its token) is a mistake, not an absence, and is reported.
 * Nothing here prints or returns a secret's value in a message: problems name variables only.
 *
 * docs/GOING_LIVE.md is the human version of this file; `.env.example` lists every variable.
 */
export type Env = Record<string, string | undefined>;

export type AdapterMode = 'sim' | 'live' | 'mixed';

export function adapterMode(env: Env): AdapterMode {
  const v = env.ROS_ADAPTERS ?? 'sim';
  if (v === 'sim' || v === 'live' || v === 'mixed') return v;
  throw new Error(`ROS_ADAPTERS must be sim, live or mixed (it is "${v}").`);
}

const flag = z.enum(['1', 'true', 'on', 'yes']);

/**
 * ROS_SIM_SQUARE_OAUTH=1 asks for a simulated Square sign-in (packages/adapters/src/sim/oauth.ts),
 * so the console's "Connect Square" flow can be clicked through, and tested end to end, with no
 * Square account. Development and tests only: composeAdapters honours it only beside the other
 * simulators, refuses it with ROS_ADAPTERS=live, and lets real Square credentials win over it.
 */
export function simSquareSignInRequested(env: Env): boolean {
  return flag.safeParse((env.ROS_SIM_SQUARE_OAUTH ?? '').trim().toLowerCase()).success;
}
const set = () => z.string().trim().min(1);
const httpsUrl = z.url({ protocol: /^https$/, error: 'must be an https URL' });

/** One schema per provider, keyed by the environment variable names themselves. */
const schemas = {
  resend: z.object({
    RESEND_API_KEY: set().startsWith('re_', 'does not look like a Resend API key (re_…)'),
    RESEND_WEBHOOK_SECRET: set().startsWith('whsec_', 'does not look like a webhook signing secret (whsec_…)'),
  }),
  twilio: z.object({
    TWILIO_ACCOUNT_SID: set().regex(/^AC[0-9a-fA-F]{32}$/, 'does not look like an account SID (AC + 32 hex characters)'),
    TWILIO_AUTH_TOKEN: set(),
    TWILIO_MESSAGING_SERVICE_SID: z.string().regex(/^MG[0-9a-fA-F]{32}$/, 'does not look like a Messaging Service SID (MG + 32 hex characters)').optional(),
    TWILIO_WEBHOOK_URL: httpsUrl.optional(),
  }),
  vercel: z.object({
    VERCEL_API_TOKEN: set(),
    VERCEL_PROJECT_ID: set(),
    VERCEL_TEAM_ID: z.string().min(1).optional(),
  }),
  square: z.object({
    SQUARE_APPLICATION_ID: set(),
    SQUARE_APPLICATION_SECRET: set(),
    SQUARE_ENVIRONMENT: z.enum(['sandbox', 'production'], { error: 'must be sandbox or production' }).default('production'),
    SQUARE_WEBHOOK_SIGNATURE_KEY: z.string().min(1).optional(),
    SQUARE_WEBHOOK_URL: httpsUrl.optional(),
  }),
  criota: z.object({
    CRIOTA_MCP_URL: httpsUrl,
  }),
  anthropic: z.object({ ANTHROPIC_API_KEY: set() }),
  uberDirect: z.object({ UBER_DIRECT_ENABLED: flag }),
  doordashDrive: z.object({ DOORDASH_DRIVE_ENABLED: flag }),
  klaviyo: z.object({ KLAVIYO_ENABLED: flag }),
  metaCapi: z.object({ META_CAPI_ENABLED: flag }),
} as const;

export type ProviderId = keyof typeof schemas;

export interface ProviderSpec {
  id: ProviderId;
  name: string;
  /** The adapter keys it registers, as `kind:key`. */
  provides: string[];
  /** Setting any of these means "I am configuring this provider". */
  switches: string[];
  /** Every variable the provider reads. */
  vars: string[];
  /** Must be configured for ROS_ADAPTERS=live to start. */
  requiredForLive: boolean;
}

export const PROVIDERS: ProviderSpec[] = [
  { id: 'resend', name: 'Resend (email)', provides: ['message:resend', 'sending_domain:resend'], switches: ['RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET'], vars: ['RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET'], requiredForLive: true },
  { id: 'twilio', name: 'Twilio (SMS)', provides: ['message:twilio'], switches: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'], vars: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID', 'TWILIO_WEBHOOK_URL'], requiredForLive: false },
  { id: 'vercel', name: 'Vercel (custom domains)', provides: ['hosting:vercel'], switches: ['VERCEL_API_TOKEN', 'VERCEL_PROJECT_ID'], vars: ['VERCEL_API_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID'], requiredForLive: false },
  { id: 'square', name: 'Square (POS, payments, sign-in)', provides: ['pos:square', 'payment:square', 'oauth:square'], switches: ['SQUARE_APPLICATION_ID', 'SQUARE_APPLICATION_SECRET'], vars: ['SQUARE_APPLICATION_ID', 'SQUARE_APPLICATION_SECRET', 'SQUARE_ENVIRONMENT', 'SQUARE_WEBHOOK_SIGNATURE_KEY', 'SQUARE_WEBHOOK_URL'], requiredForLive: false },
  { id: 'uberDirect', name: 'Uber Direct (courier)', provides: ['courier:uber-direct'], switches: ['UBER_DIRECT_ENABLED'], vars: ['UBER_DIRECT_ENABLED'], requiredForLive: false },
  { id: 'doordashDrive', name: 'DoorDash Drive (courier)', provides: ['courier:doordash-drive'], switches: ['DOORDASH_DRIVE_ENABLED'], vars: ['DOORDASH_DRIVE_ENABLED'], requiredForLive: false },
  { id: 'klaviyo', name: 'Klaviyo (connected email platform)', provides: ['esp:klaviyo'], switches: ['KLAVIYO_ENABLED'], vars: ['KLAVIYO_ENABLED'], requiredForLive: false },
  { id: 'metaCapi', name: 'Meta Conversions API', provides: ['ads:meta-capi'], switches: ['META_CAPI_ENABLED'], vars: ['META_CAPI_ENABLED'], requiredForLive: false },
  { id: 'criota', name: 'Criota (remote MCP)', provides: ['remote_mcp:criota'], switches: ['CRIOTA_MCP_URL'], vars: ['CRIOTA_MCP_URL'], requiredForLive: false },
  { id: 'anthropic', name: 'Anthropic (model)', provides: ['llm'], switches: ['ANTHROPIC_API_KEY'], vars: ['ANTHROPIC_API_KEY', 'ROS_LLM_MODEL_FAST', 'ROS_LLM_MODEL_QUALITY', 'ROS_LLM_FALLBACKS'], requiredForLive: false },
];

export type ProviderConfig = { [K in ProviderId]: z.infer<(typeof schemas)[K]> | null };

export interface ProviderEnv {
  /** Each provider's validated variables, or null when it is not configured. */
  providers: ProviderConfig;
  /** Half-configured or malformed providers, one line each, naming variables only. */
  problems: string[];
}

const present = (env: Env, name: string) => (env[name] ?? '').trim() !== '';
// A flag set to "0", "false" or "off" switches a provider off rather than being a mistake.
const OFF = new Set(['0', 'false', 'off', 'no']);

/** Read every provider's variables. Never throws: the caller decides what a problem means. */
export function readProviderEnv(env: Env): ProviderEnv {
  const providers = {} as Record<ProviderId, unknown>;
  const problems: string[] = [];
  for (const spec of PROVIDERS) {
    providers[spec.id] = null;
    const on = spec.switches.filter((v) => present(env, v) && !(v.endsWith('_ENABLED') && OFF.has(env[v]!.trim().toLowerCase())));
    if (!on.length) continue;
    const picked: Record<string, string> = {};
    for (const v of spec.vars) if (present(env, v)) picked[v] = env[v]!.trim();
    const parsed = (schemas[spec.id] as z.ZodType).safeParse(picked);
    if (parsed.success) {
      providers[spec.id] = parsed.data;
      continue;
    }
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? spec.switches[0]);
      const said = present(env, name) ? issue.message : 'is not set';
      problems.push(`${name} ${said} (${spec.name}: ${on.join(', ')} ${on.length === 1 ? 'is' : 'are'} set, so the rest must be too)`);
    }
  }
  return { providers: providers as ProviderConfig, problems };
}

function keyProblem(env: Env, name: string): string | null {
  const v = env[name];
  if (!v) return `${name} is not set (32 random bytes, base64: openssl rand -base64 32)`;
  return Buffer.from(v, 'base64').length === 32 ? null : `${name} must be 32 bytes, base64-encoded (openssl rand -base64 32)`;
}

/**
 * What ROS_ADAPTERS=live cannot start without: the database, email sending, and (in
 * production) the keys and hosts that have no safe default. Returned as lines, so the caller
 * can report every gap at once rather than one per restart.
 */
export function liveRequirements(env: Env, read: ProviderEnv, production: boolean): string[] {
  const out: string[] = [];
  if (!present(env, 'DATABASE_URL')) out.push('DATABASE_URL is not set (the database)');
  for (const spec of PROVIDERS) {
    if (!spec.requiredForLive || read.providers[spec.id]) continue;
    // Already reported as half-configured: do not say it twice.
    if (spec.switches.some((v) => present(env, v))) continue;
    out.push(`${spec.switches.join(' and ')} ${spec.switches.length === 1 ? 'is' : 'are'} not set (${spec.name} is required: sign-in codes and receipts go by email)`);
  }
  if (!present(env, 'ROS_PLATFORM_SENDING_DOMAIN')) out.push('ROS_PLATFORM_SENDING_DOMAIN is not set (the domain transactional email is sent from; it must be verified at Resend)');
  if (production) {
    for (const name of ['ROS_MASTER_KEY', 'ROS_SIGNING_KEY']) {
      const p = keyProblem(env, name);
      if (p) out.push(p);
    }
    if (!present(env, 'ROS_PLATFORM_HOST')) out.push('ROS_PLATFORM_HOST is not set (the host the console and webhooks live on)');
    if (!present(env, 'ROS_TENANT_ROOT_DOMAIN')) out.push('ROS_TENANT_ROOT_DOMAIN is not set (the domain venue sites live under)');
  }
  return out;
}

/** Configuration that cannot start. `problems` is the whole list; the message shows all of it. */
export class LiveConfigError extends Error {
  readonly problems: string[];
  constructor(mode: AdapterMode, problems: string[]) {
    super(`ROS_ADAPTERS=${mode} cannot start. Fix ${problems.length === 1 ? 'this' : `these ${problems.length}`} and start again (docs/GOING_LIVE.md):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'LiveConfigError';
    this.problems = problems;
  }
}
