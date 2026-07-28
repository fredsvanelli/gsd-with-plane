// Parser for GSD's ROADMAP.md → intermediate structure (milestones/phases/plans).
// Pure (string → object), no I/O: the caller reads the file and passes the content.
//
// Supported formats (legacy get-shit-done and gsd-core 1.6 — the two GSD
// generations write different separators and heading levels):
// - `## Milestones` list: "- ✅ **v1.0 Name** — Phases 1–4 (shipped 2026-06-01)"
//   (gsd-core uses "-" instead of "—" and adds the "(planned)" status: 📋)
// - Shipped milestones inside <details><summary>✅ v2.2 ... (Phases 36–39) — SHIPPED ...</summary>
//   with a compact checklist "- [x] Phase 36: Title (3/3 plans) — completed 2026-06-14"
// - In-progress milestones as "### 🚧 v3.0 Name — Phases 42–59 — IN PROGRESS"
//   or gsd-core's "### 🚧 v1.1 Name (In Progress)" / "### 📋 v2.0 Name (Planned)"
// - Detail sections "### Phase 42: Title" (decimal number "68.3" and "(INSERTED)" suffix
//   accepted; gsd-core also emits "#### Phase 5:" inside milestone blocks)
//   with fields "**Goal:**", "**Requirements**:", "**Depends on:**", "**Plans:** 5/5 plans complete"
// - Plan checklist "- [x] 42-01-PLAN.md — description [wave 1]" (legacy),
//   "- [x] 03-01: description" (gsd-core), or grouped under "**Wave N**"
// - gsd-core's "## Progress" table rows "| 3. Billing | v1.1 | 1/2 | In Progress | - |"
//   (legacy shape "| 42 (v3.0) | ... |" accepted) — the only per-phase done signal
//   gsd-core's `phase complete` maintains when the plan checklist is never ticked

const MILESTONE_LIST_RE = /^-\s+(\S+)\s+\*\*(v[\d.]+)\s+(.+?)\*\*\s+[—–-]\s+Phases?\s+([\d.]+)(?:\s*[–—-]\s*([\d.]+))?\+?\s*\((shipped\s+(\d{4}-\d{2}-\d{2})|in progress|planned)\)/u;
const SUMMARY_RE = /^<summary>(\S+)\s+(v[\d.]+)\s+(.+?)\s+\(Phases?\s+([\d.]+)(?:\s*[–—-]\s*([\d.]+))?\)\s*(?:[—–-]\s*(SHIPPED\s+(\d{4}-\d{2}-\d{2})|IN PROGRESS))?/u;
const MILESTONE_H3_RE = /^###\s+(\S+)\s+(v[\d.]+)\s+(.+)$/u;
const PHASE_HEADING_RE = /^#{3,4}\s+Phase\s+([\d.]+):\s+(.+)$/;
const COMPACT_PHASE_RE = /^-\s+\[([ x])\]\s+(?:\*\*)?Phase\s+([\d.]+):\s+(.+)$/;
const PLAN_ITEM_RE = /^-\s+\[([ x])\]\s+([\d.]+-\d+)(?:-PLAN\.md)?\s*(?::|\s[—–-])\s+(.+)$/;
const FIELD_RE = /^\*\*([^*]+?):?\*\*\s*:?\s*(.*)$/;
const WAVE_GROUP_RE = /^\*\*Wave\s+(\d+)\*\*/;
const PLANS_SUMMARY_RE = /(\d+)\s*\/\s*(\d+)\s+plans?/;
const COMPLETED_RE = /completed\s+(\d{4}-\d{2}-\d{2})/;
// "| 3. Billing | … |" (gsd-core) or "| 42 (v3.0) | … |" (legacy); range rows
// ("| 1–4 (v1.0) | … |") intentionally don't match — they carry no per-phase info.
const PROGRESS_ROW_RE = /^\|\s*(\d+(?:\.\d+)*)\.?(?:\s[^|]*)?\|/;
const MILESTONE_STATUS_BY_EMOJI = new Map([['✅', 'shipped'], ['📋', 'planned']]);

const KNOWN_FIELDS = new Map([
  ['goal', 'goal'],
  ['requirements', 'requirements'],
  ['depends on', 'dependsOn'],
  ['repo', 'repo'],
  ['success criteria', 'successCriteria'],
  ['plans', 'plansSummary'],
]);

