import { describe, expect, it } from 'vitest';
import { systemClock, type AppConfig } from '@ros/core';
import { checkDeployment, composeAdapters, formatDeploymentCheck } from '@ros/runtime';

/**
 * packages/runtime/src/check.ts: what `pnpm check:config` tells an operator. Pure, so every
 * case is a plain object of variables. The last block holds it to the runtime's own decisions.
 */
const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');
const CORE = {
  ROS_ENV: 'production',
  ROS_ADAPTERS: 'live',
  DATABASE_URL: 'postgres://app:dbpassword@db.example.com:5432/pipedline',
  ROS_MASTER_KEY: KEY_A,
  ROS_SIGNING_KEY: KEY_B,
  ROS_PLATFORM_HOST: 'console.example.com',
  ROS_TENANT_ROOT_DOMAIN: 'tables.example.net',
};
const LIVE = { ...CORE, RESEND_API_KEY: 're_secret_value_1234', RESEND_WEBHOOK_SECRET: 'whsec_c2VjcmV0', ROS_PLATFORM_SENDING_DOMAIN: 'mail.example.com' };
const TRIAL = { ROS_ENV: 'development', ROS_ADAPTERS: 'sim', DATABASE_URL: CORE.DATABASE_URL };

describe('checkDeployment', () => {
  it('a complete production configuration has nothing to fix, and says what is not configured', () => {
    const c = checkDeployment(LIVE);
    expect(c.errors).toEqual([]);
    expect(c.warnings).toEqual([]);
    const text = c.summary.join('\n');
    expect(text).toMatch(/ROS_ENV=production, ROS_ADAPTERS=live: real providers only/);
    expect(text).toMatch(/Resend \(email\): real/);
    expect(text).toMatch(/Twilio \(SMS\): NOT CONFIGURED: texts fail/);
    expect(text).toMatch(/File storage: NOT AVAILABLE/);
    expect(text).not.toMatch(/\/dev/);
  });

  it('an empty environment is told every decision it has not made', () => {
    const c = checkDeployment({});
    expect(c.errors.join('\n')).toMatch(/ROS_ENV is not set/);
    expect(c.errors.join('\n')).toMatch(/ROS_ADAPTERS is not set/);
    expect(c.errors.join('\n')).toMatch(/DATABASE_URL is not set/);
  });

  it('production with real providers lists every missing variable at once, each once', () => {
    const c = checkDeployment({ ROS_ENV: 'production', ROS_ADAPTERS: 'live' });
    const names = ['DATABASE_URL', 'RESEND_API_KEY and RESEND_WEBHOOK_SECRET', 'ROS_PLATFORM_SENDING_DOMAIN', 'ROS_MASTER_KEY', 'ROS_SIGNING_KEY', 'ROS_PLATFORM_HOST', 'ROS_TENANT_ROOT_DOMAIN'];
    for (const n of names) expect(c.errors.filter((e) => e.startsWith(n)).length, n).toBe(1);
    expect(c.errors.length).toBe(names.length);
  });

  it('refuses simulators in production, in words', () => {
    expect(checkDeployment({ ...CORE, ROS_ADAPTERS: 'sim' }).errors.join('\n')).toMatch(/ROS_ADAPTERS=sim cannot run with ROS_ENV=production/);
    expect(checkDeployment({ ...CORE, ROS_ADAPTERS: 'mixed' }).errors.join('\n')).toMatch(/ROS_ADAPTERS=mixed cannot run with ROS_ENV=production/);
    // Without the keys, production says so in every mode: they have no safe default.
    const bare = checkDeployment({ ROS_ENV: 'production', ROS_ADAPTERS: 'sim', DATABASE_URL: CORE.DATABASE_URL });
    expect(bare.errors.join('\n')).toMatch(/ROS_MASTER_KEY is not set/);
    expect(bare.errors.join('\n')).toMatch(/ROS_PLATFORM_HOST is not set/);
  });

  it('catches a misspelt environment, which would otherwise run as "not production"', () => {
    const c = checkDeployment({ ...LIVE, ROS_ENV: 'prod' });
    expect(c.errors).toEqual(['ROS_ENV must be production or development (it is "prod"). Anything else is treated as "not production" and would run with development defaults.']);
    expect(checkDeployment({ ...LIVE, ROS_ADAPTERS: 'real' }).errors.join('\n')).toMatch(/ROS_ADAPTERS must be sim, live or mixed \(it is "real"\)/);
  });

  it('a half-configured provider and a malformed key are named', () => {
    const c = checkDeployment({ ...LIVE, TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32), ROS_MASTER_KEY: 'too-short' });
    expect(c.errors.join('\n')).toMatch(/TWILIO_AUTH_TOKEN is not set/);
    expect(c.errors.join('\n')).toMatch(/ROS_MASTER_KEY must be 32 bytes, base64-encoded/);
    expect(c.errors.length).toBe(2);
  });

  it('hosts: a URL is not a host, the two must differ, and a port does not belong on the venue domain', () => {
    expect(checkDeployment({ ...LIVE, ROS_PLATFORM_HOST: 'https://console.example.com' }).errors.join('\n')).toMatch(/ROS_PLATFORM_HOST must be a bare host/);
    expect(checkDeployment({ ...LIVE, ROS_TENANT_ROOT_DOMAIN: 'console.example.com' }).errors.join('\n')).toMatch(/are the same host/);
    expect(checkDeployment({ ...LIVE, ROS_TENANT_ROOT_DOMAIN: 'tables.example.net:8080' }).errors.join('\n')).toMatch(/must not carry a port/);
    expect(checkDeployment({ ...LIVE, ROS_PLATFORM_HOST: 'console.tables.example.net' }).warnings.join('\n')).toMatch(/inside ROS_TENANT_ROOT_DOMAIN/);
    expect(checkDeployment({ ...LIVE, ROS_SCHEME: 'http' }).warnings.join('\n')).toMatch(/without the Secure flag/);
  });

  it('development-only switches: refused in production, flagged elsewhere', () => {
    expect(checkDeployment({ ...LIVE, ROS_CLOCK_START: '2026-10-02T08:00:00.000Z' }).errors.join('\n')).toMatch(/ROS_CLOCK_START is set/);
    expect(checkDeployment({ ...LIVE, ROS_SIM_SQUARE_OAUTH: '1' }).errors.join('\n')).toMatch(/ROS_SIM_SQUARE_OAUTH is set/);
    expect(checkDeployment({ ...TRIAL, ROS_CLOCK_START: '2026-10-02T08:00:00.000Z' }).errors).toEqual([]);
  });

  it('a trial with simulators starts, with the warnings an operator needs', () => {
    const c = checkDeployment(TRIAL);
    expect(c.errors).toEqual([]);
    expect(c.warnings.join('\n')).toMatch(/ROS_MASTER_KEY is not set, so a fixed development key/);
    expect(c.warnings.join('\n')).toMatch(/ROS_PLATFORM_HOST is not set, so it is "localhost:3000"/);
    expect(c.summary.join('\n')).toMatch(/\/dev and \/api\/dev are OPEN/);
    expect(c.summary.join('\n')).toMatch(/Resend \(email\): simulated/);
  });

  it('never repeats a value: only names', () => {
    const secrets = { ...LIVE, TWILIO_ACCOUNT_SID: 'AC' + 'f'.repeat(32), TWILIO_AUTH_TOKEN: 'twilio-secret-token-value', ANTHROPIC_API_KEY: 'sk-ant-secret-value-1234', ROS_MASTER_KEY: 'bad-master-secret' };
    const text = formatDeploymentCheck(checkDeployment(secrets));
    for (const v of ['dbpassword', 're_secret_value_1234', 'whsec_c2VjcmV0', 'twilio-secret-token-value', 'sk-ant-secret-value-1234', 'bad-master-secret', KEY_B]) expect(text).not.toContain(v);
    expect(text).toMatch(/1 thing to fix before the app will start/);
  });

  describe('agrees with the runtime about what can start', () => {
    const config = (env: Record<string, string>): AppConfig => ({
      tenantRootDomain: env.ROS_TENANT_ROOT_DOMAIN ?? 'tables.localhost',
      platformHost: env.ROS_PLATFORM_HOST ?? 'localhost:3000',
      masterKey: Buffer.alloc(32, 1),
      signingKey: Buffer.alloc(32, 2),
      env: env.ROS_ENV as AppConfig['env'],
      scheme: 'https',
      comms: { emailAdapter: 'sim-email', smsAdapter: 'sim-sms', platformSendingDomain: env.ROS_PLATFORM_SENDING_DOMAIN ?? 'mail.localhost', platformSmsSender: 'ROS', webhookSecrets: {} },
    });
    const starts = (env: Record<string, string>) => {
      try {
        composeAdapters({ env, config: config(env), clock: systemClock });
        return true;
      } catch {
        return false;
      }
    };
    const cases: Array<[string, Record<string, string>]> = [
      ['production live, complete', LIVE],
      ['production live, no email', CORE],
      ['production sim', { ...CORE, ROS_ADAPTERS: 'sim' }],
      ['production mixed', { ...LIVE, ROS_ADAPTERS: 'mixed' }],
      ['development sim', TRIAL],
      ['development mixed, nothing configured', { ...TRIAL, ROS_ADAPTERS: 'mixed' }],
      ['development mixed, half a provider', { ...TRIAL, ROS_ADAPTERS: 'mixed', SQUARE_APPLICATION_ID: 'sq0idp-x' }],
      ['development live, complete', { ...LIVE, ROS_ENV: 'development' }],
      ['development live, no email', { ...CORE, ROS_ENV: 'development' }],
      ['live with a simulated sign-in', { ...LIVE, ROS_SIM_SQUARE_OAUTH: '1' }],
    ];
    it.each(cases)('%s', (_name, env) => {
      expect(checkDeployment(env).errors.length === 0).toBe(starts(env));
    });
  });
});
