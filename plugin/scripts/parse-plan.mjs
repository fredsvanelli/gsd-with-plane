// PLAN.md → Linear markdown. GSD plans are "executable prompts": YAML
// frontmatter (wave/depends_on/must_haves/...) + XML-ish blocks (<objective>,
// <tasks> with <task> children, <threat_model>, ...) — see the PLAN.md
// Structure section of gsd-core's planner agent. Linear's ProseMirror editor
// swallows raw tags as HTML, so instead of dumping the file in a code fence the
// renderer here converts the structure into real markdown sections.
//
// Tolerant by design: anything it does not recognize falls through as plain
// content, and a file with no frontmatter AND no known top-level tag returns
// null so the caller can keep the old code-fence fallback.

// --- tiny YAML subset parser (enough for plan frontmatter) -----------------
// Supports: `key: scalar`, `key: [inline, array]`, nested maps by indentation,
// `- scalar` sequences and `- key: value` object sequences. Comments and
// anything weirder are skipped rather than failing.

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(',').map((x) => parseScalar(x)) : [];
  }
  const quoted = s.match(/^"(.*)"$/s) ?? s.match(/^'(.*)'$/s);
  return quoted ? quoted[1] : s;
}

export function parseYamlLite(src) {
  const lines = src.split('\n')
    .map((l) => ({ indent: l.match(/^ */)[0].length, text: l.replace(/\s+$/, '') }))
    .filter((l) => l.text.trim() && !l.text.trim().startsWith('#'));

  function parseNodes(start, indent) {
    // Sequence?
    if (lines[start] && lines[start].indent >= indent && lines[start].text.trim().startsWith('- ')) {
      const arr = [];
      let i = start;
      const seqIndent = lines[start].indent;
      while (i < lines.length && lines[i].indent === seqIndent && lines[i].text.trim().startsWith('- ')) {
        const rest = lines[i].text.trim().slice(2);
        const kv = rest.match(/^([\w-]+):(?:\s+(.*))?$/);
        if (kv) {
          // object item: first pair inline, siblings on deeper-indented lines
          const obj = {};
          obj[kv[1]] = kv[2] !== undefined ? parseScalar(kv[2]) : '';
          i += 1;
          const childIndent = seqIndent + 2;
          while (i < lines.length && lines[i].indent >= childIndent && !lines[i].text.trim().startsWith('- ')) {
            const pair = lines[i].text.trim().match(/^([\w-]+):(?:\s+(.*))?$/);
            if (!pair) { i += 1; continue; }
            if (pair[2] !== undefined) {
              obj[pair[1]] = parseScalar(pair[2]);
              i += 1;
            } else {
              const [child, next] = parseNodes(i + 1, lines[i].indent + 1);
              obj[pair[1]] = child;
              i = next;
            }
          }
          arr.push(obj);
        } else {
          arr.push(parseScalar(rest));
          i += 1;
        }
      }
      return [arr, i];
    }
    // Mapping
    const map = {};
    let i = start;
    let mapIndent = null;
    while (i < lines.length && lines[i].indent >= indent) {
      const { indent: li, text } = lines[i];
      if (mapIndent === null) mapIndent = li;
      if (li !== mapIndent) { i += 1; continue; } // stray deeper line — skip
      const pair = text.trim().match(/^([\w-]+):(?:\s+(.*))?$/);
      if (!pair) { i += 1; continue; }
      if (pair[2] !== undefined) {
        map[pair[1]] = parseScalar(pair[2]);
        i += 1;
      } else {
        // nested block (map or sequence) — or empty value
        if (i + 1 < lines.length && lines[i + 1].indent > li) {
          const [child, next] = parseNodes(i + 1, li + 1);
          map[pair[1]] = child;
          i = next;
        } else {
          map[pair[1]] = '';
          i += 1;
        }
      }
    }
    return [map, i];
  }

  try {
    return parseNodes(0, 0)[0];
  } catch {
    return {};
  }
}

// --- XML-ish block tokenizer ------------------------------------------------
// Line-based: a tag opens/closes only on its own line (single-line
// `<tag>content</tag>` also supported). Fenced code regions are opaque —
// tags inside ``` blocks stay verbatim.

