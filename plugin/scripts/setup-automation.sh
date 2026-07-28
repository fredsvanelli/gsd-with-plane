#!/usr/bin/env bash
# Installs (or removes, with --remove) the background auto-sync automation:
#   --mode polling (default): pull-registry.sh every 5 minutes — launchd on
#     macOS, systemd user timer on Linux (crontab fallback).
#   --mode webhook: the polling agent (kept as a safety net, gated by
#     pull-registry.sh to safetyPollMinutes) PLUS the webhook receiver daemon
#     (webhook-server.mjs) — launchd KeepAlive on macOS, systemd user service
#     on Linux. Not supported on cron-only Linux (degrades to polling with a
#     warning).
# Idempotent — /gsd-with-plane:init re-runs it on every connection, and
# re-running just rewrites the same agents. Never fails the caller: missing
# platform support degrades to a warning (the plugin hooks still sync on every
# .planning/ edit and session start).
#
# Usage: setup-automation.sh [--remove] [--mode polling|webhook]
set -uo pipefail

# Resolve to the physical path (pwd -P) so the generated launchd/systemd units
# point at the real plugin checkout rather than a symlink (e.g.
# ~/.claude/skills/<plugin>). A symlinked path makes Node's import.meta.url
# diverge from process.argv[1] in webhook-server.mjs (see its isMainModule),
# and leaves the unit broken if the symlink is ever removed.
SCRIPTS="$(cd "$(dirname "$0")" && pwd -P)"
RUNNER="$SCRIPTS/pull-registry.sh"
SERVER="$SCRIPTS/webhook-server.mjs"
CACHE_DIR="${GSD_PLANE_CACHE_DIR:-$HOME/.cache/gsd-with-plane}"
INTERVAL=300
REMOVE=0
MODE=polling
while [ $# -gt 0 ]; do
  case "$1" in
    --remove) REMOVE=1 ;;
    --mode) shift; MODE="${1:-polling}" ;;
  esac
  shift
done
mkdir -p "$CACHE_DIR"

# The webhook daemon needs an absolute node path (launchd/systemd run with a
# minimal PATH). Resolved at install time from the interactive shell.
NODE_BIN="$(command -v node || true)"

case "$(uname -s)" in
  Darwin)
    LABEL="com.gsd-with-plane.pull"
    WH_LABEL="com.gsd-with-plane.webhook"
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    WH_PLIST="$HOME/Library/LaunchAgents/$WH_LABEL.plist"
    if [ "$REMOVE" = 1 ]; then
      launchctl unload "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
      launchctl unload "$WH_PLIST" 2>/dev/null || true
      rm -f "$WH_PLIST"
      echo "removed: launchd agents $LABEL + $WH_LABEL"
      exit 0
    fi
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>$RUNNER</string>
  </array>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <!-- the runner detaches a coalesced sync subshell; without this launchd
       reaps the whole process group the moment the entry script exits -->
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$CACHE_DIR/launchd.log</string>
  <key>StandardErrorPath</key><string>$CACHE_DIR/launchd.log</string>
</dict></plist>
EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "installed: launchd agent $LABEL (every $((INTERVAL / 60)) min) → $PLIST"

    if [ "$MODE" = "webhook" ] && [ -n "$NODE_BIN" ]; then
      cat > "$WH_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$WH_LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE_BIN</string>
    <string>$SERVER</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <!-- the receiver detaches coalesced sync subshells (same reason as above) -->
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$CACHE_DIR/webhook-server.log</string>
  <key>StandardErrorPath</key><string>$CACHE_DIR/webhook-server.log</string>
