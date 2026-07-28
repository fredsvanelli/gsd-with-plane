// Helpers shared between push (sync-roadmap) and pull (pull-plane).
// CRITICAL: marker and hash must be identical in both directions — the
// conflict policy ("Plane wins only if local hasn't changed since the last
// push") compares the marker hash against the hash of the current local state.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// .env (and .env.local as fallback) from the current directory — no dependencies.
// Precedence: already-set env > .env > .env.local (??= never overwrites earlier values).
export async function loadEnv() {
  for (const envFile of ['.env', '.env.local']) {
    try {
      for (const line of (await readFile(envFile, 'utf8')).split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) process.env[m[1]] ??= m[2];
      }
    } catch { /* file missing — try the next one */ }
  }
}

// The marker travels as plain text in project/module descriptions (backticks
// survive) and as <code>gsd-sync:…</code> inside issue description_html —
// Plane sanitizes/normalizes the HTML server-side, so the regex anchors on the
// gsd-sync payload itself and treats backticks/tags as optional decoration.
export const MARKER_RE = /gsd-sync:(project|milestone|phase|plan|quick|todo|debug)(?:=([^:`<\s&]+))?:h=([a-f0-9]+)/;

// Sentinel hash used when ADOPTING an issue created in Plane: it never matches
// a real hash, so the next push normalizes the issue (title/labels/description).
export const ADOPTED_HASH = '000000000000';

export function marker(kind, key, hash) {
  return key ? `\`gsd-sync:${kind}=${key}:h=${hash}\`` : `\`gsd-sync:${kind}:h=${hash}\``;
}

export function parseMarker(text) {
  const m = (text ?? '').match(MARKER_RE);
  return m ? { kind: m[1], key: m[2] ?? null, hash: m[3] } : null;
}

export function contentHash(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 12);
}

// Hash of a desired issue (phase/plan/quick/todo) — the SAME shape used by the
// push to decide skip/update and recorded in the marker.
export function issueHash(item) {
  return contentHash({
    title: item.title,
    body: item.body,
    stateType: item.stateType,
    milestoneKey: item.milestoneKey,
    labels: item.labels ?? [],
    phaseKey: item.phaseKey ?? null,
  });
}

export function truncateTitle(title, max = 220) {
  return title.length <= max ? title : `${title.slice(0, max - 1)}…`;
}

// GSD status → Plane state group. Plane's built-in groups are literally
// backlog | unstarted | started | completed | cancelled, so the internal
// "stateType" vocabulary maps 1:1 (only "cancelled" is spelled differently
// from Linear's "canceled").
export const STATUS_TO_STATE_TYPE = {
  done: 'completed',
  in_progress: 'started',
  todo: 'unstarted',
};

// Named states of the agile flow (columns between In Progress and Done),
// created by the push on demand. Shared with the pull: the planner-sync
// capture needs "which column WOULD gsd put this card in" to tell a manual
// column move apart from gsd's own placement.
export const NAMED_STATES = {
  code_review: { name: 'Code Review', color: '#f2c94c' },
  ready_to_ship: { name: 'Ready to ship', color: '#4cb782' },
  uat: { name: 'UAT', color: '#9b51e0' },
};
export const NAMED_ORDER = ['uat', 'ready_to_ship', 'code_review'];

// The state (column) gsd itself would choose for a stateType: the named
// column when the stateType is one of the agile stages, otherwise the
// canonical (lowest-sequence) state of the group. Returns null when the
// column does not exist yet (push creates named states lazily).
export function canonicalStateFor(states, stateType) {
  const named = NAMED_STATES[stateType];
  if (named) return states.find((s) => s.name === named.name) ?? null;
  const group = states.filter((s) => s.group === stateType)
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  return group[0] ?? null;
}

// Binding created by /gsd-with-plane:init:
// {workspaceSlug, projectId, projectName}. Read from the current directory
// (GSD project root). Missing → {} and the scripts fall back to the default
// behavior (slug from the environment; project by marker/name).
export async function loadSyncConfig() {
  try {
    return JSON.parse(await readFile('.gsd-plane.json', 'utf8'));
  } catch {
    return {};
  }
}
