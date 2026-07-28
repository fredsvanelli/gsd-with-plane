// webhook-server.mjs is the realtime Plane → local path: Plane's workspace
// webhook POSTs land here, get HMAC-verified and routed to the coalesced sync
// runner. The signature contract was verified against the plane-api 1.3.1
// source (bgtasks/webhook_task.py): X-Plane-Signature = HMAC-SHA256 hex of the
// RAW request body with the webhook's secret_key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The server resolves its cache dir from the env AT IMPORT TIME — set up the
// sandbox first, import dynamically after.
const sandbox = await mkdtemp(join(tmpdir(), 'gsd-plane-wh-'));
process.env.GSD_PLANE_CACHE_DIR = join(sandbox, 'cache');
const hookLog = join(sandbox, 'hook-calls.log');
process.env.GSD_PLANE_SYNC_HOOK = join(sandbox, 'fake-hook.sh');

const { createWebhookServer, verifySignature, matchProjects, stampName, loadConfigSync } =
  await import('../plugin/scripts/webhook-server.mjs');

const SECRET = 'plane_wh_testsecret';
const SLUG = 'test-ws';
const PROJECT_ID = '5de10415-bbea-42fd-936d-2efa281ccff5';
const projDir = join(sandbox, 'proj');

let server;
let base;

before(async () => {
  await mkdir(process.env.GSD_PLANE_CACHE_DIR, { recursive: true });
  await mkdir(join(projDir, '.planning'), { recursive: true });
  await writeFile(join(process.env.GSD_PLANE_CACHE_DIR, 'webhook.json'), JSON.stringify({
    port: 0, bind: '127.0.0.1', workspaces: { [SLUG]: { secret: SECRET } },
  }));
  await writeFile(join(process.env.GSD_PLANE_CACHE_DIR, 'projects.txt'), `${projDir}\n`);
  await writeFile(join(projDir, '.gsd-plane.json'), JSON.stringify({
    workspaceSlug: SLUG, projectId: PROJECT_ID, projectName: 'Test', syncMode: 'webhook',
  }));
  await writeFile(process.env.GSD_PLANE_SYNC_HOOK,
    `#!/bin/bash\ncat >> "${hookLog}"; echo >> "${hookLog}"\n`, { mode: 0o755 });

  server = createWebhookServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await rm(sandbox, { recursive: true, force: true });
});

function sign(secret, body) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function deliver(body, { slug = SLUG, secret = SECRET, event = 'issue', delivery } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Plane-Event': event,
    'X-Plane-Signature': typeof secret === 'string' ? sign(secret, body) : secret.raw,
  };
  if (delivery) headers['X-Plane-Delivery'] = delivery;
  return fetch(`${base}/hook/${slug}`, { method: 'POST', headers, body });
}

const issuePayload = (project = PROJECT_ID) => JSON.stringify({
  event: 'issue', action: 'update', webhook_id: 'w1', workspace_id: 'ws1',
  data: { id: 'i1', project }, activity: {},
});

