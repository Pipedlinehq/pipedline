import { type AdapterRegistry, type App, type AppConfig, type Clock, type LlmPort, consoleLogger, createAdapterRegistry, createApp, createDb, createPool, runDueJobs, systemClock, tableSecretStore, tickSchedules } from '@ros/core';
import { type Sim, SIM_WEBHOOK_SECRET, anthropicLlmFromEnv, createSimAdapters } from '@ros/adapters';
// Imported for its registrations (module catalogue, events, jobs, schedules, templates, tools), and
// for the model usage store the real model adapter reads budgets from.
import { hub } from '@ros/modules';
import { type AdapterMode, type Env, LiveConfigError, adapterMode, liveRequirements, readProviderEnv, simSquareSignInRequested } from './env';
import { registerLiveAdapters, unconfiguredLlm, unconfiguredStorage } from './live';

export * from './env';
export * from './live';

/**
 * The running application, built once per process from the environment.
 *
 *   ROS_ADAPTERS=sim    every provider is simulated (development, end-to-end tests)
 *   ROS_ADAPTERS=live   real providers only: each is registered when its variables are set,
 *                       and the process refuses to start without the database and email sending
 *   ROS_ADAPTERS=mixed  real where configured, simulated otherwise. Never in production.
 *
 * docs/GOING_LIVE.md says what each provider needs; `pnpm smoke:live` checks the credentials.
 */
