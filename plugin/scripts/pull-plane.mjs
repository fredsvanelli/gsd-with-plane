// PULL: the way back of the bidirectional cycle (Plane → .planning/).
//
// What flows back:
// - PLAN state (sub-items): Done/reopened in Plane → the plan's `[x]`/`[ ]`
//   checkbox in ROADMAP.md.
// - TODO state: completed in Plane → file moves from todos/pending/ to
//   todos/resolved/ (and back, if reopened).
// - NEW ISSUES created in Plane (without a gsd-sync marker) → become a todo in
//   todos/pending/ and the issue is "adopted" (gets a marker with a sentinel
//   hash; the next push normalizes title/label/state).
// - BOARD CUSTOMIZATIONS (planner-sync overlay): manual title edits, cards
//   dragged into custom columns, labels added/removed, assignees, dates,
//   priority and comments are captured into .planning/planner-sync/
//   (board.json + BOARD.md). The push respects the captured overrides — none
//   of it is clobbered — and BOARD.md keeps GSD planning commands aware of it.
//
// What does NOT flow (report-only):
// - PHASE state: derives from the plans — move the plans, not the phase
//   (the card stays in whatever column it was dragged to, via the overlay).
// - QUICK task state: "done" locally = the existence of *-SUMMARY.md; forging
//   a SUMMARY from Plane would be a lie.
// - Prose (bodies) edited in Plane: local is the source of truth for content
//   (the next push overwrites). Titles ARE preserved, via the overlay.
//
// Conflict policy: the hash in the marker = local state at the last push.
// State differs and hash matches (local unchanged) → the edit came from Plane
// → Plane wins. Hash doesn't match (local changed too) → local wins, push pending.
//
// Usage:
//   node plugin/scripts/pull-plane.mjs                 # dry-run (default)
//   node plugin/scripts/pull-plane.mjs --apply         # applies + convergence push
//   flags: --planning <dir> · --workspace <slug> · --no-push · --watch <seconds> · --verbose

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PlaneClient } from './plane-client.mjs';
import { buildDesired } from './desired.mjs';
import {
  loadEnv, loadSyncConfig, parseMarker, marker, issueHash, ADOPTED_HASH,
  NAMED_STATES, canonicalStateFor,
} from './common.mjs';
import { htmlToText } from './html.mjs';
import { applyPlanCheckbox, moveTodo, writeForeignTodo } from './local-write.mjs';
import { loadBoard, saveBoard, ensureItem, captureFromBoard } from './planner-sync.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};
const APPLY = flag('apply');
const NO_PUSH = flag('no-push');
const PLANNING_DIR = opt('planning', '.planning');
const WATCH = Number(opt('watch', 0)) || 0;
// Same cache dir as webhook-server.mjs — the receiver drops comment-refresh
// hints there when Plane delivers an issue_comment event.
const CACHE_DIR = process.env.GSD_PLANE_CACHE_DIR
  ?? join(process.env.HOME ?? '', '.cache', 'gsd-with-plane');
const COMMENT_FETCH_CAP = 20; // per run — respects the 60 req/min default

await loadEnv();
const syncConfig = await loadSyncConfig();
const WORKSPACE = opt('workspace', syncConfig.workspaceSlug ?? process.env.PLANE_WORKSPACE_SLUG ?? null);
const client = new PlaneClient({
  apiKey: process.env.PLANE_API_KEY,
  baseUrl: process.env.PLANE_API_HOST_URL ?? process.env.PLANE_BASE_URL,
  workspaceSlug: WORKSPACE,
});

const OUR_TITLE_RE = /^(Phase\s[\d.]+:|Quick:|Todo:|Bug:)/;