const OPEN_RE = /^<([a-z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*>$/;
const INLINE_RE = /^<([a-z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*>(.*)<\/\1>$/;
// Leaf tag whose content starts on the opening line and closes on a later one
// (multi-line <automated>cmd \n more</automated>).
const OPEN_REST_RE = /^<([a-z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*>(.+)$/;

// Strip the common leading indentation of a block's content — plans indent
// child-tag bodies, and ≥4 leading spaces would render as a markdown code block.
function dedent(text) {
  const lines = text.split('\n');
  let min = Infinity;
  for (const l of lines) {
    if (l.trim()) min = Math.min(min, l.match(/^ */)[0].length);
  }
  if (!min || min === Infinity) return text;
  return lines.map((l) => l.slice(min)).join('\n');
}

function parseAttrs(raw) {
  const attrs = {};
  for (const m of (raw ?? '').matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

// → array of {tag, attrs, content} for tag blocks and {tag: null, content}
// for loose markdown between them, in document order.
export function parsePlanBlocks(body) {
  const lines = body.split('\n');
  const out = [];
  let loose = [];
  const flushLoose = () => {
    const text = loose.join('\n').trim();
    if (text) out.push({ tag: null, attrs: {}, content: text });
    loose = [];
  };

  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) inFence = !inFence;
    if (inFence) { loose.push(line); continue; }

    const inline = trimmed.match(INLINE_RE);
    if (inline) {
      flushLoose();
      out.push({ tag: inline[1], attrs: parseAttrs(inline[2]), content: inline[3].trim() });
      continue;
    }
    const open = trimmed.match(OPEN_RE);
    if (!open) {
      // <tag>content…\n…</tag> — leaf block opened with trailing content
      const openRest = trimmed.match(OPEN_REST_RE);
      if (openRest && !openRest[3].includes('<')) {
        const tag = openRest[1];
        let fence = false;
        let close = -1;
        for (let j = i + 1; j < lines.length; j += 1) {
          const t = lines[j].trimEnd();
          if (/^\s*(```|~~~)/.test(t)) fence = !fence;
          if (!fence && t.endsWith(`</${tag}>`)) { close = j; break; }
        }
        if (close !== -1) {
          flushLoose();
          const tail = lines[close].trimEnd().slice(0, -`</${tag}>`.length);
          const middle = lines.slice(i + 1, close);
          out.push({
            tag,
            attrs: parseAttrs(openRest[2]),
            content: dedent([openRest[3], ...middle, tail].join('\n')).trim(),
          });
          i = close;
          continue;
        }
      }
      loose.push(line);
      continue;
    }

    // find the matching close, counting nested same-name opens, skipping fences
    const tag = open[1];
    let depth = 1;
    let fence = false;
    let close = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j].trim();
      if (/^(```|~~~)/.test(t)) fence = !fence;
      if (fence) continue;
      if (t.match(OPEN_RE)?.[1] === tag) depth += 1;
      else if (t === `</${tag}>`) {
        depth -= 1;
        if (depth === 0) { close = j; break; }
      }
    }
    if (close === -1) { loose.push(line); continue; } // unbalanced — keep as text

    flushLoose();
    out.push({
      tag,
      attrs: parseAttrs(open[2]),
      content: dedent(lines.slice(i + 1, close).join('\n').replace(/^\n+|\s+$/g, '')),
    });
    i = close;
  }
  flushLoose();
  return out;
}

// --- markdown helpers --------------------------------------------------------

// Linear swallows leftover angle-bracket runs (`<uuid>`, `<automated>` echoed
// in prose) as HTML — wrap them in code spans. Code spans and fenced blocks
// are left untouched.
export function escapeAngles(text) {
  const lines = text.split('\n');
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    // split out existing code spans; escape only the plain segments (where
    // every backtick after the replace is ours — adjacent wraps of adjacent
    // tags produce a double backtick that must be split apart)
    const segs = line.split(/(`+[^`]+`+)/g).map((seg, idx) => (
      idx % 2 ? seg : seg.replace(/<(\/?[a-zA-Z][^<>\n]*)>/g, '`<$1>`').replace(/``/g, '` `')
    ));
    // a wrap adjacent to an existing code span would merge the backtick runs
    // (`X``Y` reads as one span with a literal backtick) — keep them apart
    let out = '';
    for (const seg of segs) {
      if (out.endsWith('`') && seg.startsWith('`')) out += ' ';
      out += seg;
    }
    return out;
  }).join('\n');
}

// Demote markdown headings one level (## → ###) so block content nests under
// the section heading the renderer adds. Fenced code is left untouched.
function demoteHeadings(text) {
  const lines = text.split('\n');
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    return line.replace(/^(#{1,5})\s/, '#$1 ');
  }).join('\n');
}

const startsWithHeading = (text) => /^#{1,6}\s/.test(text);

const titleCase = (tag) => {
  const t = tag.replace(/[_-]+/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const codeList = (items) => items.map((x) => `\`${x}\``).join(', ');

const asArray = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);

// --- frontmatter rendering ---------------------------------------------------

function renderFrontmatter(fm) {
  const parts = [];

  const meta = [];
  if (fm.wave != null && fm.wave !== '') meta.push(`**Wave:** ${fm.wave}`);
  if (fm.type) meta.push(`**Type:** ${fm.type}`);
  if (fm.autonomous !== undefined) meta.push(`**Autonomous:** ${fm.autonomous === true ? 'yes' : 'no'}`);
  const reqs = asArray(fm.requirements);
  if (reqs.length) meta.push(`**Requirements:** ${reqs.join(', ')}`);
  const deps = asArray(fm.depends_on);
  if (deps.length) meta.push(`**Depends on:** ${codeList(deps)}`);
  if (fm.repo) meta.push(`**Repo:** \`${fm.repo}\``);
  if (meta.length) parts.push(meta.join(' · '));

  const files = asArray(fm.files_modified);
  if (files.length) {
    parts.push(`**Files modified:**\n${files.map((f) => `- \`${f}\``).join('\n')}`);
  }

  const mh = fm.must_haves;
  if (mh && typeof mh === 'object') {
    const sub = [];
    const truths = asArray(mh.truths);
    if (truths.length) sub.push(`**Truths:**\n${truths.map((t) => `- ${escapeAngles(String(t))}`).join('\n')}`);
    const artifacts = asArray(mh.artifacts);
    if (artifacts.length) {
      sub.push(`**Artifacts:**\n${artifacts.map((a) => (
        typeof a === 'object'
          ? `- \`${a.path}\`${a.provides ? ` — ${escapeAngles(String(a.provides))}` : ''}`
          : `- \`${a}\``
      )).join('\n')}`);
    }
    const links = asArray(mh.key_links);
    if (links.length) {
      sub.push(`**Key links:**\n${links.map((l) => (
        typeof l === 'object'
          ? `- \`${l.from}\` → \`${l.to}\`${l.via ? ` — ${escapeAngles(String(l.via))}` : ''}`
          : `- ${escapeAngles(String(l))}`
      )).join('\n')}`);
    }
    if (sub.length) parts.push(`## Must-haves\n\n${sub.join('\n\n')}`);
  }

  const setup = asArray(fm.user_setup);
  if (setup.length) {
    const items = setup.map((s) => {
      if (typeof s !== 'object') return `- ${s}`;
      const envs = asArray(s.env_vars).map((e) => (typeof e === 'object' ? e.name : e)).filter(Boolean);
      return `- **${s.service ?? 'setup'}**${s.why ? ` — ${s.why}` : ''}${envs.length ? ` (env: ${codeList(envs)})` : ''}`;
    });
    parts.push(`## User setup\n\n${items.join('\n')}`);
  }

  return parts;
}

// --- task rendering ------------------------------------------------------------

// Child tags rendered as bold labels, in this fixed order; unknown children
// fall back to a title-cased label at the end.
const TASK_CHILD_ORDER = ['condition', 'files', 'read_first', 'behavior', 'action', 'verify', 'acceptance_criteria', 'done'];
const TASK_CHILD_LABEL = {
  condition: 'Condition',
  files: 'Files',
  read_first: 'Read first',
  behavior: 'Behavior',
  action: 'Action',
  verify: 'Verify',
  acceptance_criteria: 'Acceptance criteria',
  done: 'Done when',
};

function renderVerify(content) {
  const inner = parsePlanBlocks(content);
  const labeled = inner.filter((b) => b.tag);
  if (!labeled.length) return `**Verify:**\n${escapeAngles(content)}`;
  return inner.map((b) => {
    if (!b.tag) return escapeAngles(b.content);
    const label = b.tag === 'automated' ? 'Verify (automated)'
      : b.tag === 'human-check' || b.tag === 'manual' ? 'Verify (human)'
        : `Verify (${b.tag})`;
    const cmd = b.content.includes('\n') || b.content.length > 80
      ? `\`\`\`bash\n${b.content}\n\`\`\``
      : `\`${b.content}\``;
    return `**${label}:** ${cmd.startsWith('```') ? `\n${cmd}` : cmd}`;
  }).join('\n');
}

function renderTask(task, index) {
  const children = parsePlanBlocks(task.content);
  const byTag = new Map();
  const extras = [];
  for (const c of children) {
    if (c.tag && !byTag.has(c.tag)) byTag.set(c.tag, c);
    else extras.push(c);
  }

  const name = byTag.get('name')?.content ?? `Task ${index + 1}`;
  byTag.delete('name');

  const badges = [];
  if (task.attrs.type && task.attrs.type !== 'auto') badges.push(`\`${task.attrs.type}\``);
  if (task.attrs.tdd === 'true') badges.push('`tdd`');
  if (task.attrs.gate) badges.push(`\`gate: ${task.attrs.gate}\``);

  const lines = [`### ${escapeAngles(name)}${badges.length ? ` — ${badges.join(' ')}` : ''}`];

  const renderChild = (tag, block) => {
    const content = block.content;
    if (tag === 'files') {
      const files = content.split(/[,\n]/).map((f) => f.trim()).filter(Boolean);
      return `**Files:** ${codeList(files)}`;
    }
    if (tag === 'verify') return renderVerify(content);
    const label = TASK_CHILD_LABEL[tag] ?? titleCase(tag);
    const body = escapeAngles(content);
    // block form for multi-line content and for lists (a bullet glued after
    // the label would not render as a list)
    return content.includes('\n') || content.startsWith('- ')
      ? `**${label}:**\n${body}` : `**${label}:** ${body}`;
  };

  for (const tag of TASK_CHILD_ORDER) {
    if (byTag.has(tag)) {
      lines.push(renderChild(tag, byTag.get(tag)));
      byTag.delete(tag);
    }
  }
  for (const [tag, block] of byTag) lines.push(renderChild(tag, block));
  for (const extra of extras) {
    lines.push(extra.tag ? renderChild(extra.tag, extra) : escapeAngles(extra.content));
  }
  return lines.join('\n\n');
}

function renderTasks(content) {
  const blocks = parsePlanBlocks(content);
  const parts = ['## Tasks'];
  let index = 0;
  for (const b of blocks) {
    if (b.tag === 'task') {
      parts.push(renderTask(b, index));
      index += 1;
    } else if (b.content.trim()) {
      parts.push(escapeAngles(b.content)); // loose prose between tasks (rare)
    }
  }
  return parts.join('\n\n');
}

// --- top-level rendering ---------------------------------------------------------

// Blocks that are executor plumbing, meaningless on a board.
const SKIP_TAGS = new Set(['execution_context']);

const SECTION_TITLE = {
  objective: 'Objective',
  context: 'Context',
  threat_model: 'Threat model',
  verification: 'Verification',
  success_criteria: 'Success criteria',
  output: 'Output',
};

const KNOWN_TAGS = new Set([...Object.keys(SECTION_TITLE), ...SKIP_TAGS, 'tasks', 'task']);

function renderContextBlock(content) {
  const refs = content.split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#')) // "# Only reference..." comments
    .map((l) => (l.startsWith('@') ? `- \`${l}\`` : `- ${escapeAngles(l)}`));
  return refs.length ? `## Context\n\n${refs.join('\n')}` : null;
}

function renderSection(block) {
  if (block.tag === 'context') return renderContextBlock(block.content);
  if (block.tag === 'tasks') return renderTasks(block.content);

  const known = SECTION_TITLE[block.tag];
  const content = escapeAngles(block.content);
  if (known) return `## ${known}\n\n${demoteHeadings(content)}`;
  // Custom block (<balance_decision>, <phase_goal>...): its own leading
  // heading wins; otherwise title-case the tag.
  if (startsWithHeading(content)) return content;
  return `## ${titleCase(block.tag)}\n\n${demoteHeadings(content)}`;
}

// PLAN.md text → Linear-ready markdown, or null when the file has neither
// frontmatter nor any known GSD block (caller falls back to a code fence).
export function renderPlanMarkdown(text) {
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const body = fmMatch ? text.slice(fmMatch[0].length) : text;
  const blocks = parsePlanBlocks(body);

  const recognizable = fmMatch || blocks.some((b) => b.tag && KNOWN_TAGS.has(b.tag));
  if (!recognizable) {
    // Plans hand-written as plain markdown (heading-first, no GSD structure)
    // are already board-ready — pass them through with tags escaped.
    const trimmed = text.trim();
    return startsWithHeading(trimmed) ? escapeAngles(trimmed) : null;
  }

  const parts = [];
  if (fmMatch) parts.push(...renderFrontmatter(parseYamlLite(fmMatch[1])));
  for (const block of blocks) {
    if (block.tag && SKIP_TAGS.has(block.tag)) continue;
    if (!block.tag) {
      parts.push(escapeAngles(block.content)); // loose markdown (MVP user story etc.)
      continue;
    }
    const section = renderSection(block);
    if (section) parts.push(section);
  }
  return parts.join('\n\n').trim();
}