async function hookCalls() {
  await new Promise((r) => setTimeout(r, 300)); // triggerSync spawns detached
  const log = await readFile(hookLog, 'utf8').catch(() => '');
  return log.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// --- signature verification (incl. the Python-generated vector) ---

test('verifySignature: accepts the exact bytes+HMAC produced by Plane\'s python stack', () => {
  // Generated inside the plane-api-1 container (python requests 2.34.2):
  // requests.PreparedRequest(json=payload).body signed with HMAC-SHA256 —
  // proves raw-body HMAC matches Plane's json.dumps-based signature.
  const body = '{"event": "issue", "action": "update", "webhook_id": "w", "workspace_id": "ws", '
    + '"data": {"name": "A\\u00e7\\u00facar & <b>caf\\u00e9</b>", "estimate": null, "ids": [1, 2]}, '
    + '"activity": {"actor": {"id": "x"}}}';
  const vector = 'c19df2f782344c5dac49a2b7993cdfe3c5e3d1d1bfc78fc268b93397ee78b626';
  assert.equal(verifySignature('plane_wh_vector', Buffer.from(body, 'utf8'), vector), true);
  assert.equal(verifySignature('plane_wh_other', Buffer.from(body, 'utf8'), vector), false);
});

test('verifySignature: rejects missing/garbage/truncated signatures', () => {
  const body = Buffer.from('{}');
  assert.equal(verifySignature(SECRET, body, undefined), false);
  assert.equal(verifySignature(SECRET, body, 'not-hex'), false);
  assert.equal(verifySignature(SECRET, body, sign(SECRET, body).slice(0, 32)), false);
  assert.equal(verifySignature(undefined, body, sign(SECRET, body)), false);
});

// --- routing ---

test('matchProjects: scopes by workspace and project id, fans out when id is missing', () => {
  const bindings = [
    { dir: '/a', workspaceSlug: SLUG, projectId: PROJECT_ID },
    { dir: '/b', workspaceSlug: SLUG, projectId: 'other-project' },
    { dir: '/c', workspaceSlug: 'another-ws', projectId: PROJECT_ID },
    { dir: '/d', workspaceSlug: SLUG }, // no projectId yet (project created by first push)
  ];
  assert.deepEqual(matchProjects(bindings, SLUG, 'issue', { project: PROJECT_ID }).map((b) => b.dir), ['/a', '/d']);
  assert.deepEqual(matchProjects(bindings, SLUG, 'project', { id: 'other-project' }).map((b) => b.dir), ['/b', '/d']);
  // partial delete payload without a project id → every project of the workspace
  assert.deepEqual(matchProjects(bindings, SLUG, 'issue', {}).map((b) => b.dir), ['/a', '/b', '/d']);
  assert.deepEqual(matchProjects(bindings, 'unknown', 'issue', { project: PROJECT_ID }), []);
});

test('stampName matches pull-registry.sh (tr -c A-Za-z0-9 _)', () => {
  assert.equal(stampName('/Users/f red/proj.x'), '_Users_f_red_proj_x');
});

test('loadConfigSync applies defaults', () => {
  assert.deepEqual(loadConfigSync('{}'), { port: 8787, bind: '0.0.0.0', safetyPollMinutes: 30, workspaces: {} });
});

// --- HTTP behavior against a live server instance ---

test('valid delivery → 200, triggers the sync hook and writes heartbeat + stamp', async () => {
  const res = await deliver(issuePayload(), { delivery: 'd-ok-1' });
  assert.equal(res.status, 200);
  const calls = await hookCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool_input.file_path, join(projDir, '.planning', 'ROADMAP.md'));
  const heartbeat = await readFile(join(process.env.GSD_PLANE_CACHE_DIR, 'webhook-last-event'), 'utf8');
  assert.ok(!Number.isNaN(Date.parse(heartbeat)));
  const stamp = await readFile(
    join(process.env.GSD_PLANE_CACHE_DIR, 'stamps', `${stampName(projDir)}.stamp`), 'utf8');
  assert.ok(Number(stamp) > 0);
});

test('duplicate X-Plane-Delivery (Plane retry) → 200 but no second sync', async () => {
  const countBefore = (await hookCalls()).length;
  const res = await deliver(issuePayload(), { delivery: 'd-ok-1' });
  assert.equal(res.status, 200);
  assert.equal((await hookCalls()).length, countBefore);
});

test('event for a different project → 200, no sync', async () => {
  const countBefore = (await hookCalls()).length;
  await deliver(issuePayload('somebody-elses-project'), { delivery: 'd-other' });
  assert.equal((await hookCalls()).length, countBefore);
});

test('irrelevant event type (cycle) → 200, no sync', async () => {
  const countBefore = (await hookCalls()).length;
  const body = JSON.stringify({ event: 'cycle', action: 'update', data: { project: PROJECT_ID } });
  await deliver(body, { event: 'cycle', delivery: 'd-cycle' });
  assert.equal((await hookCalls()).length, countBefore);
});

test('bad signature → 401, unknown workspace → 404, no sync', async () => {
  const countBefore = (await hookCalls()).length;
  assert.equal((await deliver(issuePayload(), { secret: 'plane_wh_wrong' })).status, 401);
  assert.equal((await deliver(issuePayload(), { slug: 'nope' })).status, 404);
  assert.equal((await hookCalls()).length, countBefore);
});

test('GET /hook → 405, unknown path → 404, healthz reports state', async () => {
  assert.equal((await fetch(`${base}/hook/${SLUG}`)).status, 405);
  assert.equal((await fetch(`${base}/nothing`)).status, 404);
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.ok, true);
  assert.deepEqual(health.workspaces, [SLUG]);
  assert.deepEqual(health.projects, [projDir]);
  assert.ok(health.received >= 1);
  assert.ok(health.rejected >= 2);
});
