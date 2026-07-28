// Terminal preview of the board the sync would create in Plane.
// Usage: node plugin/scripts/preview-board.mjs [path to .planning] [--all]
// Without --all, shipped milestones appear collapsed (one line each).
import { readFile } from 'node:fs/promises';
import { parseRoadmap, derivePhaseStatuses, parseCurrentPhase } from './parse-roadmap.mjs';

const args = process.argv.slice(2);
const showAll = args.includes('--all');
const planningDir = args.find((a) => !a.startsWith('--')) ?? '.planning';

const roadmap = parseRoadmap(await readFile(`${planningDir}/ROADMAP.md`, 'utf8'));
const currentPhase = parseCurrentPhase(await readFile(`${planningDir}/STATE.md`, 'utf8'));

const STATUS_ICON = { done: '✅', in_progress: '🔵', todo: '⬜' };

// Sequence-aware: closing the last decimal sub-phase (75.5) also closes 75.
const phaseStatuses = derivePhaseStatuses(roadmap.phases, currentPhase);

const groups = new Map(roadmap.milestones.map((m) => [m.version, []]));
const backlog = [];
for (const phase of roadmap.phases) {
  (groups.get(phase.milestone) ?? backlog).push(phase);
}

console.log(`# Plane Project: ${roadmap.title}`);
console.log(`  current phase (STATE.md): ${currentPhase ?? '—'}\n`);

function printPhase(phase) {
  const status = phaseStatuses.get(String(phase.number));
  const plans = phase.plans.length
    ? ` [${phase.plans.filter((p) => p.checked).length}/${phase.plans.length} plans]`
    : phase.plansSummary
      ? ` [${phase.plansSummary.done}/${phase.plansSummary.total} plans]`
      : '';
  const marks = [phase.inserted && 'INSERTED', phase.stub && 'stub'].filter(Boolean);
  const suffix = marks.length ? ` (${marks.join(', ')})` : '';
  console.log(`  ${STATUS_ICON[status]} Phase ${phase.number}: ${phase.title}${plans}${suffix}`);
  for (const plan of phase.plans) {
    const wave = plan.wave !== null && plan.wave !== undefined ? ` · wave ${plan.wave}` : '';
    console.log(`      ${plan.checked ? '✔' : '·'} ${plan.file}${wave}`);
  }
}

for (const milestone of roadmap.milestones) {
  const phases = groups.get(milestone.version) ?? [];
  const doneCount = phases.filter((p) => phaseStatuses.get(String(p.number)) === 'done').length;
  const header = `## Milestone ${milestone.version} — ${milestone.name} · ${milestone.status}`
    + `${milestone.shippedDate ? ` ${milestone.shippedDate}` : ''} · ${doneCount}/${phases.length} phases`;
  console.log(header);
  if (milestone.status === 'shipped' && !showAll) {
    console.log('  (collapsed — use --all)\n');
    continue;
  }
  phases.forEach(printPhase);
  console.log('');
}

console.log(`## Backlog (no milestone) · ${backlog.length} phases`);
backlog.forEach(printPhase);