export function phaseSortKey(number) {
  return String(number).split('.').map(Number);
}

export function comparePhaseNumbers(a, b) {
  const ka = phaseSortKey(a);
  const kb = phaseSortKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function newPhase(number) {
  return {
    number,
    title: null,
    inserted: false,
    stub: false,
    milestone: null,
    checked: false,
    completedDate: null,
    plansSummary: null, // {done, total} from "**Plans:** X/Y plans ..."
    repo: null,
    goal: null,
    requirements: null,
    dependsOn: null,
    dependsOnPhases: [],
    successCriteria: null,
    plans: [],
    hasDetail: false,
    progressStatus: null, // 'complete' | 'in_progress' | 'not_started' | 'deferred' from the ## Progress table
    fields: {}, // unmapped bold fields, preserved raw
  };
}

function parseTitle(rawTitle) {
  let title = rawTitle.trim();
  const inserted = /\(INSERTED\)\s*$/.test(title);
  if (inserted) title = title.replace(/\s*\(INSERTED\)\s*$/, '');
  return { title, inserted };
}

function parseCompactEntry(line, phases, milestoneVersion) {
  const m = line.match(COMPACT_PHASE_RE);
  if (!m) return false;
  const [, check, number, restRaw] = m;
  const phase = phases.get(number) ?? newPhase(number);
  phases.set(number, phase);

  let rest = restRaw;
  // Bold variant: the title ends at the closing bold marker.
  const boldEnd = rest.indexOf('**');
  let title;
  if (line.includes('**Phase') && boldEnd !== -1) {
    title = rest.slice(0, boldEnd);
  } else {
    // Plain variant: cut at "(N/M plans)" or at "— completed".
    title = rest.replace(/\s*\(\d+\s*\/\s*\d+\s+plans?\).*$/, '').replace(/\s+—\s+completed.*$/, '');
  }
  const parsed = parseTitle(title);
  phase.title ??= parsed.title;
  phase.inserted ||= parsed.inserted;
  phase.checked = check === 'x';
  phase.milestone ??= milestoneVersion;

  const plansM = rest.match(PLANS_SUMMARY_RE);
  if (plansM && !phase.plansSummary) {
    phase.plansSummary = { done: Number(plansM[1]), total: Number(plansM[2]) };
  }
  const completedM = rest.match(COMPLETED_RE);
  if (completedM) phase.completedDate = completedM[1];
  return true;
}

export function parseRoadmap(markdown, { materializeRangeStubs = true } = {}) {
  const lines = markdown.split('\n');
  const milestones = new Map(); // version → milestone
  const phases = new Map(); // number (string) → phase

  const getMilestone = (version) => {
    if (!milestones.has(version)) {
      milestones.set(version, {
        version,
        name: null,
        status: null, // 'shipped' | 'in_progress'
        shippedDate: null,
        phaseRange: null, // [from, to] as strings
        description: null,
      });
    }
    return milestones.get(version);
  };

  let title = null;
  // Current state-machine context:
  let section = null; // 'milestones-list' | 'milestone-block' | 'phase-detail' | null
  let currentMilestone = null; // version of the current <details>/### 🚧 block
  let currentPhase = null;
  let currentField = null; // canonical name of the field being accumulated (goal, successCriteria, ...)
  let currentWave = null; // current **Wave N** group inside the detail section
  let milestoneProse = [];

  const closeMilestoneBlock = () => {
    if (currentMilestone && milestoneProse.length) {
      const m = getMilestone(currentMilestone);
      m.description ??= milestoneProse.join('\n').trim() || null;
    }
    currentMilestone = null;
    milestoneProse = [];
  };
  const closePhaseDetail = () => {
    if (currentPhase) {
      for (const key of ['goal', 'requirements', 'dependsOn', 'successCriteria']) {
        if (typeof currentPhase[key] === 'string') currentPhase[key] = currentPhase[key].trim() || null;
      }
      if (currentPhase.dependsOn) {
        currentPhase.dependsOnPhases = [...currentPhase.dependsOn.matchAll(/Phase\s+([\d.]+)/g)].map((m) => m[1]);
      }
    }
    currentPhase = null;
    currentField = null;
    currentWave = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('# ') && !title) {
      title = trimmed.replace(/^#\s+/, '').replace(/^Roadmap:\s*/i, '');
      continue;
    }

    if (trimmed.startsWith('## ')) {
      closePhaseDetail();
      closeMilestoneBlock();
      // "## Phases" hosts gsd-core's top compact checklist (no milestone yet);
      // milestone headers appearing later inside it switch the section themselves.
      section = /^##\s+Milestones/i.test(trimmed) ? 'milestones-list'
        : /^##\s+Phases/i.test(trimmed) ? 'phases-list' : null;
      continue;
    }

    // Milestone header inside <details><summary>
    const summaryM = trimmed.match(SUMMARY_RE);
    if (summaryM) {
      closePhaseDetail();
      closeMilestoneBlock();
      const [, emoji, version, name, from, to] = summaryM;
      const m = getMilestone(version);
      m.name ??= name;
      m.phaseRange ??= [from, to ?? from];
      m.status ??= MILESTONE_STATUS_BY_EMOJI.get(emoji) ?? 'in_progress';
      if (summaryM[7]) m.shippedDate ??= summaryM[7];
      currentMilestone = version;
      section = 'milestone-block';
      continue;
    }
    if (trimmed === '</details>') {
      closeMilestoneBlock();
      section = null;
      continue;
    }

    // Phase heading — H3 (both generations) or H4 (gsd-core nests phases as
    // "#### Phase 5:" under milestone H3 blocks). A phase detail does NOT close
    // the milestone block: "### 🚧 v3.0" and the following "### Phase 42..."
    // are siblings, but the phase belongs to the block.
    const phaseM = trimmed.match(PHASE_HEADING_RE);
    if (phaseM) {
      closePhaseDetail();
      const [, number, rawTitle] = phaseM;
      const phase = phases.get(number) ?? newPhase(number);
      phases.set(number, phase);
      const parsed = parseTitle(rawTitle);
      // The detail title is more complete than the compact-checklist one — it wins.
      phase.title = parsed.title;
      phase.inserted ||= parsed.inserted;
      phase.hasDetail = true;
      phase.milestone ??= currentMilestone;
      currentPhase = phase;
      section = 'phase-detail';
      continue;
    }

    if (trimmed.startsWith('### ')) {
      closePhaseDetail();

      const milestoneM = trimmed.match(MILESTONE_H3_RE);
      if (milestoneM) {
        closeMilestoneBlock();
        const [, emoji, version, rest] = milestoneM;
        const m = getMilestone(version);
        // "Name — Phases 42–59 — IN PROGRESS" → name before the first "— Phases"/
        // "— IN PROGRESS"; gsd-core suffixes "(In Progress)"/"(Planned)" instead.
        m.name ??= rest.split(/\s+—\s+(?:Phases?\s|IN PROGRESS)/)[0]
          .replace(/\s*\((?:Phase[^)]*|In Progress|Planned|Shipped[^)]*)\)\s*$/i, '').trim();
        m.status ??= MILESTONE_STATUS_BY_EMOJI.get(emoji) ?? 'in_progress';
        const rangeM = rest.match(/Phases?\s+([\d.]+)\s*[–—-]\s*([\d.]+)/);
        if (rangeM) m.phaseRange ??= [rangeM[1], rangeM[2]];
        currentMilestone = version;
        section = 'milestone-block';
        continue;
      }

      closeMilestoneBlock();
      section = null;
      continue;
    }

    // Other H4+ headings are structure inside the current block — never a
    // milestone/section boundary. Skip them so they don't pollute field
    // continuations or milestone prose.
    if (/^####/.test(trimmed)) {
      closePhaseDetail();
      continue;
    }

    // gsd-core's "## Progress" table — `phase complete`/`update-plan-progress`
    // maintain it even when the per-plan checklist is never ticked, so it is a
    // done/in-progress signal in its own right. Only consulted outside other
    // sections (the table lives under its own "## Progress" heading).
    if (section === null && PROGRESS_ROW_RE.test(trimmed)) {
      const number = trimmed.match(PROGRESS_ROW_RE)[1];
      const cells = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
      const statusCell = cells.find((c) => /^(complete|in progress|not started|deferred)$/i.test(c));
      if (statusCell && phases.has(number)) {
        const phase = phases.get(number);
        phase.progressStatus = statusCell.toLowerCase().replace(' ', '_');
        const date = cells.find((c) => /^\d{4}-\d{2}-\d{2}$/.test(c));
        if (date && phase.progressStatus === 'complete') phase.completedDate ??= date;
        const plansCell = cells.map((c) => c.match(/^(\d+)\s*\/\s*(\d+)$/)).find(Boolean);
        if (plansCell) phase.plansSummary ??= { done: Number(plansCell[1]), total: Number(plansCell[2]) };
      }
      continue;
    }

    if (section === 'milestones-list') {
      const m = trimmed.match(MILESTONE_LIST_RE);
      if (m) {
        const [, emoji, version, name, from, to, statusRaw, shippedDate] = m;
        const ms = getMilestone(version);
        // The top list is authoritative — it overrides whatever stale blocks say.
        ms.name = name;
        ms.status = statusRaw.startsWith('shipped') ? 'shipped'
          : statusRaw === 'planned' ? 'planned' : 'in_progress';
        ms.shippedDate = shippedDate ?? null;
        ms.phaseRange = [from, to ?? from];
        void emoji;
      }
      continue;
    }

    // gsd-core's greenfield "## Phases" checklist — same compact entries as a
    // milestone block, but before any milestone exists (assigned by range later).
    if (section === 'phases-list') {
      parseCompactEntry(trimmed, phases, null);
      continue;
    }

    if (section === 'milestone-block') {
      if (parseCompactEntry(trimmed, phases, currentMilestone)) continue;
      if (trimmed && !trimmed.startsWith('<')) milestoneProse.push(trimmed);
      continue;
    }

    if (section === 'phase-detail' && currentPhase) {
      const planM = trimmed.match(PLAN_ITEM_RE);
      if (planM) {
        // Group 2 is the plan id ("42-01") — legacy checklists carry the full
        // "42-01-PLAN.md" file name, gsd-core just "03-01:"; normalize to the file.
        const [, check, id, desc] = planM;
        const waveM = desc.match(/\[wave\s+(\d+)\]/);
        currentPhase.plans.push({
          file: `${id}-PLAN.md`,
          checked: check === 'x',
          description: desc.replace(/\s*\[wave\s+\d+\]/, '').trim(),
          wave: waveM ? Number(waveM[1]) : currentWave,
        });
        currentField = null;
        continue;
      }

      const waveGroupM = trimmed.match(WAVE_GROUP_RE);
      if (waveGroupM) {
        currentWave = Number(waveGroupM[1]);
        currentField = null;
        continue;
      }

      const fieldM = trimmed.match(FIELD_RE);
      if (fieldM) {
        const rawName = fieldM[1].trim().replace(/:$/, '');
        const canonical = KNOWN_FIELDS.get(rawName.toLowerCase());
        const value = fieldM[2].trim();
        if (canonical === 'plansSummary') {
          const pm = value.match(PLANS_SUMMARY_RE);
          currentPhase.plansSummary = pm ? { done: Number(pm[1]), total: Number(pm[2]) } : null;
          currentPhase.fields['Plans'] = value;
          currentField = null;
        } else if (canonical) {
          currentPhase[canonical] = value;
          currentField = canonical;
        } else {
          currentPhase.fields[rawName] = value;
          currentField = null;
        }
        continue;
      }

      if (trimmed === 'Plans:') {
        currentField = null;
        continue;
      }

      // Continuation line of the current field (extra paragraphs, goal bullets,
      // numbered success-criteria items). Blank lines become \n\n.
      if (currentField) {
        currentPhase[currentField] = (currentPhase[currentField] ?? '') + '\n' + line;
      }
      continue;
    }
  }

  closePhaseDetail();
  closeMilestoneBlock();

  // Assign milestone by range for phases that never appeared in any compact
  // checklist (e.g. detail sections outside a milestone block).
  const milestoneList = [...milestones.values()];
  for (const phase of phases.values()) {
    if (phase.milestone) continue;
    const owner = milestoneList.find(
      (m) => m.phaseRange
        && comparePhaseNumbers(phase.number, m.phaseRange[0]) >= 0
        && comparePhaseNumbers(phase.number, m.phaseRange[1]) <= 0,
    );
    if (owner) phase.milestone = owner.version;
  }

  // Materialize stubs for ranges without individual entries (e.g. v2.1 Phases
  // 12–35 exists only as a range; the detail lives in milestones/v2.1-ROADMAP.md).
  if (materializeRangeStubs) {
    for (const m of milestoneList) {
      if (!m.phaseRange) continue;
      const [from, to] = m.phaseRange.map(Number);
      if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
      for (let n = from; n <= to; n++) {
        const key = String(n);
        if (phases.has(key)) continue;
        const stub = newPhase(key);
        stub.stub = true;
        stub.milestone = m.version;
        stub.title = `${m.name} (phase ${key} — details in .planning/milestones/${m.version}-ROADMAP.md)`;
        stub.checked = m.status === 'shipped';
        if (m.status === 'shipped') stub.completedDate = m.shippedDate;
        phases.set(key, stub);
      }
    }
  }

  const sortedPhases = [...phases.values()].sort((a, b) => comparePhaseNumbers(a.number, b.number));
  return { title, milestones: milestoneList, phases: sortedPhases };
}