export interface Runtime {
  app: App;
  /** Present when any provider is simulated (sim and mixed). */
  sim: Sim | null;
  mode: AdapterMode;
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

function key(name: string, devFallback: number): Buffer {
  const v = process.env[name];
  if (v) {
    const b = Buffer.from(v, 'base64');
    if (b.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded`);
    return b;
  }
  // ROS_ENV decides, not NODE_ENV: a production *build* is also what end-to-end tests run against.
  if (envName() === 'production') throw new Error(`Missing environment variable ${name}`);
  return Buffer.alloc(32, devFallback);
}

function envName(): AppConfig['env'] {
  return (process.env.ROS_ENV ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development')) as AppConfig['env'];
}

export function configFromEnv(): AppConfig {
  const env = envName();
  return {
    tenantRootDomain: process.env.ROS_TENANT_ROOT_DOMAIN ?? 'tables.localhost',
    platformHost: process.env.ROS_PLATFORM_HOST ?? 'localhost:3000',
    masterKey: key('ROS_MASTER_KEY', 3),
    signingKey: key('ROS_SIGNING_KEY', 5),
    env,
    scheme: (process.env.ROS_SCHEME as 'http' | 'https' | undefined) ?? (env === 'production' ? 'https' : 'http'),
    comms: {
      emailAdapter: process.env.ROS_EMAIL_ADAPTER ?? 'sim-email',
      smsAdapter: process.env.ROS_SMS_ADAPTER ?? 'sim-sms',
      platformSendingDomain: process.env.ROS_PLATFORM_SENDING_DOMAIN ?? 'mail.localhost',
      platformSmsSender: process.env.ROS_PLATFORM_SMS_SENDER ?? 'ROS',
      webhookSecrets: { 'sim-email': SIM_WEBHOOK_SECRET, 'sim-sms': SIM_WEBHOOK_SECRET },
    },
  };
}

/**
 * ROS_CLOCK_START=<ISO time> starts the app's clock at that instant and lets it run forward
 * from there. For end-to-end tests, so "a Friday dinner service" is reproducible whatever the
 * wall clock says. Refused in production.
 */
function clockFromEnv(env: AppConfig['env']): Clock | null {
  const start = process.env.ROS_CLOCK_START;
  if (!start) return null;
  if (env === 'production') throw new Error('ROS_CLOCK_START cannot be used in production.');
  const base = new Date(start).getTime();
  if (Number.isNaN(base)) throw new Error('ROS_CLOCK_START must be an ISO date-time.');
  const bootedAt = Date.now();
  return () => new Date(base + (Date.now() - bootedAt));
}

export interface Composition {
  mode: AdapterMode;
  registry: AdapterRegistry;
  sim: Sim | null;
  /** `config` with the sending adapters and webhook secrets the configured providers imply. */
  config: AppConfig;
  /** `kind:key` of every real adapter registered. */
  registered: string[];
}

/**
 * Choose the adapters for a mode. Touches no database and makes no provider call, so the whole
 * decision (what is registered, what is refused) can be tested from a plain object of variables.
 * Throws LiveConfigError listing every problem at once.
 */
export function composeAdapters(args: { env: Env; config: AppConfig; clock: Clock; llm?: LlmPort | null }): Composition {
  const mode = adapterMode(args.env);
  const { config, clock } = args;
  const production = config.env === 'production';
  // A simulated Square sign-in exists only beside the other simulators, which production
  // refuses below; with real Square credentials (mixed) the real adapters are used instead.
  const simSquare = simSquareSignInRequested(args.env) && !production ? { posSignIn: { plugKey: 'square', baseUrl: `${config.scheme}://${config.platformHost}` } } : {};
  if (mode === 'sim') {
    if (production) throw new Error('Simulated providers cannot run in production.');
    const { registry, sim } = createSimAdapters({ clock, ...(args.llm ? { llm: args.llm } : {}), ...simSquare });
    return { mode, registry, sim, config, registered: [] };
  }
  if (mode === 'mixed' && production) throw new Error('ROS_ADAPTERS=mixed cannot run in production: a simulated provider would stand in for a real one. Use ROS_ADAPTERS=live.');

  const read = readProviderEnv(args.env);
  const problems = [...read.problems, ...(mode === 'live' ? liveRequirements(args.env, read, production) : [])];
  if (mode === 'live' && simSquareSignInRequested(args.env)) problems.push('ROS_SIM_SQUARE_OAUTH is set (a simulated Square sign-in cannot run with ROS_ADAPTERS=live: unset it)');
  if (problems.length) throw new LiveConfigError(mode, problems);

  let registry: AdapterRegistry;
  let sim: Sim | null = null;
  if (mode === 'mixed') {
    ({ registry, sim } = createSimAdapters({ clock, ...(args.llm ? { llm: args.llm } : {}), ...(read.providers.square ? {} : simSquare) }));
  } else {
    registry = createAdapterRegistry({ llm: args.llm ?? unconfiguredLlm(), storage: unconfiguredStorage() });
  }
  const wiring = registerLiveAdapters(registry, read.providers, { clock, config });

  // An explicit ROS_EMAIL_ADAPTER / ROS_SMS_ADAPTER wins. Otherwise: the real adapter when it
  // is configured; in mixed mode the simulator; in live mode the real key even when absent, so
  // an SMS with no provider fails loudly instead of vanishing into a simulator.
  const simulated = mode === 'mixed';
  const comms: AppConfig['comms'] = {
    ...config.comms,
    emailAdapter: args.env.ROS_EMAIL_ADAPTER ?? wiring.comms.emailAdapter ?? (simulated ? 'sim-email' : 'resend'),
    smsAdapter: args.env.ROS_SMS_ADAPTER ?? wiring.comms.smsAdapter ?? (simulated ? 'sim-sms' : 'twilio'),
    webhookSecrets: { ...(simulated ? { 'sim-email': SIM_WEBHOOK_SECRET, 'sim-sms': SIM_WEBHOOK_SECRET } : {}), ...wiring.comms.webhookSecrets },
  };
  return { mode, registry, sim, config: { ...config, comms }, registered: wiring.registered };
}

export function createRuntime(opts: { clock?: Clock } = {}): Runtime {
  // Checked before anything else is read, so a live process reports every gap in one message
  // rather than stopping at the first missing key.
  const mode = adapterMode(process.env);
  if (mode === 'live') {
    const read = readProviderEnv(process.env);
    const problems = [...read.problems, ...liveRequirements(process.env, read, envName() === 'production')];
    if (problems.length) throw new LiveConfigError(mode, problems);
  }
  const base = configFromEnv();
  const clock = opts.clock ?? clockFromEnv(base.env) ?? systemClock;
  // The model: the real one whenever ANTHROPIC_API_KEY is set, even while other providers are
  // simulated; otherwise the simulator. Model ids: ROS_LLM_MODEL_FAST / ROS_LLM_MODEL_QUALITY.
  let built: App | null = null;
  const llm = anthropicLlmFromEnv(hub.llmUsageStore(() => {
    if (!built) throw new Error('The model was asked before the app was ready.');
    return built;
  }));
  const { registry, sim, config, registered } = composeAdapters({ env: process.env, config: base, clock, llm });
  const db = createDb(createPool(need('DATABASE_URL'), { max: Number(process.env.ROS_DB_POOL ?? 10) }));
  const app = createApp({ db, config, adapters: registry, secrets: tableSecretStore, clock, log: consoleLogger });
  built = app;
  if (llm) app.log.info('model: Anthropic', { fast: llm.models.fast, quality: llm.models.quality });
  if (mode !== 'sim') {
    // Names only: which providers are real in this process, and where email and SMS go.
    app.log.info('adapters', { mode, real: registered, email: config.comms.emailAdapter, sms: config.comms.smsAdapter, model: llm ? 'anthropic' : mode === 'mixed' ? 'simulated' : 'none', storage: mode === 'mixed' ? 'simulated' : 'none' });
  }
  return { app, sim, mode };
}

const GLOBAL = Symbol.for('ros.runtime');
type Holder = { [GLOBAL]?: Runtime };

/** One runtime per process, surviving hot reloads in development. */
export function getRuntime(): Runtime {
  const g = globalThis as Holder;
  return (g[GLOBAL] ??= createRuntime());
}

export interface WorkerLoop {
  stop(): Promise<void>;
}

/** Drains due jobs and ticks schedules on a timer until stopped. */
export function startWorkerLoop(app: App, opts: { intervalMs?: number; scheduleEveryMs?: number; workerId?: string } = {}): WorkerLoop {
  const interval = opts.intervalMs ?? 1000;
  const scheduleEvery = opts.scheduleEveryMs ?? 30_000;
  let stopped = false;
  let lastTick = 0;
  let running: Promise<void> = Promise.resolve();

  const loop = async () => {
    while (!stopped) {
      try {
        if (Date.now() - lastTick >= scheduleEvery) {
          lastTick = Date.now();
          await tickSchedules(app);
        }
        const r = await runDueJobs(app, { workerId: opts.workerId });
        if (r.ran === 0) await new Promise((res) => setTimeout(res, interval));
      } catch (e) {
        app.log.error('worker loop error', { error: (e as Error).message });
        await new Promise((res) => setTimeout(res, interval * 5));
      }
    }
  };
  running = loop();
  return {
    async stop() {
      stopped = true;
      await running;
    },
  };
}
