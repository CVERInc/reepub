#!/usr/bin/env node
// check-packages.mjs — the guard over packages/manifest.json.
//
// The manifest says which package every source file belongs to. This makes that
// claim true rather than aspirational, and the check that matters most is the
// dullest one: a source file owned by NOBODY fails the build.
//
// That check is aimed at a specific, observed failure. reepub began with the
// right division of labour and lost it twice, both times without anyone
// deciding to: a file appeared, it went wherever was convenient, and nothing
// objected. Five Node modules arrived in three days that way. A README asking
// for discipline would not have caught one of them; a build that goes red does.
//
// Checks, all reported in a single run:
//
//   1. every non-virtual package has packages/<name>/README.md
//   2. every path the manifest claims exists on disk
//   3. no path is claimed by two packages
//   4. every source file on disk is claimed by exactly one package   ← the point
//   5. a frozen package's files still hash to what was recorded
//   6. only a declared assembler emits a <package> / NCX / nav document
//
// Run with --selftest to watch every one of them fail on purpose. A gate nobody
// has seen fail is not evidence of anything, so the failures are demonstrated
// here rather than assumed. The checks are pure functions of a "world" object,
// which is what lets the selftest build broken worlds without touching the repo.
//
// Exit 0 = the tree matches the ledger. Exit 1 = it does not. No dependencies.

import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Directories whose sources the ledger is responsible for, and the extensions
// that count as source. Anything else (assets, fixtures, docs) is out of scope
// on purpose — the ledger tracks code, not everything.
const SCANNED_DIRS = ['src', 'scripts', 'macos/Sources', 'packages'];
const SOURCE_EXTENSIONS = ['.js', '.mjs', '.swift', '.sh'];

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------- the checks
//
// A world is { manifest, files: Map<relPath, contents>, readmes: Set<relPath> }.
// Every check returns an array of problem lines; empty means it passed.

function checkReadmes(world) {
  const problems = [];
  for (const [name, pkg] of Object.entries(world.manifest.packages)) {
    if (pkg.status === 'virtual') continue;
    const readme = `packages/${name}/README.md`;
    if (!world.readmes.has(readme)) {
      problems.push(`${name}: no ${readme} — a package with no README is a directory`);
    }
  }
  return problems;
}

function checkClaimedPathsExist(world) {
  const problems = [];
  for (const [name, pkg] of Object.entries(world.manifest.packages)) {
    for (const path of pkg.sources) {
      if (!world.files.has(path)) {
        problems.push(`${name} claims ${path}, which does not exist — a rename left the ledger pointing at nothing`);
      }
    }
  }
  return problems;
}

function checkNoDoubleClaim(world) {
  const owners = new Map();
  const problems = [];
  for (const [name, pkg] of Object.entries(world.manifest.packages)) {
    for (const path of pkg.sources) {
      if (owners.has(path)) {
        problems.push(`${path} is claimed by both ${owners.get(path)} and ${name}`);
      } else {
        owners.set(path, name);
      }
    }
  }
  return problems;
}

// The one this file exists for.
function checkNothingUnowned(world) {
  const claimed = new Set(
    Object.values(world.manifest.packages).flatMap((pkg) => pkg.sources));
  const problems = [];
  for (const path of [...world.files.keys()].sort()) {
    if (!claimed.has(path)) {
      problems.push(`${path} belongs to no package — add it to packages/manifest.json, deciding where it lives rather than letting it land somewhere`);
    }
  }
  return problems;
}

function checkFrozen(world) {
  const problems = [];
  for (const [name, pkg] of Object.entries(world.manifest.packages)) {
    if (pkg.status !== 'frozen') continue;
    if (!pkg.hashes) {
      problems.push(`${name} is frozen but records no hashes — a freeze nothing measures is a promise`);
      continue;
    }
    for (const path of pkg.sources) {
      const contents = world.files.get(path);
      if (contents === undefined) continue; // already reported by check 2
      const actual = sha256(contents);
      if (actual !== pkg.hashes[path]) {
        problems.push(`${path} changed and ${name} is frozen (recorded ${String(pkg.hashes[path]).slice(0, 12)}…, found ${actual.slice(0, 12)}…)`);
      }
    }
  }
  return problems;
}

// Marks that mean "this file assembles an EPUB package". Kept literal: a file
// that builds the string some cleverer way is not caught here, and pretending
// otherwise would be worse than the honest limit.
const ASSEMBLY_MARKS = [
  ['<package', 'a package document'],
  ['<ncx', 'an NCX'],
  ['epub:type="toc"', 'a navigation document'],
];

function checkAssemblyBoundary(world) {
  const assemblers = new Set(world.manifest.assemblers);
  const ownerOf = new Map();
  for (const [name, pkg] of Object.entries(world.manifest.packages)) {
    for (const path of pkg.sources) ownerOf.set(path, name);
  }

  const problems = [];
  for (const [path, contents] of world.files) {
    const owner = ownerOf.get(path);
    if (owner === undefined) continue;             // check 4 reports it
    if (world.manifest.packages[owner].status === 'virtual') continue;
    if (assemblers.has(owner)) continue;
    for (const [mark, what] of ASSEMBLY_MARKS) {
      if (contents.includes(mark)) {
        problems.push(`${path} emits ${what} but ${owner} is not a declared assembler (declared: ${[...assemblers].join(', ')})`);
      }
    }
  }
  return problems;
}

