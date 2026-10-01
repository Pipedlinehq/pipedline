import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@ros/core';
import { LiveConfigError, PROVIDERS, adapterMode, composeAdapters, liveRequirements, readProviderEnv, webhookUrls } from '@ros/runtime';

/**
 * Which adapters a process gets for a given environment, and what it refuses to start
 * without. No database and no provider is touched: composeAdapters only decides.
 */
const config = (env: AppConfig['env'] = 'development'): AppConfig => ({
  tenantRootDomain: 'tables.example',
  platformHost: 'console.example',
  masterKey: Buffer.alloc(32, 1),
  signingKey: Buffer.alloc(32, 2),
  env,
  scheme: 'https',
  comms: { emailAdapter: 'sim-email', smsAdapter: 'sim-sms', platformSendingDomain: 'mail.example', platformSmsSender: 'ROS', webhookSecrets: { 'sim-email': 'x', 'sim-sms': 'x' } },
});
const clock = () => new Date('2026-10-01T00:00:00Z');
const compose = (env: Record<string, string>, appEnv: AppConfig['env'] = 'development') => composeAdapters({ env, config: config(appEnv), clock });

const KEY32 = Buffer.alloc(32, 9).toString('base64');
const RESEND = { RESEND_API_KEY: 're_live_abc', RESEND_WEBHOOK_SECRET: 'whsec_c2VjcmV0c2VjcmV0c2VjcmV0' };
const MINIMUM = { ROS_ADAPTERS: 'live', DATABASE_URL: 'postgres://u:p@db.example/ros', ROS_PLATFORM_SENDING_DOMAIN: 'mail.example', ...RESEND };
const PRODUCTION = { ...MINIMUM, ROS_MASTER_KEY: KEY32, ROS_SIGNING_KEY: KEY32, ROS_PLATFORM_HOST: 'console.example', ROS_TENANT_ROOT_DOMAIN: 'tables.example' };
const TWILIO = { TWILIO_ACCOUNT_SID: 'AC' + '0123456789abcdef0123456789abcdef', TWILIO_AUTH_TOKEN: 'twilio-auth-token-value' };
const EVERYTHING = {
  ...PRODUCTION,
  ...TWILIO,
  TWILIO_MESSAGING_SERVICE_SID: 'MG0123456789abcdef0123456789abcdef',
  VERCEL_API_TOKEN: 'vercel-token-value',
  VERCEL_PROJECT_ID: 'prj_ros',
  VERCEL_TEAM_ID: 'team_ros',
  SQUARE_APPLICATION_ID: 'sq0idp-app',
  SQUARE_APPLICATION_SECRET: 'sq0csp-secret-value',
  SQUARE_ENVIRONMENT: 'sandbox',
  SQUARE_WEBHOOK_SIGNATURE_KEY: 'square-signature-key-value',
  UBER_DIRECT_ENABLED: '1',
  DOORDASH_DRIVE_ENABLED: 'true',
  KLAVIYO_ENABLED: '1',
  META_CAPI_ENABLED: '1',
  CRIOTA_MCP_URL: 'https://mcp.criota.example/mcp',
};

const failure = (fn: () => unknown): LiveConfigError => {
  try {
    fn();
  } catch (e) {
    return e as LiveConfigError;
  }
  throw new Error('expected it to refuse');
};

describe('ROS_ADAPTERS', () => {
  it('is sim by default, and anything but sim, live or mixed is refused', () => {
    expect(adapterMode({})).toBe('sim');
    expect(adapterMode({ ROS_ADAPTERS: 'mixed' })).toBe('mixed');
    expect(() => adapterMode({ ROS_ADAPTERS: 'real' })).toThrow('ROS_ADAPTERS must be sim, live or mixed (it is "real").');
  });

  it('sim: every provider simulated, nothing real, refused in production', () => {
    const c = compose({});
    expect(c.mode).toBe('sim');
    expect(c.sim).not.toBeNull();
    expect(c.registered).toEqual([]);
    expect(c.registry.keys('message').sort()).toEqual(['sim-email', 'sim-sms']);
    // Real credentials lying around in the environment are not picked up in sim mode.
    expect(compose({ ...RESEND, ...TWILIO }).registry.keys('message').sort()).toEqual(['sim-email', 'sim-sms']);
    expect(() => compose({}, 'production')).toThrow('Simulated providers cannot run in production.');
  });
});

