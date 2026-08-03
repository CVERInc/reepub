#!/usr/bin/env node
// check-sync-markers.mjs — CI guard over the shared HEURISTICS of the two EPUB
// builders: the Node CLI (src/builder.js + src/epub-text.js) and the native app
// (packages/epub-kit/Sources/EpubKit/EpubBuilder.swift).
//
// What it does NOT establish: that the two produce the same book. They do not.
// The app assembles its own package document, NCX and navigation document, and
// its cover is page one wrapped as an image where the CLI typesets one through a
// browser — so the two diverge by construction, not by drift. This file compares
// the constants that exist on BOTH sides; passing it means those agree, and
// nothing wider. See HANDOFF.md for the inventory and the decision that ends the
// split.
//
// It checks two different things:
//
//   1. The shared `// sync-marker: vN` line — a mechanical reminder that whoever
//      last touched one side revisited the others.
//   2. The heuristics themselves, re-derived from BOTH sources and compared: the
//      break-punctuation set, the heading length metric, the paragraph geometry
//      thresholds, and the XML escape table.
//
// (2) exists because (1) alone is not evidence of anything. Behind a passing
// marker check, '“' was missing from the Node break set (so an opening quote at
// end-of-line started a paragraph in the app and did not in the CLI) and Node
// measured heading length in UTF-16 code units while Swift measured graphemes (so
// a 25-character CJK Ext-B title became <h2> in the app and <p> in the CLI). Both
// are the same class of bug: a shared constant that only ever existed twice.
//
// joinText's Latin-run test is spelled too differently in the two languages to
// compare textually; src/test-builder.js covers it instead. structureChapters
// lives in src/builder.js, which assembles no heuristics of its own beyond the
// chapter-title keywords.
//
// Every extractor fails loudly when its anchor is missing: a refactor that hides a
// heuristic from this checker must break the build, never silently pass it.
//
// Exit 0 = the implementations agree. Exit 1 = they don't. All problems are
// reported in a single run. No dependencies.

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const JS = 'src/epub-text.js';
const SWIFT = 'packages/epub-kit/Sources/EpubKit/EpubBuilder.swift';
const MARKER_FILES = ['src/builder.js', JS, SWIFT];

const read = (relPath) => readFile(join(repoRoot, relPath), 'utf8');

let failed = 0;

function pass(what) {
  console.log(`✓ ${what}`);
}

function fail(what, lines) {
  failed++;
  console.error(`✗ ${what}`);
  for (const line of lines) console.error(`    ${line}`);
}

// A check returns an array of problem lines (failure), a string (pass, with a
// note worth seeing in the CI log), or nothing (plain pass). A throwing extractor
// counts as a failure so a missing anchor can never read as agreement.
function check(what, fn) {
  try {
    const result = fn();
    if (Array.isArray(result)) fail(what, result);
    else pass(result ? `${what} — ${result}` : what);
  } catch (err) {
    fail(what, [err.message]);
  }
}

function must(source, relPath, pattern, what) {
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`${relPath}: cannot locate ${what} (searched for ${pattern})`);
  }
  return match;
}

const codePoint = (c) => `${c} (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`;

// Split a regex character-class body into its members. The class must spell its
// punctuation out literally; the only escapes understood here are identity
// escapes such as \. — anything cleverer compares unequal, which is the safe
// direction to fail.
function charClassMembers(body) {
  const chars = [...body];
  const members = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '\\' && i + 1 < chars.length) i++;
    members.push(chars[i]);
  }
  return members;
}

// Swift string-literal contents: only \" and \\ occur in the tables read here.
const swiftLiteral = (raw) => raw.replace(/\\(.)/g, '$1');

const swiftStrings = (body) =>
  [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => swiftLiteral(m[1]));

function duplicates(list) {
  const seen = new Set();
  const dups = new Set();
  for (const item of list) (seen.has(item) ? dups : seen).add(item);
  return [...dups];
}

// Sorted numeric literals matched by `pattern`, which must carry the /g flag.
function thresholds(source, relPath, pattern, what) {
  const found = [...source.matchAll(pattern)].map((m) => Number(m[1]));
  if (found.length === 0) throw new Error(`${relPath}: cannot locate ${what} (searched for ${pattern})`);
  return found.sort((a, b) => a - b);
}

