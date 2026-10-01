import { describe, expect, it } from 'vitest';
import { VercelApiError, createVercelHosting, relativeName, vercelListProjectDomains, vercelRecords } from '../src/vercel/index';
import { type StubCall, stubFetch } from './stub-fetch';

/**
 * The Vercel hosting adapter against shapes copied from Vercel's REST reference (read
 * 2026-10-01). These prove the adapter does what the reference describes. They do not prove
 * Vercel behaves as documented: the adapter has never been called against Vercel.
 */
const TOKEN = 'vercel-test-token';
const PROJECT = 'prj_ros_web';
const TEAM = 'team_ros';
const HOST = 'www.oakdiner.example';
const APEX = 'oakdiner.example';

const projectDomain = (over: Record<string, unknown> = {}) => ({ name: HOST, apexName: APEX, projectId: PROJECT, verified: true, createdAt: 1, updatedAt: 1, redirect: null, gitBranch: null, ...over });
const challenge = [{ type: 'TXT', domain: `_vercel.${APEX}`, value: 'vc-domain-verify=www.oakdiner.example,abc123', reason: 'pending_domain_verification' }];
const config = (over: Record<string, unknown> = {}) => ({
  acceptedChallenges: [],
  configuredBy: null,
  misconfigured: true,
  recommendedCNAME: [{ rank: 2, value: 'cname.vercel-dns.com.' }, { rank: 1, value: 'abc123.vercel-dns-017.com.' }],
  recommendedIPv4: [{ rank: 1, value: ['216.150.1.1'] }, { rank: 2, value: ['76.76.21.21'] }],
  ...over,
});

function vercel(state: { domain: Record<string, unknown> | null; config: Record<string, unknown>; add?: (c: StubCall) => { status?: number; body?: unknown }; verify?: () => { status?: number; body?: unknown } }) {
  return stubFetch((c) => {
    if (c.method === 'POST' && c.path === `/v10/projects/${PROJECT}/domains`) return state.add ? state.add(c) : { body: state.domain };
    if (c.method === 'GET' && c.path === `/v9/projects/${PROJECT}/domains/${state.domain?.name ?? HOST}`) return state.domain ? { body: state.domain } : { status: 404, body: { error: { code: 'not_found', message: 'x' } } };
    if (c.method === 'POST' && c.path.endsWith('/verify')) return state.verify ? state.verify() : { body: state.domain };
    if (c.method === 'GET' && c.path.startsWith('/v6/domains/') && c.path.endsWith('/config')) return { body: state.config };
    if (c.method === 'DELETE') return state.domain ? { body: {} } : { status: 404, body: { error: { code: 'not_found' } } };
    return undefined;
  });
}
const adapter = (r: { fetch: typeof fetch }) => createVercelHosting({ token: TOKEN, projectId: PROJECT, teamId: TEAM, fetch: r.fetch });

describe('Vercel: record names', () => {
  it('gives a record name relative to the apex, as a registrar wants it', () => {
    expect(relativeName('www.oakdiner.example', 'oakdiner.example')).toBe('www');
    expect(relativeName('oakdiner.example', 'oakdiner.example')).toBe('@');
    expect(relativeName('_vercel.oakdiner.example', 'oakdiner.example')).toBe('_vercel');
    expect(relativeName('order.shop.OakDiner.example.', 'oakdiner.example')).toBe('order.shop');
  });

  it('a subdomain gets the best-ranked CNAME; an apex gets the best-ranked A record', () => {
    expect(vercelRecords(projectDomain() as never, config() as never)).toEqual([{ type: 'CNAME', name: 'www', value: 'abc123.vercel-dns-017.com' }]);
    expect(vercelRecords(projectDomain({ name: APEX }) as never, config() as never)).toEqual([{ type: 'A', name: '@', value: '216.150.1.1' }]);
    expect(vercelRecords(projectDomain({ verified: false, verification: challenge }) as never, config() as never)).toEqual([
      { type: 'TXT', name: '_vercel', value: 'vc-domain-verify=www.oakdiner.example,abc123' },
      { type: 'CNAME', name: 'www', value: 'abc123.vercel-dns-017.com' },
    ]);
  });
});

