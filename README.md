# gsd-with-plane

### Visualize your [GSD](https://github.com/open-gsd/gsd-core) specs as [Plane](https://plane.so/) boards — local or self-hosted.

**gsd-with-plane** is a Claude Code plugin that mirrors and syncs GSD's `.planning/` folder as a Plane project:
- GSD milestones → Plane Modules
- phases → Work items
- plans → Sub-items (`wave-N` labels; the `NN-MM-PLAN.md` content is converted to the work item description — frontmatter becomes a meta header + Must-haves, `<objective>`/`<tasks>`/`<threat_model>` blocks become sections)
- quick tasks → Work items (`quick` label)
- pending todos → Backlog items (`todo` label)
- debug sessions → Work items (`bug` label; terminal status in the frontmatter = Done, otherwise In Progress).

It is the [gsd-with-linear](https://github.com/fredsvanelli/gsd-with-linear) feature set, ported to a Plane you own: the same board, without the SaaS.

**Bidirectional** sync:
`.planning/` is the source of truth for content; Plane sends back **states**
(plan Done ⇄ checkbox, todo Done ⇄ pending/resolved) and **new work items** (they become
todos in `pending/`).

Conflict: local wins, unless local hasn't changed since the last push.

> ⚠️ **Requirement:** the plugin depends on [GSD](https://github.com/open-gsd/gsd-core)
> being installed - it mirrors the `.planning/` that GSD creates and maintains; without GSD
> there is nothing to sync. The `init`, `status`, `pull` and `push` commands warn and stop
> when they don't find `.planning/` in the cwd.
>
> Both GSD generations are supported: legacy `get-shit-done` roadmaps (em-dash separators,
> `NN-MM-PLAN.md` checklists) and `gsd-core` ≥ 1.6 (hyphen separators, `(planned)` milestones,
> `#### Phase N` under milestone blocks, `NN-MM:` plan checklists, `## Progress` table as the
> done signal, `debug/resolved/`, and plan completion via `SUMMARY.md` on disk). The opt-in
> `phase_id_convention: "milestone-prefixed"` (phases named `1-01`) is **not** supported.

## Plane requirements

Any Plane instance reachable over HTTP works — the plugin talks to the public REST API
(`/api/v1/`, `X-API-Key` auth) and was built against **Plane self-hosted 1.3.1** (the
Docker Compose community edition):

- **Local stack** (default): Plane running on `http://localhost` — nothing to configure.
- **Self-hosted server**: set `PLANE_API_HOST_URL=https://plane.example.com` in the
  environment or in the project's `.env`/`.env.local`. That is the only difference —
  same token, same commands. Moving from local to server later = create a token on the
  server, update `PLANE_API_KEY`/`PLANE_API_HOST_URL`, re-run `/gsd-with-plane:init`.

> ℹ️ Plane's public API has **no workspace discovery endpoint** — the workspace slug (the
> first path segment of your Plane URL, `http://localhost/<slug>/`) is asked once by
> `init` and stored in the binding.

## Installation

Requirements: Node.js ≥ 18, Claude Code, [GSD](https://github.com/open-gsd/gsd-core), and
a running Plane instance. Background auto-sync is supported on **macOS** (launchd) and
**Linux** (systemd user timer, with a cron fallback). On other platforms the plugin still
syncs on every `.planning/` edit and session start, just without the 5-minute background
polling.

### Global (all your projects)

```bash
npm install -g @fredsvanelli/gsd-with-plane
claude plugin marketplace add "$(npm root -g)/@fredsvanelli/gsd-with-plane"
claude plugin install gsd-with-plane@gsd-with-plane
```

### Local (single project)

```bash
npm install -D @fredsvanelli/gsd-with-plane
claude plugin marketplace add ./node_modules/@fredsvanelli/gsd-with-plane
claude plugin install gsd-with-plane@gsd-with-plane
```

To pin the plugin for the whole team, commit this to the project's
`.claude/settings.json` instead of running `claude plugin install`:

```json
{
  "extraKnownMarketplaces": {
    "gsd-with-plane": {
      "source": { "source": "directory", "path": "./node_modules/@fredsvanelli/gsd-with-plane" }
    }
  },
  "enabledPlugins": { "gsd-with-plane@gsd-with-plane": true }
}
```

> ℹ️ Claude Code **copies** the plugin into its cache (`~/.claude/plugins/cache`) at
> install time. After upgrading the npm package, refresh the copy with
> `claude plugin marketplace update gsd-with-plane`.

### Development install (live source, no cache copy)

To hack on the plugin and have every session pick up source changes immediately,
skip the marketplace and load it through Claude Code's skills dir (plugins there
are read straight from the directory at session start — no cached copy):

```bash
ln -sfn /path/to/gsd-with-plane/plugin ~/.claude/skills/gsd-with-plane
claude plugin list   # → gsd-with-plane@skills-dir ✔ loaded
```

Don't combine it with a marketplace install of the same name — the installed
copy takes precedence and the skills-dir one is skipped. Hooks and scripts are
executed from the live directory, so edits apply on the next hook fire; command
`.md` changes apply on the next session. The background polling agent installed
by `setup-automation.sh` always points at the directory it was run from — run it
from the source checkout and it is live as well.

Then, inside a GSD project, run `/gsd-with-plane:init` to connect it to Plane.
This also installs the background polling agent for your platform and offers an
optional patch to GSD's todo capture (see [Agile ticket structure](#agile-ticket-structure)).

### Credential

This plugin needs a `PLANE_API_KEY` (**Plane > Workspace Settings > API tokens > Add API
token**) exported in the environment, or in a `.env` (or `.env.local`, read as fallback)
at the **GSD project root**. Optional in the same places:

- `PLANE_API_HOST_URL` — Plane host (default `http://localhost`); same variable the
  official Plane MCP server uses.
- `PLANE_WORKSPACE_SLUG` — workspace slug fallback when there is no `.gsd-plane.json`.

Precedence: process env > `.env` > `.env.local`.

## Commands

| Command | Description |
| --- | --- |
| `/gsd-with-plane:help` | Lists the available commands |
| `/gsd-with-plane:init` | Connects the plugin with your Plane project |
| `/gsd-with-plane:status` | Show connection status, in sync or not, push/pull pending items, last sync attempt and automation state |
| `/gsd-with-plane:pull` | Manually pull updates from Plane |
| `/gsd-with-plane:push` | Manually send updates to Plane |
| `/gsd-with-plane:webhook` | `enable`/`disable`/`status` — switch the Plane → local direction between polling and realtime webhooks |

## Board columns (agile flow)

Flow: `Backlog → Todo → In Progress → UAT → Ready to ship → Code Review → Done`.

Plane creates the five standard states per project (groups `backlog`, `unstarted`,
`started`, `completed`, `cancelled`); items land on them from the GSD status:

| Backlog | Todo | In Progress | Done |
| --- | --- | --- | --- |
| Pending todos (`todo` label) and issues adopted from Plane. | Items whose GSD status is `todo` (not started yet). | Items whose GSD status is `in_progress`. | Items whose GSD status is `done` (checked plan, resolved todo, terminal debug status). |

The "UAT", "Ready to ship" and "Code Review" columns are created by the push on demand
(as extra states in the `started` group, ordered after In Progress) and fed automatically
(phases of non-shipped milestones with completed plans; UAT prevails because it comes
earlier in the flow):

| UAT | Ready to ship | Code Review |
| --- | --- | --- |
| GSD artifacts: `<N>-VERIFICATION.md` with `status: human_needed` and no approved `HUMAN-UAT.md` (or HUMAN-UAT `partial`). | HUMAN-UAT approved (`passed`/`complete`/`resolved`) but the phase has **not entered any PR yet** - neither an open PR via `gh` nor a PR recorded in STATE.md (a record without an open PR = PR already merged → Done). | **Open PR on GitHub** associated with the phase (human review pending), covering the primary repo and the sibling repos of cross-repo phases (`**Repo:**` fields). The PR link goes into the item description. Requires a git repo + logged-in `gh`; without that the column simply stays empty. |

PR ↔ phase association (Code Review) is detected via `gh pr list` through a cascade of
signals: (1st) `.planning/phases/<N-slug>/` paths in the PR diff - GSD commits the phase
artifacts on the branch, so the association is derived from data; (2nd) "Phase N shipped -
PR #M" record in STATE.md; (3rd) fallback: `phase-N` in the branch or "Phase N" in the
title. GSD's internal `REVIEW.md` does **not** count - it is a step of the automated
pipeline, not a board column.

These stages are report-only in the pull (resolving = approving the UAT / opening or
merging the PR, not dragging the card).

## Agile ticket structure

Tickets on the board follow the usual agile shapes, fed from data GSD already captures:

- **Bugs** (debug sessions): the item description carries **Expected / Actual /
  Reproduction / Errors** extracted from the `## Symptoms` section that `/gsd-debug`
  writes in the session file. Unfilled placeholders are omitted — a fresh session shows
  just the trigger.
- **Tasks** (todos): the `## Problem` section becomes **Scope**, `## Solution` becomes
  **Proposed solution** (omitted while "TBD"), and an `## Acceptance Criteria` section —
  when present — is rendered as **Acceptance criteria**. Free-form todos fall back to the
  raw body, as before.

> ℹ️ **Difference from the Linear sibling:** Plane's public API has no issue-template
> endpoint, so no board-side templates are created. The structure still round-trips: any
> work item created on the board whose description carries `## Scope` /
> `## Acceptance Criteria` headings is adopted as a structured todo with those sections.

Optionally (asked during `init`, off by default), the plugin can patch **GSD's global
todo capture** (`workflows/add-todo.md`) so `/gsd-add-todo` also captures an
`## Acceptance Criteria` section at the source. This modifies the GSD installation for
all projects; GSD's updater backs the change up to `gsd-local-patches/` and
`/gsd-update --reapply` merges it back after a GSD update. Re-run
`node <scripts>/patch-gsd-todo-template.mjs` anytime (idempotent), or reinstall GSD to
revert.

## Task dependencies (chaining)

Each phase's `Depends on: Phase N` field becomes a native **blocked by** relation in
Plane (created through the `work-items/<id>/relations/` endpoint). Diffed against the
real relations graph (outside the issue hash); relations created by hand on the board are
preserved (we never remove relations).

## Automation (when each sync happens)

1. **Local edit** (`ROADMAP.md`, `STATE.md`, `quick/**`, `todos/**`, `phases/**`,
   `debug/**`) → `PostToolUse` hook runs pull → push (bursts coalesce). Phase artifacts
   (HUMAN-UAT, VERIFICATION, REVIEW-FIX) move the card right away, without waiting for polling.
2. **Session start** in a connected project → `SessionStart` hook runs pull → push
   (changes made on the board while you were away land before you start).
3. **Background (every 5 min, even without Claude Code open)** → a platform agent
   runs pull → push in each project listed in `projects.txt` (fed by `init`):
   launchd on macOS (`com.gsd-with-plane.pull`), a systemd user timer on Linux
   (`gsd-with-plane-pull.timer`; falls back to a crontab entry without systemd).
   Installed/refreshed by `init` via `setup-automation.sh`; disable with
   `bash <scripts>/setup-automation.sh --remove`.
4. **Realtime (webhook mode, opt-in)** → Plane pushes board changes to a local
   receiver within seconds; see the next section. In this mode, step 3 becomes a
   low-frequency safety net (default: every 30 min without a sync).

## Realtime webhook sync (Plane → local, opt-in)

Instead of waiting for the 5-minute poll, Plane can push every board change to a
small local receiver (`webhook-server.mjs`, zero dependencies) the moment it
happens. Enable it during `init` (step "Sync mode") or later with
`/gsd-with-plane:webhook enable`; go back anytime with
`/gsd-with-plane:webhook disable`. The mode is per project
(`"syncMode": "webhook"` in `.gsd-plane.json`); one receiver serves every
connected project.

How it fits together:

- **Receiver**: `POST /hook/<workspaceSlug>` on port `8787` (configurable),
  verified with the webhook's HMAC-SHA256 signature (`X-Plane-Signature`),
  deduped by `X-Plane-Delivery`, routed by project id to the same coalesced
  pull → push runner the hooks use. `GET /healthz` reports state. Runs as a
  launchd KeepAlive agent on macOS (`com.gsd-with-plane.webhook`) or a systemd
  user service on Linux (`gsd-with-plane-webhook.service`); not available on
  cron-only Linux.
- **Plane side (one-time, manual)**: Plane's public v1 API has no webhook
  endpoints, so create it in the UI — Workspace Settings → Webhooks → Add
  webhook, enable **Issue**, **Module** and **Project** events, then store the
  generated secret with `node <scripts>/webhook-config.mjs set-workspace <slug> <secret>`.
  Config lives in `~/.cache/gsd-with-plane/webhook.json` (chmod 600).
- **Safety net**: Plane silently deactivates a webhook after 5 failed
  deliveries (laptop asleep, tunnel down …) and there is no API to re-enable
  it. The 5-minute agent therefore keeps running and syncs any webhook-mode
  project that saw no sync for `safetyPollMinutes` (default 30);
  `/gsd-with-plane:status` warns when the board drifted without deliveries so
  you know to re-enable the webhook in the UI.

Webhook URL by deployment:

| Plane runs… | Webhook URL | Extra requirement |
| --- | --- | --- |
| Local Docker stack | `http://host.docker.internal:8787/hook/<slug>` | `WEBHOOK_ALLOWED_HOSTS=host.docker.internal` in the stack's `variables.env`, then `docker compose restart api worker` (Plane blocks private/loopback webhook targets — SSRF protection). Linux without Docker Desktop also needs `extra_hosts: ["host.docker.internal:host-gateway"]` on api/worker, or `WEBHOOK_ALLOWED_IPS=<bridge CIDR>`. |
| Remote server, machine reachable (VPN/public IP) | `https://<your-machine>/hook/<slug>` | Store the base URL: `webhook-config.mjs set publicUrl …` |
| Remote server, machine NOT reachable | tunnel URL + `/hook/<slug>` | e.g. `cloudflared tunnel --url http://localhost:8787` or Tailscale Funnel; keep the tunnel as a service, or stay on polling |

Troubleshooting: no deliveries arriving → check `WEBHOOK_ALLOWED_HOSTS`/URL
(local) or the tunnel (remote), then whether Plane deactivated the webhook
(Workspace Settings → Webhooks); receiver down → `~/.cache/gsd-with-plane/webhook-server.log`;
heartbeat of the last delivery → `~/.cache/gsd-with-plane/webhook-last-event`.

## Rate limit

Plane self-hosted ships with `API_KEY_RATE_LIMIT=60/minute`. The client waits and retries
automatically on 429 (honoring `Retry-After`) and paces writes at ~4/s, so a big first
push completes — it just takes a few minutes. Syncing large roadmaps often? Raise
`API_KEY_RATE_LIMIT` in Plane's `.env` and restart the stack.

## Planner-sync overlay (board edits are first-class)

The board is also edited by hand — cards dragged into custom columns, titles tweaked,
labels/assignees/due dates added, comments written — and most of that has no 1:1
representative in GSD. The overlay in `.planning/planner-sync/` is the n:n link table
between GSD items and board cards, kept as text files (committed with `.planning/`):

- **`board.json`** — one entry per linked pair, holding the merge `base` (the
  gsd-managed fields as of the last push), the `overrides` (board-side divergences:
  title, column, labels) and the `board` metadata (assignees, priority, dates,
  comments — things gsd never writes).
- **`BOARD.md`** — human/agent digest regenerated on every pull. It lives inside
  `.planning/`, so GSD planning commands (`/gsd-plan-phase`, `/gsd-discuss-phase`, …)
  naturally see everything decided on the board.

Merge policy (per-field three-way): **the board wins** for anything you touched on the
board — the push omits an overridden title/column and merges label sets — **except**
when GSD itself changed that same field since the last push, in which case GSD wins,
the override is dropped and the sync reports it (`↔` lines). Fields gsd never manages
(assignees, dates, priority, comments) are never pushed at all, only captured.
Capture happens on every pull, so polling/webhook keep the overlay fresh without any
extra step. Comment capture is incremental (webhook `issue_comment` events leave a
refresh hint; otherwise comments refresh when the work item is touched) and capped at
20 fetches per pull to respect the rate limit.

Caveat: `board.json` is committed per branch like the rest of `.planning/` — after
switching branches the merge bases may be stale; the worst case is a dropped override
(always reported), never silent data loss on the board.

## Guarantees

- Idempotent: `` `gsd-sync:<kind>=<key>:h=<hash>` `` marker at the bottom of every
  entity (a `<code>` element inside the work item's HTML description); re-run with no
  changes = 0 operations.
- Never deletes: phases removed from the ROADMAP become orphans and are only reported.
  Module membership is additive too — moving a phase between milestones adds it to the
  new Module and leaves the old association to manual cleanup.
- Board edits are never clobbered: manual titles, columns, labels, assignees, dates and
  comments survive every push via the planner-sync overlay (see above); GSD only
  reclaims a field it changed itself, and says so.
- The hook never blocks or fails Claude's turn (always exit 0, sync in the background).

## Plane ⇄ Linear concept map

For anyone coming from `gsd-with-linear`:

| gsd-with-linear (Linear) | gsd-with-plane (Plane) |
| --- | --- |
| Workspace + Team | Workspace (slug in every API route) |
| Project | Project (auto-generated `identifier`, e.g. `CCSAN-42`) |
| Project Milestones | Modules |
| Issues / Sub-issues | Work items / Sub-items (`parent`) |
| Workflow states (team-scoped) | States (project-scoped, same 5 groups) |
| `blocks` relation | `blocked_by` relation |
| Issue templates (`Bug (GSD)`, `Task (GSD)`) | — (no template API; sections round-trip by heading) |
| Markdown descriptions | HTML descriptions (converted at the API boundary) |
| `LINEAR_API_KEY` | `PLANE_API_KEY` + `PLANE_API_HOST_URL` + workspace slug |
| `.gsd-linear.json` | `.gsd-plane.json` |

## Development

```bash
npm test        # node:test suite, no dependencies to install
```

Tests are hermetic — every fixture is built in a temp dir, so the suite never reads a real
`.planning/`. CI runs it on Node 18, 20 and 22.

Releasing (maintainers):

```bash
npm version patch    # bumps package.json + plugin/.claude-plugin/plugin.json, commits, tags
git push --follow-tags
```

The `v*` tag triggers `.github/workflows/publish.yml`, which re-runs the tests and publishes
to npm with provenance (needs the `NPM_TOKEN` repo secret). To publish by hand instead:
`npm login && npm publish`.

## License

[MIT](LICENSE) © Fred Vanelli
