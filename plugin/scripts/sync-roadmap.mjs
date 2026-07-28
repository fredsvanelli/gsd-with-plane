// PUSH: syncs (local → Plane) GSD's .planning/ with a Plane Project:
// GSD milestones → Modules, phases → Work items, plans → Sub-items,
// quick tasks and todos → Work items with their own label.
//
// Idempotent: every created entity carries a visible marker at the bottom of
// its description — `gsd-sync:phase=42:h=<hash>` — used to match the existing
// entity and skip updates when the desired content hash hasn't changed.
// (Issue bodies are HTML in Plane; the marker rides in a <code> element and
// parseMarker matches it regardless of the surrounding tags.)
//
// Plane vs Linear structural notes: states, labels and modules are scoped to
// the PROJECT (not to a team/workspace), so everything the ops need is
// resolved through a ctx that is (re)loaded right after the project exists.
//
// The way back (Plane → local) is pull-plane.mjs.
//
// Usage:
//   node plugin/scripts/sync-roadmap.mjs               # dry-run (default): only prints the diff
//   node plugin/scripts/sync-roadmap.mjs --apply       # executes against the API
//   flags: --planning <dir> (default .planning) · --workspace <slug> · --verbose
//
// Deletions are NEVER executed: entities removed from .planning become orphan
// issues and are only reported.

import { PlaneClient, projectIdentifierFrom } from './plane-client.mjs';
import { buildDesired } from './desired.mjs';
import {
  loadEnv, loadSyncConfig, marker, parseMarker, contentHash, issueHash,
  NAMED_STATES, NAMED_ORDER,
} from './common.mjs';
import { mdToHtml } from './html.mjs';
import { loadBoard, saveBoard, ensureItem, mergePushFields, applyPushClears, recordBase } from './planner-sync.mjs';

// ---------- CLI / env ----------

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};
const APPLY = flag('apply');
const VERBOSE = flag('verbose');
const PLANNING_DIR = opt('planning', '.planning');

await loadEnv();
const syncConfig = await loadSyncConfig();
const WORKSPACE = opt('workspace', syncConfig.workspaceSlug ?? process.env.PLANE_WORKSPACE_SLUG ?? null);

// ---------- Desired state (from .planning) ----------

const { roadmap, desired } = await buildDesired(PLANNING_DIR);

const wavesUsed = [...new Set(desired.plans.flatMap((p) => p.labels))].sort();
const extraLabels = [
  ...(desired.quicks.length ? ['quick'] : []),
  ...(desired.todos.length ? ['todo'] : []),
  ...(desired.debugs.length ? ['bug'] : []),
];

// ---------- Current state (Plane) ----------

const client = new PlaneClient({
  apiKey: process.env.PLANE_API_KEY,
  baseUrl: process.env.PLANE_API_HOST_URL ?? process.env.PLANE_BASE_URL,
  workspaceSlug: WORKSPACE,
});

// planner-sync overlay (.planning/planner-sync/board.json): board-side
// customizations captured by the pull. The push consults it per field —
// overridden titles/columns are left alone, board labels are merged in —
// and records the new merge base after applying.
const board = await loadBoard(PLANNING_DIR);

// Project resolution: init binding (.gsd-plane.json) > marker > name.
// A binding that DECLARES a projectId which doesn't resolve is a hard error:
// falling back to marker/name could adopt (and rewrite) someone else's
// project — e.g. a stale/empty projectId after the target was deleted.
const projects = await client.listProjects();
let project;
if ('projectId' in syncConfig) {
  project = projects.find((p) => p.id === syncConfig.projectId) ?? null;
  if (!project) {
    console.error(`.gsd-plane.json points at project ${JSON.stringify(syncConfig.projectId)} which was not found in workspace "${WORKSPACE}" — refusing the marker/name fallback. Fix or remove the binding (re-run /gsd-with-plane:init).`);
    process.exit(1);
  }
} else {
  project = projects.find((p) => parseMarker(p.description)?.kind === 'project')
    ?? projects.find((p) => p.name === roadmap.title)
    ?? null;
}

