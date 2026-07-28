// parse-plan: GSD PLAN.md (YAML frontmatter + XML-ish blocks) → Linear markdown.
// The fixture mirrors the PLAN.md Structure of gsd-core's planner agent and a
// real plan of the connected project (frontmatter with must_haves, tdd tasks,
// <verify><automated>, threat_model tables, custom decision blocks).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseYamlLite, parsePlanBlocks, escapeAngles, renderPlanMarkdown,
} from '../plugin/scripts/parse-plan.mjs';

const PLAN = `---
phase: 50-recon-ui
plan: 01
type: execute
wave: 1
repo: acme-shipping-api
depends_on: [50-00]
files_modified:
  - src/handlers/statements.ts
  - src/__tests__/list-statements.test.ts
autonomous: true
requirements: [RECON-04]
user_setup:
  - service: stripe
    why: "Payment processing"
    env_vars:
      - name: STRIPE_SECRET_KEY
        source: "Stripe Dashboard"
must_haves:
  truths:
    - "GET /statements?bankAccountId=<uuid> returns paginated statements"
    - "Route is admin gated"
  artifacts:
    - path: "src/handlers/statements.ts"
      provides: "listStatements handler"
      exports: ["listStatements"]
  key_links:
    - from: "src/app/statements/route.ts"
      to: "src/handlers/statements.ts"
      via: "export const GET = createAdminHandler(listStatements)"
      pattern: "listStatements"
---

<objective>
Add the minimal backend read endpoint the screen needs.

Purpose: the screen is account-centric.
Output: a handler + a DTO.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md

# Only reference prior plan SUMMARYs if genuinely needed
@src/lib/pagination.ts
</context>

<balance_decision>
## Balance approach (decided, do not re-litigate)

Expose balance = initialBalance for accounts, null for cards.
</balance_decision>

<tasks>

<task type="auto">
  <name>Task 1: filter schema (XOR + pagination)</name>
  <files>src/schemas/ReconciliationSchemas.ts</files>
  <action>
    Add listStatementsFiltersSchema with bankAccountId XOR creditCardId.
  </action>
  <verify>
    <automated>npx tsc --noEmit</automated>
  </verify>
  <done>Schema exists and typechecks</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: expected-RED integration spec</name>
  <files>src/__tests__/list-statements.test.ts</files>
  <read_first>
    - src/__tests__/bank-statements.test.ts (the analog)
  </read_first>
  <behavior>
    - Test 1: lists statements most-recent-first
    - Test 2: rejects both origins (422)
  </behavior>
  <action>
    Create the spec importing the not-yet-built listStatements handler.
  </action>
  <verify>
    <automated>cd /repo && DATABASE_URL=postgresql://localhost/test yarn test -- list-statements
more lines</automated>
  </verify>
  <acceptance_criteria>
    - 8 cases present
    - suite is RED
  </acceptance_criteria>
  <done>RED spec committed</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 3: confirm the board renders</name>
  <action>Open Linear and check the card.</action>
  <done>User confirmed</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| browser → GET route | query params cross here |
</threat_model>

<verification>
- list-statements.test.ts 8/8 GREEN
</verification>

<success_criteria>
- XOR origin enforced (422 on neither/both)
</success_criteria>

<output>
Create \`.planning/phases/50-recon-ui/50-01-SUMMARY.md\` when done.
</output>
`;

test('parseYamlLite: scalars, inline arrays, block lists, nested object lists', () => {
  const fm = parseYamlLite(PLAN.match(/^---\n([\s\S]*?)\n---\n/)[1]);
  assert.equal(fm.wave, '1');
  assert.equal(fm.autonomous, true);
  assert.deepEqual(fm.depends_on, ['50-00']);
  assert.deepEqual(fm.requirements, ['RECON-04']);
  assert.deepEqual(fm.files_modified, ['src/handlers/statements.ts', 'src/__tests__/list-statements.test.ts']);
  assert.equal(fm.must_haves.truths.length, 2);
  assert.equal(fm.must_haves.artifacts[0].path, 'src/handlers/statements.ts');
  assert.deepEqual(fm.must_haves.artifacts[0].exports, ['listStatements']);
  assert.equal(fm.must_haves.key_links[0].via, 'export const GET = createAdminHandler(listStatements)');
  assert.equal(fm.user_setup[0].service, 'stripe');
  assert.equal(fm.user_setup[0].env_vars[0].name, 'STRIPE_SECRET_KEY');
});

