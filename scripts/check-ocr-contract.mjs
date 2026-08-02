#!/usr/bin/env node
// check-ocr-contract.mjs — the wire between bin/scan-ocr and src/builder.js.
//
// scan-ocr writes JSON on stdout and builder.js reads it. Nothing tested that
// they agreed. The extraction of packages/scan-ocr (2026-08-02) rewrote the
// producing side — the engine moved into a library and the command line grew a
// Codable type of its own — and every suite stayed green throughout, because
// not one of them ran the binary. That gap is what this file closes.
//
// It does not assert a shape copied from memory. It runs the real binary over a
// real PDF and feeds the result to structureChapters, the actual consumer: if
// the wire format drifts, the thing that breaks in production is what fails
// here. The field names are then checked on top, because a rename that
// structureChapters happens to tolerate is still a broken contract for anyone
// else reading the JSON.
//
// The PDF is built here, byte by byte, rather than fetched or committed as a
// fixture: a test that needs a download is a test that fails offline, which is
// a strange way to check a tool whose whole claim is that it never goes online.
//
// Runs after `make build`. No dependencies.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const binary = join(repoRoot, 'bin', 'scan-ocr');
const require = createRequire(import.meta.url);

let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
  } else {
    console.error(`  [FAIL] ${message}`);
    failures++;
  }
}
const section = (name) => console.log(`\n=== ${name} ===`);

// --------------------------------------------------------------- the fixture

// A one-page PDF with enough Helvetica on it to recognise. Sentences rather
// than lorem ipsum: Vision corrects against a language model, and real words
// are what it is good at. The total comfortably clears the 120-character line
// above which a page counts as text rather than as a plate.
function minimalPdf() {
  const lines = [
    [36, 700, 'Reepub scan-ocr contract'],
    [24, 640, 'The quick brown fox jumps over the lazy dog.'],
    [24, 600, 'Pack my box with five dozen liquor jugs.'],
    [24, 560, 'How vexingly quick daft zebras jump.'],
    [24, 520, 'Sphinx of black quartz, judge my vow.'],
  ];
  const content = lines
    .map(([size, y, text]) => `BT /F1 ${size} Tf 60 ${y} Td (${text}) Tj ET`)
    .join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
      + '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];

  // Offsets are counted, not guessed: an xref table that disagrees with the
  // bytes is a file some readers open and others refuse.
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
    + `startxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

// ----------------------------------------------------------------- the check

if (!existsSync(binary)) {
  console.error(`bin/scan-ocr is not built. Run \`make build\` first.`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'reepub-ocr-contract-'));
const pdfPath = join(work, 'contract.pdf');
const coverPath = join(work, 'images', 'cover.jpeg');
writeFileSync(pdfPath, minimalPdf());
require('node:fs').mkdirSync(join(work, 'images'), { recursive: true });

try {
  section('scan-ocr: the command line contract');

  const noArgs = spawnSync(binary, [], { encoding: 'utf8' });
  assert(noArgs.status !== 0, `no arguments exits non-zero (got ${noArgs.status})`);
  assert(/Usage: scan-ocr/.test(noArgs.stderr), 'usage goes to stderr');

  const run = spawnSync(binary, [pdfPath, coverPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert(run.status === 0, `a readable PDF exits 0 (got ${run.status}${run.status ? `: ${run.stderr.trim()}` : ''})`);

  let pages = null;
  try {
    pages = JSON.parse(run.stdout);
  } catch (err) {
    assert(false, `stdout is JSON — nothing else may be written there (${err.message})`);
  }

  if (Array.isArray(pages)) {
    assert(pages.length === 1, `one page in, one page out (got ${pages.length})`);
    assert(run.stderr.includes('Performing OCR'), 'progress goes to stderr, never to stdout');

    section('scan-ocr: the fields builder.js reads');

    const page = pages[0];
    assert(page.pageIndex === 0, `pageIndex is zero-based (got ${JSON.stringify(page.pageIndex)})`);
    assert(page.type === 'text' || page.type === 'image',
      `type is "text" or "image" (got ${JSON.stringify(page.type)})`);
    assert(!('imagePath' in page) || page.imagePath === null || typeof page.imagePath === 'string',
      'imagePath is a string, null, or absent — builder.js:150 treats the last two alike');
    assert(Array.isArray(page.lines), 'lines is an array');

    // The page must actually recognise, or every assertion below it is vacuous.
    assert(page.lines.length > 0,
      `the fixture recognises (got ${page.lines.length} lines) — with none of them, the checks below prove nothing`);

    if (page.lines.length > 0) {
      const keys = Object.keys(page.lines[0]).sort().join(',');
      assert(keys === 'height,text,width,x,y',
        `a line carries exactly text/x/y/width/height (got ${keys})`);

      const boxed = page.lines.every((l) =>
        typeof l.text === 'string'
        && [l.x, l.y, l.width, l.height].every((n) => typeof n === 'number' && n >= 0 && n <= 1));
      assert(boxed, 'every box is normalized to 0…1 and every text is a string');

      const descending = page.lines.every((l, i) =>
        i === 0 || page.lines[i - 1].y > l.y || Math.abs(page.lines[i - 1].y - l.y) < 0.015);
      assert(descending, 'lines arrive top-to-bottom, as the paragraph heuristics assume');

      assert(page.lines.some((l) => /contract|quick|brown/i.test(l.text)),
        `the words on the page are the words that came back (got ${JSON.stringify(page.lines[0].text)})`);
    }

    section('scan-ocr → builder.js: the real consumer accepts it');

    // The strongest form of this check: not "does it look like what I
    // remember", but "does the code that actually reads this survive it".
    const { structureChapters } = require(join(repoRoot, 'src', 'builder.js'));
    let chapters = null;
    try {
      chapters = structureChapters(pages);
    } catch (err) {
      assert(false, `structureChapters consumes scan-ocr output unmodified (${err.message})`);
    }
    if (chapters) {
      assert(Array.isArray(chapters) && chapters.length > 0,
        `and gets a book out of it (got ${chapters.length} chapter(s))`);
      const text = JSON.stringify(chapters);
      assert(/contract|quick|brown/i.test(text),
        'the recognised words survive into the chapters');
    }

    section('scan-ocr: what it writes to disk');

    assert(existsSync(coverPath), 'page one is written as the cover when a path is given');
    if (existsSync(coverPath)) {
      const magic = readFileSync(coverPath).subarray(0, 3);
      assert(magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff,
        'and it is a JPEG, not an empty file with a JPEG name');
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} contract failure(s): bin/scan-ocr and src/builder.js no longer agree.`);
  process.exit(1);
}
console.log('\n[SUCCESS] scan-ocr and builder.js agree on the wire.');
