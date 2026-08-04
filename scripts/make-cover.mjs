#!/usr/bin/env node
// make-cover.mjs — the typeset cover, as a file.
//
// This exists to close a loop. The cover is typeset in a browser (a fitting
// loop that measures text and re-scales until the title fills the measure —
// see docs/wkwebview-cover-parity.md for the measurement that says WKWebView
// could do it too, and the port that has not happened yet), and books are
// assembled in Swift. Neither needs to move for them to work together: Node
// writes a JPEG, `book-md --cover` reads it.
//
// Before this, the only way to get a generated cover into a book was to build
// the whole book through the Node path — which meant a markdown book had to go
// through an EPUB 2.0 assembler and a hand-rolled markdown converter to get one.
// That converter was the third markdown implementation in this repo, and it
// existed for exactly this reason.
//
//   node scripts/make-cover.mjs --title <text> --out <cover.jpeg>
//                               [--author <name>] [--translator <name>]
//                               [--direction ltr|rtl] [--imprint <text>]
//
// --direction, not --layout: the layout is a property of the edition and
// cover-page.js derives it, once. Callers that each re-derive "is this a
// Chinese book" are how two books in one series end up with two different
// covers.

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateCover } = require('../src/cover-generator');

function die(message) {
  console.error(`make-cover: ${message}

  Usage: node scripts/make-cover.mjs --title <text> --out <cover.jpeg>
                                     [--author <name>] [--translator <name>]
                                     [--direction ltr|rtl] [--imprint <text>]
`);
  process.exit(1);
}

const args = process.argv.slice(2);
const opts = {};
while (args.length) {
  const flag = args.shift();
  if (!flag.startsWith('--')) die(`unexpected argument ${JSON.stringify(flag)}`);
  const value = args.shift();
  if (value === undefined) die(`${flag} needs a value`);
  opts[flag.slice(2)] = value;
}

if (!opts.title) die('no --title');
if (!opts.out) die('no --out');

const direction = (opts.direction || 'ltr').toLowerCase();
if (direction !== 'ltr' && direction !== 'rtl') {
  die(`--direction must be ltr or rtl (got ${JSON.stringify(opts.direction)})`);
}

const out = resolve(opts.out);
await mkdir(dirname(out), { recursive: true });

await generateCover(opts.title, opts.author || '', out, {
  pageDirection: direction,
  translator: opts.translator || '',
  ...(opts.imprint ? { imprint: opts.imprint } : {}),
});

console.log(`make-cover: ${out}`);
