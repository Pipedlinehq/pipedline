/**
 * Gate: "Venues are data, behaviour is code" (docs/DEPLOYMENT.md section 1). Code never
 * branches on which tenant it is. This fails on any comparison of an org or venue identity
 * with a literal. Fixtures and tests are exempt: they are about specific tenants by nature.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT } from '../packages/testkit/src/local-pg';

const ROOTS = ['packages/core/src', 'packages/modules/src', 'packages/adapters/src', 'apps'];
const PATTERNS: RegExp[] = [
  /\b(orgId|org_id|orgSlug|org\.slug|org\.id|venueId|venue_id|venue\.slug|venue\.id|tenantId|tenant\.slug)\s*(===|!==|==|!=)\s*['"`][^'"`]+['"`]/,
  /['"`][^'"`]+['"`]\s*(===|!==|==|!=)\s*(orgId|org_id|orgSlug|org\.slug|org\.id|venueId|venue_id|venue\.slug|venue\.id|tenantId|tenant\.slug)\b/,
  /\b(case)\s+['"`](oak-[a-z-]+)['"`]/,
];
const ALLOW = /tenant-branching-ok:/;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const hits: string[] = [];
let files = 0;
for (const root of ROOTS) {
  for (const file of await walk(path.join(REPO_ROOT, root))) {
    files++;
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (ALLOW.test(line) || ALLOW.test(lines[i - 1] ?? '')) return;
      if (PATTERNS.some((p) => p.test(line))) hits.push(`${path.relative(REPO_ROOT, file)}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
}

if (hits.length) {
  console.error(`Code branches on a specific tenant (${hits.length}). Make it config, or an adapter:\n` + hits.map((h) => `  - ${h}`).join('\n'));
  process.exit(1);
}
console.log(`tenant branching ok: ${files} files checked`);
