// Synthetic unit tests for the roadmap status derivation helpers.
// Full ROADMAP.md parsing (milestones, phases, plans, waves, progress table,
// legacy em-dash format) is covered fixture-first in gsd-core-format.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { derivePhaseStatuses, comparePhaseNumbers } from '../plugin/scripts/parse-roadmap.mjs';

test('comparePhaseNumbers: numeric comparison by parts, not lexicographic', () => {
  assert.ok(comparePhaseNumbers('68.10', '68.2') > 0, '68.10 sorts after 68.2');
  assert.ok(comparePhaseNumbers('68', '68.1') < 0);
  assert.ok(comparePhaseNumbers('68.3', '69') < 0);
  assert.equal(comparePhaseNumbers('42', '42'), 0);
  assert.ok(comparePhaseNumbers('9', '10') < 0, 'numeric, so 9 before 10');
});

test('derivePhaseStatuses: closing the last decimal sub-phase closes the parent', () => {
  const mk = (number, extra = {}) => ({
    number, checked: false, plans: [], plansSummary: null, progressStatus: null, ...extra,
  });

  // 75.1–75.3 all done → 75 derives done, even with no plans of its own
  const all = derivePhaseStatuses([
    mk('75'),
    mk('75.1', { checked: true }),
    mk('75.2', { plans: [{ checked: true }] }),
    mk('75.3', { checked: true }),
  ]);
  assert.equal(all.get('75'), 'done');

  // one sub-phase still open → parent stays open
  const open = derivePhaseStatuses([
    mk('75'), mk('75.1', { checked: true }), mk('75.2'),
  ]);
  assert.equal(open.get('75'), 'todo');

  // parent with its own unfinished plans is NOT promoted
  const own = derivePhaseStatuses([
    mk('75', { plans: [{ checked: false }] }), mk('75.1', { checked: true }),
  ]);
  assert.notEqual(own.get('75'), 'done');

  // cascades bottom-up: 75.1.1 done → 75.1 done → 75 done
  const deep = derivePhaseStatuses([
    mk('75'), mk('75.1'), mk('75.1.1', { checked: true }),
  ]);
  assert.equal(deep.get('75.1'), 'done');
  assert.equal(deep.get('75'), 'done');

  // even STATE.md "current phase" pointing at 75 doesn't hold it open
  const current = derivePhaseStatuses([
    mk('75'), mk('75.1', { checked: true }),
  ], '75');
  assert.equal(current.get('75'), 'done');

  // phases without sub-phases keep their normal derivation
  const plain = derivePhaseStatuses([mk('74'), mk('75'), mk('75.1', { checked: true })]);
  assert.equal(plain.get('74'), 'todo');
});