// ctx: everything project-scoped, refreshed after the project exists.
const ctx = {
  project,
  states: [],
  labelByName: new Map(), // lowercase name → label
  moduleByKey: new Map(), // milestone key → module
};

async function loadProjectContext() {
  const [states, labels, modules] = await Promise.all([
    client.listStates(ctx.project.id),
    client.listLabels(ctx.project.id),
    client.listModules(ctx.project.id),
  ]);
  ctx.states = states;
  ctx.labelByName = new Map(labels.map((l) => [l.name.toLowerCase(), l]));
  ctx.moduleByKey = new Map();
  for (const mod of modules) {
    const mk = parseMarker(mod.description);
    const key = mk?.kind === 'milestone' ? mk.key : desired.milestones.find((d) => d.name === mod.name)?.key;
    if (key) ctx.moduleByKey.set(key, mod);
  }
}
if (project) await loadProjectContext();

const stateByName = () => new Map(ctx.states.map((s) => [s.name, s]));
const stateIdFor = (stateType) => {
  const named = NAMED_STATES[stateType];
  if (named) {
    const s = stateByName().get(named.name);
    if (!s) throw new Error(`named state "${named.name}" not created yet`);
    return s.id;
  }
  return client.stateByGroup(ctx.states, stateType).id;
};

const existingIssues = ctx.project ? await client.listProjectIssues(ctx.project.id) : [];

const issueByMarker = new Map();
for (const issue of existingIssues) {
  const mk = parseMarker(issue.description_html);
  if (mk && ['phase', 'plan', 'quick', 'todo', 'debug'].includes(mk.kind)) issueByMarker.set(`${mk.kind}:${mk.key}`, issue);
}

// ---------- Diff ----------

const ops = []; // {action, kind, key, label, run(ctx)}

const projectHash = contentHash({ name: roadmap.title });
const projectDesc = `Mirror of .planning/ (GSD) — generated by gsd-with-plane. `
  + `Source of truth: the local repository.\n\n${marker('project', null, projectHash)}`;
if (!ctx.project) {
  ops.push({
    action: 'create', kind: 'project', key: roadmap.title, label: `Project "${roadmap.title}"`,
    run: async () => {
      ctx.project = await client.createProject({
        name: roadmap.title,
        description: projectDesc,
        identifier: projectIdentifierFrom(roadmap.title),
      });
      // Plane seeds new projects with the default states — load them (and the
      // empty label/module maps) so the remaining ops can resolve ids.
      await loadProjectContext();
    },
  });
} else if (parseMarker(ctx.project.description)?.hash !== projectHash || !ctx.project.module_view) {
  ops.push({
    action: 'update', kind: 'project', key: roadmap.title, label: `Project "${roadmap.title}" (adopt/re-mark)`,
    // module_view on: GSD milestones live in Modules, and UI-created projects
    // can have the feature toggled off ("Modules are not enabled").
    run: async () => { ctx.project = await client.updateProject(ctx.project.id, { description: projectDesc, module_view: true }); },
  });
}

// Creates the named workflow states the desired state uses and that don't
// exist yet (order: … In Progress → UAT → Ready to ship → Code Review → Done).
// Sequence: a chain anchored on the REAL sequences of In Progress/Done and of
// the named states that already exist; missing ones interpolate between the
// anchored neighbors — guarantees a new column lands in the right spot even
// when the others were created in earlier runs. Computed inside run(): for a
// brand-new project the default states only exist after the project op.
const namedUsed = NAMED_ORDER.filter((t) => desired.phases.some((p) => p.stateType === t));
for (const stateType of namedUsed) {
  const def = NAMED_STATES[stateType];
  if (ctx.project && stateByName().has(def.name)) continue;
  ops.push({
    action: 'create', kind: 'state', key: def.name, label: `Workflow state "${def.name}"`,
    run: async () => {
      const byName = stateByName();
      if (byName.has(def.name)) return; // created out-of-band since the diff
      const inProg = client.stateByGroup(ctx.states, 'started');
      const done = client.stateByGroup(ctx.states, 'completed');
      const chain = [
        inProg.sequence,
        ...NAMED_ORDER.map((t) => byName.get(NAMED_STATES[t].name)?.sequence ?? null),
        done.sequence > inProg.sequence ? done.sequence : inProg.sequence + NAMED_ORDER.length + 1,
      ];
      for (let i = 1; i < chain.length - 1; i++) {
        if (chain[i] != null) continue;
        let next = i + 1;
        while (chain[next] == null) next++;
        chain[i] = chain[i - 1] + (chain[next] - chain[i - 1]) / (next - i + 1);
      }
      const s = await client.createState(ctx.project.id, {
        name: def.name, group: 'started', color: def.color,
        sequence: chain[NAMED_ORDER.indexOf(stateType) + 1],
      });
      ctx.states.push(s);
    },
  });
}

