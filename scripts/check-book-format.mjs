#!/usr/bin/env node
// check-book-format.mjs — keep the fixture corpus honest about the ledger.
//
// docs/data-not-format.md names the hazards a book format has to survive, and
// fixtures/book-md/ is supposed to hold one file per hazard. Two documents that
// are meant to agree and have nothing comparing them have already drifted; that
// is the failure this repo has hit before (PRINCIPLES §6), so the agreement is
// asserted rather than intended.
//
// WHAT THIS DOES NOT DO, and will say so out loud when run: it does not compare
// two parsers. The whole point of writing the format down was that two
// implementations — book-core.js in JavaScript, and reepub's in Swift — would be
// checked against one corpus rather than against each other's source. reepub has
// no parser yet. Until it does, the cross-parser comparison prints [SKIP] with
// the reason, because a check that quietly does nothing is worse than a check
// that says it did nothing.
//
// So today this asserts the two things that are true today: the corpus covers
// the ledger, and every fixture is actually the shape it claims to be.
//
//   node scripts/check-book-format.mjs
//   node scripts/check-book-format.mjs --selftest

import { readFileSync, readdirSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = join(root, 'docs', 'data-not-format.md');
const CORPUS = join(root, 'fixtures', 'book-md');

// The hazards, and the fixture each one is answered by. This list is the
// contract: adding a row to the ledger's gap table without adding a fixture is
// what this file is here to catch.
const REQUIRED = {
  'a right-to-left book': 'rtl-vertical-cjk.md',
  'a vertical CJK book': 'rtl-vertical-cjk.md',
  'a book of plates with no prose': 'plates-only.md',
  'a book of prose with no images': 'ltr-prose-only.md',
  'a book of prose interrupted by a plate': 'mixed-flow-and-plate.md',
  'a chapter whose title contains XML specials': 'xml-specials-in-title.md',
  'an astral-plane title': 'astral-title.md',
  'a fenced code block containing headings': 'fence-containing-headings.md',
};

// The ledger is prose and wraps, so a hazard can straddle a newline. Matching on
// collapsed whitespace compares what it says rather than how it was reflowed —
// otherwise this check fails the next time somebody rewraps a paragraph, which
// trains people to edit the check instead of reading it.
const flatten = (s) => s.replace(/\s+/g, ' ');

let failures = 0;
const check = (ok, message) => {
  console.log(`${ok ? '  [PASS]' : '  [FAIL]'} ${message}`);
  if (!ok) failures++;
};

function fixtures(dir = CORPUS) {
  return readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
}

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return meta;
}

// Headings that are inside a fenced block are not structure — the same guard the
// family's parser applies, applied here so a fixture cannot pass by accident.
function structuralHeadings(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const out = [];
  let fenced = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) out.push({ depth: m[1].length, title: m[2].trim() });
  }
  return out;
}

function run(corpus) {
  const ledger = flatten(readFileSync(LEDGER, 'utf8'));
  const present = new Set(fixtures(corpus));

  console.log('\n=== The corpus covers the ledger ===');
  for (const [hazard, file] of Object.entries(REQUIRED)) {
    check(ledger.includes(hazard),
      `the ledger still names "${hazard}" — if it was renamed, this list is stale`);
    check(present.has(file),
      `${hazard} → fixtures/book-md/${file}`);
  }

  const claimed = new Set(Object.values(REQUIRED));
  for (const file of [...present].sort()) {
    check(claimed.has(file),
      `${file} answers a hazard this list names — an unexplained fixture is one nobody will maintain`);
  }

  console.log('\n=== Every fixture is the shape it claims ===');
  for (const file of [...present].sort()) {
    const text = readFileSync(join(corpus, file), 'utf8');
    const meta = frontmatter(text);
    check(meta !== null, `${file} opens with frontmatter`);
    if (!meta) continue;

    check(meta['pagetile-book'] === 'true',
      `${file} claims the format it is a fixture for`);
    check(typeof meta.title === 'string' && meta.title.length > 0,
      `${file} carries a title — data, per the ledger`);
    check(meta.direction === 'ltr' || meta.direction === 'rtl',
      `${file} declares a reading direction (got ${JSON.stringify(meta.direction)}) — the property whose absence hides a whole book`);
    check(typeof meta.lang === 'string' && meta.lang.length > 0,
      `${file} declares a language`);

    const headings = structuralHeadings(text);
    check(headings.some((h) => h.depth === 1),
      `${file} has at least one chapter`);
  }

  console.log('\n=== Cross-parser comparison ===');
  console.log('  [SKIP] reepub has no book-format parser yet, so there is nothing');
  console.log('         to compare book-core.js against. This corpus exists so');
  console.log('         that when one is written it is checked against fixtures');
  console.log('         chosen before it — see docs/data-not-format.md.');
}

// --selftest: break each rule on purpose and require this file to notice. A gate
// nobody has watched fail is not evidence of anything.
function selftest() {
  const scratch = join(root, 'fixtures', '.selftest-book-md');
  const cases = [
    ['a fixture with no frontmatter', 'ltr-prose-only.md',
      (t) => t.replace(/^---\n[\s\S]*?\n---\n/, '')],
    ['a fixture with no reading direction', 'ltr-prose-only.md',
      (t) => t.replace(/^direction: .*$/m, 'shelf: mine')],
    // astral-title.md rather than a two-chapter fixture: fencing one heading of
    // two leaves the other standing, so the check passes and the corruption is
    // recorded as caught by whatever else happened to be failing. This selftest
    // reported 3/3 that way until the corpus was clean enough to expose it.
    ['a fixture whose only heading is inside a fence', 'astral-title.md',
      (t) => t.replace(/^# 𡒉$/m, '```\n# 𡒉\n```')],
  ];

  let proven = 0;
  for (const [name, file, corrupt] of cases) {
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    for (const f of fixtures()) {
      const text = readFileSync(join(CORPUS, f), 'utf8');
      writeFileSync(join(scratch, f), f === file ? corrupt(text) : text);
    }
    const before = failures;
    const hush = console.log;
    console.log = () => {};
    try { run(scratch); } finally { console.log = hush; }
    const fired = failures > before;
    failures = before;
    hush(`  ${fired ? '✓' : '✗'} ${name} — ${fired ? 'caught' : 'NOT CAUGHT'}`);
    if (fired) proven++;
  }
  rmSync(scratch, { recursive: true, force: true });

  console.log(`\n${proven}/${cases.length} rules proven to fire.`);
  return proven === cases.length ? 0 : 1;
}

if (process.argv.includes('--selftest')) {
  console.log('=== Selftest: break each rule, require this file to notice ===');
  process.exit(selftest());
}

run(CORPUS);
if (failures > 0) {
  console.error(`\n${failures} problem(s): the corpus and docs/data-not-format.md disagree.`);
  process.exit(1);
}
console.log('\n[SUCCESS] The corpus covers the ledger, and every fixture is well formed.');