// The heading length limit, reported with the unit it counts. Swift's
// String.count is extended grapheme clusters, so JS must segment the same way —
// String#length (UTF-16 code units) doubles the count of any astral title.
const JS_LENGTH_UNITS = [
  [/graphemeLength\(text\)\s*<\s*(\d+)/, 'graphemes'],
  [/\[\s*\.\.\.\s*text\s*\]\.length\s*<\s*(\d+)/, 'code points'],
  [/\btext\.length\s*<\s*(\d+)/, 'UTF-16 code units'],
];
const SWIFT_LENGTH_UNITS = [
  [/\btext\.count\s*<\s*(\d+)/, 'graphemes'],
  [/\btext\.unicodeScalars\.count\s*<\s*(\d+)/, 'code points'],
  [/\btext\.utf16\.count\s*<\s*(\d+)/, 'UTF-16 code units'],
];

function headingMetric(source, relPath, units) {
  for (const [pattern, unit] of units) {
    const match = source.match(pattern);
    if (match) return { unit, limit: Number(match[1]) };
  }
  throw new Error(`${relPath}: cannot locate the heading length metric (expected one of: ${units.map(([, u]) => u).join(', ')})`);
}

const [builderSrc, jsSrc, swiftSrc] = await Promise.all(MARKER_FILES.map(read));
const sources = { [MARKER_FILES[0]]: builderSrc, [JS]: jsSrc, [SWIFT]: swiftSrc };

check('sync markers match', () => {
  const markers = MARKER_FILES.map((relPath) =>
    must(sources[relPath].split('\n', 20).join('\n'), relPath, /sync-marker:\s*(\S+)/,
      'the "// sync-marker: vN" line near the top of the file')[1]);
  if (new Set(markers).size > 1) {
    return [...MARKER_FILES.map((f, i) => `${markers[i]}  ${f}`),
      'Bump all three to the same vN once Node and Swift are confirmed in sync again.'];
  }
  return `${markers[0]} across ${MARKER_FILES.length} files`;
});

check('break-punctuation sets agree', () => {
  const js = charClassMembers(must(jsSrc, JS,
    /\/\[([^\]]+)\]\$\/\.test\(prevLine\.text\.trim\(\)\)/,
    'the break-punctuation character class in processPage')[1]);
  const swift = swiftStrings(must(swiftSrc, SWIFT,
    /breakPunct:\s*Set<Character>\s*=\s*\[([^\]]+)\]/,
    'the breakPunct set literal')[1]);

  const problems = [];
  for (const [relPath, members] of [[JS, js], [SWIFT, swift]]) {
    const dups = duplicates(members);
    if (dups.length) {
      problems.push(`${relPath} lists ${dups.map(codePoint).join(', ')} twice — a duplicate is how a missing character hides`);
    }
  }
  const inJs = new Set(js);
  const inSwift = new Set(swift);
  const missingFromJs = swift.filter((c) => !inJs.has(c));
  const missingFromSwift = js.filter((c) => !inSwift.has(c));
  if (missingFromJs.length) problems.push(`${JS} is missing ${missingFromJs.map(codePoint).join(', ')}`);
  if (missingFromSwift.length) problems.push(`${SWIFT} is missing ${missingFromSwift.map(codePoint).join(', ')}`);

  return problems.length ? problems : `${inJs.size} characters`;
});

check('heading length metric agrees', () => {
  const js = headingMetric(jsSrc, JS, JS_LENGTH_UNITS);
  const swift = headingMetric(swiftSrc, SWIFT, SWIFT_LENGTH_UNITS);

  const problems = [];
  if (js.unit !== swift.unit) {
    problems.push(`${JS} counts ${js.unit}, ${SWIFT} counts ${swift.unit}`);
  }
  if (js.limit !== swift.limit) {
    problems.push(`${JS} caps a heading at ${js.limit}, ${SWIFT} at ${swift.limit}`);
  }
  if (js.unit === 'graphemes' && !/new Intl\.Segmenter\([^)]*granularity:\s*'grapheme'/.test(jsSrc)) {
    problems.push(`${JS} claims graphemes but builds no Intl.Segmenter with granularity 'grapheme'`);
  }
  return problems.length ? problems : `< ${js.limit} ${js.unit}`;
});

