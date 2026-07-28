// html.mjs is the Plane boundary: markdown bodies → description_html on write,
// HTML → text when adopting foreign issues. The marker must survive the full
// trip (markdown → HTML → Plane sanitizer-ish output → parseMarker).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mdToHtml, htmlToText } from '../plugin/scripts/html.mjs';
import { marker, parseMarker, MARKER_RE } from '../plugin/scripts/common.mjs';

test('mdToHtml: headings, lists, inline code, bold, links, hr', () => {
  const html = mdToHtml([
    '## Objective',
    '',
    'Fix the **auth** flow with `code`.',
    '',
    '- item one',
    '- item `two`',
    '',
    '1. first',
    '2. second',
    '',
    '---',
    '',
    '[link](https://example.com/x)',
  ].join('\n'));
  assert.match(html, /<h2>Objective<\/h2>/);
  assert.match(html, /<strong>auth<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>item one<\/li><li>item <code>two<\/code><\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<hr\/>/);
  assert.match(html, /<a href="https:\/\/example\.com\/x" target="_blank">link<\/a>/);
});

test('mdToHtml: code fences escape HTML and respect longer fences', () => {
  const html = mdToHtml(['````md', 'has ```inner``` fence and <objective> tag', '````'].join('\n'));
  assert.match(html, /<pre><code>has ```inner``` fence and &lt;objective&gt; tag<\/code><\/pre>/);
});

test('mdToHtml: plain text is escaped (no HTML injection from .planning content)', () => {
  const html = mdToHtml('a <script>alert(1)</script> & "quotes"');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test('mdToHtml: paragraph lines join with <br/>, blank lines split paragraphs', () => {
  const html = mdToHtml('line one\nline two\n\nsecond para');
  assert.match(html, /<p>line one<br\/>line two<\/p><p>second para<\/p>/);
});

test('marker survives markdown → HTML → parseMarker (push round trip)', () => {
  const mk = marker('plan', '60-04', 'abc123def456');
  const html = mdToHtml(`Some body\n\n---\n${mk}`);
  assert.match(html, /<code>gsd-sync:plan=60-04:h=abc123def456<\/code>/);
  const parsed = parseMarker(html);
  assert.deepEqual(parsed, { kind: 'plan', key: '60-04', hash: 'abc123def456' });
});

test('parseMarker: matches plain-text (project/module descriptions) and adoption HTML', () => {
  assert.deepEqual(
    parseMarker('body\n\n`gsd-sync:milestone=v1.2:h=0011aabbccdd`'),
    { kind: 'milestone', key: 'v1.2', hash: '0011aabbccdd' },
  );
  // adoption path appends raw HTML without backticks
  assert.deepEqual(
    parseMarker('<p>desc</p><hr/><p><code>gsd-sync:todo=2026-07-16-fix:h=000000000000</code></p>'),
    { kind: 'todo', key: '2026-07-16-fix', hash: '000000000000' },
  );
  assert.equal(parseMarker('<p>no marker here</p>'), null);
});

test('MARKER_RE: key never swallows tags or entities', () => {
  const m = '<code>gsd-sync:phase=2.1:h=ffffffffffff</code><p>tail</p>'.match(MARKER_RE);
  assert.equal(m[2], '2.1');
});

test('htmlToText: readable adoption text from Plane description_html', () => {
  const text = htmlToText(
    '<h2>Scope</h2><p>Do the thing &amp; more</p><ul><li>one</li><li>two</li></ul>',
  );
  assert.equal(text, 'Scope\nDo the thing & more\n- one\n- two');
});

test('htmlToText: empty/null-safe', () => {
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(null), '');
  assert.equal(htmlToText(undefined), '');
});
