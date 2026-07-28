// gsd-core 1.6 format compatibility: hyphen separators, (planned) milestones,
// H4 phase headings, "NN-MM: desc" plan checklists, ## Progress table signals,
// SUMMARY-on-disk plan completion, and debug/resolved/ sessions.
// Fixture mirrors what gsd-core's roadmapper agent + gsd-tools.cjs actually write
// (verified against a live `phase add`/`phase complete`/`update-plan-progress` run).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRoadmap, derivePhaseStatus } from '../plugin/scripts/parse-roadmap.mjs';
import { parseDebugSessions, parseExecutedPlanIds } from '../plugin/scripts/parse-extras.mjs';
import { buildDesired } from '../plugin/scripts/desired.mjs';

const ROADMAP = `# Roadmap: Compat Probe

## Milestones

- ✅ **v1.0 MVP** - Phases 1-2 (shipped 2026-07-01)
- 🚧 **v1.1 Growth** - Phases 3-4 (in progress)
- 📋 **v2.0 Scale** - Phases 5-6 (planned)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-2) - SHIPPED 2026-07-01</summary>

### Phase 1: Setup
**Goal**: Project skeleton
**Plans**: 2 plans

Plans:
- [x] 01-01: Scaffold the repo
- [x] 01-02: CI pipeline

</details>

### 🚧 v1.1 Growth (In Progress)

**Milestone Goal:** Grow the thing

#### Phase 3: Billing
**Goal**: Charge money
**Depends on**: Phase 2
**Plans**: 1/2 plans executed

Plans:
- [ ] 03-01: Stripe integration
- [ ] 03-02: Invoices

#### Phase 4: Reports
**Goal**: Show numbers
**Depends on**: Phase 3
**Plans**: TBD

### 📋 v2.0 Scale (Planned)

**Milestone Goal:** Scale it

#### Phase 5: Sharding
**Goal**: Shard the DB
**Plans:** 0/0 plans complete

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Setup | v1.0 | 2/2 | Complete | 2026-06-20 |
| 2. Auth | v1.0 | 1/1 | Complete | 2026-06-30 |
| 3. Billing | v1.1 | 1/2 | In Progress|  |
| 4. Reports | v1.1 | 0/? | Not started | - |
| 5. Sharding | v2.0 | 0/0 | Complete    | 2026-07-14 |
`;

const STATE = `# Project State

## Current Position

Phase: 3 of 5 (Billing)
Status: In progress
`;

const DEBUG_ACTIVE = `---
status: investigating
trigger: "Login hangs for 30s"
created: 2026-07-14T10:00:00Z
---

## Symptoms

expected: Login completes in under 2s.
actual: Login hangs ~30s then succeeds.
`;

const DEBUG_RESOLVED = `---
status: resolved
trigger: "Cart total ignores discounts"
created: 2026-07-10T10:00:00Z
---
`;

// Moved to resolved/ without a terminal frontmatter status — the location wins.
const DEBUG_RESOLVED_STALE_STATUS = `---
status: investigating
trigger: "App crashes on boot"
created: 2026-07-08T10:00:00Z
---
`;

let planningDir;
before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'gsd-core-fixture-'));
  planningDir = join(root, '.planning');
  await mkdir(join(planningDir, 'debug', 'resolved'), { recursive: true });
  await mkdir(join(planningDir, 'phases', '03-billing'), { recursive: true });
  await writeFile(join(planningDir, 'ROADMAP.md'), ROADMAP);
  await writeFile(join(planningDir, 'STATE.md'), STATE);
  await writeFile(join(planningDir, 'debug', 'login-timeout.md'), DEBUG_ACTIVE);
  await writeFile(join(planningDir, 'debug', 'resolved', 'cart-total-wrong.md'), DEBUG_RESOLVED);
  await writeFile(join(planningDir, 'debug', 'resolved', 'old-crash-on-boot.md'), DEBUG_RESOLVED_STALE_STATUS);
  // 03-01 executed on disk (SUMMARY present) — gsd-core leaves the roadmap
  // checklist unticked, so this is the only per-plan done signal. Its PLAN
  // content is unstructured prose — the sub-issue body keeps the fence fallback.
  await writeFile(join(planningDir, 'phases', '03-billing', '03-01-PLAN.md'), 'raw plan notes');
  await writeFile(join(planningDir, 'phases', '03-billing', '03-01-SUMMARY.md'), '---\nstatus: complete\n---\n');
  // GSD-format plan (frontmatter + <objective>/<tasks>) — rendered as real
  // markdown sections on the card, not dumped in a code fence.
  await mkdir(join(planningDir, 'phases', '01-setup'), { recursive: true });
  await writeFile(
    join(planningDir, 'phases', '01-setup', '01-01-PLAN.md'),
    '---\nwave: 1\nautonomous: true\n---\n\n<objective>\nScaffold the repo\n</objective>\n\n'
    + '<tasks>\n<task type="auto">\n  <name>Task 1: init</name>\n  <action>Run the init:\n\n'
    + '```bash\nnpm init -y\n```\n  </action>\n  <done>package.json exists</done>\n</task>\n</tasks>\n',
  );
});

