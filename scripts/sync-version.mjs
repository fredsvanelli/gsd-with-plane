#!/usr/bin/env node
// Keeps plugin/.claude-plugin/plugin.json's `version` in lockstep with
// package.json. Run automatically by `npm version` (see the "version" script),
// which then stages the updated manifest into the release commit.
//
// Usage: node scripts/sync-version.mjs [--check]
//   --check  exit 1 if out of sync instead of writing (for CI)

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const pkgPath = new URL('package.json', root);
const manifestPath = new URL('plugin/.claude-plugin/plugin.json', root);
const check = process.argv.includes('--check');

const { version } = JSON.parse(await readFile(pkgPath, 'utf8'));
const raw = await readFile(manifestPath, 'utf8');
const manifest = JSON.parse(raw);

if (manifest.version === version) {
  console.log(`plugin.json already at ${version}`);
  process.exit(0);
}

if (check) {
  console.error(
    `version drift: package.json is ${version}, plugin.json is ${manifest.version}\n`
    + 'run `node scripts/sync-version.mjs` to fix',
  );
  process.exit(1);
}

// Rewrite in place so key order and the file's own indentation survive.
const previous = manifest.version ?? '(unset)';
const indent = raw.match(/\n(\s+)"/)?.[1] ?? '  ';
manifest.version = version;
await writeFile(fileURLToPath(manifestPath), `${JSON.stringify(manifest, null, indent)}\n`);
console.log(`plugin.json ${previous} → ${version}`);
