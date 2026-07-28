// Markdown ⇄ HTML for Plane. Plane's public API takes issue bodies as
// `description_html` (it rejects/sanitizes anything else server-side), while
// the whole pipeline — GSD parsing, hashes, markers — speaks markdown. This
// module is the boundary: mdToHtml() right before a write, htmlToText() when
// reading foreign content back. No dependencies; covers exactly the constructs
// desired.mjs and renderPlanMarkdown emit (headings, lists, fences, bold,
// italic, inline code, links, hr, blockquotes). Anything else degrades to a
// plain paragraph — acceptable: local .planning/ is the source of truth and
// the board copy is a mirror.

const escapeHtml = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Inline markdown on an ALREADY-ESCAPED line. Order matters: code spans first
// (their content must not be re-processed as bold/links).
function inline(escaped) {
  const codeSpans = [];
  let text = escaped.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  text = text
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|\s)_([^_\s][^_]*)_/g, '$1<em>$2</em>');
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => codeSpans[Number(i)]);
}

export function mdToHtml(markdown) {
  const lines = (markdown ?? '').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol' while inside a list
  let para = [];

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map((l) => inline(escapeHtml(l))).join('<br/>')}</p>`);
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^(`{3,}|~{3,})(\w*)\s*$/);
    if (fence) {
      flushPara(); closeList();
      const code = [];
      i++;
      // closing fence: same char, at least as long (longer fences protect
      // backtick runs inside plan content — see desired.mjs planBody)
      const closeRe = new RegExp(`^${fence[1][0] === '~' ? '~' : '`'}{${fence[1].length},}\\s*$`);
      while (i < lines.length && !closeRe.test(lines[i])) code.push(lines[i++]);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara(); closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flushPara(); closeList();
      out.push('<hr/>');
      continue;
    }
    const li = line.match(/^\s*[-*]\s+(.*)$/) ?? line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (li) {
      flushPara();
      const kind = /^\s*[-*]/.test(line) ? 'ul' : 'ol';
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(escapeHtml(li[1]))}</li>`);
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushPara(); closeList();
      out.push(`<blockquote><p>${inline(escapeHtml(quote[1]))}</p></blockquote>`);
      continue;
    }
    if (!line.trim()) {
      flushPara(); closeList();
      continue;
    }
    closeList();
    para.push(line);
  }
  flushPara(); closeList();
  return out.join('');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e) => ENTITIES[e]);
}

// HTML → readable plain text (adopting foreign issues: Plane's API returns
// only description_html — description_stripped is excluded server-side).
export function htmlToText(html) {
  if (!html) return '';
  let text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  return text.replace(/\n{3,}/g, '\n\n').trim();
}