const CHECKS = [
  ['every package has a README', checkReadmes],
  ['every claimed path exists', checkClaimedPathsExist],
  ['no path is claimed twice', checkNoDoubleClaim],
  ['no source file is unowned', checkNothingUnowned],
  ['frozen packages are unchanged', checkFrozen],
  ['only an assembler emits a package document', checkAssemblyBoundary],
];

// ----------------------------------------------------------------- the world

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;                                     // a scanned dir may not exist yet
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.build' || entry.name === 'build') continue;
      await walk(full, out);
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

async function readWorld() {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'packages/manifest.json'), 'utf8'));

  const files = new Map();
  for (const dir of SCANNED_DIRS) {
    for (const full of await walk(join(repoRoot, dir))) {
      files.set(relative(repoRoot, full), await readFile(full, 'utf8'));
    }
  }

  const readmes = new Set();
  for (const name of Object.keys(manifest.packages)) {
    const rel = `packages/${name}/README.md`;
    try {
      if ((await stat(join(repoRoot, rel))).isFile()) readmes.add(rel);
    } catch { /* absent; checkReadmes reports it */ }
  }

  return { manifest, files, readmes };
}

// -------------------------------------------------------------------- report

function run(world) {
  let failed = 0;
  for (const [what, check] of CHECKS) {
    const problems = check(world);
    if (problems.length) {
      failed++;
      console.error(`✗ ${what}`);
      for (const line of problems) console.error(`    ${line}`);
    } else {
      console.log(`✓ ${what}`);
    }
  }
  return failed;
}

// ------------------------------------------------------------------ selftest
//
// Each case takes the real world and breaks exactly one thing, so a case that
// stops failing means the check stopped working — not that the repo got tidier.

function selftest(real) {
  const clone = () => ({
    manifest: JSON.parse(JSON.stringify(real.manifest)),
    files: new Map(real.files),
    readmes: new Set(real.readmes),
  });

  const cases = [
    ['every package has a README', checkReadmes, (w) => {
      w.readmes.delete([...w.readmes][0]);
    }],
    ['every claimed path exists', checkClaimedPathsExist, (w) => {
      w.manifest.packages['epub-text'].sources.push('src/does-not-exist.js');
    }],
    ['no path is claimed twice', checkNoDoubleClaim, (w) => {
      w.manifest.packages['epub-text'].sources.push('src/validator.js');
    }],
    ['no source file is unowned', checkNothingUnowned, (w) => {
      w.files.set('src/snuck-in.js', '// a session added this without deciding where it lives\n');
    }],
    ['frozen packages are unchanged', checkFrozen, (w) => {
      const pkg = w.manifest.packages['ocr-builder-node'];
      pkg.status = 'frozen';
      pkg.hashes = Object.fromEntries(pkg.sources.map((p) => [p, 'deadbeef'.repeat(8)]));
    }],
    // The mark comes from ASSEMBLY_MARKS rather than being spelled out again:
    // a second copy would drift from the real one, and writing the literal here
    // would trip the release-readiness check that forbids a stray <package>
    // template — which it duly did, the first time this file ran.
    ['only an assembler emits a package document', checkAssemblyBoundary, (w) => {
      const [mark] = ASSEMBLY_MARKS[0];
      w.files.set('src/validator.js', `${w.files.get('src/validator.js')}\n// ${mark} version="3.0">\n`);
    }],
  ];

  let failed = 0;
  console.log('Selftest — every check must fail when its rule is broken:\n');
  for (const [what, check, breakIt] of cases) {
    const world = clone();
    breakIt(world);
    const problems = check(world);
    if (problems.length === 0) {
      failed++;
      console.error(`✗ ${what} — DID NOT FIRE. The check is asleep; the tree being clean proves nothing.`);
    } else {
      console.log(`✓ ${what} — fires: ${problems[0]}`);
    }
  }

  // And the whole suite must be quiet on the untouched tree, or the cases above
  // would pass for the wrong reason.
  const baseline = CHECKS.flatMap(([, check]) => check(real));
  if (baseline.length) {
    failed++;
    console.error(`\n✗ baseline — the real tree already fails ${baseline.length} check(s); the cases above prove nothing`);
  } else {
    console.log('\n✓ baseline — the untouched tree passes every check');
  }
  return failed;
}

// ---------------------------------------------------------------------- main

const world = await readWorld();
const wantsSelftest = process.argv.includes('--selftest');
const failed = wantsSelftest ? selftest(world) : run(world);

if (failed > 0) {
  console.error(wantsSelftest
    ? `\n${failed} check(s) do not do what they claim.`
    : `\n${failed} check(s) failed — the tree and packages/manifest.json disagree.`);
  process.exit(1);
}

console.log(wantsSelftest
  ? '\nEvery check fires when its rule is broken.'
  : `\nEvery source file belongs to a package. ${Object.keys(world.manifest.packages).length} packages, ${world.files.size} files.`);
