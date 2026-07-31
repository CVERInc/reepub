// Web edition -> EPUB: one parameterized pipeline for "a directory of chapter
// HTML plus an images folder". It replaces scripts/build-elon-from-web.js, a
// one-off that hardcoded its source directory, an output path inside one
// person's iCloud, the book title, the author and one site's class map — and
// that re-implemented sanitizing, image optimization and package assembly
// inline, each copy drifting from the others.
//
// Nothing is implemented here twice: src/sanitizer.js owns every content
// document, src/dehydrator.js owns every image, src/binder.js owns the package
// document and the NCX, src/validator.js owns the verdict. What is left — and
// all this module decides — is the container layout and the order of the
// stages:
//
//   mimetype
//   META-INF/container.xml
//   OEBPS/content.opf  toc.ncx  cover.xhtml  chapter-N.xhtml
//   OEBPS/css/reepub-core.css
//   OEBPS/images/cover.jpeg + the images the chapters actually reference
//
// Chapters sit beside the OPF rather than in a chapters/ subdirectory, so a
// source chapter's own '../images/x.png' rewrites to 'images/x.png' and a
// site that already writes 'images/x.png' needs no rewrite at all.
//
// The book is EPUB 2.0 (binder's default) because sanitizer emits XHTML 1.1
// content documents; the two constants move together or epubcheck rejects the
// DOCTYPE. An EPUB 3 edition would need the nav document binder writes for
// version '3.0' and a different DOCTYPE from the sanitizer.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const cheerio = require('cheerio');

const binder = require('./binder');
const { sanitizeChapter, sortChapterFiles } = require('./sanitizer');
const { dehydrateImage } = require('./dehydrator');
const { generateCover } = require('./cover-generator');
const { validateEpub } = require('./validator');
const { escapeAttr } = require('./epub-text');

const CONTENT_ROOT = 'OEBPS';
const OPF_HREF = 'content.opf';
const CSS_HREF = 'css/reepub-core.css';
const CORE_CSS_PATH = path.join(__dirname, 'styles', 'reepub-core.css');
const COVER_IMAGE_HREF = `${binder.HREFS.imagesDir}cover.jpeg`;

// A source chapter lives in chapters/ and reaches its images through '../';
// inside the book it lives beside them. Nothing else is rewritten: a reference
// this table does not cover is left exactly as the site wrote it, and is then
// answered by validateEpub rather than guessed at here.
const CHAPTER_IMAGE_REWRITES = Object.freeze({ '../images/': binder.HREFS.imagesDir });

// An <img src> that names one file directly under images/ — the only shape the
// manifest can carry (binder takes bare filenames under images/).
const IMAGE_REF_RE = new RegExp(`^${binder.HREFS.imagesDir}([^/]+)$`);

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${CONTENT_ROOT}/${OPF_HREF}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

function fail(message) {
  throw new TypeError(`buildWebEpub: ${message}`);
}

function requireText(value, what) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${what} is required and must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value.trim();
}

function optionalText(value, what) {
  if (value === undefined || value === null || value === '') return '';
  return requireText(value, what);
}

// The classes reepub-core.css can actually render, read from the stylesheet
// that is about to be packaged rather than from a list kept beside it.
function definedClasses() {
  const css = fs.readFileSync(CORE_CSS_PATH, 'utf8');
  return new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map(m => m[1]));
}

// A class survives sanitization only as a classMap value, so checking the map
// against the stylesheet here is what makes "a chapter ships a class with no
// rule behind it" impossible for the whole book — the defect that put
// fade-up / accent / container into 15 chapters with no CSS to render them.
function requireClassMap(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(`classMap must be an object of { siteClass: reepubClass } (got ${JSON.stringify(value)})`);
  }
  const defined = definedClasses();
  const map = {};
  for (const [from, to] of Object.entries(value)) {
    if (typeof to !== 'string' || !/^[A-Za-z][\w-]*$/.test(to)) {
      fail(`classMap[${JSON.stringify(from)}] must be a single CSS class name (got ${JSON.stringify(to)})`);
    }
    if (!defined.has(to)) {
      fail(`classMap[${JSON.stringify(from)}] maps to ".${to}", which ${CSS_HREF} does not define`);
    }
    map[from] = to;
  }
  return map;
}

