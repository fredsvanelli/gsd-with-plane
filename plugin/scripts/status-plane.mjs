// Status of the GSD ↔ Plane integration for the project in cwd — used by
// /gsd-with-plane:status. Read-only (the push/pull dry-runs mutate nothing).
//
// Usage: node plugin/scripts/status-plane.mjs   (cwd = GSD project root)

import { readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PlaneClient } from './plane-client.mjs';
import { loadEnv, loadSyncConfig, parseMarker } from './common.mjs';
import { parseRoadmap } from './parse-roadmap.mjs';

const exists = (p) => access(p).then(() => true, () => false);
const scriptsDir = fileURLToPath(new URL('.', import.meta.url));

// --- credential (detect the source before loadEnv fills the env) ---
const envHadKey = Boolean(process.env.PLANE_API_KEY);
await loadEnv();
let credSource = null;
if (envHadKey) credSource = 'environment';
else if (process.env.PLANE_API_KEY) {
  for (const f of ['.env', '.env.local']) {
    if (await exists(f) && (await readFile(f, 'utf8')).includes('PLANE_API_KEY')) { credSource = f; break; }
  }
}

if (!await exists('.planning/ROADMAP.md')) {
  console.log('✗ This directory has no .planning/ROADMAP.md — not a GSD project.');
  process.exit(1);
}
if (!process.env.PLANE_API_KEY) {
  console.log('✗ PLANE_API_KEY missing (environment, .env or .env.local). Run /gsd-with-plane:init.');
  process.exit(1);
}

const roadmap = parseRoadmap(await readFile('.planning/ROADMAP.md', 'utf8'));
const config = await loadSyncConfig();
const workspaceSlug = config.workspaceSlug ?? process.env.PLANE_WORKSPACE_SLUG ?? null;

console.log(`# gsd-with-plane status — ${process.cwd()}`);
console.log('');
console.log(`Credential: ✓ PLANE_API_KEY via ${credSource ?? 'environment'}`);
console.log(`Host: ${process.env.PLANE_API_HOST_URL ?? process.env.PLANE_BASE_URL ?? 'http://localhost'} (PLANE_API_HOST_URL)`);
console.log(`Binding (.gsd-plane.json): ${config.projectId
  ? `✓ projectId=${String(config.projectId).slice(0, 8)}… workspace=${workspaceSlug ?? '(missing!)'}`
  : (workspaceSlug ? `partial (only workspace=${workspaceSlug})` : '— (no workspace slug — run /gsd-with-plane:init)')}`);

if (!workspaceSlug) process.exit(0);

// --- Plane project (same precedence as the sync scripts) ---
const client = new PlaneClient({
  apiKey: process.env.PLANE_API_KEY,
  baseUrl: process.env.PLANE_API_HOST_URL ?? process.env.PLANE_BASE_URL,
  workspaceSlug,
});
const projects = await client.listProjects().catch((e) => ({ error: e.message }));
if (projects.error) {
  console.log(`Workspace: ✗ ${projects.error}`);
  process.exit(0);
}
console.log(`Workspace: ✓ ${workspaceSlug} (${projects.length} projects)`);
const project = (config.projectId ? projects.find((p) => p.id === config.projectId) : null)
  ?? projects.find((p) => parseMarker(p.description)?.kind === 'project')
  ?? projects.find((p) => p.name === roadmap.title)
  ?? null;

if (!project) {
  console.log('Project: ✗ NOT CONNECTED — no Plane project matches (run /gsd-with-plane:init).');
  process.exit(0);
}

console.log(`Project: ✓ "${project.name}" (${project.identifier})`);
console.log(`Link: ${client.projectUrl(project.id)}`);

