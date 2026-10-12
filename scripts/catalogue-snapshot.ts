/**
 * Writes docs/plugins.snapshot.json: the public plugin catalogue (the shape `/plugins.json`
 * serves, docs/CONSOLE_IA.md section 6) as it stands in this checkout, so the product site has a
 * fallback when the platform host cannot be reached. Needs no database: the catalogue is built
 * from the module definitions alone.
 *
 *   pnpm catalogue:snapshot                      # for app.pipedline.com
 *   ROS_PLATFORM_HOST=host:3000 ROS_SCHEME=http pnpm catalogue:snapshot
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '@ros/core';
import { tenancy } from '@ros/modules';
import { REPO_ROOT } from '../packages/testkit/src/local-pg';

const OUT = path.join(REPO_ROOT, 'docs/plugins.snapshot.json');

// Production: simulated plugs are left out, as the live host leaves them out.
const config = {
  platformHost: process.env.ROS_PLATFORM_HOST ?? 'app.pipedline.com',
  scheme: (process.env.ROS_SCHEME === 'http' ? 'http' : 'https') as AppConfig['scheme'],
  env: 'production' as AppConfig['env'],
} as AppConfig;

const catalogue = tenancy.pluginCatalogue({ config, clock: () => new Date() });
tenancy.pluginCatalogueShape.parse(catalogue);
await writeFile(OUT, JSON.stringify(catalogue, null, 2) + '\n');
console.log(`wrote ${path.relative(REPO_ROOT, OUT)}: ${catalogue.plugins.length} plugins for ${catalogue.platform}`);
