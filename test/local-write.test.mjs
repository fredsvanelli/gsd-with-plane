// Surgical local writes for the pull (Plane → .planning/): the ROADMAP checkbox
// toggle must change exactly one character, the todo move must be reversible,
// and writeForeignTodo must never overwrite an existing file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  togglePlanCheckbox, moveTodo, writeForeignTodo, slugify,
} from '../plugin/scripts/local-write.mjs';

// Mirrors the shape GSD writes: checked/unchecked plans, a decimal phase, and a
// near-miss key (68X3-01) that an unescaped `.` in the regex would match.
const ROADMAP = [
  '# Roadmap: Fixture',
  '',
  '### Phase 42: Cotação',
  '',
  'Plans:',
  '- [x] 42-01-PLAN.md — Detalhes do pacote',
  '- [ ] 42-02-PLAN.md — Envio',
  '',
  '### Phase 63: Relatórios',
  '',
  'Plans:',
  '- [ ] 63-04-PLAN.md — Exportação CSV',
  '',
  '### Phase 68.3: Contatos',
  '',
  'Plans:',
  '  - [x] 68X3-01-PLAN.md — decoy: must not match 68.3-01',
  '  - [x] 68.3-01-PLAN.md — Mesclar tabelas',
  '',
].join('\n');

test('togglePlanCheckbox: checks an unchecked plan', () => {
  const r = togglePlanCheckbox(ROADMAP, '63-04', true);
  assert.equal(r.found, true);
  assert.equal(r.changed, true);
  assert.match(r.text, /- \[x\] 63-04-PLAN\.md/);
  // only the target line changes (1 character) — compare code points with code points
  assert.equal(r.text.length, ROADMAP.length);
  const a = [...r.text];
  const b = [...ROADMAP];
  assert.equal(a.filter((c, i) => c !== b[i]).length, 1);
});

test('togglePlanCheckbox: unchecks a checked plan', () => {
  const r = togglePlanCheckbox(ROADMAP, '42-01', false);
  assert.equal(r.changed, true);
  assert.match(r.text, /- \[ \] 42-01-PLAN\.md/);
  assert.match(r.text, /- \[ \] 42-02-PLAN\.md/, 'sibling plan untouched');
});

test('togglePlanCheckbox: no-op when already in the desired state', () => {
  const r = togglePlanCheckbox(ROADMAP, '42-01', true);
  assert.equal(r.found, true);
  assert.equal(r.changed, false);
  assert.equal(r.text, ROADMAP);
});

test('togglePlanCheckbox: decimal plan (68.3-01) — dot escaped in the regex', () => {
  const r = togglePlanCheckbox(ROADMAP, '68.3-01', false);
  assert.equal(r.found, true);
  assert.equal(r.changed, true);
  assert.match(r.text, /- \[ \] 68\.3-01-PLAN\.md/);
  // must not have matched the decoy via an unescaped `.`
  assert.match(r.text, /- \[x\] 68X3-01-PLAN\.md/, 'decoy line untouched');
});

test('togglePlanCheckbox: nonexistent plan → found=false, text untouched', () => {
  const r = togglePlanCheckbox(ROADMAP, '99-99', true);
  assert.equal(r.found, false);
  assert.equal(r.changed, false);
  assert.equal(r.text, ROADMAP);
});

test('moveTodo: pending ⇄ resolved, false when the file is not where expected', async () => {
  const planning = await mkdtemp(join(tmpdir(), 'gsdp-todos-'));
  await mkdir(join(planning, 'todos', 'pending'), { recursive: true });
  await writeFile(join(planning, 'todos', 'pending', 'fix-the-list.md'), '## Problem\n\nbroken\n');

  assert.equal(await moveTodo(planning, 'fix-the-list', true), true);
  assert.equal(
    await readFile(join(planning, 'todos', 'resolved', 'fix-the-list.md'), 'utf8'),
    '## Problem\n\nbroken\n',
  );
  // reopening moves it back
  assert.equal(await moveTodo(planning, 'fix-the-list', false), true);
  await access(join(planning, 'todos', 'pending', 'fix-the-list.md'));
  // unknown key → false, no throw
  assert.equal(await moveTodo(planning, 'does-not-exist', true), false);
});

test('writeForeignTodo: frontmatter + slugified key; never overwrites (wx)', async () => {
  const planning = await mkdtemp(join(tmpdir(), 'gsdp-foreign-'));
  const key = await writeForeignTodo(planning, {
    title: 'Cotação: detalhes do pacote',
    description: '  needs the partner breakdown  ',
    identifier: 'ACME-42',
    url: 'http://localhost/ws/browse/ACME-42/',
    createdAt: '2026-07-20T10:00:00.000Z',
  });
  assert.equal(key, '2026-07-20-cotacao-detalhes-do-pacote');
  const body = await readFile(join(planning, 'todos', 'pending', `${key}.md`), 'utf8');
  assert.match(body, /^---\ncreated: 2026-07-20T10:00:00\.000Z\ntitle: Cotação: detalhes do pacote\n/);
  assert.match(body, /source: plane ACME-42 \(http:\/\/localhost\/ws\/browse\/ACME-42\/\)/);
  assert.match(body, /\nneeds the partner breakdown\n/, 'description trimmed');

  // same key again → rejected by the wx flag, existing file preserved
  await assert.rejects(() => writeForeignTodo(planning, {
    title: 'Cotação: detalhes do pacote',
    description: 'DIFFERENT',
    identifier: 'ACME-99',
    createdAt: '2026-07-20T11:00:00.000Z',
  }), /EEXIST/);
  assert.equal(await readFile(join(planning, 'todos', 'pending', `${key}.md`), 'utf8'), body);

  // empty description falls back to a placeholder
  const k2 = await writeForeignTodo(planning, {
    title: 'No body', description: '', identifier: 'ACME-43', createdAt: '2026-07-20T12:00:00.000Z',
  });
  assert.match(await readFile(join(planning, 'todos', 'pending', `${k2}.md`), 'utf8'),
    /\(no description in Plane\)/);
});

test('slugify: accents, symbols and length', () => {
  // accented Portuguese input on purpose — exercises the accent stripping
  assert.equal(slugify('Cotação: detalhes do pacote (opcional)'), 'cotacao-detalhes-do-pacote-opcional');
  assert.equal(slugify('  --Múltiplos---hífens--  '), 'multiplos-hifens');
  assert.ok(slugify('a'.repeat(100)).length <= 60);
});