describe('ROS_ADAPTERS=live', () => {
  it('with nothing set, refuses once, listing everything that is missing', () => {
    const err = failure(() => compose({ ROS_ADAPTERS: 'live' }));
    expect(err).toBeInstanceOf(LiveConfigError);
    expect(err.problems).toEqual([
      'DATABASE_URL is not set (the database)',
      'RESEND_API_KEY and RESEND_WEBHOOK_SECRET are not set (Resend (email) is required: sign-in codes and receipts go by email)',
      'ROS_PLATFORM_SENDING_DOMAIN is not set (the domain transactional email is sent from; it must be verified at Resend)',
    ]);
    expect(err.message).toBe(`ROS_ADAPTERS=live cannot start. Fix these 3 and start again (docs/GOING_LIVE.md):\n${err.problems.map((p) => `  - ${p}`).join('\n')}`);
  });

  it('in production it also needs the keys and hosts that have no safe default', () => {
    const err = failure(() => compose({ ...MINIMUM, ROS_MASTER_KEY: 'c2hvcnQ=' }, 'production'));
    expect(err.problems).toEqual([
      'ROS_MASTER_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)',
      'ROS_SIGNING_KEY is not set (32 random bytes, base64: openssl rand -base64 32)',
      'ROS_PLATFORM_HOST is not set (the host the console and webhooks live on)',
      'ROS_TENANT_ROOT_DOMAIN is not set (the domain venue sites live under)',
    ]);
    expect(() => compose(PRODUCTION, 'production')).not.toThrow();
  });

  it('the minimum (database, Resend, a sending domain) starts with email only and no simulator anywhere', async () => {
    const c = compose(MINIMUM);
    expect(c.mode).toBe('live');
    expect(c.sim).toBeNull();
    expect(c.registered).toEqual(['message:resend', 'sending_domain:resend']);
    expect(c.registry.keys('message')).toEqual(['resend']);
    expect(c.registry.keys('hosting')).toEqual([]);
    expect(c.registry.keys('pos')).toEqual([]);
    expect(c.registry.keys('courier')).toEqual([]);
    expect(c.registry.keys('remote_mcp')).toEqual([]);
    expect(c.config.comms.emailAdapter).toBe('resend');
    // SMS has no provider: it points at the real key, so a text fails loudly rather than being "sent" by a simulator.
    expect(c.config.comms.smsAdapter).toBe('twilio');
    expect(c.registry.has('message', 'twilio')).toBe(false);
    expect(c.config.comms.webhookSecrets).toEqual({ resend: RESEND.RESEND_WEBHOOK_SECRET });
    // The sending-domain port is found by the email adapter's key, as onboarding looks it up.
    expect(c.registry.get('sending_domain', c.config.comms.emailAdapter).key).toBe('resend');
    // No model and no file storage: asked for, they say so.
    await expect(c.registry.llm.generate({} as never)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(c.registry.storage.put({} as never)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('registers each provider only when its variables are present', () => {
    const c = compose(EVERYTHING, 'production');
    expect(c.registered).toEqual([
      'message:resend',
      'sending_domain:resend',
      'message:twilio',
      'hosting:vercel',
      'pos:square',
      'payment:square',
      'oauth:square',
      'courier:uber-direct',
      'courier:doordash-drive',
      'esp:klaviyo',
      'ads:meta-capi',
      'remote_mcp:criota',
    ]);
    expect(c.config.comms.smsAdapter).toBe('twilio');
    // Twilio signs with the account's auth token; Resend with its own webhook secret.
    expect(c.config.comms.webhookSecrets).toEqual({ resend: RESEND.RESEND_WEBHOOK_SECRET, twilio: TWILIO.TWILIO_AUTH_TOKEN });
    expect(c.registry.keys('pos')).toEqual(['square']);
    // Square connections made by sign-in carry the platform's webhook key and the URL Square signs.
    expect(c.registry.get('oauth', 'square').connectionDefaults()).toEqual({
      credentials: { webhookSecret: 'square-signature-key-value' },
      config: { environment: 'sandbox', applicationId: 'sq0idp-app', webhookUrl: 'https://console.example/webhooks/pos/square' },
    });
    expect(c.registry.get('remote_mcp', 'criota').asksBeforeWriting).toBe(true);

    for (const [name, without] of [['twilio', 'TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_MESSAGING_SERVICE_SID'], ['vercel', 'VERCEL_API_TOKEN VERCEL_PROJECT_ID VERCEL_TEAM_ID'], ['uber-direct', 'UBER_DIRECT_ENABLED'], ['criota', 'CRIOTA_MCP_URL']] as const) {
      const env: Record<string, string> = { ...EVERYTHING };
      for (const v of without.split(' ')) delete env[v];
      expect(compose(env, 'production').registered.some((r) => r.endsWith(`:${name}`)), name).toBe(false);
    }
  });

  it('a half-configured provider is a mistake, reported by variable name and never by value', () => {
    const err = failure(() => compose({ ...MINIMUM, TWILIO_ACCOUNT_SID: 'not-a-sid', VERCEL_API_TOKEN: 'vercel-token-value', SQUARE_APPLICATION_SECRET: 'sq0csp-secret-value', SQUARE_ENVIRONMENT: 'staging', CRIOTA_MCP_URL: 'http://insecure.example/mcp' }));
    expect(err.problems).toEqual([
      'TWILIO_ACCOUNT_SID does not look like an account SID (AC + 32 hex characters) (Twilio (SMS): TWILIO_ACCOUNT_SID is set, so the rest must be too)',
      'TWILIO_AUTH_TOKEN is not set (Twilio (SMS): TWILIO_ACCOUNT_SID is set, so the rest must be too)',
      'VERCEL_PROJECT_ID is not set (Vercel (custom domains): VERCEL_API_TOKEN is set, so the rest must be too)',
      'SQUARE_APPLICATION_ID is not set (Square (POS, payments, sign-in): SQUARE_APPLICATION_SECRET is set, so the rest must be too)',
      'SQUARE_ENVIRONMENT must be sandbox or production (Square (POS, payments, sign-in): SQUARE_APPLICATION_SECRET is set, so the rest must be too)',
      'CRIOTA_MCP_URL must be an https URL (Criota (remote MCP): CRIOTA_MCP_URL is set, so the rest must be too)',
    ]);
    for (const secret of ['not-a-sid', 'vercel-token-value', 'sq0csp-secret-value', 're_live_abc', 'whsec_']) expect(err.message).not.toContain(secret);
  });

  it('a malformed Resend key is reported once, not also as "Resend is missing"', () => {
    const err = failure(() => compose({ ...MINIMUM, RESEND_API_KEY: 'sk_wrong_provider' }));
    expect(err.problems).toEqual(['RESEND_API_KEY does not look like a Resend API key (re_…) (Resend (email): RESEND_API_KEY, RESEND_WEBHOOK_SECRET are set, so the rest must be too)']);
  });

  it('a switch set to 0, false or off is off, not a mistake', () => {
    const c = compose({ ...MINIMUM, UBER_DIRECT_ENABLED: '0', KLAVIYO_ENABLED: 'false', META_CAPI_ENABLED: 'off', DOORDASH_DRIVE_ENABLED: '' });
    expect(c.registered).toEqual(['message:resend', 'sending_domain:resend']);
    expect(failure(() => compose({ ...MINIMUM, UBER_DIRECT_ENABLED: 'maybe' })).problems).toHaveLength(1);
  });

  it('an explicit ROS_EMAIL_ADAPTER or ROS_SMS_ADAPTER wins over the default choice', () => {
    const c = compose({ ...MINIMUM, ...TWILIO, ROS_SMS_ADAPTER: 'other-sms' });
    expect(c.config.comms.smsAdapter).toBe('other-sms');
    expect(c.config.comms.emailAdapter).toBe('resend');
  });
});

describe('ROS_ADAPTERS=mixed', () => {
  it('is refused in production', () => {
    expect(() => compose({ ...PRODUCTION, ROS_ADAPTERS: 'mixed' }, 'production')).toThrow(/mixed cannot run in production/);
  });

  it('with nothing configured it is the simulators, and needs none of what live requires', () => {
    const c = compose({ ROS_ADAPTERS: 'mixed' });
    expect(c.mode).toBe('mixed');
    expect(c.sim).not.toBeNull();
    expect(c.registered).toEqual([]);
    expect(c.config.comms.emailAdapter).toBe('sim-email');
    expect(c.config.comms.smsAdapter).toBe('sim-sms');
    expect(Object.keys(c.config.comms.webhookSecrets).sort()).toEqual(['sim-email', 'sim-sms']);
  });

  it('real where configured, simulated otherwise', () => {
    const c = compose({ ROS_ADAPTERS: 'mixed', ...RESEND, VERCEL_API_TOKEN: 't', VERCEL_PROJECT_ID: 'prj' });
    expect(c.registered).toEqual(['message:resend', 'sending_domain:resend', 'hosting:vercel']);
    expect(c.config.comms.emailAdapter).toBe('resend'); // real
    expect(c.config.comms.smsAdapter).toBe('sim-sms'); // simulated
    expect(c.registry.keys('message').sort()).toEqual(['resend', 'sim-email', 'sim-sms']);
    expect(c.registry.keys('pos')).toEqual(['sim-pos']);
    expect(Object.keys(c.config.comms.webhookSecrets).sort()).toEqual(['resend', 'sim-email', 'sim-sms']);
    expect(c.sim!.sms.key).toBe('sim-sms');
  });

  it('still refuses a half-configured provider', () => {
    expect(failure(() => compose({ ROS_ADAPTERS: 'mixed', TWILIO_AUTH_TOKEN: 'x' })).problems).toEqual(['TWILIO_ACCOUNT_SID is not set (Twilio (SMS): TWILIO_AUTH_TOKEN is set, so the rest must be too)']);
  });
});

describe('ROS_SIM_SQUARE_OAUTH (a simulated Square sign-in for development and tests)', () => {
  const SQUARE = { SQUARE_APPLICATION_ID: 'sandbox-sq0idb-app', SQUARE_APPLICATION_SECRET: 'sandbox-sq0csb-secret', SQUARE_ENVIRONMENT: 'sandbox' };

  it('is off unless asked for: the simulators offer no Square sign-in', () => {
    const c = compose({});
    expect(c.sim!.posSignIn).toBeNull();
    expect(c.registry.has('oauth', 'square')).toBe(false);
    expect(c.registry.keys('pos')).toEqual(['sim-pos']);
    expect(compose({ ROS_SIM_SQUARE_OAUTH: '0' }).registry.has('oauth', 'square')).toBe(false);
  });

  it('switched on beside the simulators, Square is answered by them: sign-in on a development page of the platform host', async () => {
    const c = compose({ ROS_SIM_SQUARE_OAUTH: '1' });
    expect(c.registered).toEqual([]); // nothing real
    expect(c.registry.keys('pos').sort()).toEqual(['sim-pos', 'square']);
    expect(c.registry.has('payment', 'square')).toBe(true);
    const oauth = c.registry.get('oauth', 'square');
    expect(oauth).toBe(c.sim!.posSignIn);
    const url = new URL(oauth.authorizeUrl({ state: 'STATE', scopes: ['PAYMENTS_READ', 'ORDERS_READ'] }));
    expect(`${url.origin}${url.pathname}`).toBe('https://console.example/dev/pos-signin');
    expect(Object.fromEntries(url.searchParams)).toEqual({ plug: 'square', scope: 'PAYMENTS_READ ORDERS_READ', state: 'STATE' });

    // Allow → a single-use code → tokens the simulated POS accepts, for a location seeded on it.
    const sim = c.sim!;
    sim.pos.addLocation('acct-1', { ref: 'loc-1', name: 'Counter' });
    const code = sim.posSignIn!.approve('acct-1');
    const tokens = await oauth.exchangeCode({ code });
    expect(tokens).toMatchObject({ externalAccountId: 'acct-1', expiresAt: new Date('2026-10-31T00:00:00Z') });
    await expect(oauth.exchangeCode({ code })).rejects.toMatchObject({ name: 'OAuthRefusedError' });
    await expect(oauth.exchangeCode({ code: 'made-up' })).rejects.toMatchObject({ name: 'OAuthRefusedError' });
    const conn = { id: 'x', orgId: 'x', venueId: null, plugKey: 'square', externalAccountId: 'acct-1', scopes: [], config: {}, credentials: { accessToken: tokens.accessToken } };
    const pos = c.registry.get('pos', 'square');
    expect(pos.key).toBe('square');
    expect(await pos.listLocations(conn)).toEqual([{ ref: 'loc-1', name: 'Counter' }]);
    expect((await oauth.refresh({ refreshToken: tokens.refreshToken! })).accessToken).toBe(tokens.accessToken);

    // Ending one token changes nothing (the token is the account's); ending the grant stops the account being served, with a 401.
    await oauth.revoke({ accessToken: tokens.accessToken, everything: false });
    expect(await pos.listLocations(conn)).toHaveLength(1);
    await oauth.revoke({ accessToken: tokens.accessToken, everything: true });
    await expect(pos.listLocations(conn)).rejects.toMatchObject({ status: 401 });
    await expect(oauth.refresh({ refreshToken: tokens.refreshToken! })).rejects.toMatchObject({ name: 'OAuthRefusedError' });
    expect(sim.posSignIn!.revocations.map((r) => [r.accountRef, r.everything])).toEqual([['acct-1', false], ['acct-1', true]]);
    expect(JSON.stringify(sim.posSignIn!.accounts())).not.toContain(tokens.accessToken);
  });

  it('never stands in for real Square, never runs live, never in production', () => {
    const mixed = compose({ ROS_ADAPTERS: 'mixed', ROS_SIM_SQUARE_OAUTH: '1', ...SQUARE });
    expect(mixed.registered).toEqual(['pos:square', 'payment:square', 'oauth:square']);
    expect(mixed.sim!.posSignIn).toBeNull();
    expect(new URL(mixed.registry.get('oauth', 'square').authorizeUrl({ state: 's', scopes: [] })).host).toBe('connect.squareupsandbox.com');
    // Mixed without Square credentials: the simulated one.
    expect(compose({ ROS_ADAPTERS: 'mixed', ROS_SIM_SQUARE_OAUTH: '1' }).sim!.posSignIn).not.toBeNull();

    expect(failure(() => compose({ ...MINIMUM, ROS_SIM_SQUARE_OAUTH: '1' })).problems).toEqual(['ROS_SIM_SQUARE_OAUTH is set (a simulated Square sign-in cannot run with ROS_ADAPTERS=live: unset it)']);
    expect(() => compose({ ROS_SIM_SQUARE_OAUTH: '1' }, 'production')).toThrow('Simulated providers cannot run in production.');
    expect(() => compose({ ROS_ADAPTERS: 'mixed', ROS_SIM_SQUARE_OAUTH: '1' }, 'production')).toThrow(/mixed cannot run in production/);
    expect(failure(() => compose({ ...PRODUCTION, ROS_SIM_SQUARE_OAUTH: '1' }, 'production')).problems).toEqual(['ROS_SIM_SQUARE_OAUTH is set (a simulated Square sign-in cannot run with ROS_ADAPTERS=live: unset it)']);
  });
});

describe('the provider table', () => {
  it('every variable a provider reads is listed in .env.example and docs/GOING_LIVE.md', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const example = await readFile(`${root}.env.example`, 'utf8');
    const doc = await readFile(`${root}docs/GOING_LIVE.md`, 'utf8');
    const core = ['ROS_ADAPTERS', 'ROS_ENV', 'DATABASE_URL', 'ROS_MASTER_KEY', 'ROS_SIGNING_KEY', 'ROS_PLATFORM_HOST', 'ROS_TENANT_ROOT_DOMAIN', 'ROS_PLATFORM_SENDING_DOMAIN', 'ROS_PLATFORM_SMS_SENDER'];
    for (const name of [...core, ...PROVIDERS.flatMap((p) => p.vars)]) {
      expect(example, `.env.example: ${name}`).toMatch(new RegExp(`^#? ?${name}=`, 'm'));
      expect(doc, `GOING_LIVE.md: ${name}`).toContain(name);
    }
  });

  it('only email is required of a live process; readProviderEnv never throws', () => {
    expect(PROVIDERS.filter((p) => p.requiredForLive).map((p) => p.id)).toEqual(['resend']);
    const read = readProviderEnv({ TWILIO_ACCOUNT_SID: 'x' });
    expect(read.providers.twilio).toBeNull();
    expect(read.problems.length).toBeGreaterThan(0);
    expect(liveRequirements({}, readProviderEnv({}), false)).toHaveLength(3);
  });

  it('webhook URLs are on the platform host, under the routes the web app serves', () => {
    expect(webhookUrls({ scheme: 'https', platformHost: 'console.example' })).toEqual({
      resend: 'https://console.example/webhooks/messages/resend',
      twilio: 'https://console.example/webhooks/messages/twilio',
      square: 'https://console.example/webhooks/pos/square',
      uberDirect: 'https://console.example/webhooks/couriers/uber-direct',
      doordashDrive: 'https://console.example/webhooks/couriers/doordash-drive',
    });
  });
});