for (const name of [...wavesUsed, ...extraLabels]) {
  if (ctx.project && ctx.labelByName.has(name.toLowerCase())) continue;
  ops.push({
    action: 'create', kind: 'label', key: name, label: `Label ${name}`,
    run: async () => {
      if (ctx.labelByName.has(name.toLowerCase())) return;
      const l = await client.createLabel(ctx.project.id, name);
      ctx.labelByName.set(name.toLowerCase(), l);
    },
  });
}

for (const dm of desired.milestones) {
  const hash = contentHash({ name: dm.name, body: dm.body, targetDate: dm.targetDate });
  const description = `${dm.body}\n\n${marker('milestone', dm.key, hash)}`;
  const existing = ctx.moduleByKey.get(dm.key);
  const input = { name: dm.name, description, ...(dm.targetDate ? { target_date: dm.targetDate } : {}) };
  if (!existing) {
    ops.push({
      action: 'create', kind: 'milestone', key: dm.key, label: `Module ${dm.name}`,
      run: async () => {
        const mod = await client.createModule(ctx.project.id, input);
        ctx.moduleByKey.set(dm.key, mod);
      },
    });
  } else if (parseMarker(existing.description)?.hash !== hash) {
    ops.push({
      action: 'update', kind: 'milestone', key: dm.key, label: `Module ${dm.name}`,
      run: async () => { await client.updateModule(ctx.project.id, existing.id, input); },
    });
  }
}

const phaseIssueId = new Map(); // phaseKey → issue id (existing or freshly created)
const issueIdByKey = new Map(); // 'kind:key' → issue id (fed by existing markers + creates)
for (const [mkKey, issue] of issueByMarker) {
  issueIdByKey.set(mkKey, issue.id);
  if (mkKey.startsWith('phase:')) phaseIssueId.set(mkKey.slice('phase:'.length), issue.id);
}

const overrideNotes = []; // planner-sync decisions worth surfacing in the report

function issueOps(list, kind, getParentId) {
  for (const item of list) {
    const hash = issueHash(item);
    const descriptionMd = `${item.body}\n\n---\n${marker(kind, item.key, hash)}`;
    const existing = issueByMarker.get(`${kind}:${item.key}`);
    const entry = board.items[`${kind}:${item.key}`];
    if (existing && parseMarker(existing.description_html)?.hash === hash) {
      // Up to date — still (re)anchor the planner-sync entry: hash match means
      // the gsd-managed fields were pushed as-is, so `base` = desired. This is
      // also the migration path for boards that predate the overlay.
      const e = ensureItem(board, kind, item.key);
      e.issueId = existing.id;
      if (existing.sequence_id != null) e.identifier = `${ctx.project.identifier}-${existing.sequence_id}`;
      recordBase(e, item);
      continue;
    }

    const merged = mergePushFields(entry, item);
    overrideNotes.push(...merged.reports);
    const respected = existing
      ? [merged.omitName ? 'title' : null, merged.omitState ? 'column' : null].filter(Boolean)
      : [];

    ops.push({
      action: existing ? 'update' : 'create',
      kind,
      key: item.key,
      label: `${kind === 'plan' ? 'Sub-item' : 'Work item'} [${item.stateType}] ${item.title.slice(0, 80)}`
        + (respected.length ? ` (keeping board ${respected.join('+')})` : ''),
      run: async () => {
        const input = {
          // Board overrides (planner-sync) win for title/column unless GSD
          // itself changed the field — creates always send everything.
          ...(existing && merged.omitName ? {} : { name: item.title }),
          description_html: mdToHtml(descriptionMd),
          ...(existing && merged.omitState ? {} : { state: stateIdFor(item.stateType) }),
          ...(merged.labelNames.length
            ? { labels: merged.labelNames.map((l) => ctx.labelByName.get(l.toLowerCase())?.id).filter(Boolean) }
            : {}),
          ...(getParentId ? { parent: getParentId(item) ?? null } : {}),
        };
        const issue = existing
          ? await client.updateIssue(ctx.project.id, existing.id, input)
          : await client.createIssue(ctx.project.id, input);
        issueIdByKey.set(`${kind}:${item.key}`, issue.id);
        if (kind === 'phase') phaseIssueId.set(item.key, issue.id);
        const e = ensureItem(board, kind, item.key);
        e.issueId = issue.id;
        const seq = issue.sequence_id ?? existing?.sequence_id;
        if (seq != null) e.identifier = `${ctx.project.identifier}-${seq}`;
        applyPushClears(e, merged.clears);
        recordBase(e, item);
      },
    });
  }
}

