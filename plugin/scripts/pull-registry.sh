#!/usr/bin/env bash
# Background runner (launchd on macOS, systemd timer or cron on Linux — see
# setup-automation.sh): walks the connected GSD projects (registry fed by
# /gsd-with-plane:init) and triggers a pull→push cycle in each one.
# Registry: ~/.cache/gsd-with-plane/projects.txt (one directory per line).
#
# Projects in webhook mode (.gsd-plane.json syncMode=webhook) are synced in
# realtime by webhook-server.mjs; here they only get a SAFETY-NET pass when
# their poll stamp is older than safetyPollMinutes (webhook.json, default 30) —
# Plane silently deactivates webhooks after 5 failed deliveries (e.g. laptop
# asleep), so low-frequency polling must keep covering them.
set -uo pipefail

CACHE_DIR="${GSD_PLANE_CACHE_DIR:-$HOME/.cache/gsd-with-plane}"
REG="$CACHE_DIR/projects.txt"
[ -f "$REG" ] || exit 0

# launchd runs with a minimal PATH — make sure node is found (nvm/homebrew/system)
NVM_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1 || true)"
[ -n "$NVM_BIN" ] && export PATH="$NVM_BIN:$PATH"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
command -v node >/dev/null || exit 0

HOOKS="$(cd "$(dirname "$0")/../hooks" && pwd)"
STAMPS="$CACHE_DIR/stamps"
mkdir -p "$STAMPS"

SAFETY_MIN="$(node -e '
  try {
    const cfg = require(process.argv[1]);
    console.log(Number(cfg.safetyPollMinutes) > 0 ? Number(cfg.safetyPollMinutes) : 30);
  } catch { console.log(30); }
' "$CACHE_DIR/webhook.json" 2>/dev/null || echo 30)"
NOW_MS="$(($(date +%s) * 1000))"

while IFS= read -r dir; do
  [ -n "$dir" ] && [ -d "$dir/.planning" ] || continue

  if grep -q '"syncMode"[[:space:]]*:[[:space:]]*"webhook"' "$dir/.gsd-plane.json" 2>/dev/null; then
    # stamp name must match webhook-server.mjs stampName(): non-alphanumerics → _
    STAMP="$STAMPS/$(printf %s "$dir" | tr -c 'A-Za-z0-9' '_').stamp"
    LAST_MS="$(cat "$STAMP" 2>/dev/null || echo 0)"
    case "$LAST_MS" in *[!0-9]*|'') LAST_MS=0 ;; esac
    [ "$((NOW_MS - LAST_MS))" -lt "$((SAFETY_MIN * 60 * 1000))" ] && continue
    printf %s "$NOW_MS" > "$STAMP"
  fi

  printf '{"tool_input":{"file_path":"%s/.planning/ROADMAP.md"}}' "$dir" | "$HOOKS/planning-sync.sh"
done < "$REG"

exit 0
