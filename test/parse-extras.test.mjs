// v1.1 filesystem parsers (quick tasks, todos, phase artifacts, debug sessions)
// plus the pure PR/phase helpers. Fixtures are built in a tmpdir — the parsers
// read folder STRUCTURE, so the fixture mirrors what GSD writes on disk.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseQuickTasks, parsePendingTodos, parsePhaseArtifacts, parseOpenPRs,
  parseDebugSessions, siblingReposFromPhases,
  phaseKeyFromPR, phaseKeysFromPRFiles, phasePRPairsFromState,
} from '../plugin/scripts/parse-extras.mjs';

let planningDir;

before(async () => {
  planningDir = await mkdtemp(join(tmpdir(), 'gsdp-extras-'));
  const write = async (rel, text) => {
    const path = join(planningDir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };

  // quick/: one dir per task; a *-SUMMARY.md marks it done.
  await write('quick/20260622-deliveries-draft-list/PLAN.md', [
    '# Quick Task: DRAFT deliveries not appearing in the list',
    '',
    'The list filters out DRAFT rows because the status enum is compared as a string.',
    '',
  ].join('\n'));
  await write('quick/20260622-deliveries-draft-list/SUMMARY.md', '# Done\n');

  await write('quick/260713-s01-fix-ux-quotes-submit/260713-s01-PLAN.md', [
    '---', 'phase: quick', '---', '',
    '<objective>',
    'Fix silent submit failure on the quotes form when no company is selected.',
    'The button posts and the API 422s without any surfaced message.',
    '</objective>',
    '',
  ].join('\n'));

  // todos/pending/: frontmatter title/created + a sectioned body.
  await write('todos/pending/2026-06-17-partner-cost-breakdown.md', [
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
  await write('todos/resolved/2026-06-01-already-done.md', '---\ntitle: Already done\n---\n\nshipped\n');

  // phases/: REVIEW / REVIEW-FIX / VERIFICATION / HUMAN-UAT status frontmatter.
  await write('phases/44-relatorios/44-REVIEW.md', '---\nstatus: findings\n---\n\nSee below.\n');
  await write('phases/44-relatorios/44-REVIEW-FIX.md', '# Fixes applied\n');
  await write('phases/44-relatorios/44-VERIFICATION.md',
    '---\nstatus: human_needed\n---\n\nNeeds a human.\n');
  await write('phases/58-contatos/58-REVIEW.md', '---\nstatus: findings\n---\n\nFindings.\n');
  // a body mentioning `status:` must not be mistaken for frontmatter
  await write('phases/60-financeiro/60-HUMAN-UAT.md', [
    '---', 'status: partial', '---', '',
    "The schema uses varchar('status', { length: 20 }) — not a status field.",
    '',
  ].join('\n'));
  // HUMAN-UAT wins over UAT when both exist
  await write('phases/60-financeiro/60-UAT.md', '---\nstatus: passed\n---\n\nolder doc\n');
  await write('phases/not-a-phase/README.md', 'ignored: no leading number\n');

  // debug/: loose .md files, plus resolved/ which forces resolution.
  await write('debug/edited-row-no-warning-highlight.md', [
    '---',
    'created: 2026-07-02T12:00:00.000Z',
    'status: diagnosed',
    'trigger: "edited row does not get the warning-50 highlight"',
    '---',
    '',
    '## Symptoms',
    '',
    'expected: the row turns warning-50 yellow after an edit',
    'actual: it does not turn yellow until a full reload',
    'errors: none',
    'reproduction: [how to trigger]',
    '',
  ].join('\n'));
  await write('debug/resolved/old-session.md', '---\ntrigger: "fixed long ago"\n---\n\ndone\n');
});

test('quick: title from the "# Quick Task: ..." heading; SUMMARY.md → done', async () => {
  const byKey = new Map((await parseQuickTasks(planningDir)).map((q) => [q.key, q]));
  const q = byKey.get('20260622-deliveries-draft-list');
  assert.equal(q.title, 'DRAFT deliveries not appearing in the list');
  assert.equal(q.status, 'done');
  assert.equal(q.planFile, 'quick/20260622-deliveries-draft-list/PLAN.md');
});

test('quick: title/excerpt via <objective> when there is no heading; no SUMMARY → in_progress', async () => {
  const q = (await parseQuickTasks(planningDir))
    .find((x) => x.key === '260713-s01-fix-ux-quotes-submit');
  assert.match(q.title, /^Fix silent submit failure/);
  assert.equal(q.status, 'in_progress');
  assert.ok(q.excerpt.length > 50, 'objective excerpt captured');
  assert.equal(q.planFile, 'quick/260713-s01-fix-ux-quotes-submit/260713-s01-PLAN.md');
});

test('quick: every task has a title and a well-formed plan path', async () => {
  for (const q of await parseQuickTasks(planningDir)) {
    assert.ok(q.title.length > 0, `${q.key} has a title`);
    if (q.planFile) assert.match(q.planFile, /^quick\/.+PLAN\.md$/);
  }
});

test('todos: title/created from frontmatter, sections from the body, resolved/ flagged', async () => {
  const todos = await parsePendingTodos(planningDir);
  const t = todos.find((x) => x.key === '2026-06-17-partner-cost-breakdown');
  assert.equal(t.title, 'Deliveries list partner cost breakdown DTO');
  assert.equal(t.created, '2026-06-17T03:59:49.691Z');
  assert.match(t.excerpt, /^## Problem/);
  assert.ok(t.excerpt.length <= 1201, 'excerpt capped at ~1200 chars');
  assert.equal(t.resolved, false);
  assert.equal(t.sections.problem, 'The list endpoint returns a flat total with no per-partner breakdown.');
  assert.equal(todos.find((x) => x.key === '2026-06-01-already-done').resolved, true);
  for (const x of todos) assert.ok(typeof x.resolved === 'boolean');
});

test('parsePhaseArtifacts: status from frontmatter, no false positive from "status:" in the body', async () => {
  const art = await parsePhaseArtifacts(planningDir);
  assert.deepEqual(
    { review: art.get('44').review, fix: art.get('44').hasReviewFix, verification: art.get('44').verification },
    { review: 'findings', fix: true, verification: 'human_needed' },
  );
  assert.deepEqual(
    { review: art.get('58').review, fix: art.get('58').hasReviewFix },
    { review: 'findings', fix: false },
  );
  assert.equal(art.get('60').humanUat, 'partial', 'HUMAN-UAT wins over UAT');
  assert.equal(art.has('not-a-phase'), false, 'dirs without a leading number are skipped');
  // no status may be junk from a file body (e.g. "varchar('status'...")
  for (const [n, a] of art) {
    for (const v of [a.review, a.verification, a.humanUat]) {
      if (v) assert.match(v, /^[a-z_]+$/, `clean status on phase ${n}: ${v}`);
    }
  }
});

test('parseDebugSessions: status/trigger frontmatter; resolved/ forces resolution', async () => {
  const sessions = await parseDebugSessions(planningDir);
  const known = sessions.find((s) => s.key === 'edited-row-no-warning-highlight');
  assert.ok(known, 'loose .md session parsed');
  assert.equal(known.status, 'diagnosed');
  assert.match(known.trigger, /warning-50/);
  assert.equal(known.file, 'debug/edited-row-no-warning-highlight.md');
  assert.equal(known.created, '2026-07-02T12:00:00.000Z');
  // Symptoms: filled fields kept, "none" and [placeholders] dropped
  assert.match(known.symptoms.expected, /warning-50 yellow/);
  assert.match(known.symptoms.actual, /does not turn yellow/);
  assert.equal(known.symptoms.errors, undefined, '"none" dropped');
  assert.equal(known.symptoms.reproduction, undefined, 'placeholder dropped');

  const old = sessions.find((s) => s.key === 'old-session');
  assert.equal(old.status, 'resolved', 'debug/resolved/ implies resolution without frontmatter');
  assert.equal(old.resolvedDir, true);
  assert.equal(old.file, 'debug/resolved/old-session.md');

  for (const s of sessions) assert.match(s.status, /^[a-z_]+$/);
});

test('missing directories → empty list, no error', async () => {
  assert.deepEqual(await parseQuickTasks('/tmp/does-not-exist-planning'), []);
  assert.deepEqual(await parsePendingTodos('/tmp/does-not-exist-planning'), []);
  assert.deepEqual(await parseDebugSessions('/tmp/does-not-exist-planning'), []);
  assert.equal((await parsePhaseArtifacts('/tmp/does-not-exist-planning')).size, 0);
});

test("siblingReposFromPhases: unique sibling repos from the phases' Repo fields", () => {
  const siblings = siblingReposFromPhases([
    { repo: '../acme-shipping-api' },
    { repo: '../acme-shipping-api' },
    { repo: 'primary and ../other-service' },
    { repo: null },
    {},
  ]);
  assert.deepEqual(siblings.sort(), ['../acme-shipping-api', '../other-service']);
  assert.deepEqual(siblingReposFromPhases([]), []);
});

test('phaseKeysFromPRFiles: phases derived from .planning paths in the PR diff', () => {
  assert.deepEqual(phaseKeysFromPRFiles([
    '.planning/phases/68.3-refactor-db/68.3-01-SUMMARY.md',
    '.planning/phases/68.3-refactor-db/68.3-02-PLAN.md',
    'src/lib/DB/schema/contacts.ts',
    '.planning/STATE.md',
  ]), ['68.3']);
  // a cross-phase PR maps both; paths outside phases/ don't count
  assert.deepEqual(phaseKeysFromPRFiles([
    '.planning/phases/51-backend/51-VERIFICATION.md',
    '.planning/phases/52-frontend/52-01-PLAN.md',
  ]), ['51', '52']);
  assert.deepEqual(phaseKeysFromPRFiles(['src/app/page.tsx', '.planning/ROADMAP.md']), []);
});

test('phasePRPairsFromState: "Phase N … PR #M", with an optional repo hint', () => {
  // ship.md's canonical format
  assert.deepEqual(phasePRPairsFromState('Status: Phase 72 shipped — PR #99'), [{ phase: '72', prNumber: 99 }]);
  // multiple pairs on one STATE.md line
  const pairs = phasePRPairsFromState(
    'Phase 49 MERGED into feat/financial-module (PR #47); Phase 50 MERGED (admin-next PR #51)',
  );
  assert.ok(pairs.some((p) => p.phase === '49' && p.prNumber === 47), '49→#47 found');
  assert.ok(pairs.some((p) => p.phase === '50' && p.prNumber === 51), '50→#51 found');
  // repoHint captured only when the preceding word is a repo name (not an em dash)
  assert.deepEqual(
    phasePRPairsFromState('Phase 50 MERGED (admin-next PR #51, shipping-api PR #48)')[0],
    { phase: '50', prNumber: 51, repoHint: 'admin-next' },
  );
  assert.deepEqual(phasePRPairsFromState('nothing to see here'), []);
});

test('phaseKeyFromPR: matches the phase in the branch or title; null without a reference', () => {
  assert.equal(phaseKeyFromPR('feat/phase-68.3-contacts', 'Merge contacts'), '68.3');
  assert.equal(phaseKeyFromPR('feature/phase_42', ''), '42');
  assert.equal(phaseKeyFromPR('fix/typo', 'Phase 41: cancel delivery'), '41');
  assert.equal(phaseKeyFromPR('feat/cancel-delivery', 'Cancel delivery flow'), null);
});

test('parseOpenPRs: degrades to empty when not a git repo (the sandbox case)', async () => {
  assert.equal((await parseOpenPRs(fileURLToPath(new URL('..', import.meta.url)))).size, 0);
});
