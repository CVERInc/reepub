const fs = require('fs');
const os = require('os');
const path = require('path');
const cheerio = require('cheerio');
const { execFileSync } = require('child_process');

// Attributes that can carry an internal reference from an XHTML document.
// SVG cover pages point at their image through xlink:href, so it counts too.
const REFERENCE_ATTRIBUTES = ['href', 'src', 'xlink:href'];

/**
 * Helper to recursively find all files in a directory
 */
function getFilesRecursively(dir, baseDir = dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getFilesRecursively(fullPath, baseDir));
    } else {
      results.push(path.relative(baseDir, fullPath));
    }
  });
  return results;
}

/**
 * Reads an XML document, proves it is well-formed, and hands back a parsed
 * document. Every XML this validator inspects goes through here: a real parser
 * is what makes attribute-carrying elements (<manifest id="...">) and
 * commented-out markup impossible to misread, which pattern matching could
 * never guarantee.
 * @param {string} absPath Absolute path to the document
 * @param {string} label Container-relative name to use in error messages
 * @returns {cheerio.CheerioAPI}
 */
function loadXml(absPath, label) {
  try {
    execFileSync('xmllint', ['--noout', absPath], { stdio: 'pipe' });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('EPUB validation error: "xmllint" is required for XML well-formedness checks but was not found on PATH');
    }
    // xmllint reports against the path it was handed, which for a zipped book
    // is a scratch directory the reader has never heard of.
    const errMsg = (err.stderr ? err.stderr.toString() : err.message).replaceAll(absPath, label);
    throw new Error(`EPUB validation error: XML well-formedness check failed for "${label}":\n${errMsg.trim()}`);
  }
  return cheerio.load(fs.readFileSync(absPath, 'utf8'), { xmlMode: true });
}

/**
 * Resolves a path declared inside a book against the container root.
 * Existence must never be answered by the host filesystem: a book that reaches
 * outside itself is broken no matter what the machine happens to hold there.
 * @param {string} epubDir Container root
 * @param {string} baseDir Directory the reference is relative to
 * @param {string} ref Decoded, fragment-free path
 * @returns {{inside: boolean, absPath: string, relPath: string}}
 */
function resolveInContainer(epubDir, baseDir, ref) {
  const absPath = path.resolve(baseDir, ref);
  const relPath = path.relative(epubDir, absPath);
  const escapes = path.isAbsolute(relPath) || relPath === '..' || relPath.startsWith('..' + path.sep);
  return { inside: !escapes, absPath, relPath };
}

/**
 * EPUB hrefs are URLs, so percent-encoding must be undone before any path
 * lookup — and an undecodable one is a defect in the book, not a crash.
 * @param {string} raw
 * @param {string} what Subject of the error message, e.g. 'Manifest item "x" href'
 */
function decodeRef(raw, what) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new Error(`EPUB validation error: ${what} "${raw}" is not valid percent-encoding`);
  }
}

/**
 * Validates the mimetype zip layout of an EPUB file (first file, uncompressed)
 */
function validateZipMimetype(epubPath) {
  const fd = fs.openSync(epubPath, 'r');
  const buf = Buffer.alloc(38);
  try {
    fs.readSync(fd, buf, 0, 38, 0);
  } finally {
    fs.closeSync(fd);
  }

  // Signature PK\x03\x04 (0x04034b50 in little endian)
  if (buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('EPUB validation error: Not a valid ZIP file (invalid local file header signature)');
  }

  // Compression method (offset 8, 2 bytes) must be 0 (Stored)
  const compMethod = buf.readUInt16LE(8);
  if (compMethod !== 0) {
    throw new Error('EPUB validation error: "mimetype" file must be uncompressed (compression method must be Stored/0)');
  }

  // Filename length (offset 26, 2 bytes) must be 8
  const filenameLen = buf.readUInt16LE(26);
  if (filenameLen !== 8) {
    throw new Error('EPUB validation error: "mimetype" must be the first file in the ZIP archive');
  }

  // Filename (offset 30, 8 bytes) must be 'mimetype'
  const filename = buf.toString('utf8', 30, 38);
  if (filename !== 'mimetype') {
    throw new Error(`EPUB validation error: "mimetype" must be the first file in the ZIP archive (found "${filename}")`);
  }
}

/**
 * Structural checks that apply to an XHTML content document: real <body>
 * markup, and internal references that actually resolve inside the container.
 * @param {cheerio.CheerioAPI} $doc Parsed document
 * @param {string} epubDir Container root
 * @param {string} docRelPath Path of the document from the container root
 */