issueOps(desired.phases, 'phase', null);
issueOps(desired.plans, 'plan', (item) => phaseIssueId.get(item.phaseKey));
issueOps(desired.quicks, 'quick', null);
issueOps(desired.todos, 'todo', null);
issueOps(desired.debugs, 'debug', null);

// ---------- Module membership: milestoneKey → module-issues (batched) ----------
// A separate association in Plane, diffed OUTSIDE the issue hash (like
// relations): a failed module create in an earlier run (e.g. "Modules are not
// enabled for this project") must be repairable later, even when every issue
// hash already matches. Additive — consistent with never-delete: moving a
// phase between milestones adds the new module and leaves the old association
// to manual cleanup. One batched POST per module (module-issues accepts a
// list), instead of one call per issue.
{
  const membersByMilestone = new Map(); // milestone key → ['kind:key', …]
  for (const [kind, list] of [['phase', desired.phases], ['plan', desired.plans]]) {
    for (const item of list) {
      if (!item.milestoneKey) continue;
      if (!membersByMilestone.has(item.milestoneKey)) membersByMilestone.set(item.milestoneKey, []);
      membersByMilestone.get(item.milestoneKey).push(`${kind}:${item.key}`);
    }
  }
  for (const [msKey, memberKeys] of membersByMilestone) {
    if (!desired.milestones.some((m) => m.key === msKey)) continue;
    const mod = ctx.moduleByKey.get(msKey);
    let inModule = new Set();
    if (mod) {
      // module-issues GET returns the member ISSUES themselves (IssueSerializer),
      // so the membership id is mi.id (mi.issue kept for older payload shapes)
      const mis = await client.listModuleIssues(ctx.project.id, mod.id).catch(() => []);
      inModule = new Set(mis.map((mi) => mi.issue ?? mi.id).filter(Boolean));
    }
    const missing = memberKeys.filter((k) => {
      const existing = issueByMarker.get(k);
      return !existing || !inModule.has(existing.id);
    });
    if (!missing.length) continue;
    ops.push({
      action: 'update', kind: 'membership', key: msKey,
      label: `Module ${msKey}: assign ${missing.length} work item(s)`,
      run: async () => {
        const module_ = ctx.moduleByKey.get(msKey);
        if (!module_) throw new Error(`module ${msKey} not available (create failed?)`);
        const ids = missing.map((k) => issueIdByKey.get(k)).filter(Boolean);
        if (ids.length) await client.addIssuesToModule(ctx.project.id, module_.id, ids);
      },
    });
  }
}