</dict></plist>
EOF
      launchctl unload "$WH_PLIST" 2>/dev/null || true
      launchctl load "$WH_PLIST"
      echo "installed: launchd agent $WH_LABEL (webhook receiver daemon) → $WH_PLIST"
    elif [ "$MODE" = "webhook" ]; then
      echo "⚠️ node not found in PATH — webhook receiver NOT installed (polling stays active)." >&2
    else
      # polling mode: retire a previously installed receiver, if any
      if [ -f "$WH_PLIST" ]; then
        launchctl unload "$WH_PLIST" 2>/dev/null || true
        rm -f "$WH_PLIST"
        echo "removed: launchd agent $WH_LABEL (mode is polling)"
      fi
    fi
    ;;

  Linux)
    if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
      UNIT_DIR="$HOME/.config/systemd/user"
      if [ "$REMOVE" = 1 ]; then
        systemctl --user disable --now gsd-with-plane-pull.timer 2>/dev/null || true
        systemctl --user disable --now gsd-with-plane-webhook.service 2>/dev/null || true
        rm -f "$UNIT_DIR/gsd-with-plane-pull.service" "$UNIT_DIR/gsd-with-plane-pull.timer" \
              "$UNIT_DIR/gsd-with-plane-webhook.service"
        systemctl --user daemon-reload 2>/dev/null || true
        echo "removed: systemd user units gsd-with-plane-pull + gsd-with-plane-webhook"
        exit 0
      fi
      mkdir -p "$UNIT_DIR"
      cat > "$UNIT_DIR/gsd-with-plane-pull.service" <<EOF
[Unit]
Description=gsd-with-plane: pull→push sync of connected GSD projects

[Service]
Type=oneshot
ExecStart=/bin/bash $RUNNER
StandardOutput=append:$CACHE_DIR/systemd.log
StandardError=append:$CACHE_DIR/systemd.log
EOF
      cat > "$UNIT_DIR/gsd-with-plane-pull.timer" <<EOF
[Unit]
Description=gsd-with-plane: run the pull sync every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=${INTERVAL}sec

[Install]
WantedBy=timers.target
EOF
      systemctl --user daemon-reload
      systemctl --user enable --now gsd-with-plane-pull.timer
      echo "installed: systemd user timer gsd-with-plane-pull (every $((INTERVAL / 60)) min)"

      if [ "$MODE" = "webhook" ] && [ -n "$NODE_BIN" ]; then
        cat > "$UNIT_DIR/gsd-with-plane-webhook.service" <<EOF
[Unit]
Description=gsd-with-plane: webhook receiver (realtime Plane → local sync)

[Service]
ExecStart=$NODE_BIN $SERVER
Restart=on-failure
RestartSec=5
StandardOutput=append:$CACHE_DIR/webhook-server.log
StandardError=append:$CACHE_DIR/webhook-server.log

[Install]
WantedBy=default.target
EOF
        systemctl --user daemon-reload
        systemctl --user enable --now gsd-with-plane-webhook.service
        systemctl --user restart gsd-with-plane-webhook.service 2>/dev/null || true
        echo "installed: systemd user service gsd-with-plane-webhook (receiver daemon)"
      elif [ "$MODE" = "webhook" ]; then
        echo "⚠️ node not found in PATH — webhook receiver NOT installed (polling stays active)." >&2
      else
        if [ -f "$UNIT_DIR/gsd-with-plane-webhook.service" ]; then
          systemctl --user disable --now gsd-with-plane-webhook.service 2>/dev/null || true
          rm -f "$UNIT_DIR/gsd-with-plane-webhook.service"
          systemctl --user daemon-reload 2>/dev/null || true
          echo "removed: systemd user service gsd-with-plane-webhook (mode is polling)"
        fi
      fi
    elif command -v crontab >/dev/null 2>&1; then
      if [ "$REMOVE" = 1 ]; then
        (crontab -l 2>/dev/null | grep -v 'gsd-with-plane') | crontab - 2>/dev/null || true
        echo "removed: crontab entry (gsd-with-plane)"
        exit 0
      fi
      LINE="*/5 * * * * /bin/bash $RUNNER >> $CACHE_DIR/cron.log 2>&1 # gsd-with-plane"
      (crontab -l 2>/dev/null | grep -v 'gsd-with-plane'; echo "$LINE") | crontab -
      echo "installed: crontab entry (every 5 min)"
      if [ "$MODE" = "webhook" ]; then
        echo "⚠️ webhook mode needs a daemon supervisor (systemd user session) — cron can't keep" >&2
        echo "   the receiver alive. Staying on polling; the 5-min cron sync remains active." >&2
      fi
    else
      echo "⚠️ no systemd user session or crontab available — background sync NOT installed." >&2
      echo "   The plugin hooks still sync on every .planning/ edit and session start." >&2
    fi
    ;;

  *)
    echo "⚠️ unsupported platform for background sync: $(uname -s) (the plugin hooks still work)." >&2
    ;;
esac

exit 0
