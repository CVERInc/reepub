// Shrink the images inside an existing EPUB and repackage the book unchanged
// in every other respect.
//
// The previous version assumed the content root was "OEBPS/": it looked for
// images in OEBPS/images and repackaged with `zip -ur9q out META-INF OEBPS`.
// On a Pandoc/InDesign/calibre book (EPUB/, OPS/, or a name of the author's
// choosing) zip found nothing to add, printed nothing under -q and exited 0, so
// the "optimized" file held mimetype and META-INF and nothing else — every
// chapter, image and the OPF silently dropped, then reported as a success.
//
// Two rules keep that whole class of bug out:
//   1. Nothing here names a directory. The content root is read from
//      META-INF/container.xml the way a reading system reads it, images are
//      found by walking the unpacked container, and the repackage re-adds the
//      exact list of files that came out of the archive.
//   2. The book is validated on the way in and on the way out, and every
//      failure — bad arguments, a broken input, a repackage that lost a file —
//      leaves the process with a non-zero exit code. A pipeline that ignores
//      stderr must still be unable to ship a destroyed book.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const cheerio = require('cheerio');
const { dehydrateImage } = require('../src/dehydrator');
const { validateEpub } = require('../src/validator');

const OPF_MEDIA_TYPE = 'application/oebps-package+xml';
// The extensions dehydrator.js has an encoder for. It would copy anything else
// through byte-for-byte, so walking those would announce work that never runs.
const IMAGE_EXT = /\.(png|jpe?g)$/i;

/** @returns {string[]} every file under dir, as paths relative to baseDir */
function listFiles(dir, baseDir = dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFiles(abs, baseDir));
    } else {
      found.push(path.relative(baseDir, abs));
    }
  }
  return found;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/**
 * Locate the package document through META-INF/container.xml, the only place an
 * EPUB says where its content lives. "OEBPS" is a convention, never a promise.
 * @param {string} epubDir Unpacked container root
 * @returns {{opfRelPath: string, contentRoot: string}} both relative to epubDir;
 *   contentRoot is '' when the OPF sits at the root of the container
 */
function findPackageDocument(epubDir) {
  const containerPath = path.join(epubDir, 'META-INF', 'container.xml');
  if (!fs.existsSync(containerPath)) {
    throw new Error('META-INF/container.xml is missing: this archive is not an EPUB');
  }

  const $ = cheerio.load(fs.readFileSync(containerPath, 'utf8'), { xmlMode: true });
  const rootfiles = $('rootfile').toArray()
    .map(el => ({ fullPath: $(el).attr('full-path'), mediaType: $(el).attr('media-type') }))
    .filter(rf => rf.fullPath);
  if (rootfiles.length === 0) {
    throw new Error('META-INF/container.xml declares no rootfile with a full-path attribute');
  }

  // Rootfiles of other media types are legal companions; the package document
  // is the one carrying the OPF media type.
  const rootfile = rootfiles.find(rf => rf.mediaType === OPF_MEDIA_TYPE) || rootfiles[0];
  let opfRelPath;
  try {
    opfRelPath = decodeURIComponent(rootfile.fullPath);
  } catch {
    throw new Error(`container.xml rootfile full-path "${rootfile.fullPath}" is not valid percent-encoding`);
  }

  const abs = path.resolve(epubDir, opfRelPath);
  const rel = path.relative(epubDir, abs);
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) {
    throw new Error(`container.xml rootfile full-path "${opfRelPath}" points outside the EPUB container`);
  }
  if (!fs.existsSync(abs)) {
    throw new Error(`container.xml names a package document at "${rel}", but the archive contains no such file`);
  }

  const contentRoot = path.dirname(rel);
  return { opfRelPath: rel, contentRoot: contentRoot === '.' ? '' : contentRoot };
}

// execFileSync's own message names the command that failed but never the
// reason; zip and unzip write that to stderr, and some of it to stdout.
function toolFailure(err) {
  const said = [err.stderr, err.stdout]
    .map(stream => (stream ? stream.toString().trim() : ''))
    .filter(Boolean)
    .join('\n');
  return said || err.message;
}

function unpack(epubPath, destDir) {
  try {
    execFileSync('unzip', ['-q', epubPath, '-d', destDir], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`Could not unzip "${epubPath}":\n${toolFailure(err)}`);
  }
}

/**
 * Write every listed file back into a fresh EPUB: mimetype first and stored, so
 * the archive stays recognizable byte-wise, then the rest deflated.
 * @param {string} sourceDir Unpacked container root
 * @param {string[]} relPaths Container-relative files, mimetype included
 * @param {string} epubPath Archive to create; replaced if it exists
 */
