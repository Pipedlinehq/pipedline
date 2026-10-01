import { type Env, PROVIDERS, type ProviderId, liveRequirements, readProviderEnv } from './env';

/**
 * What an operator's environment would do if the app were started with it, in plain words and
 * all at once. Pure: it reads the variables given and nothing else (no database, no provider,
 * no file), and names variables without ever repeating a value.
 *
 * It mirrors the decisions in ./index.ts (configFromEnv, composeAdapters, createRuntime): what
 * is an `error` here is what those refuse to start with, or what would start in a state the
 * operator almost certainly did not mean (a misspelt ROS_ENV running with development keys).
 * `pnpm check:config` prints it; `pnpm start:web` and `pnpm start:worker` refuse to start on an error.
 */
export interface DeploymentCheck {
  /** The app must not be started until these are fixed. */
  errors: string[];
  /** It will start, but something will not work or is unsafe outside a trial. */
  warnings: string[];
  /** What this configuration is: the mode, and which providers are real, simulated or absent. */
  summary: string[];
}

const ENVS = ['production', 'development', 'test'];
const MODES = ['sim', 'live', 'mixed'];
const DEV_DEFAULTS = { ROS_PLATFORM_HOST: 'localhost:3000', ROS_TENANT_ROOT_DOMAIN: 'tables.localhost' } as const;

/** What stops working when an optional provider is not configured. */
const WITHOUT: Record<ProviderId, string> = {
  resend: 'no email is sent: nobody can sign in, and receipts and campaigns fail',
  twilio: 'texts fail and are recorded as failed; guests can still sign in by email',
  vercel: 'a venue cannot attach its own domain from the console; sites still answer on <slug>.<ROS_TENANT_ROOT_DOMAIN>',
  square: 'no Square sign-in, sales ingest or card payments',
  uberDirect: 'not offered to venues',
  doordashDrive: 'not offered to venues',
  klaviyo: 'not offered to venues',
  metaCapi: 'not offered to venues',
  criota: 'not offered to venues',
  anthropic: 'menu import from a link and other model features answer "not set up"',
};

const value = (env: Env, name: string) => (env[name] ?? '').trim();
const present = (env: Env, name: string) => value(env, name) !== '';

function keyState(env: Env, name: string): 'ok' | 'missing' | 'bad' {
  if (!present(env, name)) return 'missing';
  return Buffer.from(value(env, name), 'base64').length === 32 ? 'ok' : 'bad';
}

