// Surgical local writes for the pull (Plane → .planning/). Never regenerates
// whole GSD files — only touches the exact spot (one checkbox, one file move,
// one new todo), so it never fights the structure GSD maintains.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Toggles the checkbox of ONE plan in the ROADMAP.md text.
// The line `- [x] 60-04-PLAN.md — ...` is unique in the file (the plan name is a key).
export function togglePlanCheckbox(roadmapText, planKey, checked) {
  const re = new RegExp(`(^[ \\t]*-\\s+\\[)([ x])(\\]\\s+${escapeRegExp(planKey)}-PLAN\\.md)`, 'm');
  const m = roadmapText.match(re);
  if (!m) return { text: roadmapText, changed: false, found: false };
  const desired = checked ? 'x' : ' ';
  if (m[2] === desired) return { text: roadmapText, changed: false, found: true };
  return { text: roadmapText.replace(re, `$1${desired}$3`), changed: true, found: true };
}

export async function applyPlanCheckbox(planningDir, planKey, checked) {
  const path = join(planningDir, 'ROADMAP.md');
  const text = await readFile(path, 'utf8');
  const result = togglePlanCheckbox(text, planKey, checked);
  if (result.changed) await writeFile(path, result.text);
  return result;
}

// Moves a todo between pending/ and resolved/ (completed in Plane ⇄ reopened).
export async function moveTodo(planningDir, key, toResolved) {
  const from = join(planningDir, 'todos', toResolved ? 'pending' : 'resolved', `${key}.md`);
  const to = join(planningDir, 'todos', toResolved ? 'resolved' : 'pending', `${key}.md`);
  await mkdir(join(planningDir, 'todos', toResolved ? 'resolved' : 'pending'), { recursive: true });
  try {
    await rename(from, to);
    return true;
  } catch {
    return false; // file was not where expected — reported by the caller
  }
}

export function slugify(title, max = 60) {
  return title.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, max).replace(/-+$/, '');
}

// Materializes an issue created in Plane as a todo in .planning/todos/pending/.
// Returns the key (file name without .md) used in the adoption marker.
export async function writeForeignTodo(planningDir, { title, description, identifier, url, createdAt }) {
  const date = (createdAt ?? new Date().toISOString()).slice(0, 10);
  const key = `${date}-${slugify(title) || 'untitled'}`;
  const dir = join(planningDir, 'todos', 'pending');
  await mkdir(dir, { recursive: true });
  const content = [
    '---',
    `created: ${createdAt ?? new Date().toISOString()}`,
    `title: ${title}`,
    `source: plane ${identifier}${url ? ` (${url})` : ''}`,
    '---',
    '',
    description?.trim() || '(no description in Plane)',
    '',
  ].join('\n');
  await writeFile(join(dir, `${key}.md`), content, { flag: 'wx' }); // wx: never overwrites
  return key;
}
