import { describe, expect, it } from 'vitest';
import { formatSmoke, runSmoke } from '../../../../scripts/smoke-live';

/**
 * scripts/smoke-live.ts with every provider configured and the network replaced by a recorder.
 * What matters: one call per provider, every one of them a read, and no secret in the output.
 */
const SECRETS = {
  RESEND_API_KEY: 're_live_secret_value',
  RESEND_WEBHOOK_SECRET: 'whsec_c2VjcmV0c2VjcmV0',
  TWILIO_ACCOUNT_SID: 'AC' + '0123456789abcdef0123456789abcdef',
  TWILIO_AUTH_TOKEN: 'twilio-auth-token-secret',
  VERCEL_API_TOKEN: 'vercel-token-secret',
  SQUARE_APPLICATION_SECRET: 'sq0csp-application-secret',
  SQUARE_SMOKE_ACCESS_TOKEN: 'EAAl-seller-access-token',
  ANTHROPIC_API_KEY: 'sk-ant-secret-value',
};
const ENV = {
  ...SECRETS,
  DATABASE_URL: 'postgres://ros:dbpassword@db.example/ros',
  ROS_PLATFORM_SENDING_DOMAIN: 'mail.example.com',
  VERCEL_PROJECT_ID: 'prj_ros',
  SQUARE_APPLICATION_ID: 'sq0idp-app',
  SQUARE_ENVIRONMENT: 'sandbox',
  UBER_DIRECT_ENABLED: '1',
  CRIOTA_MCP_URL: 'https://mcp.criota.example/mcp',
};

function recorder(status = 200) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : (input as Request).url;
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET');
    calls.push({ method, url, body: init?.body ?? null });
    const host = new URL(url).host;
    const body =
      status !== 200
        ? { name: 'missing_api_key', code: 20003, error: { code: 'forbidden' }, errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED' }] }
        : host === 'api.resend.com'
          ? { object: 'list', has_more: false, data: [{ id: 'd1', name: 'mail.example.com', status: 'verified' }] }
          : host === 'api.twilio.com'
            ? { sid: ENV.TWILIO_ACCOUNT_SID, friendly_name: 'ROS', status: 'active', type: 'Full' }
            : host === 'api.vercel.com'
              ? { domains: [{ name: 'www.venue.example', apexName: 'venue.example', verified: true }], pagination: { count: 1, next: null, prev: null } }
              : host === 'connect.squareupsandbox.com'
                ? { locations: [{ id: 'L1', name: 'Main' }] }
                : { data: [{ id: 'claude-x', type: 'model' }], has_more: false, first_id: 'claude-x', last_id: 'claude-x' };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('scripts/smoke-live.ts', () => {
  it('makes one read-only call per configured provider and reports pass per provider', async () => {
    const r = recorder();
    const results = await runSmoke(ENV, { fetch: r.fetch, pingDatabase: async () => 'connected to "ros"' });

    expect(r.calls.map((c) => `${c.method} ${new URL(c.url).host}${new URL(c.url).pathname}`)).toEqual([
      'GET api.resend.com/domains',
      `GET api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}.json`,
      'GET api.vercel.com/v9/projects/prj_ros/domains',
      'GET connect.squareupsandbox.com/v2/locations',
      'GET api.anthropic.com/v1/models',
    ]);
    // No writes, no sends: every call is a GET with no body.
    expect(r.calls.every((c) => c.method === 'GET' && c.body === null)).toBe(true);

    const by = Object.fromEntries(results.map((x) => [x.provider, x]));
    expect(by['Database']).toEqual({ provider: 'Database', status: 'pass', detail: 'connected to "ros"' });
    expect(by['Resend (email)']).toMatchObject({ status: 'pass', detail: 'key accepted; 1 domain(s); mail.example.com is verified' });
    expect(by['Twilio (SMS)']!.status).toBe('pass');
    expect(by['Vercel (custom domains)']).toMatchObject({ status: 'pass', detail: 'token and project accepted; 1 domain(s) on the project, 1 verified' });
    expect(by['Square (POS, payments, sign-in)']!.status).toBe('pass');
    expect(by['Square (POS, payments, sign-in)']!.detail).toContain('SQUARE_WEBHOOK_SIGNATURE_KEY is not set');
    expect(by['Anthropic (model)']!.status).toBe('pass');
    // Per-venue credentials: said so, not guessed at.
    expect(by['Criota (remote MCP)']!.status).toBe('skip');
    expect(by['Uber Direct (courier)']).toMatchObject({ status: 'skip' });
    expect(by['Klaviyo (connected email platform)']).toMatchObject({ status: 'skip', detail: 'not switched on' });
    expect(results.some((x) => x.status === 'fail')).toBe(false);

    const printed = formatSmoke(results);
    for (const secret of [...Object.values(SECRETS), 'dbpassword']) expect(printed).not.toContain(secret);
    expect(printed).toContain('6 passed, 0 failed');
  });

  it('refused credentials fail that provider, by name, without printing the credential', async () => {
    const r = recorder(401);
    const results = await runSmoke(ENV, {
      fetch: r.fetch,
      pingDatabase: async () => {
        throw new Error('password authentication failed for user "ros"');
      },
    });
    const failed = results.filter((x) => x.status === 'fail').map((x) => x.provider);
    expect(failed).toEqual(['Database', 'Resend (email)', 'Twilio (SMS)', 'Vercel (custom domains)', 'Square (POS, payments, sign-in)', 'Anthropic (model)']);
    expect(results.find((x) => x.provider === 'Resend (email)')!.detail).toBe('resend: 401 on /domains?limit=100 (missing_api_key)');
    const printed = formatSmoke(results);
    for (const secret of [...Object.values(SECRETS), 'dbpassword']) expect(printed).not.toContain(secret);
    expect(r.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('with nothing configured it calls nobody and fails nothing', async () => {
    const r = recorder();
    const results = await runSmoke({}, { fetch: r.fetch });
    expect(r.calls).toEqual([]);
    expect(results.every((x) => x.status === 'skip')).toBe(true);
  });

  it('reports a half-configured provider and what live mode is missing', async () => {
    const results = await runSmoke({ ROS_ADAPTERS: 'live', VERCEL_API_TOKEN: 'vercel-token-secret' }, { fetch: recorder().fetch });
    const problems = results.filter((x) => x.provider === 'configuration').map((x) => x.detail);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(/^VERCEL_PROJECT_ID is not set/);
    expect(problems.join('\n')).not.toContain('vercel-token-secret');
  });

  it('says the platform sending domain is missing at Resend when it is', async () => {
    const results = await runSmoke({ RESEND_API_KEY: ENV.RESEND_API_KEY, RESEND_WEBHOOK_SECRET: ENV.RESEND_WEBHOOK_SECRET, ROS_PLATFORM_SENDING_DOMAIN: 'other.example.com' }, { fetch: recorder().fetch });
    expect(results.find((x) => x.provider === 'Resend (email)')!.detail).toBe('key accepted; 1 domain(s); other.example.com is NOT among them: add and verify it at Resend');
  });
});
