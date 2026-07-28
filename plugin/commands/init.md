---
description: Connects this GSD project to a Plane workspace/project (local or self-hosted server) and runs the initial (bidirectional) sync
---

`/gsd-with-plane:init` command.

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

## Initialization process

Follow ALL steps, in order. Use AskUserQuestion for every selection.

1. **Pre-checks.**
   - Confirm `.planning/ROADMAP.md` exists in the cwd. If it doesn't, say this is not a GSD project, display the GSD alert and stop.
   - Confirm the credential: `PLANE_API_KEY` in the environment, `.env` or `.env.local` of the cwd. If missing, explain how to create an API token (Plane → Workspace Settings → API tokens → Add API token), ask them to paste it into `.env.local` as `PLANE_API_KEY=...` and stop (do not ask for the key in the chat).
   - Confirm the host: `PLANE_API_HOST_URL` in the environment/`.env`/`.env.local`. If absent, the default is `http://localhost` (the local Docker stack). If the user runs Plane on a server, they should set `PLANE_API_HOST_URL=https://plane.example.com` in the same `.env.local` — mention this but don't block on it.

2. **Workspace slug.** Plane's API scopes everything under a workspace slug and has no discovery endpoint for it. Resolve in order: existing `.gsd-plane.json` → `PLANE_WORKSPACE_SLUG` in env/`.env`/`.env.local` → ask the user (AskUserQuestion with header "Workspace"; explain the slug is visible in the Plane URL: `http://<host>/<slug>/`).

3. **Discovery.** Run `node "$SCRIPTS/init-plane.mjs" --workspace <slug>` and parse the JSON: `host`, `workspace` (slug + authenticated user — show them so the user confirms the token belongs to the right account), `projects`. If it errors with an invalid-token message, point back at step 1; if the workspace 404s, the slug is wrong — ask again.

4. **Project selection**: AskUserQuestion with the existing projects (name + identifier; mark those with `gsdManaged: true` as "already managed by gsd-sync" and those with `hasIssues: true` as "has content") + the option **"Create new project"** (recommended when no project matches this repository).

5. **Write the binding**: write `.gsd-plane.json` at the project root with `{"workspaceSlug": "...", "projectId": "...", "projectName": "..."}` — for "Create new", omit `projectId`/`projectName` (the push creates the project named after the ROADMAP and finds it by marker from then on). Also register the project for background polling: add the absolute path of the project root (one line) to `~/.cache/gsd-with-plane/projects.txt`, without duplicating (`sort -u`), and install/refresh the polling agent with `bash "$SCRIPTS/setup-automation.sh"` (idempotent; launchd on macOS, systemd timer or cron on Linux — a warning instead of an agent is fine, just relay it to the user).

