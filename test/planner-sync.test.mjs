// planner-sync overlay: per-field three-way merge between GSD (.planning/),
// the merge base (last push) and the board. Board wins for fields the user
// touched on the board; GSD wins for fields it changed itself since the base.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadBoard, saveBoard, ensureItem, mergePushFields, applyPushClears,
  recordBase, captureFromBoard, renderBoardMd,
} from '../plugin/scripts/planner-sync.mjs';
import { canonicalStateFor } from '../plugin/scripts/common.mjs';

const item = (over = {}) => ({
  key: '42', title: 'Phase 42: API', stateType: 'started', labels: [], ...over,
});

const STATES = [
  { id: 's-backlog', name: 'Backlog', group: 'backlog', sequence: 1 },
  { id: 's-todo', name: 'Todo', group: 'unstarted', sequence: 2 },
  { id: 's-prog', name: 'In Progress', group: 'started', sequence: 3 },
  { id: 's-uat', name: 'UAT', group: 'started', sequence: 4 },
  { id: 's-blocked', name: 'Blocked', group: 'started', sequence: 5 }, // user-created
  { id: 's-done', name: 'Done', group: 'completed', sequence: 6 },
  { id: 's-deployed', name: 'Deployed', group: 'completed', sequence: 7 }, // user-created
];
const canonicalIdFor = (t) => canonicalStateFor(STATES, t)?.id ?? null;

const view = (over = {}) => ({
  issueId: 'i-1', identifier: 'CCSA-12', title: 'Phase 42: API',
  stateId: 's-prog', stateName: 'In Progress', stateGroup: 'started',
  labelNames: [], assignees: [], priority: 'none',
  targetDate: null, startDate: null, updatedAt: 't0', ...over,
});

// ---------- capture (pull side) ----------

test('capture: board rename becomes a title override; revert clears it', () => {
  const e = {};
  let r = captureFromBoard(e, item(), view({ title: 'API core (renamed on board)' }), { canonicalIdFor });
  assert.equal(e.overrides.title, 'API core (renamed on board)');
  assert.equal(r.length, 1);
  // pulled again unchanged → no repeated report
  r = captureFromBoard(e, item(), view({ title: 'API core (renamed on board)' }), { canonicalIdFor });
  assert.equal(r.length, 0);
  // user reverts on the board → override cleared
  r = captureFromBoard(e, item(), view(), { canonicalIdFor });
  assert.equal(e.overrides, undefined);
  assert.match(r[0], /cleared/);
});

test('capture: card dragged to a custom column becomes a state override', () => {
  const e = {};
  captureFromBoard(e, item(), view({ stateId: 's-blocked', stateName: 'Blocked' }), { canonicalIdFor });
  assert.deepEqual(e.overrides.state, { id: 's-blocked', name: 'Blocked', group: 'started' });
});

test('capture: pending GSD-side state change is NOT an override', () => {
  // base said unstarted, GSD now wants completed, board still sits at Todo —
  // the push should move the card; nothing to capture.
  const e = { base: { title: 'Phase 42: API', stateType: 'unstarted', labels: [] } };
  captureFromBoard(e, item({ stateType: 'completed' }), view({ stateId: 's-todo', stateName: 'Todo', stateGroup: 'unstarted' }), { canonicalIdFor });
  assert.equal(e.overrides, undefined);
  assert.equal(e.base.stateType, 'unstarted'); // base advances only via push/flip
});

test('capture: applied flip advances the base so the convergence push respects the column', () => {
  // plan done on the board, dragged into the custom "Deployed" column; the
  // pull applies the flip → base follows and the column becomes an override.
  const e = { base: { title: 'Phase 42: API', stateType: 'unstarted', labels: [] } };
  captureFromBoard(e, item({ stateType: 'unstarted' }),
    view({ stateId: 's-deployed', stateName: 'Deployed', stateGroup: 'completed' }),
    { flipTo: 'completed', canonicalIdFor });
  assert.equal(e.base.stateType, 'completed');
  assert.equal(e.overrides.state.name, 'Deployed');
  // convergence push: stateType now matches base → column kept
  const m = mergePushFields(e, item({ stateType: 'completed' }));
  assert.equal(m.omitState, true);
});

test('capture: extra and removed labels tracked against the base', () => {
  const e = { base: { title: 'Phase 42: API', stateType: 'started', labels: ['wave-1'] } };
  captureFromBoard(e, item({ labels: ['wave-1'] }), view({ labelNames: ['urgent'] }), { canonicalIdFor });
  assert.deepEqual(e.overrides.extraLabels, ['urgent']);
  assert.deepEqual(e.overrides.removedLabels, ['wave-1']);
});

