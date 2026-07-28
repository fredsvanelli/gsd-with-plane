// planner-sync: the overlay layer between GSD's .planning/ and the Plane board.
//
// Problem it solves: the board is ALSO edited by hand (cards dragged into
// custom columns, titles tweaked, labels/assignees/dates/comments added) and
// most of that has no 1:1 representative in GSD — so a plain push used to
// clobber it. This layer is the n:n link table, kept as text files inside
// .planning/planner-sync/ so both humans and GSD planning agents can read it:
//
//   board.json — machine state, one entry per linked pair:
//     base      = the gsd-managed fields (title/stateType/labels) as of the
//                 last push — the merge base of a per-field three-way merge.
//     overrides = board-side divergences from base (title, column, labels).
//                 The push RESPECTS these (omits the field / merges labels);
//                 they are only dropped when GSD itself changed that same
//                 field since base ("GSD wins on its own edits"), with a report.
//     board     = board-only metadata gsd never writes (assignees, priority,
//                 dates, comments) — captured for visibility, never pushed.
//   BOARD.md   — human/agent digest regenerated on every pull; lives inside
//                .planning/ so /gsd-plan-phase & friends pick it up naturally.
//
// Ownership rules encoded here:
//   - GSD owns: body/description, lifecycle state transitions it derives from
//     files, and any field it changed since the last push.
//   - Board owns: everything the user touched on the board that GSD did NOT
//     change meanwhile — plus fields GSD never manages at all.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const SYNC_DIR = 'planner-sync';
const BOARD_JSON = 'board.json';
const BOARD_MD = 'BOARD.md';

export async function loadBoard(planningDir) {
  try {
    const board = JSON.parse(await readFile(join(planningDir, SYNC_DIR, BOARD_JSON), 'utf8'));
    board.items ??= {};
    return board;
  } catch {
    return { version: 1, project: null, items: {}, foreignSubItems: [], customColumns: [] };
  }
}

export async function saveBoard(planningDir, board) {
  const dir = join(planningDir, SYNC_DIR);
  await mkdir(dir, { recursive: true });
  board.updatedAt = new Date().toISOString();
  // Stable key order → clean git diffs (the file is meant to be committed).
  const sorted = Object.fromEntries(Object.entries(board.items).sort(([a], [b]) => a.localeCompare(b)));
  board.items = sorted;
  await writeFile(join(dir, BOARD_JSON), `${JSON.stringify(board, null, 2)}\n`);
  await writeFile(join(dir, BOARD_MD), renderBoardMd(board));
}

