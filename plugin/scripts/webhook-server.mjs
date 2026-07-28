// Webhook receiver daemon (realtime Plane → local): listens for Plane's
// workspace webhooks and triggers the same coalesced pull→push cycle the
// polling runner uses. Managed by setup-automation.sh --mode webhook
// (launchd KeepAlive on macOS, systemd user service on Linux).
//
// Endpoints:
//   POST /hook/<workspaceSlug>  — Plane delivery (HMAC-SHA256 verified)
//   GET  /healthz               — status JSON for status-plane.mjs
//
// Config (~/.cache/gsd-with-plane/webhook.json, chmod 600 — created by
// /gsd-with-plane:init):
//   { "port": 8787, "bind": "0.0.0.0", "safetyPollMinutes": 30,
//     "workspaces": { "<slug>": { "secret": "plane_wh_..." } } }
//
// Plane-side contract (verified against plane-api 1.3.1 source,
// bgtasks/webhook_task.py): payload {event, action, webhook_id, workspace_id,
// data, activity}; headers X-Plane-Event, X-Plane-Delivery (uuid),
// X-Plane-Signature = HMAC-SHA256 hex of the raw request body with the
// webhook's secret_key. Plane retries failed deliveries 5x and then flips the
// webhook to inactive — so this server ALWAYS answers 200 fast and does the
// sync work after responding.

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, stat, appendFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

export const CACHE_DIR = process.env.GSD_PLANE_CACHE_DIR
  ?? join(process.env.HOME ?? '', '.cache', 'gsd-with-plane');
const CONFIG_FILE = join(CACHE_DIR, 'webhook.json');
const REGISTRY_FILE = join(CACHE_DIR, 'projects.txt');
const HEARTBEAT_FILE = join(CACHE_DIR, 'webhook-last-event');
const STAMPS_DIR = join(CACHE_DIR, 'stamps');

const MAX_BODY = 5 * 1024 * 1024;
const RELEVANT_EVENTS = new Set(['issue', 'module', 'project', 'issue_comment']);
const COMMENT_HINTS_FILE = join(CACHE_DIR, 'comment-refresh');

export function loadConfigSync(raw) {
  const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    port: cfg.port ?? 8787,
    bind: cfg.bind ?? '0.0.0.0',
    safetyPollMinutes: cfg.safetyPollMinutes ?? 30,
    workspaces: cfg.workspaces ?? {},
  };
}

// mtime-cached readers — deliveries arrive in bursts during a push echo, so
// each request must not re-read config/bindings from disk unconditionally.
function cached(loader, ttlMs = 5000) {
  let value = null;
  let at = 0;
  return async () => {
    if (Date.now() - at > ttlMs) { value = await loader(); at = Date.now(); }
    return value;
  };
}

const getConfig = cached(async () => loadConfigSync(await readFile(CONFIG_FILE, 'utf8')));

// Registry (projects.txt) → [{dir, workspaceSlug, projectId, syncMode}] for
// the projects that opted into webhook mode via .gsd-plane.json.
const getBindings = cached(async () => {
  const reg = await readFile(REGISTRY_FILE, 'utf8').catch(() => '');
  const out = [];
  for (const dir of reg.split('\n').map((l) => l.trim()).filter(Boolean)) {
    try {
      const b = JSON.parse(await readFile(join(dir, '.gsd-plane.json'), 'utf8'));
      if (b.syncMode === 'webhook') out.push({ dir, ...b });
    } catch { /* unreadable binding — project handled by polling only */ }
  }
  return out;
});

