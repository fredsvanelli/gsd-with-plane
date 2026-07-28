// Agile ticket templates: bug bodies with Expected/Actual (DEBUG.md Symptoms),
// todo bodies with Scope/Acceptance criteria, and the opt-in GSD capture patch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { parseSymptoms, parseSections } from '../plugin/scripts/parse-extras.mjs';
import { bugBody, todoBody, buildDesired } from '../plugin/scripts/desired.mjs';

const scriptsDir = fileURLToPath(new URL('../plugin/scripts/', import.meta.url));

test('parseSymptoms: extracts filled fields, drops placeholders/none/empty', () => {
  const filled = [
    '## Symptoms',
    '<!-- Written during gathering, then immutable -->',
    '',
    'expected: rows turn yellow',
    'actual: rows stay gray',
    '  on every second edit', // continuation line
    'errors: none',
    'reproduction: [how to trigger]',
    'started: always',
    '',
    '## Eliminated',
    'expected: not a symptom field (different section)',
  ].join('\n');
  assert.deepEqual(parseSymptoms(filled), {
    expected: 'rows turn yellow',
    actual: 'rows stay gray\n  on every second edit',
  });
  // template fresh out of gsd-debug: everything is placeholder → {}
  assert.deepEqual(parseSymptoms([
    '## Symptoms',
    'expected: [what should happen]',
    'actual: [what actually happens]',
  ].join('\n')), {});
  assert.deepEqual(parseSymptoms('no symptoms section here'), {});
});

test('parseSections: lowercased ## headings → trimmed content', () => {
  const body = '## Problem\n\nthe problem\n\n## Solution\n\nTBD\n\n## Acceptance Criteria\n\n- [ ] works\n';
  assert.deepEqual(parseSections(body), {
    problem: 'the problem',
    solution: 'TBD',
    'acceptance criteria': '- [ ] works',
  });
  assert.deepEqual(parseSections(''), {});
  assert.deepEqual(parseSections(null), {});
});

test('bugBody: agile fields between trigger and status; plain fallback without symptoms', () => {
  const base = { trigger: 'it broke', status: 'investigating', created: null, file: 'debug/x.md' };
  const rich = bugBody({ ...base, symptoms: { expected: 'ok', actual: 'crash', reproduction: 'click' } });
  assert.match(rich, /it broke\n\n\*\*Expected:\*\*\nok\n\n\*\*Actual:\*\*\ncrash\n\n\*\*Reproduction:\*\*\nclick/);
  assert.equal(bugBody({ ...base, symptoms: {} }),
    'it broke\n\nDebug session status: `investigating`\n\nSource: `.planning/debug/x.md`');
});

test('todoBody: Problem→Scope, Scope/Acceptance Criteria pass through, TBD solution dropped', () => {
  const base = { created: null, file: 'todos/pending/x.md', excerpt: 'raw body' };
  const fromProblem = todoBody({ ...base, sections: { problem: 'fix the list', solution: 'TBD' } });
  assert.match(fromProblem, /^\*\*Scope:\*\*\nfix the list\n\nSource:/);
  assert.ok(!fromProblem.includes('Proposed solution'), 'TBD solution omitted');
  const fromTemplate = todoBody({ ...base, sections: {
    scope: 'ship the thing', solution: 'use the API', 'acceptance criteria': '- [ ] deployed',
  } });
  assert.match(fromTemplate, /\*\*Scope:\*\*\nship the thing/);
  assert.match(fromTemplate, /\*\*Proposed solution:\*\*\nuse the API/);
  assert.match(fromTemplate, /\*\*Acceptance criteria:\*\*\n- \[ \] deployed/);
  // free-form body (no known sections) → raw excerpt, unchanged behavior
  assert.match(todoBody({ ...base, sections: {} }), /^raw body\n\nSource:/);
});

// End-to-end: the templates above must survive the trip through buildDesired.
// (The bug/Symptoms path is covered on a full fixture in gsd-core-format.test.mjs.)
test('buildDesired: a todo with ## Problem renders as **Scope:** on the board', async () => {
  const planningDir = join(await mkdtemp(join(tmpdir(), 'gsdp-agile-')), '.planning');
  await mkdir(join(planningDir, 'todos', 'pending'), { recursive: true });
  await writeFile(join(planningDir, 'ROADMAP.md'), '# Roadmap: Agile\n\n## Milestones\n\n## Phases\n');
  await writeFile(join(planningDir, 'todos', 'pending', '2026-06-17-partner-cost-breakdown.md'), [
    '---',
    'created: 2026-06-17T03:59:49.691Z',
    'title: Deliveries list partner cost breakdown DTO',
    '---',
    '',
    '## Problem',
    '',
    'The list endpoint returns a flat total with no per-partner breakdown.',
    '',
    '## Solution',
    '',
    'TBD',
    '',
  ].join('\n'));

  const { desired } = await buildDesired(planningDir);
  const todo = desired.todos.find((t) => t.key.includes('partner-cost-breakdown'));
  assert.ok(todo, 'todo picked up by buildDesired');
  assert.match(todo.body, /^\*\*Scope:\*\*\nThe list endpoint returns a flat total/);
  assert.ok(!todo.body.includes('Proposed solution'), 'TBD solution omitted end-to-end');
  assert.match(todo.body, /Source: `\.planning\/todos\/pending\/2026-06-17-partner-cost-breakdown\.md`/);
});

// --- opt-in GSD capture patch (option B) ---

const ADD_TODO_SNIPPET = [
  'Write to `.planning/todos/pending/${date}-${slug}.md`:',
  '',
  '```markdown',
  '## Problem',
  '',
  '[problem description - enough context for future Claude to understand weeks later]',
  '',
  '## Solution',
  '',
  '[approach hints or "TBD"]',
  '```',
  '',
].join('\n');

function runPatch(gsdDir, ...extra) {
  return spawnSync(process.execPath, [join(scriptsDir, 'patch-gsd-todo-template.mjs'), '--gsd-dir', gsdDir, ...extra], {
    encoding: 'utf8',
  });
}

test('patch-gsd-todo-template: applies once, idempotent, fails cleanly on unknown format', async () => {
  const gsdDir = await mkdtemp(join(tmpdir(), 'gsd-fake-'));
  await mkdir(join(gsdDir, 'workflows'), { recursive: true });
  const target = join(gsdDir, 'workflows', 'add-todo.md');
  await writeFile(target, ADD_TODO_SNIPPET);

  const first = runPatch(gsdDir);
  assert.equal(first.status, 0, first.stderr);
  const patched = await readFile(target, 'utf8');
  assert.match(patched, /## Solution\n\n\[approach hints or "TBD"\]\n\n## Acceptance Criteria\n\n- \[ \] /);

  const second = runPatch(gsdDir);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /already/i);
  assert.equal(await readFile(target, 'utf8'), patched, 'second run changes nothing');

  // --check never writes
  const check = runPatch(gsdDir, '--check');
  assert.equal(check.status, 0);
  assert.match(check.stdout, /patched/i);

  // unrecognized template block → exit 2, file untouched
  await writeFile(target, '## Solution\n\nsomething custom\n');
  const bad = runPatch(gsdDir);
  assert.equal(bad.status, 2);
  assert.equal(await readFile(target, 'utf8'), '## Solution\n\nsomething custom\n');
});

test('patch-gsd-todo-template: exit 2 when GSD is not installed at the given dir', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'gsd-none-'));
  const r = runPatch(empty);
  assert.equal(r.status, 2);
});
