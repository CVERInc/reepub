#!/usr/bin/env node
// Thin CLI over src/web-to-epub.js. It parses flags, reports the outcome and
// exits non-zero when the build fails — nothing else lives here.
//
// The version this replaced hardcoded its source directory, an output path
// inside one person's iCloud, the book title, the author and one site's class
// map, then finished with `buildFromWeb().catch(console.error)`: a validation
// failure was printed, the broken book stayed on disk and the process exited 0.
// Both halves of that are now structurally impossible — every value is a flag,
// and buildWebEpub rejects rather than logs.
//
//   node scripts/build-elon-from-web.js \
//     --src /tmp/book-of-elon-src \
//     --out ~/Books/the-book-of-elon.epub \
//     --title 'The Book of Elon' \
//     --author 'Eric Jorgenson' \
//     --lang zh-TW --cover horizontal

const fs = require('fs');
const path = require('path');
const { buildWebEpub } = require('../src/web-to-epub');
const { DEFAULT_CLASS_MAP } = require('../src/sanitizer');

const USAGE = `Usage: node scripts/build-elon-from-web.js --src <dir> --out <file.epub> --title <text> --lang <bcp47> [options]

  --src <dir>          site directory holding chapters/*.html and images/  (required)
  --out <file.epub>    where to write the book                             (required)
  --title <text>       book title, also the cover title                    (required)
  --lang <bcp47>       language tag, e.g. zh-TW                            (required)
  --author <name>      the ORIGINAL author  (dc:creator, MARC 'aut')
  --translator <name>  the translator       (dc:contributor, MARC 'trl')
  --cover <layout>     cover layout: horizontal | vertical  (default vertical)
  --class-map <file>   JSON { "siteClass": "reepubClass" } translation table;
                       defaults to the Book of Elon web edition's table`;

const FLAGS = {
  '--src': 'srcDir',
  '--out': 'outputPath',
  '--title': 'title',
  '--lang': 'language',
  '--author': 'creator',
  '--translator': 'translator',
  '--cover': 'coverLayout',
  '--class-map': 'classMapPath',
};

// Everything a book cannot be built without. The rest is optional because the
// pipeline has an honest answer for its absence — no author line on the cover,
// no translator credit, cover-generator's own default layout, the bundled class
// table — whereas a guessed title, path or language is a silent defect.
const REQUIRED_FLAGS = ['--src', '--out', '--title', '--lang'];

function die(message) {
  console.error(`build-elon-from-web: ${message}\n\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    const key = FLAGS[flag];
    if (!key) die(`unknown argument ${JSON.stringify(flag)}`);
    if (i + 1 >= argv.length) die(`${flag} needs a value`);
    parsed[key] = argv[++i];
  }
  return parsed;
}

// A class map from disk is untrusted input: a parse error or the wrong shape
// must be reported against the file the user named, not surface later as a
// confusing complaint about the table's contents.
function readClassMap(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    die(`could not read --class-map ${file}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    die(`--class-map ${file} is not valid JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    die(`--class-map ${file} must contain a JSON object of { "siteClass": "reepubClass" }`);
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const flag of REQUIRED_FLAGS) {
    if (!args[FLAGS[flag]]) die(`${flag} is required`);
  }

  // Every argument is settled before the build is announced, so a usage error
  // never appears under a "Building …" line that was never true.
  const classMap = args.classMapPath ? readClassMap(args.classMapPath) : DEFAULT_CLASS_MAP;
  const outputPath = path.resolve(args.outputPath);
  console.log(`Building ${args.title} -> ${outputPath}`);

  const { outputPath: written } = await buildWebEpub({
    srcDir: args.srcDir,
    outputPath,
    title: args.title,
    creator: args.creator,
    translator: args.translator,
    language: args.language,
    classMap,
    coverLayout: args.coverLayout,
  });

  const sizeMb = (fs.statSync(written).size / 1024 / 1024).toFixed(2);
  console.log(`Validated and saved: ${written} (${sizeMb} MB)`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
