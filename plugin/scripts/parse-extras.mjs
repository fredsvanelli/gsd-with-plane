// v1.1 parsers: .planning/quick/ (standalone tasks) and .planning/todos/pending/.
// Unlike parse-roadmap (pure), these read the filesystem: the information
// lives in the folder STRUCTURE (quick-task dir, SUMMARY present = done).

import { readdir, readFile, access } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Title of a quick-task PLAN, in order of preference:
// 1. first `# ...` heading ("Quick Task: " prefix removed)
// 2. first line of the <objective> block (newer format)
// 3. humanized slug of the directory name (fallback)
function quickTitle(planText, dirName) {
  const heading = planText.match(/^#\s+(.+)$/m);
  // Strip redundant prefixes: "Quick Task:", "Quick Task —", "Quick Task 260620-q9g:"
  if (heading) return heading[1].replace(/^Quick Task\b[\s—:-]*(\d{6}-[a-z0-9]{3}:\s*)?/i, '').trim();
  const objective = planText.match(/<objective>\s*\n?([^\n]+)/);
  if (objective) return objective[1].trim();
  return dirName.replace(/^\d{6,8}(-[a-z0-9]{3})?-/, '').replace(/-/g, ' ').trim();
}

// Excerpt from <objective> or the first paragraph after the frontmatter, for the description.
function quickExcerpt(planText) {
  const objective = planText.match(/<objective>\s*([\s\S]*?)<\/objective>/);
  if (objective) return objective[1].trim();
  const afterFrontmatter = planText.replace(/^---\n[\s\S]*?\n---\n/, '');
  const para = afterFrontmatter.split(/\n\s*\n/).map((p) => p.trim())
    .find((p) => p && !p.startsWith('#') && !p.startsWith('<'));
  return para ?? '';
}

// .planning/quick/<dir>/: each dir is a task; `*-SUMMARY.md` present = completed.
export async function parseQuickTasks(planningDir) {
  const quickDir = join(planningDir, 'quick');
  let entries;
  try {
    entries = (await readdir(quickDir, { withFileTypes: true })).filter((e) => e.isDirectory());
  } catch {
    return []; // project without quick/ — nothing to sync
  }

  const tasks = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = join(quickDir, entry.name);
    const files = await readdir(dir);
    const planFile = files.find((f) => /(^|-)PLAN\.md$/.test(f));
    const hasSummary = files.some((f) => /(^|-)SUMMARY\.md$/.test(f));
    let planText = '';
    if (planFile) {
      planText = await readFile(join(dir, planFile), 'utf8').catch(() => '');
    }
    tasks.push({
      key: entry.name,
      title: planText ? quickTitle(planText, entry.name) : quickTitle('', entry.name),
      excerpt: planText ? quickExcerpt(planText) : '',
      // quick dir exists = execution started; SUMMARY = finished
      status: hasSummary ? 'done' : 'in_progress',
      planFile: planFile ? `quick/${entry.name}/${planFile}` : null,
    });
  }
  return tasks;
}

// Extracts `status:` from the frontmatter (only from the ---...--- block —
// avoids false positives with "status:" in the body, e.g. code snippets).
function frontmatterStatus(text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  return fm?.[1].match(/^status:\s*(\S+)/m)?.[1] ?? null;
}

// --- Agile ticket sections (bug Symptoms, todo Scope/Acceptance Criteria) ---