export function checkDeployment(env: Env): DeploymentCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const summary: string[] = [];

  // ── Which environment, which mode ──────────────────────────────────────────────────────────
  const rosEnv = value(env, 'ROS_ENV');
  if (!rosEnv) {
    errors.push('ROS_ENV is not set. Set it to production, or to development for a trial with simulated providers. Left unset, the web app and the worker can disagree: one decides from NODE_ENV, which only the web app sets.');
  } else if (!ENVS.includes(rosEnv)) {
    errors.push(`ROS_ENV must be production or development (it is "${rosEnv}"). Anything else is treated as "not production" and would run with development defaults.`);
  }
  const production = rosEnv === 'production';

  const rawMode = value(env, 'ROS_ADAPTERS');
  let mode: 'sim' | 'live' | 'mixed' | null = null;
  if (!rawMode) errors.push('ROS_ADAPTERS is not set. Set it to live (real providers only), or to sim or mixed for a trial. Left unset it means sim, which production refuses.');
  else if (!MODES.includes(rawMode)) errors.push(`ROS_ADAPTERS must be sim, live or mixed (it is "${rawMode}").`);
  else mode = rawMode as 'sim' | 'live' | 'mixed';

  if (production && mode === 'sim') errors.push('ROS_ADAPTERS=sim cannot run with ROS_ENV=production: simulated providers are refused in production. Use ROS_ADAPTERS=live, or ROS_ENV=development for a trial.');
  if (production && mode === 'mixed') errors.push('ROS_ADAPTERS=mixed cannot run with ROS_ENV=production: a simulated provider would stand in for a real one. Use ROS_ADAPTERS=live.');

  // ── The database ───────────────────────────────────────────────────────────────────────────
  const live = mode === 'live';
  const read = readProviderEnv(env);
  // liveRequirements reports these itself for live: say each thing once.
  const liveLines = live ? liveRequirements(env, read, production) : [];
  if (!present(env, 'DATABASE_URL')) {
    if (!live) errors.push('DATABASE_URL is not set (the database)');
  } else if (!/^postgres(ql)?:\/\//.test(value(env, 'DATABASE_URL'))) {
    errors.push('DATABASE_URL must be a Postgres address: postgres://USER:PASSWORD@HOST:5432/DATABASE');
  }
  if (present(env, 'ROS_DB_POOL') && !(Number(value(env, 'ROS_DB_POOL')) >= 1)) errors.push('ROS_DB_POOL must be a whole number of connections, 1 or more.');

  // ── Keys ───────────────────────────────────────────────────────────────────────────────────
  for (const name of ['ROS_MASTER_KEY', 'ROS_SIGNING_KEY']) {
    const state = keyState(env, name);
    if (state === 'bad') {
      if (!(live && production)) errors.push(`${name} must be 32 bytes, base64-encoded (openssl rand -base64 32)`);
    } else if (state === 'missing') {
      if (production) {
        if (!live) errors.push(`${name} is not set (32 random bytes, base64: openssl rand -base64 32)`);
      } else {
        warnings.push(`${name} is not set, so a fixed development key that is printed in the source code is used. Fine for a trial on your own machine; never for real data. Changing it later makes ${name === 'ROS_MASTER_KEY' ? 'stored provider credentials unreadable' : 'signed links and tokens invalid'}.`);
      }
    }
  }
  if (keyState(env, 'ROS_MASTER_KEY') === 'ok' && value(env, 'ROS_MASTER_KEY') === value(env, 'ROS_SIGNING_KEY')) {
    warnings.push('ROS_MASTER_KEY and ROS_SIGNING_KEY are the same. Generate one for each.');
  }

  // ── Hosts ──────────────────────────────────────────────────────────────────────────────────
  for (const name of ['ROS_PLATFORM_HOST', 'ROS_TENANT_ROOT_DOMAIN'] as const) {
    if (!present(env, name)) {
      if (!(live && production)) {
        const line = `${name} is not set, so it is "${DEV_DEFAULTS[name]}"`;
        if (production) errors.push(`${line}, which nobody outside this machine can reach.`);
        else warnings.push(`${line}. That only works in a browser on this machine.`);
      }
    } else if (!/^[a-z0-9.-]+(:\d+)?$/.test(value(env, name).toLowerCase())) {
      errors.push(`${name} must be a bare host such as ${name === 'ROS_PLATFORM_HOST' ? 'console.example.com' : 'tables.example.com'}: no https://, no path${name === 'ROS_PLATFORM_HOST' ? ' (a port is allowed)' : ''}.`);
    }
  }
  const platformHost = value(env, 'ROS_PLATFORM_HOST').toLowerCase();
  const platformName = platformHost.replace(/:\d+$/, '');
  const root = value(env, 'ROS_TENANT_ROOT_DOMAIN').toLowerCase();
  if (platformHost && root) {
    if (/:\d+$/.test(root)) errors.push('ROS_TENANT_ROOT_DOMAIN must not carry a port. Venue addresses are stored without one.');
    if (platformName === root) errors.push('ROS_PLATFORM_HOST and ROS_TENANT_ROOT_DOMAIN are the same host. The console needs its own host; venue sites live at <slug>.<ROS_TENANT_ROOT_DOMAIN>.');
    else if (platformName.endsWith(`.${root}`)) warnings.push('ROS_PLATFORM_HOST is inside ROS_TENANT_ROOT_DOMAIN. It works, but the console then shares a parent domain with venue sites; a separate domain for the console is the safer layout.');
  }
  const scheme = value(env, 'ROS_SCHEME');
  if (scheme && scheme !== 'http' && scheme !== 'https') errors.push(`ROS_SCHEME must be http or https (it is "${scheme}").`);
  if (production && scheme === 'http') warnings.push('ROS_SCHEME=http with ROS_ENV=production: session cookies are sent without the Secure flag and every link the app writes is http. Use https behind a proxy that terminates TLS.');
  if (!production && rosEnv && !scheme && platformHost && !/^localhost(:\d+)?$/.test(platformHost)) {
    warnings.push('ROS_SCHEME is not set, so outside production it is http: links in emails and webhook addresses will be http://. Set ROS_SCHEME=https if the host is served over TLS.');
  }

  // ── Providers ──────────────────────────────────────────────────────────────────────────────
  if (mode && mode !== 'sim') errors.push(...read.problems);
  errors.push(...liveLines);
  if (live && value(env, 'ROS_SIM_SQUARE_OAUTH') && !['0', 'false', 'off', 'no'].includes(value(env, 'ROS_SIM_SQUARE_OAUTH').toLowerCase())) {
    errors.push('ROS_SIM_SQUARE_OAUTH is set (a simulated Square sign-in cannot run with ROS_ADAPTERS=live: unset it)');
  }
  if (!live && mode && !present(env, 'ROS_PLATFORM_SENDING_DOMAIN') && read.providers.resend) {
    warnings.push('ROS_PLATFORM_SENDING_DOMAIN is not set, so email is sent from mail.localhost, which Resend will refuse. Set it to a domain verified at Resend.');
  }

  // ── Development-only switches ──────────────────────────────────────────────────────────────
  if (present(env, 'ROS_CLOCK_START')) {
    if (production) errors.push('ROS_CLOCK_START is set. It replaces the clock and is refused in production: unset it.');
    else warnings.push('ROS_CLOCK_START is set: the app does not use the real time. Only for tests.');
  }
  if (value(env, 'ROS_INLINE_WORKER') === '1') {
    warnings.push('ROS_INLINE_WORKER=1: the web process also runs the job worker. Do not start a separate worker as well unless you mean to run two.');
  }

  // ── What this configuration is ─────────────────────────────────────────────────────────────
  if (mode && rosEnv) {
    summary.push(`ROS_ENV=${rosEnv}, ROS_ADAPTERS=${mode}: ${mode === 'live' ? 'real providers only' : mode === 'sim' ? 'every provider is simulated; nothing leaves this machine' : 'real providers where configured, simulated otherwise'}.`);
    if (!production && mode !== 'live') {
      summary.push('The development tools at /dev and /api/dev are OPEN on the platform host in this mode, including an inbox that shows every sign-in code. Never expose this mode to the internet.');
    }
    for (const spec of PROVIDERS) {
      const on = read.providers[spec.id] !== null;
      const state = mode === 'sim' ? 'simulated' : on ? 'real' : mode === 'mixed' ? 'simulated' : 'NOT CONFIGURED';
      summary.push(`${spec.name}: ${state}${state === 'NOT CONFIGURED' ? `: ${WITHOUT[spec.id]}` : ''}`);
    }
    summary.push(`File storage: ${mode === 'live' ? 'NOT AVAILABLE: there is no real storage adapter yet, so image uploads are refused' : 'simulated (kept in memory, lost on restart)'}`);
  }
  return { errors, warnings, summary };
}

export function formatDeploymentCheck(check: DeploymentCheck): string {
  const lines: string[] = [];
  for (const s of check.summary) lines.push(`  ${s}`);
  if (check.summary.length) lines.push('');
  for (const w of check.warnings) lines.push(`WARN  ${w}`);
  for (const e of check.errors) lines.push(`FIX   ${e}`);
  lines.push(check.errors.length ? `\n${check.errors.length} thing${check.errors.length === 1 ? '' : 's'} to fix before the app will start. ${check.warnings.length} warning${check.warnings.length === 1 ? '' : 's'}.` : `\nConfiguration is complete. ${check.warnings.length} warning${check.warnings.length === 1 ? '' : 's'}.`);
  return lines.join('\n');
}
