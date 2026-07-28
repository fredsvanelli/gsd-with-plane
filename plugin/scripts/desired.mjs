// Builds the "desired state" in Plane from .planning/ — used by the push
// (diff/upsert) and by the pull (hash comparison for the conflict policy).
// Bodies are built as markdown; the push converts them to description_html at
// the API boundary (html.mjs) — hashes are computed over the markdown, so the
// conversion never invalidates markers.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRoadmap, derivePhaseStatuses, parseCurrentPhase } from './parse-roadmap.mjs';
import {
  parseQuickTasks, parsePendingTodos, parsePhaseArtifacts, parseOpenPRs,
  parseDebugSessions, siblingReposFromPhases, phasePRPairsFromState,
  parseExecutedPlanIds, parsePlanContents,
} from './parse-extras.mjs';
import { truncateTitle, STATUS_TO_STATE_TYPE } from './common.mjs';
import { renderPlanMarkdown } from './parse-plan.mjs';

const UAT_DONE = new Set(['passed', 'complete', 'resolved']);

// Agile stage of the phase, applied only to "completed" phases of NON-shipped
// milestones (a phase of an archived milestone never returns to the board as
// pending work).
// Flow order: … → UAT → Ready to ship → Code Review → Done, so a pending UAT
// prevails (the phase sits at the earliest stage of the pipeline):
// - GSD artifacts: VERIFICATION human_needed without HUMAN-UAT passed (or
//   HUMAN-UAT partial) → uat
// - open PR on GitHub associated with the phase (human review pending) →
//   code_review (GSD's internal REVIEW.md does NOT count — it is a step of the
//   automated pipeline, not a board column). `prs` is an array: cross-repo
//   phases have one PR per repo.
// - UAT approved with NO PR for the phase — neither open via gh nor recorded
//   in STATE.md (a record without an open PR = PR already merged) → ready_to_ship
function stagePhase(stateType, art, milestoneShipped, prs, prRecorded) {
  if (milestoneShipped || stateType !== 'completed') return stateType;
  const uatDone = art?.humanUat && UAT_DONE.has(art.humanUat);
  if (art && ((art.verification === 'human_needed' && !uatDone) || art.humanUat === 'partial')) return 'uat';
  if (prs?.length) return 'code_review';
  if (uatDone && !prRecorded) return 'ready_to_ship';
  return stateType;
}

const capBody = (text, max = 1200) => (text.length > max ? `${text.slice(0, max)}…` : text);

// Agile bug ticket body: trigger + Expected/Actual (+ Reproduction/Errors) from
// DEBUG.md's Symptoms section — fields the gsd-debug workflow already captures.
// A session without filled symptoms renders like before (trigger only).
export function bugBody(d) {
  const s = d.symptoms ?? {};
  return [
    d.trigger,
    s.expected ? `**Expected:**\n${s.expected}` : null,
    s.actual ? `**Actual:**\n${s.actual}` : null,
    s.reproduction ? `**Reproduction:**\n${s.reproduction}` : null,
    s.errors ? `**Errors:**\n${s.errors}` : null,
    `Debug session status: \`${d.status}\``,
    d.created ? `Created: ${d.created}` : null,
    `Source: \`.planning/${d.file}\``,
  ].filter(Boolean).join('\n\n');
}

// Agile task ticket body: Scope / Acceptance criteria. GSD's capture writes
// ## Problem/## Solution — Problem becomes the Scope; todos adopted from the
// board that carry ## Scope/## Acceptance Criteria round-trip those sections.
// Free-form bodies fall back to the raw excerpt.
export function todoBody(t) {
  const s = t.sections ?? {};
  const scope = s.scope ?? s.problem;
  const structured = scope ? [
    `**Scope:**\n${scope}`,
    s.solution && s.solution.toUpperCase() !== 'TBD' ? `**Proposed solution:**\n${s.solution}` : null,
    s['acceptance criteria'] ? `**Acceptance criteria:**\n${s['acceptance criteria']}` : null,
  ].filter(Boolean).join('\n\n') : null;
  return [
    structured ? capBody(structured) : t.excerpt,
    t.created ? `Created: ${t.created}` : null,
    `Source: \`.planning/${t.file}\``,
  ].filter(Boolean).join('\n\n');
}

