/**
 * Gate: every module carries a manifest an owner can read (docs/CONSOLE_IA.md section 6;
 * docs/PLUGINS.md "Manifest"). The public catalogue, the console's Channels and Plugins pages
 * and the assistant's `plugins_list` are all generated from it, so a thin or jargon-laden
 * manifest is what a venue owner sees.
 *
 *   - every module (test_ ones aside) has a manifest and it passes its schema: no empty field
 *   - the manifest's name is the module's name, so a card and a confirmation question agree
 *   - no banned word: "SKU", "merchant", "fulfilment"/"fulfillment", "inventory" (section 1 of CONSOLE_IA)
 *   - the channels are the channels: website, qr, ordering, delivery, bookings, guest-plugin are
 *     `kind: 'channel'` and nothing else is; every channel has a `publicAddress`
 *   - a spine module is `kind: 'module'`
 *   - `DOCUMENTED_MODULES` (what the catalogue links to) matches docs/modules/<key>.md on disk
 *
 * Exits non-zero on any violation.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { checkManifest, listModuleDefs } from '@ros/core';
import { tenancy } from '@ros/modules';
import { REPO_ROOT } from '../packages/testkit/src/local-pg';

const BANNED = [/\bskus?\b/i, /\bmerchants?\b/i, /\bfulfil+ment\b/i, /\binventory\b/i];
const CHANNELS = new Set(['website', 'qr', 'ordering', 'delivery', 'bookings', 'guest-plugin']);

const defs = listModuleDefs().filter((d) => !d.key.startsWith('test_'));
const problems: string[] = [];

for (const def of defs) {
  const m = def.manifest as Partial<typeof def.manifest> | undefined;
  if (!m) {
    problems.push(`${def.key}: no manifest`);
    continue;
  }
  for (const issue of checkManifest(def)) problems.push(`${def.key}: ${issue}`);

  const texts: Array<[string, string]> = [
    ['name', m.name ?? ''],
    ['purpose', m.purpose ?? ''],
    ...(m.needs ?? []).map((t, i) => [`needs[${i}]`, t] as [string, string]),
    ...(m.reads ?? []).map((t, i) => [`reads[${i}]`, t] as [string, string]),
    ...(m.writes ?? []).map((t, i) => [`writes[${i}]`, t] as [string, string]),
    ...(m.consent ? ([['consent', m.consent]] as Array<[string, string]>) : []),
  ];
  for (const [field, text] of texts) {
    for (const re of BANNED) {
      const hit = text.match(re);
      if (hit) problems.push(`${def.key}: ${field} uses the banned word "${hit[0]}" (write it for a venue owner)`);
    }
  }

  if (CHANNELS.has(def.key)) {
    if (m.kind !== 'channel') problems.push(`${def.key}: is a channel and must say kind: 'channel'`);
    if (typeof m.publicAddress !== 'function') problems.push(`${def.key}: a channel needs a publicAddress`);
  } else if (m.kind === 'channel') {
    problems.push(`${def.key}: says kind: 'channel' but is not one of the channels (${[...CHANNELS].join(', ')}); add it to the list in scripts/check-manifests.ts if it is`);
  }
  if (def.spine && m.kind !== 'module') problems.push(`${def.key}: a spine module is kind: 'module'`);
}

// The docs the catalogue links to must exist, and every spec that exists must be linked.
const docsDir = path.join(REPO_ROOT, 'docs/modules');
const onDisk = new Set((await readdir(docsDir)).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)));
const moduleKeys = new Set(defs.map((d) => d.key));
for (const key of tenancy.DOCUMENTED_MODULES) {
  if (!onDisk.has(key)) problems.push(`DOCUMENTED_MODULES names "${key}" but docs/modules/${key}.md does not exist`);
  if (!moduleKeys.has(key)) problems.push(`DOCUMENTED_MODULES names "${key}" but no module has that key`);
}
for (const key of onDisk) {
  if (moduleKeys.has(key) && !tenancy.DOCUMENTED_MODULES.includes(key)) problems.push(`docs/modules/${key}.md exists but DOCUMENTED_MODULES (packages/modules/src/tenancy/plugins.ts) does not list "${key}"`);
}

if (problems.length) {
  console.error(`Manifest problems (${problems.length}):\n` + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
const channels = defs.filter((d) => d.manifest.kind === 'channel').length;
console.log(`manifests ok: ${defs.length} modules, ${channels} channels, ${defs.filter((d) => d.spine).length} always on, ${tenancy.DOCUMENTED_MODULES.length} with docs`);