// ---------- Dependencies: "Depends on: Phase N" → blocked_by relation ----------
// Diffed against the real relations graph (not part of issueHash). Never
// removes relations — the ones created by hand on the board are preserved.
{
  const phaseKeys = new Set(desired.phases.map((p) => p.key));
  const relationCache = new Map(); // dependent issue id → Set of blocking issue ids
  for (const item of desired.phases) {
    const deps = (item.dependsOn ?? []).filter((dep) => phaseKeys.has(dep) && dep !== item.key);
    if (!deps.length) continue;
    const toIssue = issueByMarker.get(`phase:${item.key}`);
    if (toIssue && !relationCache.has(toIssue.id)) {
      const rel = await client.listRelations(ctx.project.id, toIssue.id).catch(() => null);
      relationCache.set(toIssue.id, new Set((rel?.blocked_by ?? []).map((r) => r.issue_id)));
    }
    for (const dep of deps) {
      const fromIssue = issueByMarker.get(`phase:${dep}`);
      const already = fromIssue && toIssue && relationCache.get(toIssue.id)?.has(fromIssue.id);
      if (already) continue;
      ops.push({
        action: 'create', kind: 'relation', key: `${dep}→${item.key}`,
        label: `Relation: Phase ${dep} blocks Phase ${item.key}`,
        run: async () => {
          const fromId = phaseIssueId.get(dep);
          const toId = phaseIssueId.get(item.key);
          if (!fromId || !toId) throw new Error(`missing phase issue (${dep} or ${item.key})`);
          await client.createRelation(ctx.project.id, toId, 'blocked_by', [fromId]);
        },
      });
    }
  }
}

// Orphans: gsd-sync-marked issues whose key no longer exists in .planning.
const desiredKeys = new Set([
  ...desired.phases.map((p) => `phase:${p.key}`),
  ...desired.plans.map((p) => `plan:${p.key}`),
  ...desired.quicks.map((p) => `quick:${p.key}`),
  ...desired.todos.map((p) => `todo:${p.key}`),
  ...desired.debugs.map((p) => `debug:${p.key}`),
]);
const orphans = [...issueByMarker.keys()].filter((k) => !desiredKeys.has(k));

// ---------- Report / execution ----------

const counts = ops.reduce((acc, op) => {
  const k = `${op.action}:${op.kind}`;
  acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});

console.log(`Workspace: ${WORKSPACE} · Project: ${ctx.project ? `existing "${ctx.project.name}"` : `will be created "${roadmap.title}"`}`);
console.log(`Desired: ${desired.milestones.length} milestones · ${desired.phases.length} phases · ${desired.plans.length} plans · ${desired.quicks.length} quick · ${desired.todos.length} todos · ${desired.debugs.length} bugs`);
console.log(`Operations: ${ops.length}${ops.length ? ` → ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}` : ' (all up to date)'}`);
if (orphans.length) console.log(`⚠️  Orphans (exist in Plane, gone from .planning — will NOT be deleted): ${orphans.join(', ')}`);
for (const n of overrideNotes) console.log(`  ↔ ${n}`);

if (VERBOSE || !APPLY) {
  const shown = VERBOSE ? ops : ops.slice(0, 25);
  for (const op of shown) console.log(`  ${op.action === 'create' ? '+' : '~'} ${op.label}`);
  if (!VERBOSE && ops.length > shown.length) console.log(`  … and ${ops.length - shown.length} more (use --verbose)`);
}

if (!APPLY) {
  console.log('\nDry-run (default). Run with --apply to execute.');
  process.exit(0);
}

let done = 0;
for (const op of ops) {
  try {
    await op.run();
  } catch (err) {
    console.error(`✗ ${op.label}: ${err.message}`);
    process.exitCode = 1;
    // Sub-items depend on the parent phase's id; a failed phase create must
    // not take down the rest, but the error stays on record.
    continue;
  }
  done++;
  if (done % 25 === 0 || done === ops.length) console.log(`  ${done}/${ops.length}…`);
  // courtesy toward Plane's API rate limit (self-hosted default: 60 req/min —
  // raise API_KEY_RATE_LIMIT in Plane's .env for big first pushes)
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`Completed: ${done}/${ops.length} operations applied.`);

// Persist the planner-sync overlay (merge bases advanced by the ops above;
// entries anchored for hash-match skips). Dry-run never writes.
if (ctx.project) {
  board.project = { id: ctx.project.id, identifier: ctx.project.identifier, name: ctx.project.name };
  await saveBoard(PLANNING_DIR, board);
}
if (ctx.project) console.log(`Project: ${client.projectUrl(ctx.project.id)}`);
