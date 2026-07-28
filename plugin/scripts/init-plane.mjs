// Discovery for /gsd-with-plane:init: prints JSON with the authenticated user
// and the workspace's projects — including whether each one has issues and
// whether it is already managed by gsd-sync (marker in the description). The
// selection itself happens in the conversation (AskUserQuestion); this script
// only collects.
//
// Plane's public API has no "list my workspaces" endpoint — the workspace slug
// is part of every route — so the slug must come in: --workspace <slug>,
// PLANE_WORKSPACE_SLUG in the env/.env, or an existing .gsd-plane.json.
// (The slug is visible in the Plane URL: http://<host>/<slug>/.)
//
// Usage: node plugin/scripts/init-plane.mjs [--workspace <slug>]
//   (requires PLANE_API_KEY, and PLANE_API_HOST_URL when not http://localhost)

import { PlaneClient } from './plane-client.mjs';
import { loadEnv, loadSyncConfig, parseMarker } from './common.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};

await loadEnv();
const syncConfig = await loadSyncConfig();
const WORKSPACE = opt('workspace', syncConfig.workspaceSlug ?? process.env.PLANE_WORKSPACE_SLUG ?? null);

const client = new PlaneClient({
  apiKey: process.env.PLANE_API_KEY,
  baseUrl: process.env.PLANE_API_HOST_URL ?? process.env.PLANE_BASE_URL,
  workspaceSlug: WORKSPACE,
});

const me = await client.getMe();
const projects = await client.listProjects();

// hasIssues probes one page per project — capped to stay inside Plane's
// self-hosted rate limit (60 req/min by default).
const PROBE_LIMIT = 25;
const out = [];
for (const [i, p] of projects.entries()) {
  let hasIssues = null; // null = not probed
  if (i < PROBE_LIMIT) {
    const page = await client.req('GET', client.proj(p.id, 'work-items/?per_page=1')).catch(() => null);
    hasIssues = page ? (page.count ?? page.results?.length ?? 0) > 0 : null;
  }
  out.push({
    id: p.id,
    name: p.name,
    identifier: p.identifier,
    url: client.projectUrl(p.id),
    gsdManaged: parseMarker(p.description)?.kind === 'project',
    hasIssues,
  });
}

console.log(JSON.stringify({
  host: client.baseUrl,
  workspace: { slug: WORKSPACE, viewer: { name: [me.first_name, me.last_name].filter(Boolean).join(' ') || me.display_name, email: me.email } },
  projects: out,
}, null, 2));