// `## Heading` sections of a markdown body → { 'heading in lowercase': content }.
// Todos use them to render the agile task format (Scope / Acceptance criteria)
// on the board; recognizes both GSD's native ## Problem/## Solution and the
// ## Scope/## Acceptance Criteria of issues adopted from a Linear template.
export function parseSections(body) {
  const sections = {};
  for (const m of (body ?? '').matchAll(/^##\s+(.+?)\s*\n([\s\S]*?)(?=\n##\s|(?![\s\S]))/gm)) {
    sections[m[1].toLowerCase()] = m[2].trim();
  }
  return sections;
}

// `key: value` fields of DEBUG.md's "## Symptoms" section (expected / actual /
// errors / reproduction) → agile bug fields. Values still holding the template
// placeholder ("[what should happen]"), empty or "none" are dropped — a freshly
// created session renders like before (trigger only).
export function parseSymptoms(text) {
  const section = text.match(/^## Symptoms[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/m)?.[1];
  if (!section) return {};
  const fields = {};
  let current = null;
  for (const line of section.split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) {
      current = kv[1];
      fields[current] = kv[2];
    } else if (current && line.trim() && !line.trimStart().startsWith('<!--')) {
      fields[current] += `\n${line}`; // multi-line value continuation
    } else if (!line.trim()) {
      current = null; // blank line ends the field
    }
  }
  const out = {};
  for (const key of ['expected', 'actual', 'errors', 'reproduction']) {
    const v = fields[key]?.trim();
    if (v && !/^\[.*\]$/s.test(v) && v.toLowerCase() !== 'none') out[key] = v;
  }
  return out;
}

// Per-phase lifecycle artifacts (.planning/phases/<N-slug>/):
// REVIEW.md, REVIEW-FIX.md, VERIFICATION.md, HUMAN-UAT.md → board stages
// (Code Review / UAT) derived from real GSD data.
export async function parsePhaseArtifacts(planningDir) {
  const phasesDir = join(planningDir, 'phases');
  const artifacts = new Map(); // phaseNumber → {review, hasReviewFix, verification, humanUat}
  let dirs;
  try {
    dirs = (await readdir(phasesDir, { withFileTypes: true })).filter((e) => e.isDirectory());
  } catch {
    return artifacts;
  }

  for (const entry of dirs) {
    const number = entry.name.match(/^([\d.]+)-/)?.[1];
    if (!number) continue;
    const dir = join(phasesDir, entry.name);
    const files = await readdir(dir);
    const statusOf = async (suffix) => {
      const f = files.find((x) => new RegExp(`^[\\d.]+-${suffix}\\.md$`).test(x));
      return f ? frontmatterStatus(await readFile(join(dir, f), 'utf8').catch(() => '')) : null;
    };
    artifacts.set(number, {
      review: await statusOf('REVIEW'),
      hasReviewFix: files.some((x) => /-REVIEW-FIX\.md$/.test(x)),
      verification: await statusOf('VERIFICATION'),
      // verify-work writes N-UAT.md (gsd-core@next doc) or N-HUMAN-UAT.md
      // (earlier versions); real projects have both variants. HUMAN-UAT wins
      // when both exist (it is the record of the final human acceptance).
      humanUat: await statusOf('HUMAN-UAT') ?? await statusOf('UAT'),
    });
  }
  return artifacts;
}

// Per-plan completion signal on disk: .planning/phases/<dir>/<id>-SUMMARY.md.
// gsd-core's execute updates the roadmap's "N/M plans executed" counters and the
// ## Progress table but does not tick the per-plan checklist — the SUMMARY file
// is the authoritative per-plan done marker (the same signal quick tasks use).
export async function parseExecutedPlanIds(planningDir) {
  const phasesDir = join(planningDir, 'phases');
  const ids = new Set();
  let dirs;
  try {
    dirs = (await readdir(phasesDir, { withFileTypes: true })).filter((e) => e.isDirectory());
  } catch {
    return ids;
  }
  for (const entry of dirs) {
    for (const f of await readdir(join(phasesDir, entry.name)).catch(() => [])) {
      const m = f.match(/^([\d.]+-\d+)-SUMMARY\.md$/);
      if (m) ids.add(m[1]);
    }
  }
  return ids;
}

// Full PLAN.md content per plan id (.planning/phases/<dir>/<id>-PLAN.md) —
// mirrored into the plan sub-issue description so the card carries the plan
// itself, not just the roadmap checklist line. Plans the plan-phase hasn't
// written to disk yet are simply absent from the map.
export async function parsePlanContents(planningDir) {
  const phasesDir = join(planningDir, 'phases');
  const contents = new Map(); // planId → {dir, content}
  let dirs;
  try {
    dirs = (await readdir(phasesDir, { withFileTypes: true })).filter((e) => e.isDirectory());
  } catch {
    return contents;
  }
  for (const entry of dirs) {
    for (const f of await readdir(join(phasesDir, entry.name)).catch(() => [])) {
      const m = f.match(/^([\d.]+-\d+)-PLAN\.md$/);
      if (!m) continue;
      const text = await readFile(join(phasesDir, entry.name, f), 'utf8').catch(() => '');
      if (text.trim()) contents.set(m[1], { dir: entry.name, content: text.trim() });
    }
  }
  return contents;
}

// --- PR ⇄ phase association, from the strongest signal to the weakest ---

// 1st (most robust): GSD commits the phase artifacts on the branch, so the PR
// diff contains `.planning/phases/<N-slug>/...`. Derives the phases from paths.
// (GitHub lists files alphabetically — `.planning/` comes first — so gh's
// ~100-files-per-PR cap never hides these paths.)
export function phaseKeysFromPRFiles(paths) {
  const keys = new Set();
  for (const p of paths) {
    const m = p.match(/^\.planning\/phases\/([\d.]+)-/);
    if (m) keys.add(m[1]);
  }
  return [...keys];
}

// 2nd: GSD's ship.md writes "Phase N shipped — PR #M" to STATE.md (and the free
// text accumulates variations like "Phase 50 MERGED (admin-next PR #51)"). The
// word right before "PR" becomes repoHint when present — PR numbers are PER
// REPO, so "shipping-api PR #48" only matches in the shipping-api repo.
export function phasePRPairsFromState(stateText) {
  const pairs = [];
  // Tempered lookahead: the span between "Phase N" and "PR #M" must not contain
  // another "Phase X" mention (otherwise prose with several phases on the same
  // line crosses the associations — e.g. "phase 53. PRs target … Phase 49 … (PR #47)").
  for (const m of (stateText ?? '').matchAll(/Phase\s+([\d.]+)(?:(?!Phase\s+[\d.])[^\n])*?(?:([\w-]+)\s+)?PR\s*#(\d+)/gi)) {
    const pair = { phase: m[1], prNumber: Number(m[3]) };
    if (m[2]) pair.repoHint = m[2];
    pairs.push(pair);
  }
  return pairs;
}

// 3rd (fallback): phase number in the branch ("feat/phase-68.3-...") or title
// ("Phase 41: cancelar entrega"). Null when the PR doesn't reference a phase.
export function phaseKeyFromPR(branch, title) {
  const m = `${branch} ${title}`.match(/\bphase[-_ ]?(\d+(?:\.\d+)*)\b/i);
  return m ? m[1] : null;
}

async function listOpenPRs(repoDir) {
  try {
    await access(join(repoDir, '.git'));
  } catch {
    return [];
  }
  const r = spawnSync('gh', ['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,url,files'], {
    cwd: repoDir, encoding: 'utf8', timeout: 8000,
  });
  if (r.status !== 0 || !r.stdout) return [];
  try {
    return JSON.parse(r.stdout);
  } catch {
    return [];
  }
}

// Sibling repos mentioned in the phases' **Repo:** fields (e.g. cross-repo
// phases pointing at `../acme-shipping-api`) — backend PRs open there.
export function siblingReposFromPhases(phases) {
  return [...new Set(
    phases.map((p) => p.repo).filter(Boolean)
      .flatMap((r) => [...r.matchAll(/\.\.\/[\w.-]+/g)].map((m) => m[0])),
  )];
}

// Open PRs attributable to phases → "Code Review" on the board (human PR
// review, not GSD's internal REVIEW.md). Covers the primary repo (where the
// .planning lives) and the sibling repos of cross-repo phases. A phase can
// accumulate more than one PR (one per repo). Degrades to empty per repo when
// it is not a git repo, gh is missing/logged out, or there is no remote.
export async function parseOpenPRs(projectDir, stateText = '', siblingDirs = []) {
  const statePairs = phasePRPairsFromState(stateText);
  const byPhase = new Map(); // phase → [{repo, number, title, url, branch}]
  const claim = (key, pr, repoName) => {
    if (!key) return;
    const arr = byPhase.get(key) ?? [];
    if (!arr.some((p) => p.repo === repoName && p.number === pr.number)) {
      arr.push({ repo: repoName, number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName });
      byPhase.set(key, arr);
    }
  };

  const primaryName = basename(resolve(projectDir));
  const primaryPRs = await listOpenPRs(projectDir);

  // signal 1: .planning/phases/ paths in the diff (only exists in the primary repo)
  for (const pr of primaryPRs) {
    for (const key of phaseKeysFromPRFiles((pr.files ?? []).map((f) => f.path))) claim(key, pr, primaryName);
  }
  // signal 2: STATE.md — no repoHint (or a matching hint) applies to the primary
  for (const { phase, prNumber, repoHint } of statePairs) {
    if (repoHint && !primaryName.includes(repoHint)) continue;
    if (byPhase.has(phase)) continue;
    const pr = primaryPRs.find((p) => p.number === prNumber);
    if (pr) claim(phase, pr, primaryName);
  }
  // signal 3: fallback by branch/title (only for phases still without a PR)
  for (const pr of primaryPRs) {
    const key = phaseKeyFromPR(pr.headRefName ?? '', pr.title ?? '');
    if (key && !byPhase.has(key)) claim(key, pr, primaryName);
  }

  for (const dir of siblingDirs) {
    const name = basename(resolve(dir));
    const prs = await listOpenPRs(dir);
    if (!prs.length) continue;
    // signal 2 with repoHint matching the sibling (PR numbers are per repo)
    for (const { phase, prNumber, repoHint } of statePairs) {
      if (!repoHint || !name.includes(repoHint)) continue;
      const pr = prs.find((p) => p.number === prNumber);
      if (pr) claim(phase, pr, name);
    }
    // signal 3 by branch/title
    for (const pr of prs) claim(phaseKeyFromPR(pr.headRefName ?? '', pr.title ?? ''), pr, name);
    // signal 4 (siblings only): same branch as an already-associated primary PR —
    // cross-repo GSD uses the SAME branch name in both repos
    for (const [key, arr] of byPhase) {
      for (const p of [...arr]) {
        if (p.repo !== primaryName) continue;
        const match = prs.find((x) => x.headRefName === p.branch);
        if (match) claim(key, match, name);
      }
    }
  }
  return byPhase;
}

// Debug sessions (.planning/debug/) → bugs on the board. Accepts loose .md
// files (format observed in a real project) and session directories (gsd-debug
// doc) containing .md files. Frontmatter: status/trigger/created.
// gsd-core moves finished sessions to debug/resolved/ — each file there is its
// own session (same key as when it was active, so the marker/issue is reused)
// and counts as resolved regardless of the frontmatter status.
export async function parseDebugSessions(planningDir) {
  const debugDir = join(planningDir, 'debug');
  let entries;
  try {
    entries = await readdir(debugDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions = [];
  const readSession = async (file, key, relFile, resolvedDir = false) => {
    const text = await readFile(file, 'utf8').catch(() => '');
    const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const trigger = fm.match(/^trigger:\s*"?(.+?)"?\s*$/m)?.[1] ?? null;
    sessions.push({
      key,
      status: frontmatterStatus(text) ?? (resolvedDir ? 'resolved' : 'open'),
      resolvedDir,
      trigger,
      title: trigger ?? key.replace(/-/g, ' '),
      created: fm.match(/^created:\s*(\S+)/m)?.[1] ?? null,
      symptoms: parseSymptoms(text),
      file: relFile,
    });
  };

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const key = basename(entry.name, '.md');
      await readSession(join(debugDir, entry.name), key, `debug/${entry.name}`);
    } else if (entry.isDirectory() && entry.name === 'resolved') {
      const inner = (await readdir(join(debugDir, 'resolved')).catch(() => []))
        .filter((f) => f.endsWith('.md')).sort();
      for (const f of inner) {
        await readSession(join(debugDir, 'resolved', f), basename(f, '.md'), `debug/resolved/${f}`, true);
      }
    } else if (entry.isDirectory()) {
      const inner = (await readdir(join(debugDir, entry.name)).catch(() => []))
        .filter((f) => f.endsWith('.md')).sort()[0];
      if (!inner) continue;
      await readSession(join(debugDir, entry.name, inner), entry.name, `debug/${entry.name}/${inner}`);
    }
  }
  return sessions;
}

// .planning/todos/{pending,resolved}/<file>.md: title/created frontmatter +
// body. `resolved/` is the bidirectional pull's counterpart: a todo completed
// in Linear moves the file from pending/ to resolved/ (leaves GSD's backlog
// without losing the record).
export async function parsePendingTodos(planningDir) {
  const todos = [];
  for (const [subdir, resolved] of [['pending', false], ['resolved', true]]) {
    const dir = join(planningDir, 'todos', subdir);
    let files;
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      const text = await readFile(join(dir, file), 'utf8').catch(() => '');
      const title = text.match(/^title:\s*(.+)$/m)?.[1]?.trim()
        ?? basename(file, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-/g, ' ');
      const created = text.match(/^created:\s*(\S+)/m)?.[1] ?? null;
      const body = text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
      todos.push({
        key: basename(file, '.md'),
        title,
        created,
        excerpt: body.length > 1200 ? `${body.slice(0, 1200)}…` : body,
        sections: parseSections(body),
        file: `todos/${subdir}/${file}`,
        resolved,
      });
    }
  }
  return todos;
}
