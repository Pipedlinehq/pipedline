/**
 * Gate: "No module may read another module's tables directly" (docs/MODULES.md contract item 4).
 *
 *   - every table in the schema is owned by exactly one module, or by core
 *   - a module may do anything to its own tables
 *   - any module may read spine tables (customers, transactions, events, venues …); writes to
 *     them go through the spine's functions
 *   - spine modules form one layer and may touch each other's tables
 *   - nothing outside core touches core's tables (jobs, audit_log, secrets …)
 *
 * Exits non-zero on any violation.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { listModuleDefs } from '@ros/core';
import '@ros/modules';
import { REPO_ROOT } from '../packages/testkit/src/local-pg';

const CORE_TABLES = new Set(['jobs', 'side_effects', 'audit_log', 'rate_limits', 'webhook_events', 'secrets']);
const MODULES_SRC = path.join(REPO_ROOT, 'packages/modules/src');
const VERB = /\b(selectFrom|insertInto|updateTable|deleteFrom|replaceInto|mergeInto|innerJoin|leftJoin|rightJoin|fullJoin|innerJoinLateral|leftJoinLateral)\(\s*['"`]([a-z_][a-z0-9_]*)(?:\s+as\s+\w+)?['"`]/g;
const RAW = /\b(from|join|into|update)\s+(?:public\.)?([a-z_][a-z0-9_]*)\b/gi;
const WRITES = new Set(['insertInto', 'updateTable', 'deleteFrom', 'replaceInto', 'mergeInto']);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const defs = listModuleDefs().filter((d) => !d.key.startsWith('test_'));
const owner = new Map<string, string>();
const problems: string[] = [];
for (const d of defs) {
  for (const t of d.tables) {
    if (owner.has(t)) problems.push(`table ${t} is claimed by both ${owner.get(t)} and ${d.key}`);
    owner.set(t, d.key);
  }
}
const spine = new Set(defs.filter((d) => d.spine).map((d) => d.key));

// Which module keys does each source directory define?
const dirKeys = new Map<string, Set<string>>();
for (const dir of (await readdir(MODULES_SRC, { withFileTypes: true })).filter((e) => e.isDirectory())) {
  const keys = new Set<string>();
  for (const file of await walk(path.join(MODULES_SRC, dir.name))) {
    const src = await readFile(file, 'utf8');
    for (const m of src.matchAll(/defineModule\(\{\s*key:\s*['"]([a-z_]+)['"]/g)) keys.add(m[1]!);
  }
  dirKeys.set(dir.name, keys);
}

// Every table in the schema must have an owner.
const gen = await readFile(path.join(REPO_ROOT, 'packages/core/src/db.gen.ts'), 'utf8');
const dbBlock = gen.slice(gen.indexOf('export interface DB {'));
const allTables = [...dbBlock.matchAll(/^\s{2}([a-z_][a-z0-9_]*):/gm)].map((m) => m[1]!);
for (const t of allTables) {
  if (!owner.has(t) && !CORE_TABLES.has(t)) problems.push(`table ${t} has no owning module (add it to a module's "tables")`);
}
const known = new Set(allTables);

for (const [dir, keys] of dirKeys) {
  const dirIsSpine = [...keys].some((k) => spine.has(k));
  for (const file of await walk(path.join(MODULES_SRC, dir))) {
    const src = await readFile(file, 'utf8');
    const rel = path.relative(REPO_ROOT, file);
    const check = (verb: string, table: string, isWrite: boolean) => {
      if (!known.has(table)) return;
      if (CORE_TABLES.has(table)) {
        problems.push(`${rel}: ${verb}('${table}') — core table; use the core function for it`);
        return;
      }
      const o = owner.get(table);
      if (!o || keys.has(o)) return;
      if (spine.has(o)) {
        if (dirIsSpine) return;
        if (isWrite) problems.push(`${rel}: ${verb}('${table}') — writes to the ${o} spine table go through its functions`);
        return;
      }
      problems.push(`${rel}: ${verb}('${table}') — table belongs to module "${o}"; use a function it publishes`);
    };
    for (const m of src.matchAll(VERB)) check(m[1]!, m[2]!, WRITES.has(m[1]!));
    // Raw SQL inside sql`…` templates.
    for (const tpl of src.matchAll(/sql(?:<[^>]*>)?`([^`]*)`/g)) {
      for (const m of tpl[1]!.matchAll(RAW)) check(`sql ${m[1]!.toLowerCase()}`, m[2]!, /into|update/i.test(m[1]!));
    }
  }
}

if (problems.length) {
  console.error(`Module boundary violations (${problems.length}):\n` + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`module boundaries ok: ${defs.length} modules, ${allTables.length} tables, ${dirKeys.size} source directories`);
