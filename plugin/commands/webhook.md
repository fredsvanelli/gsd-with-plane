---
description: Switch the Plane → local sync between polling and realtime webhook mode (or check the receiver) for an already-connected project
---

`/gsd-with-plane:webhook` command. Arguments: `enable`, `disable` or `status`
(no argument → ask with AskUserQuestion, header "Webhook").

First resolve the plugin's scripts directory exactly like `/gsd-with-plane:init`
does (plugin cache → `~/.claude/skills/gsd-with-plane/scripts` → local npm →
global npm; stop with the README pointer if not found). The project must already
be connected: `.gsd-plane.json` with `workspaceSlug` must exist in the cwd —
otherwise say so and point at `/gsd-with-plane:init`.

## `status`

1. `node "$SCRIPTS/webhook-config.mjs" show` — display port, publicUrl and
   configured workspaces (secrets come pre-masked).
2. `curl -s --max-time 3 http://127.0.0.1:<port>/healthz` — if it answers, show
   `lastEventAt`, `received`, `triggered`, `rejected` and the registered
   projects; if not, the receiver daemon is not running (mode is polling, or
   `setup-automation.sh --mode webhook` was never run / failed — check
   `~/.cache/gsd-with-plane/webhook-server.log`).
3. Show this project's mode (`syncMode` in `.gsd-plane.json`, absent = polling).

## `enable`

Follow step 6's webhook sub-steps (a–e) of the `init.md` flow, verbatim: port →
URL (local `host.docker.internal` + `WEBHOOK_ALLOWED_HOSTS`, or remote
publicUrl/tunnel) → manual creation in Plane's UI + secret via
`webhook-config.mjs set-workspace` (skip the creation if `webhook-config.mjs
show` already has this workspace configured and the user confirms the Plane-side
webhook still exists) → `"syncMode": "webhook"` in `.gsd-plane.json` →
`bash "$SCRIPTS/setup-automation.sh" --mode webhook` → verify via `/healthz` +
heartbeat.

## `disable`

1. Remove the `syncMode` key from `.gsd-plane.json` (polling is the default).
2. If NO other project in `~/.cache/gsd-with-plane/projects.txt` still has
   `"syncMode": "webhook"` in its `.gsd-plane.json`, run
   `bash "$SCRIPTS/setup-automation.sh" --mode polling` to retire the receiver
   daemon; otherwise leave the daemon running (it serves the other projects) and
   say so.
3. Remind the user they may also want to delete (or disable) the webhook in
   Plane's UI (Workspace Settings → Webhooks) — the plugin cannot do it via the
   API. Keeping it does no harm if the receiver stays up for other projects;
   deliveries to a dead receiver get the webhook auto-deactivated by Plane after
   5 failures.