// Derives the "board" status of a phase. Backlog phases never get "[x]" in a
// compact checklist, so "all plans completed" also counts as done.
// `currentPhaseNumber` comes from STATE.md ("Current Position: Phase: 68.3")
// — the only explicit per-phase in-progress signal GSD provides.
export function derivePhaseStatus(phase, currentPhaseNumber = null) {
  if (phase.checked) return 'done';
  if (phase.plans.length > 0 && phase.plans.every((p) => p.checked)) return 'done';
  if (!phase.plans.length && phase.plansSummary && phase.plansSummary.total > 0
    && phase.plansSummary.done === phase.plansSummary.total) return 'done';
  // gsd-core: `phase complete` marks the ## Progress table (and may leave the
  // checklist unticked, or write "0/0 plans" for phases closed without plans).
  if (phase.progressStatus === 'complete') return 'done';
  if (currentPhaseNumber !== null && comparePhaseNumbers(phase.number, currentPhaseNumber) === 0) {
    return 'in_progress';
  }
  if (phase.plans.some((p) => p.checked)) return 'in_progress';
  // gsd-core: partial "N/M plans executed" counter / Progress table row without
  // per-plan checkbox ticks.
  if (phase.plansSummary && phase.plansSummary.done > 0) return 'in_progress';
  if (phase.progressStatus === 'in_progress') return 'in_progress';
  return 'todo';
}