async function runOnce() {
  const { roadmap, desired } = await buildDesired(PLANNING_DIR);
  const byKind = {
    phase: new Map(desired.phases.map((i) => [i.key, i])),
    plan: new Map(desired.plans.map((i) => [i.key, i])),
    quick: new Map(desired.quicks.map((i) => [i.key, i])),
    todo: new Map(desired.todos.map((i) => [i.key, i])),
    debug: new Map(desired.debugs.map((i) => [i.key, i])),
  };

  const projects = await client.listProjects();
  // Same guard as the push: a binding that declares a projectId which doesn't
  // resolve must NOT fall back to marker/name (could adopt another project).
  let project;
  if ('projectId' in syncConfig) {
    project = projects.find((p) => p.id === syncConfig.projectId) ?? null;
    if (!project) {
      console.error(`.gsd-plane.json points at project ${JSON.stringify(syncConfig.projectId)} which was not found in workspace "${WORKSPACE}" — refusing the marker/name fallback. Fix or remove the binding (re-run /gsd-with-plane:init).`);
      process.exitCode = 1;
      return 0;
    }
  } else {
    project = projects.find((p) => parseMarker(p.description)?.kind === 'project')
      ?? projects.find((p) => p.name === roadmap.title)
      ?? null;
  }
  if (!project) {
    console.log('No gsd-sync project in Plane — nothing to pull (run the push first).');
    return 0;
  }

  // Issues carry the state as a bare id — the group (backlog/…/completed)
  // comes from the project's state list.
  const states = await client.listStates(project.id);
  const stateGroupById = new Map(states.map((s) => [s.id, s.group]));
  const stateById = new Map(states.map((s) => [s.id, s]));
  const canonicalIdFor = (stateType) => canonicalStateFor(states, stateType)?.id ?? null;
  const labels = await client.listLabels(project.id).catch(() => []);
  const labelNameById = new Map(labels.map((l) => [l.id, l.name]));
  const issues = await client.listProjectIssues(project.id);
  const identifierOf = (issue) => `${project.identifier}-${issue.sequence_id}`;

  // planner-sync overlay: board-side customizations get captured here so the
  // push never clobbers them and GSD planning commands can see them (BOARD.md).
  const board = await loadBoard(PLANNING_DIR);
  board.project = { id: project.id, identifier: project.identifier, name: project.name };
  let memberName = new Map(); // uuid → display name (best-effort)
  try {
    memberName = new Map((await client.listWorkspaceMembers()).map((m) => {
      const u = m.member ?? m; // tolerate both flattened and nested shapes
      return [u.id ?? m.id, u.display_name || u.email || u.id || m.id];
    }));
  } catch { /* endpoint unavailable — raw uuids are shown instead */ }

  // Issue id → gsd key, for labeling foreign sub-items' parents in BOARD.md.
  const keyByIssueId = new Map();
  for (const issue of issues) {
    const m = parseMarker(issue.description_html);
    if (m?.key) keyByIssueId.set(issue.id, `${m.kind}:${m.key}`);
  }

  const actions = []; // {label, run}
  const reports = [];
  const captures = []; // planner-sync capture report lines
  const commentCandidates = []; // {entry, issue, hinted}
  const hintFile = join(CACHE_DIR, 'comment-refresh');
  const hints = new Set((await readFile(hintFile, 'utf8').catch(() => ''))
    .split('\n').map((s) => s.trim()).filter(Boolean));
  board.foreignSubItems = []; // rebuilt from the live board every pull

  for (const issue of issues) {
    const mk = parseMarker(issue.description_html);
    const group = stateGroupById.get(issue.state) ?? 'backlog';

    if (mk && byKind[mk.kind]) {
      const item = byKind[mk.kind].get(mk.key);
      if (!item) continue; // orphan — the push already reports it
      const planeDone = group === 'completed';
      const localDone = item.stateType === 'completed';
      let flipTo = null; // stateType local will have after an applied flip

      if (planeDone !== localDone) {
        if (mk.hash !== issueHash(item)) {
          reports.push(`conflict ${mk.kind}=${mk.key}: local changed since the last push — local wins`);
        } else if (mk.kind === 'plan') {
          flipTo = planeDone ? 'completed' : 'unstarted';
          actions.push({
            label: `plan ${mk.key} → ${planeDone ? '[x]' : '[ ]'} in ROADMAP.md (${identifierOf(issue)})`,
            run: async () => {
              const r = await applyPlanCheckbox(PLANNING_DIR, mk.key, planeDone);
              if (!r.found) throw new Error(`plan line ${mk.key} not found in ROADMAP.md`);
            },
          });
        } else if (mk.kind === 'todo') {
          flipTo = planeDone ? 'completed' : 'backlog';
          actions.push({
            label: `todo ${mk.key} → todos/${planeDone ? 'resolved' : 'pending'}/ (${identifierOf(issue)})`,
            run: async () => {
              const ok = await moveTodo(PLANNING_DIR, mk.key, planeDone);
              if (!ok) throw new Error(`todo ${mk.key} was not in ${planeDone ? 'pending' : 'resolved'}/`);
            },
          });
        } else if (mk.kind === 'debug') {
          reports.push(`debug=${mk.key} moved on the board — resolving locally = updating the debug session status (.planning/debug/); the card stays where you put it (overlay)`);
        } else if (mk.kind === 'quick') {
          reports.push(`quick=${mk.key} moved on the board — no local representation (SUMMARY.md); the card stays where you put it (overlay)`);
        } else if (mk.kind === 'phase') {
          reports.push(`phase=${mk.key} moved on the board — phase state derives from the plans (move the plans); the card stays where you put it (overlay)`);
        }
      }

      const entry = ensureItem(board, mk.kind, mk.key);
      const prevUpdated = entry.board?.updatedAt ?? null;
      const neverFetched = entry.board?.comments == null;
      const st = stateById.get(issue.state);
      captures.push(...captureFromBoard(entry, item, {
        issueId: issue.id,
        identifier: identifierOf(issue),
        title: issue.name,
        stateId: issue.state,
        stateName: st?.name ?? '?',
        stateGroup: group,
        labelNames: (issue.labels ?? []).map((id) => labelNameById.get(id)).filter(Boolean),
        assignees: (issue.assignees ?? []).map((id) => memberName.get(id) ?? id),
        priority: issue.priority ?? null,
        targetDate: issue.target_date ?? null,
        startDate: issue.start_date ?? null,
        updatedAt: issue.updated_at ?? null,
      }, { flipTo, canonicalIdFor }));

      if (hints.has(issue.id) || prevUpdated !== (issue.updated_at ?? null)
        || (neverFetched && !['completed', 'cancelled'].includes(group))) {
        commentCandidates.push({ entry, issue, hinted: hints.has(issue.id) });
      }
      continue;
    }

    // No marker: foreign issue (created directly in Plane)
    if (issue.parent) {
      board.foreignSubItems.push({
        identifier: identifierOf(issue),
        title: issue.name.slice(0, 80),
        parent: keyByIssueId.get(issue.parent) ?? null,
        state: stateById.get(issue.state)?.name ?? null,
      });
      reports.push(`foreign sub-item (kept, listed in planner-sync/BOARD.md): ${identifierOf(issue)} "${issue.name.slice(0, 50)}"`);
      continue;
    }
    if (OUR_TITLE_RE.test(issue.name)) {
      reports.push(`${identifierOf(issue)} looks like ours but lost its marker (manual description edit?) — ignored to avoid duplicating`);
      continue;
    }
    if (['completed', 'cancelled'].includes(group)) continue;

    actions.push({
      label: `adopt ${identifierOf(issue)} "${issue.name.slice(0, 60)}" → todos/pending/`,
      run: async () => {
        const key = await writeForeignTodo(PLANNING_DIR, {
          title: issue.name,
          description: htmlToText(issue.description_html),
          identifier: identifierOf(issue),
          url: client.issueUrl(project.id, issue.id),
          createdAt: issue.created_at,
        });
        // Marks the issue with a sentinel hash: the next push normalizes it
        // (title "Todo: ...", todo label, Backlog state) and writes the real hash.
        const html = `${issue.description_html ?? ''}<hr/><p><code>${marker('todo', key, ADOPTED_HASH).replaceAll('`', '')}</code></p>`;
        await client.updateIssue(project.id, issue.id, { description_html: html });
      },
    });
  }

  // Columns created by hand on the board (neither a group canonical nor one of
  // gsd's named agile columns) — surfaced in BOARD.md, never touched.
  const gsdColumnNames = new Set(Object.values(NAMED_STATES).map((s) => s.name));
  const canonicalIds = new Set(['backlog', 'unstarted', 'started', 'completed', 'cancelled']
    .map((g) => canonicalStateFor(states, g)?.id).filter(Boolean));
  board.customColumns = states
    .filter((s) => !canonicalIds.has(s.id) && !gsdColumnNames.has(s.name))
    .map((s) => ({ name: s.name, group: s.group }));

  console.log(`Pull: ${actions.length} actions`
    + `${captures.length ? ` · ${captures.length} board captures` : ''}`
    + `${reports.length ? ` · ${reports.length} warnings` : ''}`);
  for (const r of reports) console.log(`  ⚠️  ${r}`);
  for (const c of captures) console.log(`  ↔ ${c}`);
  for (const a of actions) console.log(`  ← ${a.label}`);

  if (!APPLY) {
    if (actions.length || captures.length) console.log('Dry-run (default). Run with --apply to execute.');
    return 0;
  }

  let done = 0;
  for (const a of actions) {
    try {
      await a.run();
      done++;
    } catch (err) {
      console.error(`✗ ${a.label}: ${err.message}`);
      process.exitCode = 1;
    }
  }
  if (done) console.log(`Pull applied: ${done}/${actions.length}.`);

  // Comment capture (apply mode only — read-only API calls, but capped and
  // skipped in dry-runs to keep them cheap). Hinted issues (webhook
  // issue_comment deliveries) go first; the rest refresh as their updated_at
  // moves. Note: commenting alone may not bump the issue's updated_at, so
  // without webhooks comment counts refresh lazily.
  commentCandidates.sort((a, b) => Number(b.hinted) - Number(a.hinted));
  const consumed = new Set();
  for (const c of commentCandidates.slice(0, COMMENT_FETCH_CAP)) {
    const comments = await client.listComments(project.id, c.issue.id).catch(() => null);
    if (!comments) continue;
    consumed.add(c.issue.id);
    comments.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
    c.entry.board = {
      ...(c.entry.board ?? {}),
      comments: {
        count: comments.length,
        last: comments.slice(-3).map((cm) => ({
          by: memberName.get(cm.actor) ?? cm.actor ?? '?',
          at: cm.created_at ?? null,
          text: htmlToText(cm.comment_html ?? '').slice(0, 300),
        })),
      },
    };
  }
  if (hints.size) {
    // Consume only OUR issues' hints — other projects' pulls eat their own.
    const rest = [...hints].filter((id) => !consumed.has(id)).slice(-200);
    await writeFile(hintFile, rest.length ? `${rest.join('\n')}\n` : '').catch(() => {});
  }

  // Persist the overlay BEFORE the convergence push (the push subprocess
  // reloads board.json and must see the fresh overrides/bases).
  await saveBoard(PLANNING_DIR, board);

  // Convergence push: writes new hashes into the markers and normalizes adopted issues.
  if (done && !NO_PUSH) {
    const syncScript = fileURLToPath(new URL('./sync-roadmap.mjs', import.meta.url));
    const pushArgs = [syncScript, '--apply', '--planning', PLANNING_DIR];
    if (WORKSPACE) pushArgs.push('--workspace', WORKSPACE);
    const res = spawnSync(process.execPath, pushArgs, { stdio: 'inherit' });
    if (res.status !== 0) process.exitCode = res.status ?? 1;
  }
  return done;
}

if (WATCH > 0) {
  console.log(`Watch mode: pull every ${WATCH}s (Ctrl-C to stop).`);
  for (;;) {
    try {
      await runOnce();
    } catch (err) {
      console.error(`pull failed: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, WATCH * 1000));
  }
} else {
  await runOnce();
}