test('parsePlanBlocks: top-level blocks in order, attrs, loose markdown', () => {
  const body = PLAN.replace(/^---\n[\s\S]*?\n---\n/, '');
  const blocks = parsePlanBlocks(body);
  assert.deepEqual(
    blocks.map((b) => b.tag),
    ['objective', 'execution_context', 'context', 'balance_decision', 'tasks',
      'threat_model', 'verification', 'success_criteria', 'output'],
  );
  const tasks = parsePlanBlocks(blocks.find((b) => b.tag === 'tasks').content)
    .filter((b) => b.tag === 'task');
  assert.equal(tasks.length, 3);
  assert.equal(tasks[1].attrs.tdd, 'true');
  assert.equal(tasks[2].attrs.type, 'checkpoint:human-verify');
  assert.equal(tasks[2].attrs.gate, 'blocking');
});

test('parsePlanBlocks: tags inside code fences stay verbatim', () => {
  const blocks = parsePlanBlocks('<action>\nUse this snippet:\n```xml\n<task type="auto">\n</task>\n```\ndone\n</action>');
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].content, /<task type="auto">/);
});

test('escapeAngles: wraps bare tags, leaves code spans and fences alone', () => {
  assert.equal(escapeAngles('GET ?id=<uuid> works'), 'GET ?id=`<uuid>` works');
  assert.equal(escapeAngles('keep `<automated>` as is'), 'keep `<automated>` as is');
  assert.equal(escapeAngles('```\n<objective>\n```'), '```\n<objective>\n```');
  assert.equal(escapeAngles('a < b and a > b'), 'a < b and a > b');
});

