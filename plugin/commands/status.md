---
description: Shows the connected Plane project, whether it is in sync, pending items in both directions, the last sync attempt, and the automation state
---

`/gsd-with-plane:status` command.

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

## Status

If there is no `.planning/` in the cwd, display the GSD alert and stop (do not run the script).
Run `node "$SCRIPTS/status-plane.mjs"` (read-only — the internal dry-runs mutate nothing)
and present the output to the user faithfully: keep the project link clickable, highlight
"In sync: YES/NO" and, if there are pending items (push/pull/orphans/warnings), list them and
explain in one sentence what each one means. If the script reports the project as not
connected or the credential as missing, suggest `/gsd-with-plane:init`.
