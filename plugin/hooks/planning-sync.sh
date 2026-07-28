#!/usr/bin/env bash
# PostToolUse hook (matcher: Write|Edit|MultiEdit): when a GSD skill writes
# .planning/ROADMAP.md or .planning/STATE.md, triggers the sync → Plane in the
# background. Never blocks or fails Claude's turn (always exit 0); the result
# lands in ~/.cache/gsd-with-plane/sync.log.
set -uo pipefail

INPUT="$(cat)"

# Extracts tool_input.file_path from the hook JSON (node is guaranteed: the
# sync itself is node). Any parse failure → not our event, exit quietly.
FILE_PATH="$(printf '%s' "$INPUT" | node -e '
  let s = "";
  process.stdin.on("data", (c) => (s += c));
  process.stdin.on("end", () => {
    try { process.stdout.write(JSON.parse(s).tool_input?.file_path ?? ""); } catch {}
  });
' 2>/dev/null)" || exit 0

case "$FILE_PATH" in
  */.planning/ROADMAP.md|*/.planning/STATE.md) ;;
  */.planning/quick/*|*/.planning/todos/*) ;;
  # phase artifacts (HUMAN-UAT/VERIFICATION/REVIEW-FIX) and debug sessions
  # change board columns/states — sync without waiting for the 5-min polling
  */.planning/phases/*|*/.planning/debug/*) ;;
  *) exit 0 ;;
esac

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CACHE_DIR="${GSD_PLANE_CACHE_DIR:-$HOME/.cache/gsd-with-plane}"
LOCK="$CACHE_DIR/lock"
PENDING="$CACHE_DIR/pending"
LOG="$CACHE_DIR/sync.log"
mkdir -p "$CACHE_DIR"

# Coalescing: GSD skills produce bursts of Edits. Each event marks "pending";
# only one runner runs at a time (lock via mkdir, atomic) and it repeats while
# new events keep arriving during the previous sync.
echo "$(date +%s) $FILE_PATH" >> "$PENDING"

if mkdir "$LOCK" 2>/dev/null; then
  (
    trap 'rmdir "$LOCK" 2>/dev/null' EXIT
    while [ -s "$PENDING" ]; do
      sleep 2  # window for the burst to settle (events arriving meanwhile join this pass)
      # Drain EVERY project dir with pending events, not just ours — webhook
      # deliveries (webhook-server.mjs) interleave projects, and events queued
      # while another project's sync holds the lock must not be dropped.
      DIRS="$(cut -d' ' -f2- "$PENDING" | sed 's|/\.planning/.*||' | sort -u)"
      : > "$PENDING"
      while IFS= read -r dir; do
        [ -n "$dir" ] && [ -d "$dir/.planning" ] || continue
        {
          echo "--- $(date '+%Y-%m-%d %H:%M:%S') sync ($dir)"
          # pull first (Plane → local; --no-push since the push comes next),
          # then push (local → Plane) — every local edit also reconciles
          # changes made on the board since the last round.
          (cd "$dir" && node "$PLUGIN_ROOT/scripts/pull-plane.mjs" --apply --no-push)
          (cd "$dir" && node "$PLUGIN_ROOT/scripts/sync-roadmap.mjs" --apply)
        } >> "$LOG" 2>&1 || echo "sync FAILED (see above)" >> "$LOG"
      done <<< "$DIRS"
    done
  ) >/dev/null 2>&1 &
  disown 2>/dev/null || true
fi

exit 0