6. **Sync mode (Plane → local direction).** AskUserQuestion, header "Sync mode":
   - **"Polling (default)"** — background pull every 5 minutes. Zero extra setup.
   - **"Webhook (realtime)"** — Plane pushes board changes to a local receiver within
     seconds. Requires a ONE-TIME manual step in Plane's UI (Plane's public v1 API has
     no webhook endpoints, so the plugin cannot create it with the API token).

   **If Polling:** nothing else to do — the binding written in step 5 omits `syncMode`
   (polling is the default) and the agent from step 5 covers it. Skip to step 7.

   **If Webhook**, follow ALL sub-steps:

   a. **Receiver port.** Run `node "$SCRIPTS/webhook-config.mjs" show` and note `port`
      (default 8787). If the user wants another port: `node "$SCRIPTS/webhook-config.mjs" set port <n>`.

   b. **Work out the webhook URL** from `PLANE_API_HOST_URL`:
      - **Local Docker stack** (host is `localhost`/`127.0.0.1`): the URL is
        `http://host.docker.internal:<port>/hook/<workspaceSlug>`. Plane's SSRF
        protection rejects `localhost` URLs and blocks private IPs at delivery time,
        so the user must ALSO add `WEBHOOK_ALLOWED_HOSTS=host.docker.internal` to the
        Plane stack's `variables.env` and run `docker compose restart api worker`
        (offer to do this for them if the compose directory is known — e.g.
        `~/projects/plane`). On Linux hosts without Docker Desktop,
        `host.docker.internal` needs `extra_hosts: ["host.docker.internal:host-gateway"]`
        on the api/worker services, or use `WEBHOOK_ALLOWED_IPS=<docker bridge CIDR>`.
      - **Remote server**: the Plane server must be able to reach this machine. Ask the
        user (AskUserQuestion, header "Reachability") whether this machine has a URL
        reachable from the server (VPN/public IP/tunnel). If yes, store it:
        `node "$SCRIPTS/webhook-config.mjs" set publicUrl https://…` — the webhook URL
        is `<publicUrl>/hook/<workspaceSlug>`. If no, recommend a tunnel (e.g.
        `cloudflared tunnel` or Tailscale Funnel pointing at `localhost:<port>`, see the
        README's "Realtime webhook sync" section) — or falling back to Polling; if they
        pick Polling here, skip to step 7.

   c. **Create the webhook in Plane's UI** (user does this manually): Workspace
      Settings → Webhooks → Add webhook → paste the URL from (b), enable **Issue**,
      **Module** and **Project** events (Cycle and Comment can stay off), save, and
      **copy the generated secret key** (`plane_wh_…` — shown once). Ask for the secret
      via AskUserQuestion (header "Secret", free-text via "Other"; note: this secret
      only authenticates inbound deliveries — it grants NO read/write access to Plane).
      Store it: `node "$SCRIPTS/webhook-config.mjs" set-workspace <slug> <secret>`.

   d. **Activate**: add `"syncMode": "webhook"` to `.gsd-plane.json`, then run
      `bash "$SCRIPTS/setup-automation.sh" --mode webhook` (installs the receiver
      daemon — launchd KeepAlive on macOS, systemd user service on Linux; on cron-only
      Linux it warns and stays on polling: relay that and revert `syncMode` to omit).
      The 5-minute agent stays installed as a safety net but only runs a webhook-mode
      project when no sync happened for `safetyPollMinutes` (default 30) — Plane
      deactivates webhooks after 5 failed deliveries (e.g. laptop asleep), so the
      safety net catches what a dead webhook misses.

   e. **Verify end-to-end**: `curl -s http://127.0.0.1:<port>/healthz` must answer.
      Then ask the user to make any small edit to an issue on the Plane board and check
      that `~/.cache/gsd-with-plane/webhook-last-event` appears/updates within a few
      seconds (`cat` it). If it doesn't: the usual suspects are the SSRF env vars not
      set (local), the webhook URL wrong, or the tunnel down — see the README
      troubleshooting table. A failed verification is NOT fatal: polling still covers
      the project; say so.

7. **Agile ticket structure (note, no action).** Plane's public API has no issue-template
   endpoint, so — unlike the Linear sibling plugin — no board-side templates are created.
   Tell the user: issues created on the board with `## Scope` / `## Acceptance Criteria`
   sections in the description are still adopted as structured todos (the sections
   round-trip), and bug/task bodies pushed from GSD carry the agile sections
   (Expected/Actual/Reproduction/Errors, Scope/Acceptance criteria) automatically.

8. **(Opt-in) Agile capture patch (GSD side).** AskUserQuestion — header "GSD patch",
   question: "Also patch GSD's todo capture so new todos include an Acceptance Criteria
   section? This edits GSD's global add-todo workflow (affects all GSD projects, not just
   this one). GSD backs the change up on update; reapply with `/gsd-update --reapply`.":
   - **"Skip"** — leave GSD untouched (the push formatting works regardless).
   - **"Patch GSD"** — run `node "$SCRIPTS/patch-gsd-todo-template.mjs"` and relay the
     output verbatim (it is idempotent; exit 2 = GSD missing or unrecognized format —
     report and continue, non-fatal).

9. **Existing-content check + merge/cancel.** If the chosen project already existed and has `hasIssues: true`:
   - Run `node "$SCRIPTS/pull-plane.mjs"` (dry-run) and count the `← adopt` lines (foreign issues) and the warnings.
   - Run `node "$SCRIPTS/sync-roadmap.mjs"` (dry-run) and capture the operations summary.
   - Warn the user: the project already has content — N foreign issues would be adopted as todos in `.planning/todos/pending/`, and the push will perform M creates/updates. AskUserQuestion: **"Merge"** (recommended — adopts the foreign issues as todos and syncs) or **"Cancel"** (deletes the freshly created `.gsd-plane.json` and stops, without touching anything in Plane).
   - If cancel: delete `.gsd-plane.json`, confirm nothing was changed and stop.

10. **Initial sync.**
   - Merge (or project with content): `node "$SCRIPTS/pull-plane.mjs" --apply` (it already chains the convergence push).
   - New or empty project: `node "$SCRIPTS/sync-roadmap.mjs" --apply`.
   - ATTENTION: never run `--apply` before the user has decided in step 9 (when applicable).
   - Note: Plane self-hosted defaults to `API_KEY_RATE_LIMIT=60/minute`. A large first
     push waits automatically on 429s, so it may take a few minutes; if the user plans to
     sync big roadmaps often, suggest raising `API_KEY_RATE_LIMIT` in Plane's `.env` and
     restarting the stack.

11. **Final report**: the Plane project URL, counts (milestones/phases/plans/quick/todos), adopted issues (if merged), whether the GSD capture patch was applied (step 8), plus a reminder that the hook now syncs automatically on every `.planning/` edit (log in `~/.cache/gsd-with-plane/sync.log`; for changes born on the board with no local activity, `pull-plane.mjs --apply --watch 60`).
