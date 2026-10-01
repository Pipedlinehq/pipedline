import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { App } from '@ros/core';
import { FIXTURE_ORGS, seedOrg, type SeedOptions } from './base';
import { loadFixture, type Fixture } from './load';

export * from './base';
export * from './load';
export * from './rng';
export * from './data';

/**
 * A module's fixture seeds (docs/MODULES.md contract item 5). Put one file per module in
 * ./seeders, named NN-module.ts, default-exporting one of these. They run in file-name order
 * after the spine is seeded, with the clock at "today".
 */
export interface ModuleSeeder {
  module: string;
  seed(app: App, fixture: Fixture, opts: SeedOptions): Promise<void>;
}

export async function seedFixtures(app: App, opts: SeedOptions): Promise<Fixture> {
  await app.db
    .insertInto('users')
    .values({ email: 'admin@rosplatform.test', name: 'Platform Admin' })
    .onConflict((oc) => oc.column('email').doNothing())
    .execute();
  const admin = await app.db.selectFrom('users').select('id').where('email', '=', 'admin@rosplatform.test').executeTakeFirstOrThrow();
  await app.db.insertInto('platform_admins').values({ user_id: admin.id }).onConflict((oc) => oc.doNothing()).execute();

  for (const spec of FIXTURE_ORGS) await seedOrg(app, spec, opts);
  opts.setNow(opts.now);
  const fixture = await loadFixture(app);

  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seeders');
  const files = (await readdir(dir)).filter((f) => /^\d+-.+\.ts$/.test(f)).sort();
  const failures: string[] = [];
  for (const file of files) {
    try {
      const mod = (await import(pathToFileURL(path.join(dir, file)).href)) as { default: ModuleSeeder };
      await mod.default.seed(app, fixture, opts);
    } catch (e) {
      // While modules are being built in parallel, one module's broken seeder must not take
      // every other module's tests down with it. The gates run strict.
      if (process.env.ROS_STRICT_SEEDERS === '1') throw e;
      failures.push(`${file}: ${(e as Error).message}`);
    }
    opts.setNow(opts.now);
  }
  if (failures.length) console.error(`\nFIXTURE SEEDERS FAILED (${failures.length}) — their data is missing from this run:\n  ${failures.join('\n  ')}\n`);
  return fixture;
}
