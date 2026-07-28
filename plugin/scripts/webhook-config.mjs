// CRUD helper for the webhook receiver config
// (~/.cache/gsd-with-plane/webhook.json, chmod 600) — used by the
// /gsd-with-plane:init and /gsd-with-plane:webhook command flows so they never
// hand-edit JSON. Secrets are MASKED in every output (they only ever flow
// file → webhook-server.mjs).
//
// Usage:
//   node webhook-config.mjs show
//   node webhook-config.mjs set-workspace <slug> <secret>
//   node webhook-config.mjs remove-workspace <slug>
//   node webhook-config.mjs set <port|bind|safetyPollMinutes|publicUrl> <value>

import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';

const CACHE_DIR = process.env.GSD_PLANE_CACHE_DIR
  ?? join(process.env.HOME ?? '', '.cache', 'gsd-with-plane');
const CONFIG_FILE = join(CACHE_DIR, 'webhook.json');
const DEFAULTS = { port: 8787, bind: '0.0.0.0', safetyPollMinutes: 30, publicUrl: null, workspaces: {} };

async function load() {
  try { return { ...DEFAULTS, ...JSON.parse(await readFile(CONFIG_FILE, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}

async function save(cfg) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  await chmod(CONFIG_FILE, 0o600);
}

function masked(cfg) {
  return {
    ...cfg,
    workspaces: Object.fromEntries(Object.entries(cfg.workspaces).map(([slug, w]) => [
      slug, { ...w, secret: w.secret ? `${w.secret.slice(0, 12)}…` : '(none)' },
    ])),
  };
}

const [cmd, ...args] = process.argv.slice(2);
const cfg = await load();

switch (cmd) {
  case 'show':
    console.log(JSON.stringify(masked(cfg), null, 2));
    break;

  case 'set-workspace': {
    const [slug, secret] = args;
    if (!slug || !secret) { console.error('usage: set-workspace <slug> <secret>'); process.exit(2); }
    cfg.workspaces[slug] = { secret };
    await save(cfg);
    console.log(`workspace "${slug}" configured (secret ${secret.slice(0, 12)}…)`);
    break;
  }

  case 'remove-workspace': {
    const [slug] = args;
    if (!slug || !cfg.workspaces[slug]) { console.error(`unknown workspace "${slug ?? ''}"`); process.exit(2); }
    delete cfg.workspaces[slug];
    await save(cfg);
    console.log(`workspace "${slug}" removed`);
    break;
  }

  case 'set': {
    const [key, value] = args;
    if (!['port', 'bind', 'safetyPollMinutes', 'publicUrl'].includes(key) || value === undefined) {
      console.error('usage: set <port|bind|safetyPollMinutes|publicUrl> <value>');
      process.exit(2);
    }
    cfg[key] = ['port', 'safetyPollMinutes'].includes(key) ? Number(value)
      : (key === 'publicUrl' && (value === 'null' || value === '') ? null : value);
    if (['port', 'safetyPollMinutes'].includes(key) && !(cfg[key] > 0)) {
      console.error(`invalid ${key}: ${value}`);
      process.exit(2);
    }
    await save(cfg);
    console.log(`${key} = ${JSON.stringify(cfg[key])}`);
    break;
  }

  default:
    console.error('usage: webhook-config.mjs show | set-workspace <slug> <secret> | remove-workspace <slug> | set <key> <value>');
    process.exit(2);
}