// A phase split into decimal sub-phases (75 → 75.1 … 75.5) often keeps no
// plans of its own, so nothing ever flips it to done. Sequence-aware pass:
// once EVERY sub-phase of a parent is done, the parent derives done too —
// unless the parent still has unfinished plans of its own (those win).
// Cascades bottom-up (75.1.x closes 75.1, which can then close 75).
// Returns Map<phaseNumber(string), status>.
export function derivePhaseStatuses(phases, currentPhaseNumber = null) {
  const statuses = new Map(
    phases.map((p) => [String(p.number), derivePhaseStatus(p, currentPhaseNumber)]),
  );
  // Deepest parents first so 75.1 (from 75.1.x) resolves before 75.
  const parents = phases
    .filter((p) => statuses.get(String(p.number)) !== 'done')
    .sort((a, b) => phaseSortKey(b.number).length - phaseSortKey(a.number).length);
  for (const phase of parents) {
    const prefix = `${phase.number}.`;
    const subs = phases.filter((p) => String(p.number).startsWith(prefix));
    if (!subs.length) continue;
    // Unfinished work directly on the parent keeps it open.
    if (phase.plans.length > 0 && !phase.plans.every((p) => p.checked)) continue;
    if (phase.plansSummary && phase.plansSummary.done < phase.plansSummary.total) continue;
    if (subs.every((p) => statuses.get(String(p.number)) === 'done')) {
      statuses.set(String(phase.number), 'done');
    }
  }
  return statuses;
}

// Extracts the current phase from STATE.md ("## Current Position" section → "Phase: 68.3").
export function parseCurrentPhase(stateMarkdown) {
  const m = stateMarkdown.match(/^Phase:\s+([\d.]+)/m);
  return m ? m[1] : null;
}