function validateXhtmlDocument($doc, epubDir, docRelPath) {
  const html = $doc('html').first();
  if (html.length === 0) {
    throw new Error(`EPUB validation error: XHTML document "${docRelPath}" has no <html> root element`);
  }
  if (html.children('body').length === 0) {
    throw new Error(`EPUB validation error: XHTML document "${docRelPath}" has no <body> element; content must live inside <html><body>...</body></html>`);
  }

  const docDir = path.dirname(path.resolve(epubDir, docRelPath));
  for (const el of $doc('*').toArray()) {
    for (const attr of REFERENCE_ATTRIBUTES) {
      const raw = $doc(el).attr(attr);
      if (!raw) continue;
      const ref = raw.trim();

      // Fragments stay in the document; scheme-qualified and protocol-relative
      // references leave the book entirely. Neither names a packaged file.
      if (!ref || ref.startsWith('#') || ref.startsWith('//')) continue;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) continue;

      const target = ref.split('#')[0];
      if (!target) continue;
      const decoded = decodeRef(target, `Reference ${attr}="${ref}" in "${docRelPath}"`);
      const location = resolveInContainer(epubDir, docDir, decoded);
      if (!location.inside) {
        throw new Error(`EPUB validation error: "${docRelPath}" references <${el.name} ${attr}="${ref}">, which escapes the EPUB container; every reference must resolve to a file inside the book`);
      }
      if (!fs.existsSync(location.absPath)) {
        throw new Error(`EPUB validation error: "${docRelPath}" references <${el.name} ${attr}="${ref}">, but the EPUB contains no such file (expected it at "${location.relPath}", relative to the EPUB root)`);
      }
    }
  }
}

/**
 * Main validation logic on extracted directory
 */
function validateDirectory(epubDir) {
  // 1. mimetype file content check
  const mimetypePath = path.join(epubDir, 'mimetype');
  if (!fs.existsSync(mimetypePath)) {
    throw new Error('EPUB validation error: "mimetype" file is missing from root');
  }
  const mimetypeContent = fs.readFileSync(mimetypePath, 'utf8').trim();
  if (mimetypeContent !== 'application/epub+zip') {
    throw new Error(`EPUB validation error: "mimetype" file content must be exactly "application/epub+zip", found "${mimetypeContent}"`);
  }

  // 2. container.xml check
  const containerPath = path.join(epubDir, 'META-INF', 'container.xml');
  if (!fs.existsSync(containerPath)) {
    throw new Error('EPUB validation error: "META-INF/container.xml" is missing');
  }

  const $container = loadXml(containerPath, 'META-INF/container.xml');
  const rootfiles = $container('rootfile').toArray()
    .map(el => ({ fullPath: $container(el).attr('full-path'), mediaType: $container(el).attr('media-type') }))
    .filter(rf => rf.fullPath);
  if (rootfiles.length === 0) {
    throw new Error('EPUB validation error: META-INF/container.xml does not declare a rootfile with full-path attribute');
  }
  // The package document is the rootfile carrying the OPF media type; other
  // rootfiles are legal and are not this validator's business.
  const rootfile = rootfiles.find(rf => rf.mediaType === 'application/oebps-package+xml') || rootfiles[0];
  const opfPathRelative = decodeRef(rootfile.fullPath, 'The container.xml rootfile full-path');

  // 3. OPF check
  const opfLocation = resolveInContainer(epubDir, epubDir, opfPathRelative);
  if (!opfLocation.inside) {
    throw new Error(`EPUB validation error: container.xml rootfile full-path "${opfPathRelative}" escapes the EPUB container; it must name a file inside the book`);
  }
  if (!fs.existsSync(opfLocation.absPath)) {
    throw new Error(`EPUB validation error: OPF rootfile "${opfPathRelative}" declared in container.xml does not exist`);
  }

  const $opf = loadXml(opfLocation.absPath, opfPathRelative);

  // Parse manifest
  if ($opf('manifest').length === 0) {
    throw new Error(`EPUB validation error: OPF file "${opfPathRelative}" is missing a <manifest> element`);
  }
  const manifestItems = new Map();
  for (const el of $opf('manifest > item').toArray()) {
    const id = $opf(el).attr('id');
    const href = $opf(el).attr('href');
    if (!id || !href) {
      throw new Error(`EPUB validation error: Manifest <item> is missing id or href attribute: ${$opf.html(el)}`);
    }
    manifestItems.set(id, { id, href, mediaType: $opf(el).attr('media-type') || '' });
  }

  // Parse spine and validate its item references
  if ($opf('spine').length === 0) {
    throw new Error(`EPUB validation error: OPF file "${opfPathRelative}" is missing a <spine> element`);
  }
  for (const el of $opf('spine > itemref').toArray()) {
    const idref = $opf(el).attr('idref');
    if (!idref) {
      throw new Error(`EPUB validation error: Spine <itemref> is missing idref attribute: ${$opf.html(el)}`);
    }
    if (!manifestItems.has(idref)) {
      throw new Error(`EPUB validation error: Spine refers to item idref "${idref}" which is not declared in the manifest`);
    }
  }

  // 4. Validate manifest containment, file existence and document structure
  const opfDir = path.dirname(opfLocation.absPath);
  const manifestPaths = new Set();

  for (const item of manifestItems.values()) {
    const decodedHref = decodeRef(item.href, `Manifest item "${item.id}" href`);
    const location = resolveInContainer(epubDir, opfDir, decodedHref);

    if (!location.inside) {
      throw new Error(`EPUB validation error: Manifest item "${item.id}" references "${decodedHref}", which escapes the EPUB container; every manifest href must resolve to a file inside the book`);
    }
    if (!fs.existsSync(location.absPath)) {
      throw new Error(`EPUB validation error: Manifest item "${item.id}" references file "${decodedHref}" which does not exist (expected "${location.relPath}" inside the EPUB)`);
    }

    // Save relative path from EPUB root for orphan detection
    manifestPaths.add(path.normalize(location.relPath));

    const ext = path.extname(location.absPath).toLowerCase();
    const isXhtml = item.mediaType === 'application/xhtml+xml' || ext === '.xhtml';
    const isXml = isXhtml ||
                  item.mediaType.endsWith('+xml') ||
                  ext === '.xml' ||
                  ext === '.ncx';

    if (isXml) {
      const $doc = loadXml(location.absPath, location.relPath);
      if (isXhtml) {
        validateXhtmlDocument($doc, epubDir, location.relPath);
      }
    }
  }

  // 5. Orphan File Detection (all files in directory must be in manifest or exempted)
  const allFiles = getFilesRecursively(epubDir);
  for (const fileRelPath of allFiles) {
    const normalizedPath = path.normalize(fileRelPath);

    // Exempt files that aren't declared in manifest
    if (normalizedPath === 'mimetype') continue;
    if (normalizedPath === path.normalize(opfLocation.relPath)) continue;
    if (normalizedPath.startsWith('META-INF' + path.sep)) continue;
    if (path.basename(normalizedPath) === '.DS_Store') continue;

    if (!manifestPaths.has(normalizedPath)) {
      throw new Error(`EPUB validation error: Orphan file found in EPUB: "${fileRelPath}" is not declared in the OPF manifest`);
    }
  }
}