test('milestones: hyphen separators, (planned) status, clean names', () => {
  const { milestones } = parseRoadmap(ROADMAP);
  const byV = new Map(milestones.map((m) => [m.version, m]));
  assert.deepEqual(
    { s: byV.get('v1.0').status, d: byV.get('v1.0').shippedDate, r: byV.get('v1.0').phaseRange, n: byV.get('v1.0').name },
    { s: 'shipped', d: '2026-07-01', r: ['1', '2'], n: 'MVP' },
  );
  assert.equal(byV.get('v1.1').status, 'in_progress');
  assert.equal(byV.get('v1.1').name, 'Growth');
  assert.deepEqual({ s: byV.get('v2.0').status, r: byV.get('v2.0').phaseRange }, { s: 'planned', r: ['5', '6'] });
});

test('phases: H4 headings parsed and assigned to their milestone blocks', () => {
  const { phases } = parseRoadmap(ROADMAP);
  const byN = new Map(phases.map((p) => [p.number, p]));
  assert.deepEqual([...byN.keys()].sort(), ['1', '2', '3', '4', '5', '6']); // 2 and 6 materialized from ranges
  assert.equal(byN.get('3').milestone, 'v1.1');
  assert.equal(byN.get('3').goal, 'Charge money');
  assert.equal(byN.get('5').milestone, 'v2.0');
  assert.equal(byN.get('4').dependsOn, 'Phase 3');
});

test('plans: gsd-core "NN-MM: desc" checklist normalized to -PLAN.md keys', () => {
  const { phases } = parseRoadmap(ROADMAP);
  const billing = phases.find((p) => p.number === '3');
  assert.deepEqual(billing.plans.map((p) => p.file), ['03-01-PLAN.md', '03-02-PLAN.md']);
  assert.deepEqual(billing.plans.map((p) => p.checked), [false, false]);
  assert.deepEqual(billing.plansSummary, { done: 1, total: 2 }); // "1/2 plans executed"
});

test('progress table: complete/in-progress signals and completion dates', () => {
  const { phases } = parseRoadmap(ROADMAP);
  const byN = new Map(phases.map((p) => [p.number, p]));
  assert.equal(byN.get('1').progressStatus, 'complete');
  assert.equal(byN.get('1').completedDate, '2026-06-20');
  assert.equal(byN.get('3').progressStatus, 'in_progress');
  // "0/0 plans" + table Complete = phase closed without plans (gsd-core `phase complete`)
  assert.equal(derivePhaseStatus(byN.get('5')), 'done');
  assert.equal(derivePhaseStatus(byN.get('1')), 'done');
  assert.equal(derivePhaseStatus(byN.get('3')), 'in_progress'); // partial counter, no ticked boxes
  assert.equal(derivePhaseStatus(byN.get('4')), 'todo');
});

test('debug/resolved/: one session per file, key preserved, location forces resolution', async () => {
  const sessions = await parseDebugSessions(planningDir);
  const keys = sessions.map((s) => s.key).sort();
  assert.deepEqual(keys, ['cart-total-wrong', 'login-timeout', 'old-crash-on-boot']);
  const stale = sessions.find((s) => s.key === 'old-crash-on-boot');
  assert.equal(stale.resolvedDir, true);
  assert.equal(stale.file, 'debug/resolved/old-crash-on-boot.md');
  assert.equal(sessions.find((s) => s.key === 'login-timeout').resolvedDir, false);
});

