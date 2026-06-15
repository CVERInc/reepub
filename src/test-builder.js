// Unit tests for the headless EPUB text/geometry helpers (src/epub-text.js) and
// for XML-escaping regressions. These exercise the parts of the build pipeline
// that don't need the native Swift OCR binary, so they run anywhere `npm test`
// does. Each escaping test is a regression: it fails against the old
// "&-only" escaping and passes once <, >, and " are encoded too.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { escapeXML, escapeAttr, joinText, processPage } = require('./epub-text');

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    console.error(`  [FAIL] ${message}`);
    failures++;
  } else {
    console.log(`  [PASS] ${message}`);
  }
}

// Returns true if the given XML fragment is well-formed per xmllint.
function isWellFormed(xml) {
  const tmp = path.join(os.tmpdir(), `reepub-xmltest-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`);
  fs.writeFileSync(tmp, xml, 'utf8');
  try {
    execFileSync('xmllint', ['--noout', tmp], { stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

console.log('Starting builder/escaping unit tests...\n');

// --- escapeXML: element content ---
assert(escapeXML('a & b < c > d') === 'a &amp; b &lt; c &gt; d',
  'escapeXML encodes &, < and > in element content');
assert(escapeXML('<') === '&lt;', 'escapeXML encodes a bare <');
// Regression: the old escaper only handled &, leaving < and > raw.
assert(!escapeXML('x < y').includes('< '),
  'escapeXML must not leave a raw < (old &-only escaper regression)');

// --- escapeAttr: attribute value (adds ") ---
assert(escapeAttr('say "hi" & <bye>') === 'say &quot;hi&quot; &amp; &lt;bye&gt;',
  'escapeAttr encodes ", &, < and > for attribute values');
assert(!escapeAttr('a"b').includes('"'),
  'escapeAttr must not leave a raw double-quote that would close an attribute');

// --- End-to-end: hostile title flows into well-formed XML ---
const hostileTitle = 'A <b> & "Q" > end';

// title in an element (e.g. <dc:title>, <h1>, <title>, ncx <text>)
assert(isWellFormed(`<?xml version="1.0"?><t>${escapeXML(hostileTitle)}</t>`),
  'Hostile title escaped for element content yields well-formed XML');
// the same hostile title in an attribute (e.g. alt="...")
assert(isWellFormed(`<?xml version="1.0"?><img alt="${escapeAttr(hostileTitle)}"/>`),
  'Hostile title escaped for an attribute yields well-formed XML');
// proof the bug was real: the OLD &-only escaping is NOT well-formed
const oldAmpOnly = hostileTitle.replace(/&/g, '&amp;');
assert(isWellFormed(`<?xml version="1.0"?><t>${oldAmpOnly}</t>`) === false,
  'Sanity: old &-only escaping of a hostile title is malformed (the bug)');

// --- joinText: CJK vs Latin spacing ---
assert(joinText([{ text: 'Hello' }, { text: 'World' }]) === 'Hello World',
  'joinText inserts a space between two Latin runs');
assert(joinText([{ text: '你好' }, { text: '世界' }]) === '你好世界',
  'joinText does not insert a space between CJK runs');
assert(joinText([{ text: 'A' }, { text: '' }, { text: 'B' }]) === 'A B',
  'joinText skips an empty middle line without dropping spacing logic');
assert(joinText([{ text: '價' }, { text: '錢' }]) === '價錢',
  'joinText keeps CJK contiguous');

// --- processPage: header/footer filtering + paragraph break on big gap ---
const page = {
  lines: [
    { text: 'PAGE HEADER', x: 0.1, y: 0.97, width: 0.5, height: 0.02 }, // header, dropped
    { text: 'First line of paragraph one.', x: 0.1, y: 0.80, width: 0.8, height: 0.03 },
    { text: 'still paragraph one', x: 0.1, y: 0.76, width: 0.8, height: 0.03 },
    // large vertical gap → new paragraph
    { text: 'Paragraph two begins here.', x: 0.1, y: 0.50, width: 0.8, height: 0.03 },
    { text: '42', x: 0.1, y: 0.02, width: 0.1, height: 0.02 }, // footer page number, dropped
  ],
};
const paras = processPage(page);
assert(paras.length === 2, `processPage splits on a large gap and drops header/footer (got ${paras.length} paragraphs)`);
const joined = paras.map(p => p.text).join(' | ');
assert(!joined.includes('PAGE HEADER'), 'processPage drops the top header line');
assert(!joined.includes('42'), 'processPage drops the bottom footer/page-number line');

assert(processPage({ lines: [] }).length === 0, 'processPage returns no paragraphs for an empty page');
assert(processPage({ lines: null }).length === 0, 'processPage tolerates a null lines array');

if (failures === 0) {
  console.log('\n[SUCCESS] All builder/escaping unit tests passed!');
  process.exit(0);
} else {
  console.error(`\n[FAILURE] ${failures} unit test(s) failed.`);
  process.exit(1);
}