test('renderPlanMarkdown: frontmatter → meta line, files, must-haves, user setup', () => {
  const md = renderPlanMarkdown(PLAN);
  assert.match(md, /\*\*Wave:\*\* 1 · \*\*Type:\*\* execute · \*\*Autonomous:\*\* yes · \*\*Requirements:\*\* RECON-04 · \*\*Depends on:\*\* `50-00` · \*\*Repo:\*\* `acme-shipping-api`/);
  assert.match(md, /\*\*Files modified:\*\*\n- `src\/handlers\/statements\.ts`/);
  assert.match(md, /## Must-haves/);
  assert.match(md, /- GET \/statements\?bankAccountId=`<uuid>` returns paginated statements/);
  assert.match(md, /- `src\/handlers\/statements\.ts` — listStatements handler/);
  assert.match(md, /- `src\/app\/statements\/route\.ts` → `src\/handlers\/statements\.ts` — export const GET/);
  assert.match(md, /## User setup\n\n- \*\*stripe\*\* — Payment processing \(env: `STRIPE_SECRET_KEY`\)/);
});

test('renderPlanMarkdown: body sections become markdown, no raw tags survive', () => {
  const md = renderPlanMarkdown(PLAN);
  assert.match(md, /## Objective\n\nAdd the minimal backend read endpoint/);
  // execution_context is executor plumbing — skipped
  assert.doesNotMatch(md, /execute-plan\.md/);
  // context @refs become a code-span list; the "# comment" line is dropped
  assert.match(md, /## Context\n\n- `@\.planning\/PROJECT\.md`/);
  assert.doesNotMatch(md, /Only reference prior plan/);
  // custom block keeps its own heading, no invented one
  assert.match(md, /## Balance approach \(decided, do not re-litigate\)/);
  assert.doesNotMatch(md, /## Balance decision/);
  // threat_model: added heading + inner headings demoted
  assert.match(md, /## Threat model\n\n### Trust Boundaries/);
  assert.match(md, /\| browser → GET route \|/);
  assert.match(md, /## Verification/);
  assert.match(md, /## Success criteria/);
  assert.match(md, /## Output/);
  // no structural tag leaks into the rendered output
  for (const tag of ['<objective>', '<tasks>', '<task ', '<name>', '<verify>', '<automated>', '</']) {
    assert.ok(!md.includes(tag), `leaked ${tag}`);
  }
});

test('renderPlanMarkdown: tasks → ### sections with labeled fields and badges', () => {
  const md = renderPlanMarkdown(PLAN);
  assert.match(md, /## Tasks/);
  assert.match(md, /### Task 1: filter schema \(XOR \+ pagination\)\n\n\*\*Files:\*\* `src\/schemas\/ReconciliationSchemas\.ts`/);
  assert.match(md, /\*\*Action:\*\* Add listStatementsFiltersSchema/);
  assert.match(md, /\*\*Verify \(automated\):\*\* `npx tsc --noEmit`/);
  assert.match(md, /\*\*Done when:\*\* Schema exists and typechecks/);
  // tdd badge + multi-line verify becomes a bash fence
  assert.match(md, /### Task 2: expected-RED integration spec — `tdd`/);
  assert.match(md, /\*\*Read first:\*\*\n- src\/__tests__\/bank-statements\.test\.ts/);
  assert.match(md, /\*\*Behavior:\*\*\n- Test 1: lists statements most-recent-first/);
  assert.match(md, /\*\*Verify \(automated\):\*\* \n```bash\ncd \/repo && DATABASE_URL=postgresql:\/\/localhost\/test yarn test -- list-statements\nmore lines\n```/);
  assert.match(md, /\*\*Acceptance criteria:\*\*\n- 8 cases present/);
  // checkpoint task badges
  assert.match(md, /### Task 3: confirm the board renders — `checkpoint:human-verify` `gate: blocking`/);
});

test('renderPlanMarkdown: loose markdown (MVP user story) is kept in place', () => {
  const md = renderPlanMarkdown('---\nwave: 1\n---\n\n## Phase Goal\n\n**As a** user, **I want to** sync, **so that** I see the board.\n\n<objective>\nDo it.\n</objective>');
  assert.match(md, /## Phase Goal\n\n\*\*As a\*\* user/);
  assert.match(md, /## Objective\n\nDo it\./);
});

test('renderPlanMarkdown: quick-task plan without frontmatter still renders', () => {
  const md = renderPlanMarkdown('<objective>\nFix the flaky test.\n</objective>\n\n<tasks>\n<task type="auto">\n  <name>Task 1: fix</name>\n  <action>Pin the clock.</action>\n</task>\n</tasks>');
  assert.match(md, /## Objective\n\nFix the flaky test\./);
  assert.match(md, /### Task 1: fix/);
});

test('renderPlanMarkdown: heading-first plain-markdown plans pass through', () => {
  const md = renderPlanMarkdown('# Phase 52 · Plan 01 — data layer\n\n## Types\nMirror the contract of <FinancialReports>.');
  assert.match(md, /^# Phase 52 · Plan 01 — data layer/);
  assert.match(md, /Mirror the contract of `<FinancialReports>`\./);
});

test('renderPlanMarkdown: unrecognizable content returns null (caller keeps the fence)', () => {
  assert.equal(renderPlanMarkdown('just some prose\n\nwith paragraphs'), null);
  // unknown tags alone (no frontmatter, no known GSD block) do not count
  assert.equal(renderPlanMarkdown('<weird>\nstuff\n</weird>'), null);
});

test('escapeAngles: wrap adjacent to an existing code span keeps the runs apart', () => {
  assert.equal(
    escapeAngles('renders `<span class="add">`<PlusIcon /> ok'),
    'renders `<span class="add">` `<PlusIcon />` ok',
  );
});

test('renderPlanMarkdown: unbalanced tag degrades to text, not a crash', () => {
  const md = renderPlanMarkdown('---\nwave: 2\n---\n<objective>\nnever closed');
  assert.match(md, /\*\*Wave:\*\* 2/);
  assert.match(md, /`<objective>`/); // escaped, not swallowed
});