test('parseExecutedPlanIds: SUMMARY.md on disk marks the plan executed', async () => {
  const ids = await parseExecutedPlanIds(planningDir);
  assert.deepEqual([...ids], ['03-01']);
});

test('buildDesired end-to-end on a gsd-core-native .planning', async () => {
  const { desired } = await buildDesired(planningDir);
  const phaseState = new Map(desired.phases.map((p) => [p.key, p.stateType]));
  assert.equal(phaseState.get('1'), 'completed');
  assert.equal(phaseState.get('3'), 'started');
  assert.equal(phaseState.get('4'), 'unstarted');
  assert.equal(phaseState.get('5'), 'completed');
  const planState = new Map(desired.plans.map((p) => [p.key, p.stateType]));
  assert.equal(planState.get('03-01'), 'completed'); // via SUMMARY on disk, checklist unticked
  assert.equal(planState.get('03-02'), 'unstarted');
  const v20 = desired.milestones.find((m) => m.key === 'v2.0');
  assert.match(v20.body, /Planned/);
  const bugState = new Map(desired.debugs.map((d) => [d.key, d.stateType]));
  assert.equal(bugState.get('login-timeout'), 'started');
  assert.equal(bugState.get('cart-total-wrong'), 'completed');
  assert.equal(bugState.get('old-crash-on-boot'), 'completed');
  const bug = desired.debugs.find((d) => d.key === 'login-timeout');
  assert.match(bug.body, /\*\*Expected:\*\*\nLogin completes in under 2s\./);
});

test('plan sub-issue body carries the PLAN.md content when it exists on disk', async () => {
  const { desired } = await buildDesired(planningDir);
  // Non-GSD content (no frontmatter, no known tags) keeps the code-fence fallback.
  const withContent = desired.plans.find((p) => p.key === '03-01');
  assert.match(withContent.body, /```md\nraw plan notes\n```/);
  assert.match(withContent.body, /Source: `\.planning\/phases\/03-billing\/03-01-PLAN\.md`/);
  // GSD-format plan is rendered as markdown sections — no raw tags, no fence.
  const rendered = desired.plans.find((p) => p.key === '01-01');
  assert.match(rendered.body, /\*\*Wave:\*\* 1 · \*\*Autonomous:\*\* yes/);
  assert.match(rendered.body, /## Objective\n\nScaffold the repo/);
  assert.match(rendered.body, /### Task 1: init/);
  assert.match(rendered.body, /```bash\nnpm init -y\n```/);
  assert.match(rendered.body, /\*\*Done when:\*\* package\.json exists/);
  assert.doesNotMatch(rendered.body, /<objective>|````/);
  // Plan not written to disk yet keeps the description-only body.
  const notOnDisk = desired.plans.find((p) => p.key === '03-02');
  assert.equal(notOnDisk.body, 'Invoices\n\nSource: `.planning/phases/` → `03-02-PLAN.md`');
});

test('legacy format keeps parsing: em-dash separators and -PLAN.md checklists', () => {
  const legacy = [
    '# Roadmap: Legacy',
    '',
    '## Milestones',
    '',
    '- ✅ **v1.0 Core** — Phases 1–2 (shipped 2026-06-01)',
    '',
    '### Phase 1: Setup',
    '**Goal:** skeleton',
    '',
    'Plans:',
    '- [x] 01-01-PLAN.md — scaffold [wave 1]',
    '- [x] 01-02 — no suffix variant (completed 2026-06-01)',
    '',
  ].join('\n');
  const { milestones, phases } = parseRoadmap(legacy);
  assert.equal(milestones[0].status, 'shipped');
  const plans = phases.find((p) => p.number === '1').plans;
  assert.deepEqual(plans.map((p) => [p.file, p.checked, p.wave]), [
    ['01-01-PLAN.md', true, 1],
    ['01-02-PLAN.md', true, null],
  ]);
});
