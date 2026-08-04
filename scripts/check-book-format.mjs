#!/usr/bin/env node
// check-book-format.mjs — keep the fixture corpus honest about the ledger.
//
// docs/data-not-format.md names the hazards a book format has to survive, and
// fixtures/book-md/ is supposed to hold one file per hazard. Two documents that
// are meant to agree and have nothing comparing them have already drifted; that
// is the failure this repo has hit before (PRINCIPLES §6), so the agreement is
// asserted rather than intended.
//
// Three things are asserted here:
//
//   1. the corpus covers the ledger, in both directions;
//   2. every fixture is actually the shape it claims to be;
//   3. two implementations of the format agree on the DATA columns — the
//      JavaScript parser in this file, and EpubKit/BookMarkdown.swift behind
//      `book-md` — and the Swift serializer is a fixpoint.
//
// (3) was a [SKIP] until 2026-08-04, printed out loud rather than left silent,
// because a check that quietly does nothing is worse than one that says it did
// nothing. The Swift parser landed and the skip became a gate. The JavaScript
// side was written from docs/data-not-format.md rather than from the Swift:
// reading the other implementation is how two parsers come to agree about
// something neither of them got right.
//
// --selftest breaks each rule on purpose, including four that make the Swift
// side answer wrong through a shim, because both parsers read the same file and
// corrupting the file cannot make them disagree.
//
//   node scripts/check-book-format.mjs
//   node scripts/check-book-format.mjs --selftest      # needs book-md built

import { readFileSync, readdirSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  // Found by running a real book through a converter, not by reasoning about the
  // format — see the ledger section that says so.
  'a heading inside a blockquote': 'heading-inside-blockquote.md',
  'a chapter containing a list': 'bulleted-list.md',
  'a book with an empty chapter': 'empty-chapter.md',
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
  crossParser(corpus);
}