export function verifySignature(secret, rawBody, signatureHex) {
  if (!secret || !signatureHex) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let got;
  try { got = Buffer.from(signatureHex, 'hex'); } catch { return false; }
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// Which registered project dirs does this delivery concern? Issue/module
// payloads carry the project id; project events carry it as data.id; delete
// payloads can be partial — when no id is extractable, fan out to every
// webhook-mode project of the workspace (the sync is idempotent and coalesced,
// over-triggering is harmless).
export function matchProjects(bindings, workspaceSlug, event, data) {
  const scoped = bindings.filter((b) => b.workspaceSlug === workspaceSlug);
  const projectId = event === 'project' ? data?.id : (data?.project ?? data?.project_id);
  if (!projectId) return scoped;
  return scoped.filter((b) => !b.projectId || b.projectId === projectId);
}

export function stampName(dir) {
  return dir.replace(/[^A-Za-z0-9]/g, '_');
}

// Trigger the coalesced pull→push runner (planning-sync.sh) exactly like the
// polling runner does, and freshen the project's poll stamp so the safety-net
// poll (pull-registry.sh) skips its next pass.
async function triggerSync(dir) {
  await mkdir(STAMPS_DIR, { recursive: true });
  await writeFile(join(STAMPS_DIR, `${stampName(dir)}.stamp`), String(Date.now()));
  const hook = process.env.GSD_PLANE_SYNC_HOOK
    ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'planning-sync.sh');
  const child = spawn('bash', [hook], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  child.stdin.end(JSON.stringify({ tool_input: { file_path: join(dir, '.planning', 'ROADMAP.md') } }));
  child.unref();
}

const state = {
  startedAt: new Date().toISOString(),
  lastEventAt: null,
  received: 0,
  triggered: 0,
  rejected: 0,
  seen: new Set(), // X-Plane-Delivery LRU — Plane retries re-send the same id
};

function remember(deliveryId) {
  if (!deliveryId) return false;
  if (state.seen.has(deliveryId)) return true;
  state.seen.add(deliveryId);
  if (state.seen.size > 500) state.seen.delete(state.seen.values().next().value);
  return false;
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function handleDelivery(slug, headers, rawBody, res) {
  const config = await getConfig().catch(() => null);
  const secret = config?.workspaces?.[slug]?.secret;
  if (!secret) {
    res.writeHead(404).end('unknown workspace');
    state.rejected++;
    return log(`404 unknown workspace "${slug}"`);
  }
  if (!verifySignature(secret, rawBody, headers['x-plane-signature'])) {
    res.writeHead(401).end('bad signature');
    state.rejected++;
    return log(`401 bad signature (workspace ${slug}, event ${headers['x-plane-event'] ?? '?'})`);
  }

  // Answer BEFORE doing any work — a slow response counts as a failed
  // delivery on Plane's side and 5 failures deactivate the webhook.
  res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');

  state.received++;
  state.lastEventAt = new Date().toISOString();
  writeFile(HEARTBEAT_FILE, state.lastEventAt).catch(() => {});

  if (remember(headers['x-plane-delivery'])) return; // retry duplicate

  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return; }
  const event = payload.event ?? headers['x-plane-event'];
  if (!RELEVANT_EVENTS.has(event)) return;

  // issue_comment: leave a refresh hint so the pull re-fetches this issue's
  // comments (commenting alone may not bump the issue's updated_at, which is
  // what the pull's lazy comment refresh keys on).
  if (event === 'issue_comment' && payload.data?.issue) {
    await mkdir(CACHE_DIR, { recursive: true }).catch(() => {});
    await appendFile(COMMENT_HINTS_FILE, `${payload.data.issue}\n`).catch(() => {});
  }

  const bindings = await getBindings();
  const targets = matchProjects(bindings, slug, event, payload.data);
  for (const t of targets) {
    state.triggered++;
    log(`event ${event}/${payload.action ?? '?'} (${slug}) → sync ${t.dir}`);
    await triggerSync(t.dir).catch((e) => log(`trigger failed for ${t.dir}: ${e.message}`));
  }
}

export function createWebhookServer() {
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://internal');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      getConfig().catch(() => null).then((config) => getBindings().then((bindings) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          startedAt: state.startedAt,
          lastEventAt: state.lastEventAt,
          received: state.received,
          triggered: state.triggered,
          rejected: state.rejected,
          workspaces: Object.keys(config?.workspaces ?? {}),
          projects: bindings.map((b) => b.dir),
        }));
      }));
      return;
    }

    const hook = url.pathname.match(/^\/hook\/([^/]+)$/);
    if (!hook) { res.writeHead(404).end('not found'); return; }
    if (req.method !== 'POST') { res.writeHead(405).end('method not allowed'); return; }

    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413).end('too large'); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      handleDelivery(decodeURIComponent(hook[1]), req.headers, Buffer.concat(chunks), res)
        .catch((e) => { log(`delivery handler error: ${e.message}`); if (!res.headersSent) res.writeHead(500).end(); });
    });
    req.on('error', () => {});
  });
}

// Main-module check that survives symlinks: when this file is reached through a
// symlink (e.g. ~/.claude/skills/<plugin> → the plugin checkout), Node resolves
// import.meta.url to the realpath while process.argv[1] keeps the symlink path,
// so a raw === comparison is false and the daemon exits 0 without listening.
// Compare realpaths of both sides (falling back to the raw compare if argv[1]
// can't be resolved, e.g. `node --eval`).
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return entry === self;
  }
}

if (isMainModule()) {
  await mkdir(CACHE_DIR, { recursive: true });
  const config = await getConfig().catch(() => loadConfigSync({}));
  const server = createWebhookServer();
  server.listen(config.port, config.bind, () => {
    log(`gsd-with-plane webhook receiver listening on ${config.bind}:${config.port} `
      + `(workspaces: ${Object.keys(config.workspaces).join(', ') || 'none configured yet'})`);
  });
  server.on('error', (e) => { log(`fatal: ${e.message}`); process.exit(1); });
}
