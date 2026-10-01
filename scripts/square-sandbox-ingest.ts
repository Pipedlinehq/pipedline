/**
 * The whole POS path against a Square SANDBOX account: a fresh database, a new org connected
 * to the sandbox location with read-only scopes, the back-fill, then the tenant-zero acceptance
 * checks (ledger vs Square, ingest twice, card-identifier search, isolation).
 *
 *   pnpm tsx scripts/square-sandbox-ingest.ts      (reads SQUARE_SMOKE_ACCESS_TOKEN from .env.local)
 */
import { existsSync, readFileSync } from 'node:fs';
import { createSquareAdapter } from '@ros/adapters';
import { ledger, tenancy } from '@ros/modules';
import { createTestApp, fakeClock } from '../packages/testkit/src/app';
import { createDatabase, migrateDatabase, startLocalPg } from '../packages/testkit/src/local-pg';
import { tenantZeroAcceptance } from './tenant-zero';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
  }
}
const token = process.env.SQUARE_SMOKE_ACCESS_TOKEN;
if (!token) throw new Error('Set SQUARE_SMOKE_ACCESS_TOKEN to a sandbox access token.');

const pg = await startLocalPg();
let code = 1;
try {
  const url = await createDatabase(pg, 'square_sandbox');
  await migrateDatabase(url);
  const t = createTestApp(url, { clock: fakeClock(new Date()) });
  const square = createSquareAdapter();
  t.app.adapters.register('pos', square);
  t.app.adapters.register('payment', square);

  const org = await t.app.platform('square sandbox check', (p) =>
    tenancy.createOrg(p, { slug: 'square-sandbox', legalName: 'Square Sandbox Check', tradingName: 'Square Sandbox Check', timezone: 'Australia/Sydney', owner: { email: 'owner@square-sandbox.test', firstName: 'Olive' }, venue: { name: 'Sandbox venue' } }),
  );
  const base = { id: 'x', orgId: org.orgId, venueId: org.venueId, plugKey: 'square', externalAccountId: '', scopes: [], config: { environment: 'sandbox' }, credentials: { accessToken: token } };
  const loc = (await square.listLocations(base))[0]!;
  await t.app.tenant(org.orgId, { kind: 'worker', job: 'square-sandbox' }, (ctx) =>
    ledger.connectPos(ctx, {
      plugKey: 'square',
      venueId: org.venueId,
      externalAccountId: `sandbox:${loc.ref}`,
      locationRef: loc.ref,
      credentials: { accessToken: token, webhookSecret: 'unused-in-this-check' },
      config: { environment: 'sandbox', currency: 'AUD', ...(process.env.SQUARE_APPLICATION_ID ? { applicationId: process.env.SQUARE_APPLICATION_ID } : {}) },
      scopes: ledger.SQUARE_READ_SCOPES,
    }),
  );
  const report = await tenantZeroAcceptance(t.app, { org: 'square-sandbox', months: 12, onProgress: (l) => console.log(l) });
  console.log(`\n${report.text}`);
  code = report.ok ? 0 : 1;
  await t.close();
} finally {
  await pg.stop();
}
process.exit(code);
