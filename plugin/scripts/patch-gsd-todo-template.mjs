// Opt-in step of /gsd-with-linear:init (agile templates, option B): patches
// GSD's GLOBAL todo capture workflow (add-todo.md) so newly captured todos get
// an "## Acceptance Criteria" section alongside Problem/Solution. The push then
// mirrors it on the board (todoBody in desired.mjs).
//
// GSD itself makes this survivable: its updater backs locally modified files up
// to gsd-local-patches/ and `/gsd-update --reapply` merges them into the new
// version — so the patch is not silently lost on `gsd update`.
//
// Usage: node plugin/scripts/patch-gsd-todo-template.mjs [--check] [--gsd-dir <path>]
//   --check    report the patch status without writing
//   --gsd-dir  GSD install dir (default: ~/.claude/gsd-core, then the legacy
//              ~/.claude/get-shit-done)
// Exit codes: 0 patched / already patched / --check; 2 GSD not found or the
// add-todo template block was not recognized (nothing written).

import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SECTION_HEADING = '## Acceptance Criteria';
// Anchor: the exact tail of add-todo.md's file-template block (same text in
// gsd-core 1.6 and get-shit-done 1.x). If GSD rewords it, we bail out rather
// than patch the wrong spot.
const ANCHOR = '## Solution\n\n[approach hints or "TBD"]';
const PATCH = `${ANCHOR}\n\n${SECTION_HEADING}\n\n- [ ] [verifiable outcome — one checkbox per criterion, or "TBD"]`;

const args = process.argv.slice(2);
const check = args.includes('--check');
const dirFlag = args.indexOf('--gsd-dir');
const candidates = dirFlag !== -1
  ? [args[dirFlag + 1]]
  : [join(homedir(), '.claude', 'gsd-core'), join(homedir(), '.claude', 'get-shit-done')];

let target = null;
for (const dir of candidates) {
  const file = join(dir, 'workflows', 'add-todo.md');
  try {
    await access(file);
    target = file;
    break;
  } catch { /* try the next candidate */ }
}
if (!target) {
  console.error(`GSD not found (looked for workflows/add-todo.md under: ${candidates.join(', ')})`);
  process.exit(2);
}

const text = await readFile(target, 'utf8');
if (text.includes(SECTION_HEADING)) {
  console.log(`Already patched: ${target} already captures "${SECTION_HEADING}".`);
  process.exit(0);
}
if (check) {
  console.log(`Not patched: ${target} has no "${SECTION_HEADING}" section.`);
  process.exit(0);
}
if (!text.includes(ANCHOR)) {
  console.error(`Unrecognized add-todo template block in ${target} — patch skipped (GSD version too old/new?).`);
  process.exit(2);
}

await writeFile(target, text.replace(ANCHOR, PATCH));
console.log(`Patched ${target}: new todos captured by GSD now include an "${SECTION_HEADING}" section.`);
console.log('Note: this is global (all GSD projects). After a `gsd update`, run `/gsd-update --reapply` to merge it back (GSD backs it up in gsd-local-patches/).');