// --- board composition ---
const issues = await client.listProjectIssues(project.id);
const byKind = { phase: 0, plan: 0, quick: 0, todo: 0, debug: 0 };
let foreign = 0;
for (const i of issues) {
  const mk = parseMarker(i.description_html);
  if (mk && mk.kind in byKind) byKind[mk.kind]++;
  else foreign++;
}
console.log('');
console.log(`Board: ${issues.length} work items — ${byKind.phase} phases · ${byKind.plan} plans · ${byKind.quick} quick · ${byKind.todo} todos · ${byKind.debug} bugs${foreign ? ` · ${foreign} foreign (no marker)` : ''}`);

// --- planner-sync overlay (.planning/planner-sync/) ---
const overlay = JSON.parse(await readFile('.planning/planner-sync/board.json', 'utf8').catch(() => 'null'));
if (overlay?.items) {
  const entries = Object.values(overlay.items);
  const nOverrides = entries.filter((e) => e.overrides && Object.keys(e.overrides).length).length;
  const nMeta = entries.filter((e) => e.board && (e.board.assignees?.length
    || (e.board.priority && e.board.priority !== 'none') || e.board.targetDate || e.board.comments?.count)).length;
  console.log(`Overlay (planner-sync): ${entries.length} linked items · ${nOverrides} board overrides · `
    + `${nMeta} with board metadata${overlay.foreignSubItems?.length ? ` · ${overlay.foreignSubItems.length} foreign sub-items` : ''}`
    + ` — see .planning/planner-sync/BOARD.md`);
} else {
  console.log('Overlay (planner-sync): not materialized yet (created on the first pull/push with this version).');
}

// --- in sync? (dry-runs, read-only) ---
const run = (script) => {
  const r = spawnSync(process.execPath, [scriptsDir + script], { encoding: 'utf8' });
  return (r.stdout ?? '') + (r.stderr ?? '');
};
const pushOut = run('sync-roadmap.mjs');
const pullOut = run('pull-plane.mjs');
const pushOps = pushOut.match(/Operations: (\d+)/)?.[1] ?? '?';
const pullActs = pullOut.match(/Pull: (\d+) actions/)?.[1] ?? '?';
const orphanLine = pushOut.split('\n').find((l) => l.includes('Orphans'));
const warnLines = pullOut.split('\n').filter((l) => l.trim().startsWith('⚠️'));
const actLines = pullOut.split('\n').filter((l) => l.trim().startsWith('←'));

const inSync = pushOps === '0' && pullActs === '0';
console.log(`In sync: ${inSync ? '✓ YES (0 pending items in either direction)' : '✗ NO'}`);
if (pushOps !== '0') console.log(`  pending push: ${pushOps} operations (local → Plane)`);
if (pullActs !== '0') {
  console.log(`  pending pull: ${pullActs} actions (Plane → local)`);
  for (const l of actLines) console.log(`  ${l.trim()}`);
}
for (const l of warnLines) console.log(`  ${l.trim()}`);
if (orphanLine) console.log(`  ${orphanLine.trim()}`);

// --- last sync attempt (runner log) ---
const home = process.env.HOME;
const log = await readFile(`${home}/.cache/gsd-with-plane/sync.log`, 'utf8').catch(() => '');
const blocks = log.split(/^(?=--- )/m).filter((b) => b.includes(`(${process.cwd()})`));
console.log('');
if (blocks.length) {
  const last = blocks[blocks.length - 1];
  const when = last.match(/^--- ([\d-]+ [\d:]+)/)?.[1];
  const failed = /FAILED/.test(last) || last.includes('✗');
  const applied = [...last.matchAll(/Completed: (\d+)\/(\d+)/g)].map((m) => `${m[1]}/${m[2]}`);
  console.log(`Last sync attempt (runner): ${when} — ${failed ? '✗ FAILED' : `✓ ok${applied.length ? ` (${applied.join(' + ')} operations)` : ''}`}`);
} else {
  console.log('Last sync attempt (runner): none recorded for this project.');
}

// --- automation ---
const reg = await readFile(`${home}/.cache/gsd-with-plane/projects.txt`, 'utf8').catch(() => '');
const inRegistry = reg.split('\n').includes(process.cwd());

