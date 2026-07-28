#!/usr/bin/env bash
# SessionStart hook: when a session opens in a connected GSD project, triggers
# a pull→push cycle in the background (changes made on the board while you were
# away land in .planning/ before you start working).
# Reuses planning-sync.sh's coalesced runner via a synthetic event.
set -uo pipefail

INPUT="$(cat)"
CWD="$(printf '%s' "$INPUT" | node -e '
  let s = "";
  process.stdin.on("data", (c) => (s += c));
  process.stdin.on("end", () => {
    try { process.stdout.write(JSON.parse(s).cwd ?? ""); } catch {}
  });
' 2>/dev/null)" || CWD=""
CWD="${CWD:-$PWD}"

[ -d "$CWD/.planning" ] || exit 0
# Only connected projects (init binding) or with a local credential
[ -f "$CWD/.gsd-plane.json" ] || [ -f "$CWD/.env" ] || [ -f "$CWD/.env.local" ] || exit 0

DIR="$(cd "$(dirname "$0")" && pwd)"
printf '{"tool_input":{"file_path":"%s/.planning/ROADMAP.md"}}' "$CWD" | "$DIR/planning-sync.sh"
exit 0
