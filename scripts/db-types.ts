/**
 * Regenerates packages/core/src/db.gen.ts from the migrations: boots a throwaway Postgres,
 * applies every migration, and introspects it. Run after adding or changing a migration.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT, createDatabase, migrateDatabase, startLocalPg } from '../packages/testkit/src/local-pg';

const server = await startLocalPg();
try {
  const url = await createDatabase(server, 'types');
  const applied = await migrateDatabase(url);
  console.log(`applied ${applied.length} migrations`);
  const out = path.join(REPO_ROOT, 'packages/core/src/db.gen.ts');
  execFileSync(
    path.join(REPO_ROOT, 'node_modules/.bin/kysely-codegen'),
    [
      '--dialect', 'postgres',
      '--url', url,
      '--out-file', out,
      '--numeric-parser', 'number',
      '--date-parser', 'string',
      '--type-mapping', '{"int8":"number"}',
      '--exclude-pattern', 'schema_migrations',
    ],
    { stdio: 'inherit' },
  );
  console.log(`wrote ${path.relative(REPO_ROOT, out)}`);
} finally {
  await server.stop();
}