function repack(sourceDir, relPaths, epubPath) {
  const rest = relPaths.filter(rel => rel !== 'mimetype');
  if (rest.length === relPaths.length) {
    throw new Error('The unpacked book has no "mimetype" file, so it cannot be repackaged as an EPUB');
  }
  // zip -@ takes one name per line, which is what makes a name starting with
  // "-" a filename here instead of an option. A name containing a newline could
  // never survive that round trip, so it is refused rather than silently lost.
  const unfeedable = rest.filter(rel => rel.includes('\n'));
  if (unfeedable.length > 0) {
    throw new Error(`Cannot repackage: filename contains a newline: ${JSON.stringify(unfeedable[0])}`);
  }

  fs.rmSync(epubPath, { force: true });
  try {
    execFileSync('zip', ['-0Xq', epubPath, 'mimetype'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('zip', ['-9Xq', epubPath, '-@'], { cwd: sourceDir, input: rest.join('\n') + '\n', stdio: 'pipe' });
  } catch (err) {
    // A half-written archive is a broken book wearing a finished book's name.
    fs.rmSync(epubPath, { force: true });
    throw new Error(`Could not write "${epubPath}":\n${toolFailure(err)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error('Usage: node scripts/optimize.js <input.epub> <output.epub>');
    process.exit(1);
  }

  const inputEpub = path.resolve(args[0]);
  const outputEpub = path.resolve(args[1]);
  if (!fs.existsSync(inputEpub)) {
    throw new Error(`Input EPUB does not exist: ${inputEpub}`);
  }

  // Validating the input first is what keeps blame straight: after this point
  // any validation failure was caused here, not inherited.
  const inputCheck = validateEpub(inputEpub);
  if (!inputCheck.success) {
    throw new Error(`Input EPUB is not valid, refusing to optimize it:\n${inputCheck.error}`);
  }

  // Scratch space in the system temp dir, never beside the output: the output
  // directory may be read-only, and mkdtemp keeps two runs started in the same
  // millisecond out of each other's files.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reepub-opt-'));
  try {
    console.log(`Unpacking ${path.basename(inputEpub)}...`);
    unpack(inputEpub, tmp);

    const { opfRelPath, contentRoot } = findPackageDocument(tmp);
    console.log(`Content root: ${contentRoot === '' ? '(archive root)' : contentRoot + '/'} (package document ${opfRelPath})`);

    // The packing list is taken before any re-encoding, so nothing this run
    // creates — a stray encoder temp file, a .DS_Store — can end up in the book.
    const allFiles = listFiles(tmp);
    const images = allFiles.filter(rel => IMAGE_EXT.test(rel)).sort();

    let shrunk = 0;
    let totalSaved = 0;
    if (images.length === 0) {
      console.log('No PNG or JPEG images in this book — there is nothing to shrink.');
    } else {
      console.log(`Found ${images.length} image${images.length === 1 ? '' : 's'}:`);
      for (let i = 0; i < images.length; i++) {
        const rel = images[i];
        process.stdout.write(`  [${i + 1}/${images.length}] ${rel}... `);
        const result = await dehydrateImage(path.join(tmp, rel), path.join(tmp, rel));
        if (result) {
          const saved = result.originalSize - result.newSize;
          shrunk++;
          totalSaved += saved;
          console.log(`${formatBytes(result.originalSize)} -> ${formatBytes(result.newSize)} (saved ${formatBytes(saved)})`);
        } else {
          console.log('kept as-is (re-encoding would not make it smaller)');
        }
      }
      console.log(`${shrunk} of ${images.length} image${images.length === 1 ? '' : 's'} shrunk, ${formatBytes(totalSaved)} saved inside the book.`);
    }

    // Unpacking before this point is what lets input and output be the same
    // path: by now nothing on disk is needed from the original archive.
    console.log(`Repackaging ${allFiles.length} file${allFiles.length === 1 ? '' : 's'}...`);
    const inputSize = fs.statSync(inputEpub).size;
    repack(tmp, allFiles, outputEpub);
    const outputSize = fs.statSync(outputEpub).size;
    const delta = inputSize - outputSize;
    // Repackaging can also make a book *heavier* — the original archive may
    // have been deflated harder — so the comparison is stated, never assumed.
    const change = delta > 0 ? `${formatBytes(delta)} smaller`
      : delta < 0 ? `${formatBytes(-delta)} larger`
      : 'the same size';
    console.log(`Wrote ${path.basename(outputEpub)}: ${formatBytes(outputSize)}, ${change} than the input.`);

    console.log('Validating...');
    const outputCheck = validateEpub(outputEpub);
    if (!outputCheck.success) {
      // The broken file goes with the error: an unusable book left on disk is
      // exactly what the next stage of a pipeline would pick up.
      fs.rmSync(outputEpub, { force: true });
      throw new Error(`Optimized EPUB failed validation, so it was deleted:\n${outputCheck.error}`);
    }
    console.log('✓ EPUB valid');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
