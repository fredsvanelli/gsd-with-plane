---
description: GSD ↔ Plane integration — lists the available commands and how the sync works
---

`/gsd-with-plane:help` command.

Display (formatted, without executing anything):

- `/gsd-with-plane:init` — connects this GSD project to a Plane workspace/project (local Docker stack or self-hosted server), optionally patches GSD's todo capture (Acceptance Criteria), and runs the initial (bidirectional) sync.
- `/gsd-with-plane:status` — shows the connected project (with link), whether it is in sync, pending items in both directions, the last sync attempt, and the automation state.
- `/gsd-with-plane:pull` — manual Plane → local sync: shows what came from the board and applies it (with a convergence push when something changed).
- `/gsd-with-plane:push` — manual local → Plane sync: shows the diff and applies it (idempotent, never deletes anything in Plane).
- `/gsd-with-plane:webhook` — `enable`/`disable`/`status`: switches the Plane → local direction between 5-minute polling (default) and realtime webhooks (Plane pushes board changes to a local receiver within seconds; polling stays as a low-frequency safety net).
- Manual script usage (cwd = project root): `sync-roadmap.mjs` (push, dry-run by default, `--apply` executes) · `pull-plane.mjs` (pull, `--apply`, `--watch <s>` for board polling) · `preview-board.mjs .planning` (local preview without the API).
- Automatic sync: the plugin hook runs pull → push on every edit to `.planning/ROADMAP.md`, `STATE.md`, `quick/**` or `todos/**`. Log: `~/.cache/gsd-with-plane/sync.log`.
- Planner-sync overlay (`.planning/planner-sync/`): the n:n link table between GSD items and board cards. Board-side customizations (renamed titles, cards dragged to custom columns, extra labels, assignees, due dates, priorities, comments) are captured on every pull into `board.json` and rendered in `BOARD.md` — the push respects them (a field is only reclaimed when GSD itself changes it), and GSD planning commands see `BOARD.md` as part of `.planning/`.
- Project binding: `.gsd-plane.json` at the root (created by init). Credential: `PLANE_API_KEY` in the environment, `.env` or `.env.local`; host via `PLANE_API_HOST_URL` (default `http://localhost` — point it at your server, e.g. `https://plane.example.com`, when Plane moves off the local Docker stack).
- Requirement: GSD installed (https://github.com/open-gsd/gsd-core) — the plugin mirrors the `.planning/` created by GSD.

Then ask whether the user wants to run init.