// Background polling agent: launchd (macOS) or systemd timer / cron (Linux) —
// installed by setup-automation.sh (run by /gsd-with-plane:init).
let pollStatus;
let pollLog = 'launchd.log';
if (process.platform === 'darwin') {
  const launchdLine = (spawnSync('launchctl', ['list'], { encoding: 'utf8' }).stdout ?? '')
    .split('\n').find((l) => l.includes('com.gsd-with-plane.pull'));
  const lastExit = launchdLine?.split('\t')[1];
  pollStatus = !launchdLine
    ? '✗ launchd not loaded (run /gsd-with-plane:init)'
    : lastExit && lastExit !== '0' && lastExit !== '-'
      ? `✗ launchd loaded but last run FAILED (exit ${lastExit} — see launchd.log)`
      : '✓ launchd active';
} else {
  const timer = (spawnSync('systemctl', ['--user', 'is-active', 'gsd-with-plane-pull.timer'],
    { encoding: 'utf8' }).stdout ?? '').trim();
  const cron = (spawnSync('crontab', ['-l'], { encoding: 'utf8' }).stdout ?? '')
    .includes('gsd-with-plane');
  if (timer === 'active') { pollStatus = '✓ systemd timer active'; pollLog = 'systemd.log'; }
  else if (cron) { pollStatus = '✓ cron entry active'; pollLog = 'cron.log'; }
  else pollStatus = '✗ background polling not installed (run /gsd-with-plane:init)';
}
console.log(`Automation: local+session hook via plugin · 5min polling: ${pollStatus} · registry: ${inRegistry ? '✓ this project' : '✗ project not in projects.txt'}`);

// --- webhook mode (realtime Plane → local) ---
const cacheDir = process.env.GSD_PLANE_CACHE_DIR ?? `${home}/.cache/gsd-with-plane`;
const syncMode = config.syncMode === 'webhook' ? 'webhook' : 'polling';
if (syncMode === 'webhook') {
  const whConfig = JSON.parse(await readFile(`${cacheDir}/webhook.json`, 'utf8').catch(() => '{}'));
  const port = whConfig.port ?? 8787;
  const safetyMin = whConfig.safetyPollMinutes ?? 30;
  const health = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.json()).catch(() => null);
  const heartbeat = (await readFile(`${cacheDir}/webhook-last-event`, 'utf8').catch(() => '')).trim();
  const lastEvent = heartbeat ? new Date(heartbeat) : null;
  const ageMin = lastEvent ? Math.round((Date.now() - lastEvent.getTime()) / 60000) : null;

  console.log(`Sync mode: webhook (realtime) · safety poll every ${safetyMin}min`);
  console.log(`Receiver: ${health
    ? `✓ up on port ${port} (${health.received} received · ${health.triggered} syncs · ${health.rejected} rejected, since ${health.startedAt})`
    : `✗ NOT RUNNING on port ${port} — run /gsd-with-plane:webhook enable (log: webhook-server.log)`}`);
  console.log(`Last webhook event: ${lastEvent ? `${heartbeat} (${ageMin}min ago)` : 'never received'}`);
  // Plane flips a webhook to inactive after 5 failed deliveries and there is
  // no public API to re-enable it — if the board drifted but no event arrived,
  // the webhook is very likely dead on Plane's side.
  if (pullActs !== '0' && pullActs !== '?' && (!lastEvent || ageMin > safetyMin)) {
    console.log('  ⚠️ pending board changes but no recent webhook delivery — Plane may have '
      + 'DEACTIVATED the webhook (it does so silently after 5 failed deliveries). '
      + 'Re-enable it in Plane: Workspace Settings → Webhooks.');
  }
} else {
  console.log('Sync mode: polling (default) — /gsd-with-plane:webhook enable switches to realtime.');
}
console.log(`Logs: ~/.cache/gsd-with-plane/sync.log · ${pollLog}${syncMode === 'webhook' ? ' · webhook-server.log' : ''}`);