test('capture: board metadata lands in entry.board, comments preserved', () => {
  const e = { board: { comments: { count: 2, last: [] } } };
  captureFromBoard(e, item(), view({ assignees: ['Fred'], priority: 'high', targetDate: '2026-07-30' }), { canonicalIdFor });
  assert.equal(e.board.assignees[0], 'Fred');
  assert.equal(e.board.priority, 'high');
  assert.equal(e.board.comments.count, 2); // untouched by capture
});

// ---------- merge (push side) ----------

test('push: title override omits name; GSD rename wins and clears it', () => {
  const e = {
    base: { title: 'Phase 42: API', stateType: 'started', labels: [] },
    overrides: { title: 'Board title' },
  };
  // GSD unchanged → board title kept
  let m = mergePushFields(e, item());
  assert.equal(m.omitName, true);
  assert.deepEqual(m.clears, {});
  // GSD renamed → GSD wins, override cleared after apply
  m = mergePushFields(e, item({ title: 'Phase 42: API v2' }));
  assert.equal(m.omitName, false);
  assert.equal(m.clears.title, true);
  assert.match(m.reports[0], /GSD renamed/);
  applyPushClears(e, m.clears);
  assert.equal(e.overrides, undefined);
});

test('push: state override omits state; GSD state change wins', () => {
  const e = {
    base: { title: 'Phase 42: API', stateType: 'started', labels: [] },
    overrides: { state: { id: 's-blocked', name: 'Blocked', group: 'started' } },
  };
  assert.equal(mergePushFields(e, item()).omitState, true);
  const m = mergePushFields(e, item({ stateType: 'completed' }));
  assert.equal(m.omitState, false);
  assert.equal(m.clears.state, true);
});

test('push: labels merge = (desired − removed) ∪ extra', () => {
  const e = {
    base: { title: 'Phase 42: API', stateType: 'started', labels: ['wave-1'] },
    overrides: { extraLabels: ['urgent'], removedLabels: ['wave-1'] },
  };
  assert.deepEqual(mergePushFields(e, item({ labels: ['wave-1'] })).labelNames, ['urgent']);
  // no overrides / no entry → desired labels untouched
  assert.deepEqual(mergePushFields(undefined, item({ labels: ['wave-2'] })).labelNames, ['wave-2']);
});

test('push: entry without base (migration) respects every override', () => {
  const e = { overrides: { title: 'Board title', state: { id: 's-blocked', name: 'Blocked', group: 'started' } } };
  const m = mergePushFields(e, item());
  assert.equal(m.omitName, true);
  assert.equal(m.omitState, true);
});

// ---------- persistence / render ----------

test('board.json round-trips and BOARD.md renders the overlay', async () => {
  const planning = await mkdtemp(join(tmpdir(), 'psync-'));
  const board = await loadBoard(planning);
  board.project = { id: 'p1', identifier: 'CCSA', name: 'Cheap Courier' };
  const e = ensureItem(board, 'phase', '42');
  e.identifier = 'CCSA-12';
  recordBase(e, item());
  e.overrides = { title: 'Board title', extraLabels: ['urgent'] };
  e.board = {
    assignees: ['Fred'], priority: 'high', targetDate: '2026-07-30', startDate: null,
    updatedAt: 't1', comments: { count: 1, last: [{ by: 'Fred', at: '2026-07-17T00:00:00Z', text: 'hello' }] },
  };
  board.foreignSubItems = [{ identifier: 'CCSA-99', title: 'Fix logo', parent: 'phase:42', state: 'Todo' }];
  board.customColumns = [{ name: 'Blocked', group: 'started' }];
  await saveBoard(planning, board);

  const again = await loadBoard(planning);
  assert.equal(again.items['phase:42'].overrides.title, 'Board title');
  assert.equal(again.items['phase:42'].base.stateType, 'started');

  const md = await readFile(join(planning, 'planner-sync', 'BOARD.md'), 'utf8');
  assert.match(md, /\| `phase:42` \| CCSA-12 \| title: "Board title" · labels added: urgent \|/);
  assert.match(md, /Assignees: Fred/);
  assert.match(md, /Priority: high · Due: 2026-07-30/);
  assert.match(md, /Fred \(2026-07-17\): hello/);
  assert.match(md, /CCSA-99 "Fix logo" under `phase:42`/);
  assert.match(md, /Blocked \(group: started\)/);
});

test('renderBoardMd: empty board renders the explanatory skeleton', () => {
  const md = renderBoardMd({ items: {}, foreignSubItems: [], customColumns: [] });
  assert.match(md, /planning commands .* treat them as user input/s);
  assert.match(md, /_None — the board matches/);
});