describe('Vercel: custom domains (documented shapes, unverified against Vercel)', () => {
  it('adds a domain to the project with the bearer token and team, and returns the record to add', async () => {
    const r = vercel({ domain: projectDomain(), config: config() });
    const reg = await adapter(r).addDomain({ host: HOST, idempotencyKey: 'onboarding:1:domain:www' });

    const add = r.calls[0]!;
    expect(add.method).toBe('POST');
    expect(add.url.toString()).toBe(`https://api.vercel.com/v10/projects/${PROJECT}/domains?teamId=${TEAM}`);
    expect(add.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(add.body).toEqual({ name: HOST });
    const cfg = r.calls[1]!;
    expect(cfg.url.toString()).toBe(`https://api.vercel.com/v6/domains/${HOST}/config?projectIdOrName=${PROJECT}&teamId=${TEAM}`);
    // Owned by the project, but DNS does not point at Vercel yet: not verified.
    expect(reg).toEqual({ providerDomainId: HOST, verified: false, records: [{ type: 'CNAME', name: 'www', value: 'abc123.vercel-dns-017.com' }] });
  });

  it('is verified only when Vercel says the project owns it AND its DNS is configured', async () => {
    const both = vercel({ domain: projectDomain(), config: config({ misconfigured: false, configuredBy: 'CNAME' }) });
    expect((await adapter(both).addDomain({ host: HOST, idempotencyKey: 'k' })).verified).toBe(true);
    const unowned = vercel({ domain: projectDomain({ verified: false, verification: challenge }), config: config({ misconfigured: false, configuredBy: 'CNAME' }) });
    expect((await adapter(unowned).addDomain({ host: HOST, idempotencyKey: 'k' })).verified).toBe(false);
  });

  it('a retry of a domain already on this project reads it back instead of failing (400 and 409 alike)', async () => {
    for (const status of [400, 409]) {
      const r = vercel({ domain: projectDomain({ verified: false, verification: challenge }), config: config(), add: () => ({ status, body: { error: { code: 'domain_already_in_use', message: 'x' } } }) });
      const reg = await adapter(r).addDomain({ host: HOST, idempotencyKey: 'k' });
      expect(reg.providerDomainId).toBe(HOST);
      expect(reg.records[0]).toEqual({ type: 'TXT', name: '_vercel', value: 'vc-domain-verify=www.oakdiner.example,abc123' });
    }
  });

  it('a domain held by another project stays an error: it is not on ours to read back', async () => {
    const r = vercel({ domain: null, config: config(), add: () => ({ status: 409, body: { error: { code: 'domain_already_in_use', message: `in use, token ${TOKEN}` } } }) });
    const err = await adapter(r)
      .addDomain({ host: HOST, idempotencyKey: 'k' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(VercelApiError);
    expect(err.message).toBe(`vercel: 409 on /v10/projects/${PROJECT}/domains (domain_already_in_use)`);
    expect(err.message).not.toContain(TOKEN);
  });

  it('other failures are not swallowed', async () => {
    const r = vercel({ domain: projectDomain(), config: config(), add: () => ({ status: 403, body: { error: { code: 'forbidden' } } }) });
    await expect(adapter(r).addDomain({ host: HOST, idempotencyKey: 'k' })).rejects.toThrow(/403/);
    expect(r.calls).toHaveLength(1);
  });

  it('checking an unowned domain asks Vercel to verify; a 400 means the challenge is still unmet', async () => {
    const r = vercel({ domain: projectDomain({ verified: false, verification: challenge }), config: config(), verify: () => ({ status: 400, body: { error: { code: 'missing_txt_record' } } }) });
    const check = await adapter(r).checkDomain({ host: HOST, providerDomainId: HOST });
    expect(check.verified).toBe(false);
    expect(check.reason).toBe('The TXT record that proves the domain is yours has not been found yet.');
    expect(check.records).toHaveLength(2);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /v9/projects/${PROJECT}/domains/${HOST}`, `POST /v9/projects/${PROJECT}/domains/${HOST}/verify`, `GET /v6/domains/${HOST}/config`]);
  });

  it('checking becomes verified once the challenge passes and DNS points at Vercel', async () => {
    const r = vercel({ domain: projectDomain({ verified: false, verification: challenge }), config: config({ misconfigured: false, configuredBy: 'CNAME' }), verify: () => ({ body: projectDomain({ verified: true }) }) });
    expect((await adapter(r).checkDomain({ host: HOST, providerDomainId: HOST })).verified).toBe(true);
  });

  it('an owned domain whose DNS is not there yet says so, without asking to verify again', async () => {
    const r = vercel({ domain: projectDomain(), config: config() });
    const check = await adapter(r).checkDomain({ host: HOST, providerDomainId: HOST });
    expect(check).toEqual({ verified: false, reason: 'The domain does not point at the site yet: its DNS record has not been found.', records: [{ type: 'CNAME', name: 'www', value: 'abc123.vercel-dns-017.com' }] });
    expect(r.calls.some((c) => c.path.endsWith('/verify'))).toBe(false);
  });

  it('a verify failure that is not "unmet" is raised, not read as unverified', async () => {
    const r = vercel({ domain: projectDomain({ verified: false, verification: challenge }), config: config(), verify: () => ({ status: 500, body: {} }) });
    await expect(adapter(r).checkDomain({ host: HOST, providerDomainId: HOST })).rejects.toThrow(/500/);
  });

  it('a domain the project does not hold, or an id for a different host, is not verified', async () => {
    const gone = vercel({ domain: null, config: config() });
    expect(await adapter(gone).checkDomain({ host: HOST, providerDomainId: HOST })).toEqual({ verified: false, records: [], reason: 'That domain is not registered with the web host.' });
    const mismatch = vercel({ domain: projectDomain(), config: config({ misconfigured: false }) });
    expect((await adapter(mismatch).checkDomain({ host: HOST, providerDomainId: 'someone-else.com' })).verified).toBe(false);
    expect(mismatch.calls).toHaveLength(0);
  });

  it('removes a domain; removing an absent one is not an error; an outage is', async () => {
    const r = vercel({ domain: projectDomain(), config: config() });
    await adapter(r).removeDomain({ host: HOST, providerDomainId: HOST });
    expect(r.calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([`DELETE /v9/projects/${PROJECT}/domains/${HOST}?teamId=${TEAM}`]);
    const gone = vercel({ domain: null, config: config() });
    await expect(adapter(gone).removeDomain({ host: HOST, providerDomainId: null })).resolves.toBeUndefined();
    const down = stubFetch(() => ({ status: 503, body: {} }));
    await expect(adapter(down).removeDomain({ host: HOST, providerDomainId: HOST })).rejects.toThrow(/503/);
  });

  it('leaves teamId off for a personal account', async () => {
    const r = vercel({ domain: projectDomain(), config: config() });
    await createVercelHosting({ token: TOKEN, projectId: PROJECT, fetch: r.fetch }).removeDomain({ host: HOST, providerDomainId: HOST });
    expect(r.calls[0]!.url.search).toBe('');
  });

  it('the smoke read lists project domains with a GET and nothing else', async () => {
    const r = stubFetch(() => ({ body: { domains: [projectDomain()], pagination: { count: 1, next: null, prev: null } } }));
    expect(await vercelListProjectDomains({ token: TOKEN, projectId: PROJECT, fetch: r.fetch })).toEqual([{ name: HOST, verified: true }]);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /v9/projects/${PROJECT}/domains`]);
  });
});