/**
 * Validates an EPUB file (or unpacked directory).
 * Never throws: a malformed book, an unreadable path and unusable scratch
 * space are all reported through the returned object, never as an exception.
 * @param {string} targetPath Absolute path to .epub file or folder
 * @returns {{success: boolean, error?: string}}
 */
function validateEpub(targetPath) {
  let scratchDir = null;
  try {
    const absolutePath = path.resolve(targetPath);
    if (!fs.existsSync(absolutePath)) {
      return { success: false, error: `Path does not exist: ${absolutePath}` };
    }

    if (fs.statSync(absolutePath).isDirectory()) {
      validateDirectory(absolutePath);
      return { success: true };
    }

    // It's a file, validate mimetype first, then extract and validate directory
    validateZipMimetype(absolutePath);

    // Scratch space lives in the system temp dir, never beside the EPUB: the
    // book's own directory may be read-only, and mkdtemp is what keeps two
    // validations started in the same millisecond out of each other's files.
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reepub-validate-'));
    try {
      execFileSync('unzip', ['-q', absolutePath, '-d', scratchDir], { stdio: 'pipe' });
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`EPUB validation error: could not unzip "${absolutePath}":\n${errMsg}`);
    }

    validateDirectory(scratchDir);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (scratchDir) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  }
}

// Support CLI execution
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node src/validator.js <path-to-epub-file-or-dir>');
    process.exit(1);
  }

  console.log(`Validating EPUB at: ${args[0]}`);
  const result = validateEpub(args[0]);
  if (result.success) {
    console.log('\n[Success] EPUB validation passed! No XML errors or Manifest omissions found.');
    process.exit(0);
  } else {
    console.error(`\n[Failure] EPUB validation failed:\n${result.error}`);
    process.exit(1);
  }
}

module.exports = {
  validateEpub
};
