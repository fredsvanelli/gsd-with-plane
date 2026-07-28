// Thin client for Plane's REST API v1 (native fetch, no dependencies).
// Auth via personal API token (X-API-Key header). Does not use MCP: Claude
// Code hooks are shell scripts and have no access to the session's MCP tools.
//
// Works against any Plane instance — the local Docker stack (default
// http://localhost) or a self-hosted server — via PLANE_API_HOST_URL.
// Verified against Plane self-hosted 1.3.1: issues live under the
// `work-items/` prefix (the legacy `issues/` routes lack the relations
// endpoint), lists are cursor-paginated ({next_cursor, next_page_results,
// results}), and issue bodies are HTML (description_html).

export class PlaneClient {
  constructor({ apiKey, baseUrl, workspaceSlug }) {
    if (!apiKey) throw new Error('PLANE_API_KEY missing (set it in the environment or .env)');
    if (!workspaceSlug) {
      throw new Error('workspace slug missing (run /gsd-with-plane:init, or set PLANE_WORKSPACE_SLUG)');
    }
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || 'http://localhost').replace(/\/+$/, '');
    this.slug = workspaceSlug;
  }

  // Self-hosted defaults ship API_KEY_RATE_LIMIT=60/minute — a first push of a
  // real roadmap trips it, so 429 waits for Retry-After and resumes instead of
  // failing the run.
  async req(method, path, body = undefined, attempt = 0) {
    const res = await fetch(`${this.baseUrl}/api/v1/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 6) {
      const wait = Number(res.headers.get('retry-after')) || 15;
      await new Promise((r) => setTimeout(r, Math.min(wait, 70) * 1000));
      return this.req(method, path, body, attempt + 1);
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = data ? JSON.stringify(data).slice(0, 300) : `HTTP ${res.status}`;
      const err = new Error(`Plane API ${method} /${path}: ${detail}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Follows Plane's cursor pagination ({next_cursor, next_page_results,
  // results}); plain-array responses pass through untouched.
  async paginate(path) {
    const sep = path.includes('?') ? '&' : '?';
    const all = [];
    let cursor = null;
    for (;;) {
      const page = await this.req('GET', `${path}${sep}per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (Array.isArray(page)) return page;
      all.push(...(page.results ?? []));
      if (!page.next_page_results) return all;
      cursor = page.next_cursor;
    }
  }

  ws(path) { return `workspaces/${this.slug}/${path}`; }
  proj(projectId, path) { return this.ws(`projects/${projectId}/${path}`); }

  // ---------- current user / workspace ----------

  async getMe() { return this.req('GET', 'users/me/'); }

  // ---------- projects ----------

  async listProjects() {
    return this.paginate(this.ws('projects/'));
  }

  // Plane requires a per-project identifier (issue key prefix, e.g. GSD-42).
  // module_view on: GSD milestones live in Modules, and UI-created projects
  // can have the feature toggled off.
  async createProject({ name, description, identifier }) {
    return this.req('POST', this.ws('projects/'), {
      name,
      description: description ?? '',
      identifier: identifier ?? projectIdentifierFrom(name),
      module_view: true,
    });
  }

  async updateProject(id, patch) {
    return this.req('PATCH', this.ws(`projects/${id}/`), patch);
  }

  projectUrl(projectId) {
    return `${this.baseUrl}/${this.slug}/projects/${projectId}/issues/`;
  }

  // ---------- states (per project; groups: backlog|unstarted|started|completed|cancelled) ----------

  async listStates(projectId) {
    return this.paginate(this.proj(projectId, 'states/'));
  }

  async createState(projectId, { name, color, group, sequence }) {
    return this.req('POST', this.proj(projectId, 'states/'), {
      name, color, group, ...(sequence != null ? { sequence } : {}),
    });
  }

  // Canonical state of a group = lowest sequence: the named flow columns
  // (UAT, Ready to ship, Code Review) are also group "started" but live AFTER
  // the default In Progress — without sorting, creation order could elect one
  // of them as "the" started state.
  stateByGroup(states, group) {
    const s = states.filter((x) => x.group === group)
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))[0];
    if (!s) throw new Error(`No state of group "${group}" in the project`);
    return s;
  }

  // ---------- labels (per project) ----------

  async listLabels(projectId) {
    return this.paginate(this.proj(projectId, 'labels/'));
  }

  async createLabel(projectId, name) {
    return this.req('POST', this.proj(projectId, 'labels/'), { name });
  }

  // ---------- modules (GSD milestones) ----------

  async listModules(projectId) {
    return this.paginate(this.proj(projectId, 'modules/'));
  }

  async createModule(projectId, input) {
    return this.req('POST', this.proj(projectId, 'modules/'), input);
  }

  async updateModule(projectId, id, patch) {
    return this.req('PATCH', this.proj(projectId, `modules/${id}/`), patch);
  }

  // Adding an issue that already sits in another module is additive in Plane —
  // consistent with the plugin's never-delete policy.
  async addIssuesToModule(projectId, moduleId, issueIds) {
    return this.req('POST', this.proj(projectId, `modules/${moduleId}/module-issues/`), { issues: issueIds });
  }

  async listModuleIssues(projectId, moduleId) {
    return this.paginate(this.proj(projectId, `modules/${moduleId}/module-issues/`));
  }

  // ---------- issues (work items) ----------

  async listProjectIssues(projectId) {
    return this.paginate(this.proj(projectId, 'work-items/'));
  }

  async createIssue(projectId, input) {
    return this.req('POST', this.proj(projectId, 'work-items/'), input);
  }

  async updateIssue(projectId, id, patch) {
    return this.req('PATCH', this.proj(projectId, `work-items/${id}/`), patch);
  }

  issueUrl(projectId, issueId) {
    return `${this.baseUrl}/${this.slug}/projects/${projectId}/issues/${issueId}`;
  }

  // ---------- comments / members (planner-sync board capture) ----------

  // Comment fields (IssueCommentSerializer, verified in the 1.3.1 container):
  // comment_html, actor (uuid), created_at (comment_stripped/comment_json are
  // excluded by the serializer).
  async listComments(projectId, issueId) {
    return this.paginate(this.proj(projectId, `work-items/${issueId}/comments/`));
  }

  // workspaces/<slug>/members/ — used to resolve assignee/actor uuids to
  // display names. Callers must tolerate failure (older instances / permission
  // differences) and fall back to raw ids.
  async listWorkspaceMembers() {
    return this.paginate(this.ws('members/'));
  }

  // ---------- relations ("Depends on: Phase N" → blocked_by) ----------

  // Grouped response: {blocking: [{issue_id,…}], blocked_by: […], …}
  async listRelations(projectId, issueId) {
    return this.req('GET', this.proj(projectId, `work-items/${issueId}/relations/`));
  }

  // relation_type "blocked_by" on the DEPENDENT issue: `issues` are the ones
  // blocking it. (POSTing "blocking" on the other side is equivalent.)
  async createRelation(projectId, issueId, relationType, issueIds) {
    return this.req('POST', this.proj(projectId, `work-items/${issueId}/relations/`), {
      relation_type: relationType,
      issues: issueIds,
    });
  }
}

// Plane project identifiers: 1–12 chars, uppercase alphanumerics. Derived from
// the roadmap title ("cheap courier api" → "CCA"; single word → first 5 chars).
export function projectIdentifierFrom(name) {
  const words = (name ?? '').toUpperCase().replace(/[^A-Z0-9\s-]/g, '').split(/[\s-]+/).filter(Boolean);
  let id = words.length >= 2 ? words.map((w) => w[0]).join('').slice(0, 12) : (words[0] ?? '').slice(0, 5);
  if (!id) id = 'GSD';
  if (/^\d/.test(id)) id = `P${id}`.slice(0, 12);
  return id;
}
