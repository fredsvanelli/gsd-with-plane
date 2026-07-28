---
description: Manual Plane → local sync — shows what came from the board and applies it (with a convergence push when something changed)
---

`/gsd-with-plane:pull` command.

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

## Manual Plane → local sync

Same semantics as the automatic sync (hook/background agent), just triggered now and with a report.

1. **Quick pre-checks.** If there is no `.planning/` in the cwd, display the GSD alert and
   stop. If there is no `.gsd-plane.json` at the root, say the project is not connected
   and suggest `/gsd-with-plane:init` (stop).
2. **Dry-run.** Run `node "$SCRIPTS/pull-plane.mjs"` and show the output to the user:
   `←` lines are what would come from the board, `↔` lines are board customizations the
   planner-sync overlay will capture (renamed titles, cards moved to custom columns,
   labels added by hand — all preserved, never clobbered by the push), `⚠️` are
   report-only warnings.
3. **If "Pull: 0 actions" and no `↔` captures**: say local already reflects the board
   (mention the warnings, if any) and stop — do not run `--apply` for nothing. Remind
   them that a pending push is the other direction: `/gsd-with-plane:push`.
4. **Apply.** Run `node "$SCRIPTS/pull-plane.mjs" --apply` (do not ask first — the
   automatic sync already does exactly this without asking). The script chains the
   convergence push when it applied something.
5. **Report**: what was brought in (plan checkboxes, resolved/reopened todos, issues
   adopted as todos in `.planning/todos/pending/`), board captures (`↔`), warnings, and
   the result of the convergence push. If the script fails due to a missing credential,
   point at `PLANE_API_KEY` (`.env`/`.env.local`) and suggest `/gsd-with-plane:status`.
6. The apply also refreshes `.planning/planner-sync/BOARD.md` — the digest of everything
   done directly on the board (assignees, due dates, priorities, comments, renamed cards,
   custom columns, foreign sub-items). GSD planning commands read `.planning/` and pick
   it up as context.