check('paragraph geometry thresholds agree', () => {
  const axes = [
    ['header/footer y cutoffs', /\.y\s*[<>]=?\s*(0\.\d+)/g],
    ['indent x threshold', /\.x\s*[<>]=?\s*(0\.\d+)/g],
    ['avgHeight multipliers', /avgHeight\s*\*\s*(\d+(?:\.\d+)?)/g],
  ];
  const problems = [];
  const notes = [];
  for (const [what, pattern] of axes) {
    const js = thresholds(jsSrc, JS, pattern, what);
    const swift = thresholds(swiftSrc, SWIFT, pattern, what);
    if (js.join(' ') !== swift.join(' ')) {
      problems.push(`${what}: ${JS} has [${js.join(', ')}], ${SWIFT} has [${swift.join(', ')}]`);
    } else {
      notes.push(`${what} ${js.join('/')}`);
    }
  }
  return problems.length ? problems : notes.join(' · ');
});

check('XML escape table agrees', () => {
  // Order is part of the contract: & must be replaced before the entities that
  // introduce one, or every escape gets double-encoded.
  const js = [...jsSrc.matchAll(/\.replace\(\/(\\.|[^/\\])\/g,\s*'([^']*)'\)/g)]
    .map((m) => [m[1].replace(/^\\/, ''), m[2]]);
  const swift = [...swiftSrc.matchAll(/\.replacingOccurrences\(of:\s*"((?:[^"\\]|\\.)*)",\s*with:\s*"((?:[^"\\]|\\.)*)"\)/g)]
    .map((m) => [swiftLiteral(m[1]), swiftLiteral(m[2])]);

  if (js.length === 0) throw new Error(`${JS}: cannot locate any escape replacement`);
  if (swift.length === 0) throw new Error(`${SWIFT}: cannot locate any escape replacement`);

  const render = (pairs) => pairs.map(([from, to]) => `${from}→${to}`).join(', ');
  if (render(js) !== render(swift)) {
    return [`${JS}: ${render(js)}`, `${SWIFT}: ${render(swift)}`];
  }
  return render(js);
});

check('pictograph range agrees', () => {
  // The range that decides which characters a Kindle-bound book may keep. It
  // must stop short of U+20000 (CJK Extension B) on BOTH sides, or one builder
  // strips a reader's own language while the other keeps emoji that cost the
  // book its cover.
  const js = must(jsSrc, JS,
    /PICTOGRAPH = \/\[\\u\{([0-9A-Fa-f]+)\}-\\u\{([0-9A-Fa-f]+)\}\]\\u\{([0-9A-Fa-f]+)\}\?\/u/,
    'the PICTOGRAPH regex (range plus variation selector)');
  const swiftRange = must(swiftSrc, SWIFT,
    /pictographRange:\s*ClosedRange<UInt32>\s*=\s*0x([0-9A-Fa-f]+)\.\.\.0x([0-9A-Fa-f]+)/,
    'the pictographRange constant');
  const swiftVS = must(swiftSrc, SWIFT,
    /variationSelector:\s*UInt32\s*=\s*0x([0-9A-Fa-f]+)/,
    'the variationSelector constant');

  const norm = (hex) => parseInt(hex, 16);
  const jsBounds = [norm(js[1]), norm(js[2]), norm(js[3])];
  const swiftBounds = [norm(swiftRange[1]), norm(swiftRange[2]), norm(swiftVS[1])];
  const show = (b) => `U+${b[0].toString(16).toUpperCase()}–U+${b[1].toString(16).toUpperCase()} (+U+${b[2].toString(16).toUpperCase()})`;

  const problems = [];
  if (jsBounds.join() !== swiftBounds.join()) {
    problems.push(`${JS} strips ${show(jsBounds)}, ${SWIFT} strips ${show(swiftBounds)}`);
  }
  for (const [relPath, [, upper]] of [[JS, jsBounds], [SWIFT, swiftBounds]]) {
    if (upper >= 0x20000) {
      problems.push(`${relPath}: the range reaches U+${upper.toString(16).toUpperCase()}, into CJK Extension B — a book would lose characters of its own language`);
    }
  }
  return problems.length ? problems : show(jsBounds);
});

if (failed > 0) {
  console.error(`\n${failed} divergence(s) between the Node and Swift EPUB builders. The same PDF would produce different books.`);
  process.exit(1);
}

console.log(`\nNode and Swift EPUB builders agree on every machine-checkable heuristic.`);
