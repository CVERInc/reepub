#!/usr/bin/env node
// check-optional-boundary.mjs — is epub-doctor actually installable without a
// browser, or does it only say so?
//
// The claim is that validating, repairing and merging an EPUB needs one library,
// and that the 150MB of Chromium behind --cover and --emoji glyph is a thing you
// can decline. packages/manifest.json declares it and check-packages.mjs proves
// the declaration matches the imports — but both of those read source. Neither
// has ever watched the program run with the browser missing, and "the imports
// look right" is not the same claim as "it works".
//
// So this removes playwright and sharp from module resolution and runs the thing
// for real: the repair modules must load, and the option that needs pixels must
// fail with a message that names what to install rather than a stack trace.
//
// Runs anywhere Node runs. No dependencies.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const assert = (ok, message) => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${message}`);
  if (!ok) failures++;
};

// The absence is simulated at resolution rather than by moving directories: an
// interrupted run that left node_modules half-renamed would be a worse problem
// than the one being tested.
const work = mkdtempSync(join(tmpdir(), 'reepub-optional-'));
const preload = join(work, 'no-raster.cjs');
writeFileSync(preload, `
const Module = require('module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'playwright' || request === 'sharp') {
    const err = new Error("Cannot find module '" + request + "'");
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }
  return resolve.call(this, request, ...rest);
};
`);

const runWithout = (args) => spawnSync(process.execPath, ['-r', preload, ...args],
  { cwd: repoRoot, encoding: 'utf8' });

try {
  console.log('\n=== epub-doctor without a rasteriser installed ===');

  // Sanity first: the simulation has to actually bite, or every check below it
  // passes for the wrong reason.
  const sanity = runWithout(['-e', "require('playwright')"]);
  assert(sanity.status !== 0 && /Cannot find module 'playwright'/.test(sanity.stderr),
    'sanity: playwright really is unreachable in this child process');

  for (const [label, code] of [
    ['validator', "const { validateEpub } = require('./src/validator'); if (typeof validateEpub !== 'function') process.exit(3);"],
    ['merge', "require('./src/merge');"],
    ['contents-page', "require('./src/contents-page');"],
  ]) {
    const run = runWithout(['-e', code]);
    assert(run.status === 0,
      `${label} loads with no browser present${run.status === 0 ? '' : ` — ${run.stderr.trim().split('\n')[0]}`}`);
  }

  const heal = runWithout([join('src', 'heal.js')]);
  assert(/Usage/.test(heal.stdout + heal.stderr),
    'heal runs and prints its usage, rather than dying on an import it does not need yet');

  console.log('\n=== and says so plainly when pixels are actually asked for ===');

  const asked = runWithout(['-e', `
    const { optional } = require('./src/optional');
    try {
      optional(() => require('./src/cover-generator'), { pkg: 'epub-raster', need: 'heal --cover' });
      process.exit(4);
    } catch (err) {
      console.log(JSON.stringify({ code: err.code, message: err.message }));
    }
  `]);
  let reported = {};
  try { reported = JSON.parse(asked.stdout.trim()); } catch { /* asserted below */ }

  assert(reported.code === 'MISSING_OPTIONAL_PACKAGE',
    `asking for a cover fails as a missing optional package, not as a crash (got ${JSON.stringify(reported.code)})`);
  assert(typeof reported.message === 'string' && reported.message.includes('epub-raster'),
    'the message names the package to install');
  assert(typeof reported.message === 'string' && reported.message.includes('heal --cover'),
    'and names the flag that asked for it');

  // A module that exists but throws while loading must not be reported as
  // missing: that error message sends the reader somewhere there is nothing to
  // find, which is worse than no message at all.
  const realBug = runWithout(['-e', `
    const { optional } = require('./src/optional');
    try {
      optional(() => { throw Object.assign(new Error('kaboom'), { code: 'ERR_SOMETHING_ELSE' }); },
        { pkg: 'epub-raster', need: 'heal --cover' });
      process.exit(5);
    } catch (err) {
      console.log(JSON.stringify({ code: err.code, message: err.message }));
    }
  `]);
  let passedThrough = {};
  try { passedThrough = JSON.parse(realBug.stdout.trim()); } catch { /* asserted below */ }
  assert(passedThrough.code === 'ERR_SOMETHING_ELSE' && passedThrough.message === 'kaboom',
    `a real failure inside an optional module is re-thrown untouched, not relabelled as "not installed" (got ${JSON.stringify(passedThrough)})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} failure(s): epub-doctor does not actually work without the rasteriser.`);
  process.exit(1);
}
console.log('\n[SUCCESS] The optional boundary is real, not just declared.');
