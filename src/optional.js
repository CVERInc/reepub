'use strict';

// A dependency one option needs and the rest of the program does not, written
// so that a machine can tell.
//
// `heal` validates and repairs an EPUB without drawing anything. Only --cover
// and --emoji glyph need pixels, and pixels mean a browser. Charging every user
// of a repair tool a 150MB install for two flags they may never pass is the
// thing this exists to prevent.
//
// Writing `require()` inside an `if` does not prevent it: the cost is charged
// when the package is installed, not when the line runs, so a lazy require
// saves load time and nothing else. What makes the difference is the boundary
// being declared — packages/manifest.json lists the optional edge, and
// scripts/check-packages.mjs recognises this exact call shape and leaves it out
// of the budget. A plain require of the same module is charged, as it should be.
//
//   const { generateCover } = optional(() => require('./cover-generator'),
//     { pkg: 'epub-raster', need: 'heal --cover' });
//
// The thunk is not decoration. It keeps the specifier at the call site, where
// Node resolves it correctly and where a reader can see what is being loaded.

/**
 * Load an optional module, or fail with a message naming what is missing and
 * which flag asked for it.
 *
 * Only a genuinely absent module is translated. A module that exists and throws
 * while loading is re-thrown untouched — swallowing that would turn a real bug
 * into "you should install something", which is the worst kind of error message
 * because it sends the reader somewhere there is nothing to find.
 */
function optional(load, { pkg, need }) {
  try {
    return load();
  } catch (err) {
    if (!err || err.code !== 'MODULE_NOT_FOUND') throw err;
    const missing = new Error(
      `${need} needs ${pkg}, which is not installed. Everything else in this `
      + `tool works without it — install ${pkg} to draw covers, or drop the flag.`);
    missing.code = 'MISSING_OPTIONAL_PACKAGE';
    missing.cause = err;
    throw missing;
  }
}

module.exports = { optional };