function collectImageRefs(xhtml, into) {
  const $ = cheerio.load(xhtml, { xmlMode: true });
  $('img[src]').each((_, el) => into.add($(el).attr('src').trim()));
}

// The bare filename an <img src> names under images/, or null when it names
// anything else (a nested path, a sibling directory, a remote URL). EPUB hrefs
// are URLs, so the percent-encoding comes off before the name touches the disk.
function imageFileNameOf(ref) {
  let decoded;
  try {
    decoded = decodeURIComponent(ref);
  } catch (_) {
    return null;
  }
  const found = IMAGE_REF_RE.exec(decoded);
  return found ? found[1] : null;
}

/**
 * Build an EPUB from a directory of web chapters.
 *
 * opts: { srcDir, outputPath, title, creator, translator, language,
 *         classMap, coverLayout }
 *
 *   srcDir       must exist and hold chapters/*.html (images/ is optional)
 *   outputPath   where the .epub lands; its directory is created
 *   title        book title, also the cover title
 *   creator      the ORIGINAL author (dc:creator, MARC 'aut')
 *   translator   the translator (dc:contributor, MARC 'trl')
 *   language     BCP-47 tag; no default, because a guess mislabels the book
 *   classMap     { siteClass: reepubClass }; every value must be a class
 *                reepub-core.css defines, and every class outside it is dropped
 *   coverLayout  'horizontal' | 'vertical' (cover-generator's allowlist)
 *
 * Resolves with { outputPath } only when the finished file passed
 * validateEpub. On any failure it REJECTS and outputPath is untouched: the
 * book is assembled under a staging name and moved into place last, so a
 * broken build can neither ship nor destroy the edition already there.
 *
 * @param {object} opts
 * @returns {Promise<{outputPath: string}>}
 */