// The gate this corpus was built for. Two implementations of one written format:
// the JavaScript below, and EpubKit/BookMarkdown.swift behind `book-md`. They are
// compared on the ledger's DATA columns only — never on bytes, never on the
// embed form, never on how a paragraph was wrapped.
//
// This was a [SKIP] until 2026-08-04, and the skip was printed out loud rather
// than left silent, because a check that quietly does nothing is worse than one
// that says it did nothing.
function bookMdBinary() {
  // BOOK_MD_BIN exists for the selftest, which needs a Swift side that answers
  // WRONG on purpose. Without it there is no way to watch this gate fail, and a
  // comparison nobody has seen go red is only evidence that it is quiet.
  if (process.env.BOOK_MD_BIN) return process.env.BOOK_MD_BIN;
  const candidates = [
    join(root, 'packages', 'epub-kit', '.build', 'release', 'book-md'),
    join(root, 'packages', 'epub-kit', '.build', 'debug', 'book-md'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/// The JavaScript parser. Deliberately written from docs/data-not-format.md
/// rather than from the Swift — reading the other implementation is how two
/// parsers end up agreeing about something neither of them got right.
function parseBookJS(text) {
  const src = text.replace(/\r\n/g, '\n').split('\n');
  const meta = { title: '', lang: '', direction: '', author: null, translator: null, cover: null };
  let i = 0;
  if (src[0]?.trim() === '---') {
    const close = src.findIndex((l, n) => n > 0 && l.trim() === '---');
    if (close > 0) {
      for (const line of src.slice(1, close)) {
        const c = line.indexOf(':');
        if (c < 0) continue;
        const k = line.slice(0, c).trim();
        const v = line.slice(c + 1).trim();
        if (k in meta) meta[k] = v;
      }
      i = close + 1;
    }
  }

  const norm = (s) => s.split(/\s+/).filter(Boolean).join(' ');
  const heading = (t) => {
    const m = /^(#{1,6}) +(.*)$/.exec(t);
    return m ? { level: m[1].length, text: m[2].trim() } : null;
  };
  const listItem = (t) => /^([*+-]) +(.*)$/.exec(t);
  const fence = (t) => /^(`{3,}|~{3,})(.*)$/.exec(t);
  const embed = (t) => {
    let m = /^!\[\[([^\]]*)\]\]$/.exec(t);
    if (m) {
      const [href, alt] = m[1].includes('|') ? m[1].split('|') : [m[1], null];
      return { href, alt };
    }
    m = /^!\[([^\]]*)\]\(([^)]*)\)$/.exec(t);
    return m ? { href: m[2], alt: m[1] || null } : null;
  };

  // Returns { text: [], headingLevels: [], images: [] } for a run of lines,
  // recursing through blockquotes so a `> #` stays a heading.
  const blocks = (lines) => {
    const out = { text: [], headingLevels: [], images: [] };
    let n = 0;
    while (n < lines.length) {
      const t = lines[n].trim();
      if (!t) { n++; continue; }

      const f = fence(t);
      if (f) {
        n++;
        while (n < lines.length) {
          const g = fence(lines[n].trim());
          if (g && g[1][0] === f[1][0] && g[1].length >= f[1].length && !g[2].trim()) { n++; break; }
          n++;
        }
        continue;   // a fence carries no prose and no structure
      }

      if (t.startsWith('>')) {
        const inner = [];
        while (n < lines.length) {
          const q = lines[n].trim();
          if (q.startsWith('>')) { inner.push(q.slice(1).replace(/^ /, '')); n++; }
          else if (!q && lines[n + 1]?.trim().startsWith('>')) { inner.push(''); n++; }
          else break;
        }
        const sub = blocks(inner);
        out.text.push(...sub.text);
        out.headingLevels.push(...sub.headingLevels);
        out.images.push(...sub.images);
        continue;
      }

      const h = heading(t);
      if (h) { out.headingLevels.push(h.level); out.text.push(norm(h.text)); n++; continue; }

      const img = embed(t);
      if (img) { out.images.push(img); n++; continue; }

      const li = listItem(t);
      if (li) {
        const marker = li[1];
        while (n < lines.length) {
          const m2 = listItem(lines[n].trim());
          if (!m2 || m2[1] !== marker) break;
          out.text.push(norm(m2[2]));
          n++;
        }
        continue;
      }

      // Paragraphs end at blank lines, not at line endings.
      const run = [t];
      n++;
      while (n < lines.length) {
        const p = lines[n].trim();
        if (!p || p.startsWith('>') || heading(p) || fence(p) || listItem(p) || embed(p)) break;
        run.push(p);
        n++;
      }
      out.text.push(norm(run.join(' ')));
    }
    return out;
  };

  // Split into chapters on top-level headings only. A heading inside a
  // blockquote is quoted content — it stays a heading, it does not open a
  // chapter.
  const body = src.slice(i);
  const chapters = [];
  const preambleLines = [];
  let current = null;
  let inFence = false;
  for (const line of body) {
    const t = line.trim();
    const f = fence(t);
    if (f) inFence = !inFence;
    const h = !inFence && !t.startsWith('>') ? heading(t) : null;
    if (h) { current = { level: h.level, title: h.text, lines: [] }; chapters.push(current); continue; }
    (current ? current.lines : preambleLines).push(line);
  }

  return {
    ...meta,
    preamble: blocks(preambleLines),
    chapters: chapters.map((c) => {
      const b = blocks(c.lines);
      return { level: c.level, title: norm(c.title), text: b.text,
               images: b.images, innerHeadingLevels: b.headingLevels };
    }),
  };
}

function crossParser(corpus) {
  const bin = bookMdBinary();
  if (!bin) {
    check(false, 'book-md is built — run: swift build --package-path packages/epub-kit '
      + '--product book-md. Without it this gate cannot run, and a gate that '
      + 'skips itself when the tool is missing is how it stays green forever.');
    return;
  }

  for (const file of fixtures(corpus).sort()) {
    const path = join(corpus, file);
    const js = parseBookJS(readFileSync(path, 'utf8'));

    const run = spawnSync(bin, [path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (run.status !== 0) {
      check(false, `${file}: book-md exited ${run.status} — ${(run.stderr || '').trim().split('\n')[0]}`);
      continue;
    }
    const swift = JSON.parse(run.stdout);

    const differences = [];
    for (const key of ['title', 'lang', 'direction', 'author', 'translator', 'cover']) {
      if (JSON.stringify(js[key] ?? null) !== JSON.stringify(swift[key] ?? null)) {
        differences.push(`${key}: js=${JSON.stringify(js[key])} swift=${JSON.stringify(swift[key])}`);
      }
    }
    // Images are compared as ordered pairs, not as objects: JSON key order is
    // format, and comparing it turned this gate red twice over `{href,alt}` vs
    // `{alt,href}` — the byte-identity mistake the ledger warns about, made by
    // the very check meant to enforce it.
    const img = (list) => list.map((x) => [x.href, x.alt ?? null]);
    const shape = (d) => ({
      chapters: d.chapters.map((c) => [c.level, c.title, c.text, img(c.images), c.innerHeadingLevels]),
      preamble: [d.preamble.text, d.preamble.headingLevels, img(d.preamble.images)],
    });
    const a = JSON.stringify(shape(js));
    const b = JSON.stringify(shape(swift));
    if (a !== b) {
      const at = a.split('').findIndex((ch, n) => ch !== b[n]);
      differences.push(`structure diverges at offset ${at}\n           js:    …${a.slice(Math.max(0, at - 40), at + 60)}\n           swift: …${b.slice(Math.max(0, at - 40), at + 60)}`);
    }

    check(differences.length === 0,
      `${file}: both parsers agree on the data columns`
      + (differences.length ? `\n         ${differences.join('\n         ')}` : ''));

    const rt = spawnSync(bin, [path, '--roundtrip'], { encoding: 'utf8' });
    check(rt.status === 0,
      `${file}: serialize(parse(serialize(x))) == serialize(x)`
      + (rt.status === 0 ? '' : `\n         ${(rt.stderr || '').trim().split('\n').slice(0, 5).join('\n         ')}`));
  }
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
    // The rule every hazard in REQUIRED leans on, and the one nobody had watched
    // fail: three hazards were added on 2026-08-04 trusting it to catch a
    // missing fixture, on no evidence that it ever had.
    ['a hazard whose fixture is missing', 'bulleted-list.md', null],
  ];

  // The cross-parser gate needs a different kind of corruption: both parsers read
  // the same file, so breaking the file cannot make them disagree. What proves it
  // fires is a Swift side that answers wrong — a shim that runs the real book-md
  // and then edits one data column on the way out.
  const shimCases = [
    ['a Swift parser that reports the wrong reading direction',
      `d["direction"]="xx"`],
    ['a Swift parser that drops a chapter',
      `d["chapters"]=d["chapters"][1:]`],
    ['a Swift parser that loses a heading nested in a blockquote',
      `d["preamble"]["headingLevels"]=[]`],
    ['a Swift parser that merges two paragraphs into one',
      `[c.__setitem__("text", [" ".join(c["text"])]) for c in d["chapters"]]`],
  ];

  let proven = 0;
  for (const [name, file, corrupt] of cases) {
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    for (const f of fixtures()) {
      const text = readFileSync(join(CORPUS, f), 'utf8');
      // corrupt === null means "leave this fixture out entirely" — the
      // corruption is the absence.
      if (f === file && corrupt === null) continue;
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

  const real = bookMdBinary();
  let shimProven = 0;
  if (!real) {
    hushLog('  · book-md is not built, so the cross-parser cases cannot be proven.');
  } else {
    mkdirSync(scratch, { recursive: true });
    for (const [name, mutation] of shimCases) {
      const shim = join(scratch, 'book-md-shim');
      writeFileSync(shim, [
        '#!/bin/sh',
        // --roundtrip must still pass through untouched: this shim is proving the
        // comparison fires, not that the fixpoint check does.
        `case "$*" in *--roundtrip*) exec ${JSON.stringify(real)} "$@";; esac`,
        `${JSON.stringify(real)} "$@" | python3 -c 'import json,sys`,
        `d=json.load(sys.stdin)`,
        mutation,
        `json.dump(d,sys.stdout)'`,
      ].join('\n'), { mode: 0o755 });

      const before = failures;
      const hush = console.log;
      console.log = () => {};
      process.env.BOOK_MD_BIN = shim;
      try { crossParser(CORPUS); } finally {
        console.log = hush;
        delete process.env.BOOK_MD_BIN;
      }
      const fired = failures > before;
      failures = before;
      hush(`  ${fired ? '✓' : '✗'} ${name} — ${fired ? 'caught' : 'NOT CAUGHT'}`);
      if (fired) shimProven++;
    }
    rmSync(scratch, { recursive: true, force: true });
  }

  const total = cases.length + (real ? shimCases.length : 0);
  const done = proven + shimProven;
  console.log(`\n${done}/${total} rules proven to fire.`);
  return done === total ? 0 : 1;
}

function hushLog(s) { console.log(s); }

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
