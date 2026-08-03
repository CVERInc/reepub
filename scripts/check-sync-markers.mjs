#!/usr/bin/env node
// check-sync-markers.mjs — what the Node side and the app still owe each other,
// and what they no longer do.
//
// These two implement overlapping rules: the Node modules (src/epub-text.js,
// src/builder.js) and the app's assembler (packages/epub-kit). This file used to
// demand they agree on all of it, which sounds like rigour and is actually a
// promise — that reepub will keep a second implementation in step forever. That
// promise is declined (2026-08-03). The app is where development happens; the
// Node path stays, works, and is not held to the app's pace. Nobody needs to be
// told which is which: the dates say so, per file, and never go stale.
//
// So the output has two kinds of line.
//
//   ✓ / ✗   A PROMISE. The XML escape table and the pictograph range are shared
//           with tools that are maintained — epub-doctor heals and merges books
//           with them — so a book repaired by the Node side and one built by the
//           app must escape the same characters and strip the same range. CI
//           stops the build when they do not.
//
//   ·       A RECORD, which never touches the exit code. The paragraph
//           heuristics, the heading metric and the shared marker version exist
//           on both sides but are only promised on one. Their difference is
//           written down as it appears rather than reconstructed later, because
//           it is precisely the to-do list for the day someone picks the Node
//           path back up — the day this repository stops being able to use
//           Swift, for instance.
//
// Deleting those four was the other option, and it was the wrong one: measuring
// is not asserting. What was being withdrawn was the blocking, not the knowing.
//
// Every extractor fails loudly when its anchor is missing — for a promise that
// is a failure, for a record it is only a line saying the comparison could not
// be made. A missing anchor may never read as agreement either way.
//
// Exit 0 = every promise is kept. Exit 1 = one is not. No dependencies.

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const JS = 'src/epub-text.js';
const SWIFT = 'packages/epub-kit/Sources/EpubKit/EpubBuilder.swift';
const MARKER_FILES = ['src/builder.js', JS, SWIFT];

const read = (relPath) => readFile(join(repoRoot, relPath), 'utf8');

let failed = 0;
let differences = 0;

function pass(what) {
  console.log(`✓ ${what}`);
}

function fail(what, lines) {
  failed++;
  console.error(`✗ ${what}`);
  for (const line of lines) console.error(`    ${line}`);
}

// Two kinds of line, and the difference is what reepub promises.
//
// A `check` is a promise: these must agree, and CI stops the build when they do
// not. Both surviving ones are rules the LIVE Node tools share with the app —
// a book healed by epub-doctor and a book built by the app escape XML the same
// way and strip the same range, because both are maintained.
//
// A `record` is not a promise and must never read as a failure. It writes down
// the current difference between an implementation that moves and one that does
// not. Demanding they match would be the perpetual-parity commitment reepub has
// declined, expressed in CI — but the difference is still worth having, because
// it is exactly the to-do list for the day someone picks the Node path back up.
// A record never touches the exit code.

function check(what, fn) {
  try {
    const result = fn();
    if (Array.isArray(result)) fail(what, result);
    else pass(result ? `${what} — ${result}` : what);
  } catch (err) {
    fail(what, [err.message]);
  }
}

function record(what, fn) {
  try {
    const result = fn();
    if (Array.isArray(result)) {
      differences++;
      console.log(`· ${what} — differs`);
      for (const line of result) console.log(`    ${line}`);
    } else {
      console.log(`· ${what} — ${result || 'identical'}`);
    }
  } catch (err) {
    // An anchor that has moved is not a divergence and not a failure: it means
    // this line can no longer be read, which is worth saying and nothing more.
    console.log(`· ${what} — not comparable: ${err.message}`);
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

record('sync markers', () => {
  const markers = MARKER_FILES.map((relPath) =>
    must(sources[relPath].split('\n', 20).join('\n'), relPath, /sync-marker:\s*(\S+)/,
      'the "// sync-marker: vN" line near the top of the file')[1]);
  if (new Set(markers).size > 1) {
    return [...MARKER_FILES.map((f, i) => `${markers[i]}  ${f}`),
      'Bump all three to the same vN once Node and Swift are confirmed in sync again.'];
  }
  return `${markers[0]} across ${MARKER_FILES.length} files`;
});

record('break-punctuation sets', () => {
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

record('heading length metrics', () => {
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

record('paragraph geometry thresholds', () => {
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
  console.error(`\n${failed} shared rule(s) disagree. A book healed by the Node tools and one built by the app would not behave the same.`);
  process.exit(1);
}

console.log(differences === 0
  ? `\nThe 2 shared rules agree, and the Node build path has not diverged from the app's.`
  : `\nThe 2 shared rules agree. ${differences} recorded difference(s) between the Node build path and the app's — not a failure, and the list to work from if the Node path is ever picked back up.`);