async function buildWebEpub(opts) {
  if (!opts || typeof opts !== 'object') fail('buildWebEpub(opts) needs an options object');

  // srcDir is checked before anything else so the most common caller mistake
  // keeps the most specific diagnostic.
  const srcDir = path.resolve(requireText(opts.srcDir, 'srcDir'));
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    throw new Error(`buildWebEpub: srcDir does not exist or is not a directory: ${srcDir}`);
  }

  const outputPath = path.resolve(requireText(opts.outputPath, 'outputPath'));
  const title = requireText(opts.title, 'title');
  const language = requireText(opts.language, 'language');
  const creator = optionalText(opts.creator, 'creator');
  const translator = optionalText(opts.translator, 'translator');
  const classMap = requireClassMap(opts.classMap);

  const chaptersDir = path.join(srcDir, 'chapters');
  if (!fs.existsSync(chaptersDir)) {
    throw new Error(`buildWebEpub: ${srcDir} has no chapters/ directory to build from`);
  }
  const chapterFiles = sortChapterFiles(
    fs.readdirSync(chaptersDir).filter(name => /\.html?$/i.test(name)));
  if (chapterFiles.length === 0) {
    throw new Error(`buildWebEpub: ${chaptersDir} contains no .html chapters`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'reepub-web-'));
  const oebps = path.join(work, CONTENT_ROOT);
  // Staged beside the destination, never in the temp dir: the rename that
  // publishes the book must stay on one filesystem to be atomic.
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const stagedPath = `${outputPath}.building-${process.pid}-${Math.random().toString(36).slice(2)}`;

  try {
    fs.mkdirSync(path.join(oebps, binder.HREFS.imagesDir), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(oebps, CSS_HREF)), { recursive: true });
    fs.mkdirSync(path.join(work, 'META-INF'), { recursive: true });
    fs.writeFileSync(path.join(work, 'mimetype'), 'application/epub+zip');
    fs.writeFileSync(path.join(work, 'META-INF', 'container.xml'), CONTAINER_XML);
    fs.copyFileSync(CORE_CSS_PATH, path.join(oebps, CSS_HREF));

    // First, so an unsupported layout is refused before a single chapter is
    // read. The allowlist stays in cover-generator: a copy of it here is the
    // drift this pipeline exists to remove.
    await generateCover(title, creator, path.join(oebps, COVER_IMAGE_HREF), opts.coverLayout);

    const chapters = [];
    const imageRefs = new Set();
    chapterFiles.forEach((name, i) => {
      const { xhtml, title: chapterTitle } = sanitizeChapter(
        fs.readFileSync(path.join(chaptersDir, name), 'utf8'), {
          lang: language,
          cssHref: CSS_HREF,
          fallbackTitle: `Chapter ${i + 1}`,
          classMap,
          imagePathRewrites: CHAPTER_IMAGE_REWRITES,
        });
      const href = `chapter-${i + 1}.xhtml`;
      fs.writeFileSync(path.join(oebps, href), xhtml);
      chapters.push({ id: `chapter-${i + 1}`, href, title: chapterTitle });
      collectImageRefs(xhtml, imageRefs);
    });

    // The book carries exactly the images its chapters ask for: an image the
    // site never uses is not a book resource, and every packaged file has to
    // appear in the manifest anyway. A reference that resolves to nothing is
    // deliberately left dangling — validateEpub names the document and the
    // href it came from, which is a better report than anything this loop
    // could invent, and it is the check that stops the book from shipping.
    const images = [];
    for (const ref of [...imageRefs].sort()) {
      const name = imageFileNameOf(ref);
      // The cover is generated, not copied; a site image of the same name must
      // not overwrite it. It is manifested as the cover image either way.
      if (!name || `${binder.HREFS.imagesDir}${name}` === COVER_IMAGE_HREF) continue;
      const from = path.join(srcDir, binder.HREFS.imagesDir, name);
      if (!fs.existsSync(from)) continue;
      await dehydrateImage(from, path.join(oebps, binder.HREFS.imagesDir, name));
      images.push(name);
    }

    // The cover page is a content document like any other, so it is written by
    // the sanitizer: DOCTYPE, namespace, language and escaping all come from
    // the one module that owns them.
    const cover = sanitizeChapter(
      `<html><head><title></title></head><body>`
      + `<div><img src="${COVER_IMAGE_HREF}" alt="${escapeAttr(title)}"/></div>`
      + `</body></html>`,
      { lang: language, cssHref: CSS_HREF, fallbackTitle: title });
    fs.writeFileSync(path.join(oebps, binder.HREFS.coverPage), cover.xhtml);

    // One uuid for both documents: two randomUUID() calls is how the OPF
    // identifier and the NCX dtb:uid used to disagree.
    const uuid = binder.newUuid();
    fs.writeFileSync(path.join(oebps, OPF_HREF), binder.buildOpf({
      title, creator, translator, language, uuid, chapters, images,
      cssHref: CSS_HREF,
      coverImage: COVER_IMAGE_HREF,
    }));
    fs.writeFileSync(path.join(oebps, binder.HREFS.ncx), binder.buildNcx({ title, uuid, chapters }));

    // mimetype first and STORED, everything else after and deflated.
    execFileSync('zip', ['-0', '-X', '-q', stagedPath, 'mimetype'], { cwd: work });
    execFileSync('zip', ['-r', '-9', '-X', '-D', '-q', stagedPath, 'META-INF', CONTENT_ROOT], { cwd: work });

    const verdict = validateEpub(stagedPath);
    if (!verdict.success) {
      throw new Error(
        `buildWebEpub: the assembled EPUB is invalid, so nothing was written to ${outputPath}\n${verdict.error}`);
    }

    fs.renameSync(stagedPath, outputPath);
    return { outputPath };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    // A no-op once the rename published the book; the whole failure path
    // depends on it otherwise.
    fs.rmSync(stagedPath, { force: true });
  }
}

module.exports = { buildWebEpub };
