---
description: Manual local → Plane sync — shows the diff and applies it (idempotent, never deletes anything in Plane)
---

`/gsd-with-plane:push` command.

First resolve the plugin's scripts directory (set once and reuse). Try, in order:
Claude Code's plugin cache → local npm install → global npm install:

```bash
SCRIPTS="$(find -L ~/.claude/plugins/cache -maxdepth 4 -type d -name scripts -path '*gsd-with-plane*' 2>/dev/null | head -1)"
[ -z "$SCRIPTS" ] && [ -d "$HOME/.claude/skills/gsd-with-plane/scripts" ] \
  && SCRIPTS="$HOME/.claude/skills/gsd-with-plane/scripts"
[ -z "$SCRIPTS" ] && [ -d "./node_modules/@fredsvanelli/gsd-with-plane/plugin/scripts" ] \
  && SCRIPTS="./node_modules/@fredsvanelli/gsd-with-plane/plugin/scripts"
if [ -z "$SCRIPTS" ]; then
  G="$(npm root -g 2>/dev/null)/@fredsvanelli/gsd-with-plane/plugin/scripts"
  [ -d "$G" ] && SCRIPTS="$G"
fi
echo "SCRIPTS=$SCRIPTS"
```

If `SCRIPTS` ends up empty, tell the user the plugin scripts could not be located
and point them to the Installation section of the plugin's README, then stop.
Run every `node` command with the **GSD project directory as cwd** (the directory
containing `.planning/` — usually the current cwd).

**GSD dependency alert** (referenced below as "GSD alert"): when indicated,
display exactly this message before stopping:

> ⚠️ This plugin requires **GSD** to be installed: it mirrors the `.planning/`
> directory that GSD creates and maintains — without GSD, there is nothing to sync.
> Install it from https://github.com/open-gsd/gsd-core and initialize the project with
> `/gsd-new-project` before using the `/gsd-with-plane:*` commands.

## Manual local → Plane sync

1. **Quick pre-checks.** If there is no `.planning/` in the cwd, display the GSD alert and
   stop. If there is no `.gsd-plane.json` at the root, say the project is not connected
   and suggest `/gsd-with-plane:init` (stop).
2. **Dry-run.** Run `node "$SCRIPTS/sync-roadmap.mjs"` and show the summary
   (Workspace/Project, desired-state counts, operations).
3. **If "Operations: 0 (all up to date)"**: say Plane already reflects local and stop.
   If there are orphans (`⚠️`), explain: they exist in Plane but are gone from `.planning/` —
   the push never deletes; archiving them on the board is the user's manual decision.
4. **Apply.** Run `node "$SCRIPTS/sync-roadmap.mjs" --apply` (do not ask first —
   the push is idempotent and never deletes anything in Plane).
5. **Report**: applied operations (X/Y), orphans if any, and the project link.
   If any operation fails (e.g. a transient 502 from the Plane API), say that running
   `/gsd-with-plane:push` again is enough — the sync is idempotent and resumes where it
   left off. 429s are handled automatically (the script waits for the rate-limit window);
   for chronically big pushes suggest raising `API_KEY_RATE_LIMIT` in Plane's `.env`.
6. **Overlay notes.** `↔` lines are planner-sync decisions: ops labeled
   `(keeping board title/column)` mean a board-side customization was respected
   (not clobbered); `override dropped/released` means GSD itself changed that field
   and won. The full picture of board-side customizations lives in
   `.planning/planner-sync/BOARD.md`.