// Plan sub-issue body: description + the PLAN.md content itself when the file
// exists on disk. GSD plans (YAML frontmatter + <objective>/<tasks> XML-ish
// blocks) are converted to real markdown sections by parse-plan; content the
// renderer does not recognize falls back to a code fence sized to survive any
// backtick runs inside the plan (raw tags would be swallowed as HTML).
const PLAN_CONTENT_MAX = 50_000;

const truncatePlan = (content) => (content.length > PLAN_CONTENT_MAX
  ? `${content.slice(0, PLAN_CONTENT_MAX)}\n… (truncated — full plan on disk)`
  : content);

function planBody(plan, onDisk) {
  if (!onDisk) {
    return `${plan.description}\n\nSource: \`.planning/phases/\` → \`${plan.file}\``;
  }
  const source = `Source: \`.planning/phases/${onDisk.dir}/${plan.file}\``;
  const rendered = renderPlanMarkdown(onDisk.content);
  if (rendered) {
    return `${plan.description}\n\n${truncatePlan(rendered)}\n\n${source}`;
  }
  const content = truncatePlan(onDisk.content);
  const longestRun = (content.match(/`+/g) ?? []).reduce((n, s) => Math.max(n, s.length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${plan.description}\n\n${fence}md\n${content}\n${fence}\n\n${source}`;
}

function phaseBody(phase) {
  const parts = [];
  if (phase.stub) {
    parts.push(`Phase materialized from the ${phase.milestone} milestone range; details in `
      + `\`.planning/milestones/${phase.milestone}-ROADMAP.md\`.`);
  }
  if (phase.goal) parts.push(`**Goal:**\n${phase.goal}`);
  if (phase.requirements) parts.push(`**Requirements:** ${phase.requirements}`);
  if (phase.dependsOn) parts.push(`**Depends on:** ${phase.dependsOn}`);
  if (phase.repo) parts.push(`**Repo:** ${phase.repo}`);
  if (phase.inserted) parts.push('_Phase inserted (INSERTED) outside the original numbering._');
  parts.push(`Source: \`.planning/ROADMAP.md\` → \`### Phase ${phase.number}\``);
  return parts.join('\n\n');
}

export async function buildDesired(planningDir) {
  const roadmapMd = await readFile(`${planningDir}/ROADMAP.md`, 'utf8');
  const stateMd = await readFile(`${planningDir}/STATE.md`, 'utf8').catch(() => '');
  const roadmap = parseRoadmap(roadmapMd);
  const currentPhase = stateMd ? parseCurrentPhase(stateMd) : null;

  const desired = { milestones: [], phases: [], plans: [], quicks: [], todos: [], debugs: [] };

  for (const m of roadmap.milestones) {
    desired.milestones.push({
      key: m.version,
      name: truncateTitle(`${m.version} — ${m.name}`),
      body: [
        m.description,
        m.status === 'shipped' ? `Shipped ${m.shippedDate}`
          : m.status === 'planned' ? 'Planned' : 'In progress',
        m.phaseRange ? `Phases ${m.phaseRange[0]}–${m.phaseRange[1]}` : null,
      ].filter(Boolean).join('\n\n'),
      targetDate: m.shippedDate ?? null,
    });
  }

  const artifacts = await parsePhaseArtifacts(planningDir);
  const executedPlans = await parseExecutedPlanIds(planningDir);
  const planContents = await parsePlanContents(planningDir);
  const projectDir = join(planningDir, '..');
  const siblingDirs = siblingReposFromPhases(roadmap.phases).map((rel) => join(projectDir, rel));
  const openPRs = await parseOpenPRs(projectDir, stateMd, siblingDirs);
  // Phases with a PR RECORDED in STATE.md (open or already merged) — tells
  // "never entered PR" (→ ready_to_ship) apart from "PR merged" (→ Done).
  const prRecorded = new Set(phasePRPairsFromState(stateMd).map((p) => p.phase));
  const milestoneStatus = new Map(roadmap.milestones.map((m) => [m.version, m.status]));

  // Sequence-aware: closing the last decimal sub-phase (75.5) also closes 75.
  const phaseStatuses = derivePhaseStatuses(roadmap.phases, currentPhase);
  for (const phase of roadmap.phases) {
    const status = phaseStatuses.get(String(phase.number));
    // Phase with no milestone and no activity → Backlog state (its own board column)
    let stateType = status === 'todo' && !phase.milestone ? 'backlog' : STATUS_TO_STATE_TYPE[status];
    const prs = openPRs.get(phase.number);
    stateType = stagePhase(
      stateType,
      artifacts.get(phase.number),
      milestoneStatus.get(phase.milestone) === 'shipped',
      prs,
      prRecorded.has(phase.number),
    );
    const prLines = stateType === 'code_review' && prs?.length
      ? `\n\n**Open PRs:**\n${prs.map((p) => `- [#${p.number} ${p.title}](${p.url}) · \`${p.repo}\``).join('\n')}`
      : '';
    const body = phaseBody(phase) + prLines;
    desired.phases.push({
      key: phase.number,
      title: truncateTitle(`Phase ${phase.number}: ${phase.title}`),
      body,
      stateType,
      milestoneKey: phase.milestone,
      // "Depends on: Phase N" → blocked_by relation in Plane (outside
      // issueHash: relations are diffed separately, against the real graph)
      dependsOn: phase.dependsOnPhases ?? [],
    });
    for (const plan of phase.plans) {
      const id = plan.file.replace(/-PLAN\.md$/, '');
      desired.plans.push({
        key: id,
        phaseKey: phase.number,
        title: truncateTitle(`${id} — ${plan.description}`),
        body: planBody(plan, planContents.get(id)),
        // checked in the roadmap OR executed on disk (SUMMARY.md present —
        // gsd-core doesn't tick the roadmap checklist)
        stateType: plan.checked || executedPlans.has(id) ? 'completed' : 'unstarted',
        milestoneKey: phase.milestone,
        labels: plan.wave != null ? [`wave-${plan.wave}`] : [],
      });
    }
  }

  for (const q of await parseQuickTasks(planningDir)) {
    desired.quicks.push({
      key: q.key,
      title: truncateTitle(`Quick: ${q.title}`),
      body: [
        q.excerpt,
        q.planFile ? `Source: \`.planning/${q.planFile}\`` : `Source: \`.planning/quick/${q.key}/\``,
      ].filter(Boolean).join('\n\n'),
      stateType: q.status === 'done' ? 'completed' : 'started',
      milestoneKey: null,
      labels: ['quick'],
    });
  }

  for (const t of await parsePendingTodos(planningDir)) {
    desired.todos.push({
      key: t.key,
      title: truncateTitle(`Todo: ${t.title}`),
      body: todoBody(t),
      stateType: t.resolved ? 'completed' : 'backlog',
      milestoneKey: null,
      labels: ['todo'],
    });
  }

  const DEBUG_DONE = new Set(['resolved', 'fixed', 'verified', 'closed', 'done']);
  for (const d of await parseDebugSessions(planningDir)) {
    desired.debugs.push({
      key: d.key,
      title: truncateTitle(`Bug: ${d.title}`),
      body: bugBody(d),
      // session exists = investigation started; terminal status OR moved to
      // debug/resolved/ (gsd-core) = resolved
      stateType: d.resolvedDir || DEBUG_DONE.has(d.status) ? 'completed' : 'started',
      milestoneKey: null,
      labels: ['bug'],
    });
  }

  return { roadmap, currentPhase, desired };
}