export function ensureItem(board, kind, key) {
  return (board.items[`${kind}:${key}`] ??= {});
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

// ---------- push side ----------
//
// Decides, per field, whether the push sends the gsd value or leaves the
// board's. Pure: returns instructions + reports; the caller applies `clears`
// to the entry only after the API op succeeds.
export function mergePushFields(entry, item) {
  const base = entry?.base ?? null;
  const ov = entry?.overrides ?? {};
  const desiredLabels = item.labels ?? [];
  const out = { omitName: false, omitState: false, labelNames: desiredLabels, clears: {}, reports: [] };

  if (ov.title != null) {
    if (base && item.title !== base.title) {
      out.clears.title = true;
      out.reports.push(`${item.key}: GSD renamed the item — board title override "${ov.title}" dropped`);
    } else {
      out.omitName = true;
    }
  }

  if (ov.state != null) {
    if (base && item.stateType !== base.stateType) {
      out.clears.state = true;
      out.reports.push(`${item.key}: GSD state changed (${base.stateType} → ${item.stateType}) — board column "${ov.state.name}" released`);
    } else {
      out.omitState = true;
    }
  }

  const removed = ov.removedLabels ?? [];
  const extra = ov.extraLabels ?? [];
  if (removed.length || extra.length) {
    const kept = desiredLabels.filter((l) => !removed.includes(l));
    out.labelNames = [...kept, ...extra.filter((l) => !kept.includes(l))];
  }

  return out;
}

export function applyPushClears(entry, clears) {
  if (!entry?.overrides) return;
  if (clears.title) delete entry.overrides.title;
  if (clears.state) delete entry.overrides.state;
  if (!Object.keys(entry.overrides).length) delete entry.overrides;
}

// Records the merge base after a successful push (or a hash-match skip, which
// proves board == desired for the gsd-managed fields as of the last push).
export function recordBase(entry, item) {
  entry.base = { title: item.title, stateType: item.stateType, labels: item.labels ?? [] };
}

// ---------- pull side (capture) ----------
//
// view = what the board says right now:
//   { issueId, identifier, title, stateId, stateName, stateGroup,
//     labelNames, assignees, priority, targetDate, startDate, updatedAt }
// item = the gsd desired item.
// opts:
//   flipTo         — set when the pull is APPLYING a done/reopen flip from the
//                    board: the local stateType is about to become this value,
//                    so the base follows (the convergence push must not read
//                    the flip as a gsd-side change and yank the card out of
//                    its column).
//   canonicalIdFor — stateType → state id gsd itself would use (null when the
//                    column does not exist yet).
// Mutates entry; returns human report lines (only for override changes —
// metadata capture is silent).
export function captureFromBoard(entry, item, view, { flipTo = null, canonicalIdFor = () => null } = {}) {
  const reports = [];
  entry.issueId = view.issueId;
  entry.identifier = view.identifier;
  entry.base ??= { title: item.title, stateType: item.stateType, labels: item.labels ?? [] };
  const ov = (entry.overrides ??= {});
  const tag = `${view.identifier}`;

  if (view.title !== entry.base.title) {
    if (ov.title !== view.title) {
      ov.title = view.title;
      reports.push(`${tag}: board title kept — "${view.title}"`);
    }
  } else if (ov.title != null) {
    delete ov.title;
    reports.push(`${tag}: board title matches GSD again — title override cleared`);
  }

  if (flipTo) entry.base.stateType = flipTo;
  // Column override: only when the BOARD moved the card — i.e. it sits in a
  // column that is neither where gsd last put it (base) nor where gsd wants it
  // now. A pending gsd-side state change (base ≠ desired, board still at base)
  // is NOT an override; the push moves the card.
  const expectedId = canonicalIdFor(flipTo ?? item.stateType);
  const baseId = canonicalIdFor(entry.base.stateType);
  if (expectedId && baseId && view.stateId !== expectedId && view.stateId !== baseId) {
    if (ov.state?.id !== view.stateId) {
      ov.state = { id: view.stateId, name: view.stateName, group: view.stateGroup };
      reports.push(`${tag}: board column kept — "${view.stateName}"`);
    }
  } else if (ov.state != null && view.stateId !== ov.state.id) {
    delete ov.state;
    reports.push(`${tag}: card back in a GSD column — column override cleared`);
  }

  const baseLabels = entry.base.labels ?? [];
  const extra = view.labelNames.filter((l) => !baseLabels.includes(l));
  const removed = baseLabels.filter((l) => !view.labelNames.includes(l));
  if (extra.length) {
    if (!sameSet(ov.extraLabels ?? [], extra)) {
      ov.extraLabels = extra;
      reports.push(`${tag}: board labels kept — ${extra.join(', ')}`);
    }
  } else if (ov.extraLabels) delete ov.extraLabels;
  if (removed.length) ov.removedLabels = removed;
  else if (ov.removedLabels) delete ov.removedLabels;

  if (!Object.keys(ov).length) delete entry.overrides;

  entry.board = {
    ...(entry.board ?? {}),
    assignees: view.assignees ?? [],
    priority: view.priority ?? null,
    targetDate: view.targetDate ?? null,
    startDate: view.startDate ?? null,
    updatedAt: view.updatedAt ?? null,
  };
  return reports;
}

// ---------- BOARD.md ----------

const describeOverrides = (e) => {
  const o = e.overrides ?? {};
  const parts = [];
  if (o.title != null) parts.push(`title: "${o.title}"`);
  if (o.state) parts.push(`column: "${o.state.name}" (${o.state.group})`);
  if (o.extraLabels?.length) parts.push(`labels added: ${o.extraLabels.join(', ')}`);
  if (o.removedLabels?.length) parts.push(`labels removed: ${o.removedLabels.join(', ')}`);
  return parts;
};

const hasMetadata = (b) => b && (b.assignees?.length || b.priority && b.priority !== 'none'
  || b.targetDate || b.startDate || b.comments?.count);

export function renderBoardMd(board) {
  const lines = [
    '# Plane board overlay',
    '',
    '> Auto-generated by gsd-with-plane on every pull — do not edit by hand',
    '> (to drop an override, remove it from `board.json` or revert the card on the board).',
    '> These are BOARD-SIDE decisions layered on top of `.planning/`: the sync',
    '> preserves them, and planning commands (`/gsd-plan-phase`, `/gsd-discuss-phase`)',
    '> should treat them as user input — assignees, deadlines, priorities, renamed',
    '> cards, custom columns and comments made directly in Plane.',
    '',
  ];
  if (board.project) lines.push(`Project: **${board.project.name}** (${board.project.identifier}) · updated ${board.updatedAt ?? '—'}`, '');

  const entries = Object.entries(board.items ?? {});
  const withOv = entries.filter(([, e]) => e.overrides && Object.keys(e.overrides).length);
  lines.push('## Overrides (board wins over the next push)', '');
  if (withOv.length) {
    lines.push('| GSD item | Card | Override |', '| --- | --- | --- |');
    for (const [key, e] of withOv) {
      lines.push(`| \`${key}\` | ${e.identifier ?? '?'} | ${describeOverrides(e).join(' · ')} |`);
    }
  } else lines.push('_None — the board matches `.planning/` for every gsd-managed field._');
  lines.push('');

  const withMeta = entries.filter(([, e]) => hasMetadata(e.board));
  lines.push('## Board metadata (never pushed — assignees, dates, priority, comments)', '');
  if (withMeta.length) {
    for (const [key, e] of withMeta) {
      const b = e.board;
      lines.push(`### \`${key}\` — ${e.identifier ?? '?'}`);
      if (b.assignees?.length) lines.push(`- Assignees: ${b.assignees.join(', ')}`);
      const facts = [
        b.priority && b.priority !== 'none' ? `Priority: ${b.priority}` : null,
        b.targetDate ? `Due: ${b.targetDate}` : null,
        b.startDate ? `Start: ${b.startDate}` : null,
      ].filter(Boolean);
      if (facts.length) lines.push(`- ${facts.join(' · ')}`);
      if (b.comments?.count) {
        lines.push(`- Comments (${b.comments.count})${b.comments.last?.length ? ', latest:' : ''}`);
        for (const c of b.comments.last ?? []) {
          lines.push(`  - ${c.by} (${(c.at ?? '').slice(0, 10)}): ${c.text}`);
        }
      }
      lines.push('');
    }
  } else lines.push('_None captured yet._', '');

  if (board.foreignSubItems?.length) {
    lines.push('## Sub-items created on the board (no GSD counterpart)', '');
    for (const f of board.foreignSubItems) {
      lines.push(`- ${f.identifier} "${f.title}"${f.parent ? ` under \`${f.parent}\`` : ''}${f.state ? ` · ${f.state}` : ''}`);
    }
    lines.push('');
  }

  if (board.customColumns?.length) {
    lines.push('## Custom columns (created on the board)', '');
    for (const c of board.customColumns) lines.push(`- ${c.name} (group: ${c.group})`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}
