// The single image-optimization module for the reepub pipelines. Previously
// this lived twice (scripts/optimize.js and scripts/build-from-web.js) and
// the copies had already drifted: one kept the re-encode only when it shrank,
// the other overwrote unconditionally and so could make a book heavier.
//
// Two invariants make one implementation enough for every caller:
//   1. The output is never larger than the input. Re-encoding can *grow* a file
//      — a constant-row-delta PNG goes 949KB -> 1.15MB under sharp's default
//      encoder even after a 2.25x pixel reduction — so the candidate is
//      measured before it is allowed to replace anything.
//   2. Anything sharp cannot decode, or cannot re-encode in its own format,
//      passes through byte-for-byte instead of raising.
// Writing through a temp file and only then renaming is what makes both
// invariants hold when inputPath === outputPath (in-place optimization).

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DEFAULT_MAX_DIM = 1600;

// Encoder per *decoded* format, not per file extension: the decoded format is
// the truth about what the bytes are, and looking it up here is what keeps
// "png stays png, jpeg stays jpeg" structural. A format with no entry has no
// re-encode path and therefore passes through untouched.
// PNG is palette-quantized because this project ships e-ink diagrams and
// screenshots, where 256 colors are visually free and truecolor is not.
// Null prototype so that no format name can resolve to an inherited function.
const ENCODERS = Object.assign(Object.create(null), {
  png: (pipeline) => pipeline.png({ palette: true, quality: 80 }),
  jpeg: (pipeline) => pipeline.jpeg({ quality: 80 }),
});

function requirePathArg(value, name) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`dehydrateImage: ${name} must be a non-empty path string`);
  }
}

// True when both paths name the same file on disk, including via symlink or
// hard link. statSync throws when outputPath does not exist yet, which is the
// common case and correctly means "not the same file".
function isSameFile(a, b) {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    const statA = fs.statSync(a);
    const statB = fs.statSync(b);
    return statA.dev === statB.dev && statA.ino === statB.ino;
  } catch (_) {
    return false;
  }
}

// The output of last resort: the original bytes, which are by definition no
// larger than the input and still a valid image. In place, that is a no-op.
function passThrough(inputPath, outputPath) {
  if (!isSameFile(inputPath, outputPath)) fs.copyFileSync(inputPath, outputPath);
  return null;
}

/**
 * Re-encode one image so it is lighter, never heavier.
 *
 * @param {string} inputPath   image to read; may be the same file as outputPath
 * @param {string} outputPath  where the result is written (always written)
 * @param {{maxDim?: number}} [opts]  maxDim caps the longest side (default 1600);
 *                                    smaller images are never enlarged
 * @returns {Promise<{originalSize: number, newSize: number} | null>}
 *   the byte counts when the re-encode won, or null when the original bytes
 *   were passed through unchanged (grew, tied, corrupt, or unsupported format).
 *   Rejects only on caller errors — bad arguments, a missing input, an
 *   unwritable output — never on the content of a readable file.
 */
async function dehydrateImage(inputPath, outputPath, opts = {}) {
  requirePathArg(inputPath, 'inputPath');
  requirePathArg(outputPath, 'outputPath');
  if (opts === null || typeof opts !== 'object') {
    throw new TypeError('dehydrateImage: opts must be an object');
  }
  const maxDim = opts.maxDim === undefined ? DEFAULT_MAX_DIM : opts.maxDim;
  if (!Number.isInteger(maxDim) || maxDim < 1) {
    throw new TypeError(`dehydrateImage: opts.maxDim must be a positive integer (got ${maxDim})`);
  }

  const originalSize = fs.statSync(inputPath).size;
  // Unique per call so two dehydrations racing on one output cannot swap
  // half-written bytes into each other's result.
  const tmpPath = `${outputPath}.dehydrate-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;

  let newSize = null;
  try {
    const image = sharp(inputPath);
    const metadata = await image.metadata();
    const encode = ENCODERS[metadata.format];
    if (encode) {
      const pipeline = metadata.width > maxDim || metadata.height > maxDim
        ? image.resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
        : image;
      await encode(pipeline).toFile(tmpPath);
      newSize = fs.statSync(tmpPath).size;
    }
  } catch (_) {
    // Corrupt, truncated or non-image input. Nothing about the source is
    // trustworthy enough to re-encode, so it keeps its own bytes.
    newSize = null;
  }

  try {
    if (newSize !== null && newSize < originalSize) {
      fs.renameSync(tmpPath, outputPath);
      return { originalSize, newSize };
    }
    return passThrough(inputPath, outputPath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

module.exports = { dehydrateImage };
