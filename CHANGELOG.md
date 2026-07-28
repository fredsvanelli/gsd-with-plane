# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-27

Initial release.

### Added

- Claude Code plugin mirroring GSD's `.planning/` as a Plane project: milestones →
  Modules, phases → Work items, plans → Sub-items (`wave-N` labels), quick tasks
  (`quick`), pending todos (`todo`), debug sessions (`bug`).
- Commands: `/gsd-with-plane:init`, `:status`, `:push`, `:pull`, `:webhook`, `:help`.
- Bidirectional sync — `.planning/` owns content; Plane sends back states (plan Done ⇄
  checkbox, todo Done ⇄ pending/resolved) and new work items (materialized as todos in
  `todos/pending/`). Conflicts resolve local-first unless local is unchanged since the
  last push.
- Planner-sync overlay (`.planning/planner-sync/`): per-field three-way merge so manual
  board edits (titles, columns, labels, assignees, dates, comments) survive every push,
  plus a regenerated `BOARD.md` digest that GSD planning commands can read.
- Hooks: sync on every `.planning/` edit (`PostToolUse`) and on session start
  (`SessionStart`); background polling via launchd (macOS) or a systemd user timer with
  a cron fallback (Linux).
- Webhook server for push-based updates from Plane, with signature verification and
  delivery de-duplication.
- Plane's official MCP server (`@makeplane/plane-mcp-server`) wired in for conversational
  board queries.
- Support for both GSD generations: legacy `get-shit-done` roadmaps and `gsd-core` ≥ 1.6.
- Works against any Plane instance via `PLANE_API_HOST_URL` (local Docker or self-hosted);
  built against Plane self-hosted 1.3.1.

[Unreleased]: https://github.com/fredsvanelli/gsd-with-plane/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/fredsvanelli/gsd-with-plane/releases/tag/v0.1.0
