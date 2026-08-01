// Merge several EPUB volumes of one series into a single book.
//
// Usage:
//   node src/merge.js [options] <output.epub> <input1.epub> [input2.epub ...]
//
// Volumes are merged in the order given. Each volume's first spine entry (its
// own table of contents) is dropped and every remaining chapter is renumbered
// into OEBPS/1.xhtml … OEBPS/N.xhtml.
//
// Moving a chapter changes what its relative references mean, so each one is
// re-resolved against the merged layout and the resource it names is carried
// across with it. Chapters used to be copied byte-for-byte out of
// OEBPS/chapters/ into OEBPS/, which left every '../style.css' and
// '../images/page_5.jpeg' pointing one directory above the container: an
// unstyled book with blank image pages that nothing in the pipeline noticed.
// Nothing is carried because a manifest declared it — only because a chapter
// actually points at it, which is what leaves the merged book with neither a
// dangling reference nor an orphan file.
//
// The package document, the NCX and the navigation document are written by
// src/binder.js, which escapes by construction: the hand-rolled templates that
// used to live here interpolated the title, the author and every TOC label raw,
// so 'AT&T 傳' produced malformed XML in three documents at once.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cheerio = require('cheerio');
const { execFileSync } = require('child_process');
const { newUuid, buildOpf, buildNcx, buildNavDocument, HREFS } = require('./binder');
const { escapeAttr, serializeXml, decodeNonAsciiRefs, stripPictographsFrom } = require('./epub-text');
const { validateEpub } = require('./validator');
const { generateCover, buildCoverImagePage } = require('./cover-generator');

// EPUB 3, because it is the only version whose spine can carry
// page-progression-direction: epubcheck rejects that attribute on an EPUB 2
// package (RSC-005), so an RTL series had to lose either its reading direction
// or its validity. src/builder.js already writes EPUB 3 content documents.
const EPUB_VERSION = '3.0';

// Where the merged book keeps the two things it carries. binder.js owns the
// rest of the layout (cover.xhtml, nav.xhtml, toc.ncx, images/).
const CSS_HREF = 'stylesheet.css';
const COVER_IMAGE = 'cover.jpeg';

const LANGUAGE_FALLBACK = 'zh-TW';

// Attributes that can carry an internal reference out of a content document.
// An SVG cover page points at its image through xlink:href.
const REFERENCE_ATTRIBUTES = ['href', 'src', 'xlink:href'];

// The image types binder.js can manifest in both EPUB 2 and EPUB 3. Anything
// else needs a manifest fallback this merge cannot invent.
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg'];

// Adobe Digital Editions page template, carried over from EPUB 2 volumes.
const PAGE_TEMPLATE_EXT = '.xpgt';
const PAGE_TEMPLATE_HREF = 'page-template.xpgt';
const PAGE_TEMPLATE_MEDIA_TYPE = 'application/vnd.adobe-page-template+xml';

// A url() a reader can never load. 'data:' is self-contained and stays; a
// relative path names a packaged file and is left to carryReference. Everything
// else — 'res:' pointing into an Android device's font directory, an http(s)
// asset, a file: path on the machine that made the book — is either remote,
// which EPUB 3 forbids for a resource used this way, or simply absent.
function unloadableUrl(url) {
  const value = url.trim().replace(/^['"]|['"]$/g, '');
  if (!value) return false;
  if (value.startsWith('data:')) return false;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith('//');
}

/**
 * Make a borrowed stylesheet safe to carry.
 *
 * Ebooks in the wild are full of rules that were only ever valid on the device
 * that produced them: every volume of a Chinese-market EPUB tends to open with
 * an @font-face pointing at res:///system/fonts/DroidSansFallback.ttf, a font
 * that exists on an Android reader and nowhere else. epubcheck rejects it
 * (RSC-006 / OPF-014) and no reader outside Android can load it, so the rule is
 * already dead — it only survives because nothing ever told the owner.
 *
 * Returns { css, healed } where healed lists what was removed, so the merge can
 * say out loud what it changed rather than quietly rewriting someone's book.
 */
function healStylesheet(source) {
  const healed = [];

  // An @font-face whose only source cannot load has nothing left to declare.
  let css = source.replace(/@font-face\s*\{[^}]*\}/gi, (block) => {
    const urls = [...block.matchAll(/url\(([^)]*)\)/gi)].map(m => m[1]);
    if (urls.length === 0 || !urls.every(unloadableUrl)) return block;
    const family = (block.match(/font-family\s*:\s*([^;}]+)/i) || [, 'unnamed'])[1].trim();
    healed.push(`@font-face ${family} → ${urls.map(u => u.trim()).join(', ')} cannot load in an EPUB`);
    return '';
  });

  // Any other declaration resting on an unloadable url() — a background image
  // served over http, say — goes the same way; the rest of the rule stays.
  css = css.replace(/([^;{}]+):([^;{}]*url\(([^)]*)\)[^;{}]*);/gi, (decl, property, value, url) => {
    if (!unloadableUrl(url)) return decl;
    healed.push(`${property.trim()} → ${url.trim()} cannot load in an EPUB`);
    return '';
  });

  return { css: healed.length ? css.replace(/\n{3,}/g, '\n\n') : source, healed };
}

const HELP = `reepub merge — combine multiple EPUBs from the same series into one.

Usage:
  node src/merge.js [options] <output.epub> <input1.epub> [input2.epub ...]

Options:
  --title <title>     Book title (default: first volume's title, volume number dropped)
  --author <author>   Book author (default: first volume's dc:creator)
  --cover             Generate and embed a clean synthetic cover image
  --no-validate       Skip EPUB validation after merge
  -h, --help          Show this help

Volumes are merged in the order given. Each volume's first spine entry
(typically a per-volume table of contents) is skipped; all remaining
chapters are renumbered sequentially and relinked to their new location.

Carried across with the chapters: every image they reference, and one
stylesheet. Output is EPUB 3 (content.opf + nav.xhtml + toc.ncx).

Limitations:
  - All volumes must share one stylesheet; a second, different one is refused.
  - A chapter reference to anything else (fonts, page templates, audio) is
    refused rather than shipped dangling.`;

function fail(message) {
  throw new Error(`merge: ${message}`);
}

// ---------------------------------------------------------------------------
// references
// ---------------------------------------------------------------------------

// Chapters are parsed with entity decoding OFF (see relocateChapter), so an
// attribute arrives spelled exactly as the source wrote it. Only the five
// predefined XML entities and numeric references can legitimately stand inside
// a path; &nbsp; and friends are left untouched, because they are not part of
// any filename and re-encoding them is how a chapter's text gets corrupted.
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlEntities(value) {
  return String(value).replace(/&(#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z]+);/g, (match, body) => {
    if (body[0] !== '#') {
      return XML_ENTITIES[body] === undefined ? match : XML_ENTITIES[body];
    }
    const code = body[1] === 'x' || body[1] === 'X'
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/** Percent-decode an href: the file on disk carries the decoded name. */
function decodeHref(raw, what) {
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return fail(`${what} is not valid percent-encoding`);
  }
}

/**
 * Resolve a reference against the directory it was written in and return the
 * path from the container root — the one key under which a volume's files are
 * known here, whoever pointed at them.
 */
function resolveContainerPath(baseDir, ref, what) {
  if (ref.startsWith('/')) {
    fail(`${what} is an absolute path; a reference must be relative to the document that makes it`);
  }
  const resolved = path.posix.normalize(path.posix.join(baseDir, ref));
  if (resolved === '..' || resolved.startsWith('../')) {
    fail(`${what} escapes the EPUB container`);
  }
  return resolved;
}

function loadXml(absPath, what, decodeEntities = true) {
  let source;
  try {
    source = fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    return fail(`cannot read ${what}: ${err.message}`);
  }
  return cheerio.load(source, { xmlMode: true, decodeEntities });
}

// ---------------------------------------------------------------------------
// volume extraction
// ---------------------------------------------------------------------------

/**
 * Unpack one volume, whole, into scratch space.
 *
 * unzip matches every file argument as a GLOB while OPF hrefs are
 * percent-encoded URLs, so 'chapters/第1話%20[修].xhtml' selected nothing at all
 * ("caution: filename not matched", exit 11): %20 was never decoded and [修] was
 * read as a bracket expression. Quoting a pattern for every unzip build is not
 * portable — a backslash escape is itself a legal filename character — so no
 * pattern is ever passed. Names come off the filesystem instead, and one
 * process replaces one per chapter.
 */
function unpackVolume(epubPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  try {
    execFileSync('unzip', ['-qq', '-o', epubPath, '-d', destDir], { stdio: 'pipe' });
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString().trim() : err.message;
    fail(`cannot unpack "${path.basename(epubPath)}": ${detail}`);
  }
  return destDir;
}

/** Container-relative path of the package document, per META-INF/container.xml. */
function readRootfilePath(volumeRoot, name) {
  const containerPath = path.join(volumeRoot, 'META-INF', 'container.xml');
  if (!fs.existsSync(containerPath)) {
    fail(`${name} has no META-INF/container.xml; it is not an EPUB`);
  }
  const $ = loadXml(containerPath, `${name} META-INF/container.xml`);
  const rootfiles = $('rootfile').toArray()
    .map(el => ({ fullPath: $(el).attr('full-path'), mediaType: $(el).attr('media-type') }))
    .filter(rf => rf.fullPath);
  if (rootfiles.length === 0) {
    fail(`${name} declares no rootfile in META-INF/container.xml`);
  }
  const rootfile = rootfiles.find(rf => rf.mediaType === 'application/oebps-package+xml') || rootfiles[0];
  return resolveContainerPath('.', decodeHref(rootfile.fullPath, `${name} rootfile "${rootfile.fullPath}"`),
    `${name} rootfile "${rootfile.fullPath}"`);
}

/** Chapter titles as the volume's own NCX gives them, keyed by container path. */
function readNcxLabels(volumeRoot, ncxPath, name) {
  const labels = new Map();
  const $ = loadXml(path.join(volumeRoot, ncxPath), `${name} ${ncxPath}`);
  const ncxDir = path.posix.dirname(ncxPath);
  for (const el of $('navPoint').toArray()) {
    const src = $(el).children('content').attr('src');
    const text = $(el).children('navLabel').children('text').first().text().trim();
    if (!src || !text) continue;
    const target = src.split('#')[0];
    if (!target) continue;
    const what = `${name} navPoint content src="${src}"`;
    const containerPath = resolveContainerPath(ncxDir, decodeHref(target, what), what);
    // First label wins: a nested navPoint pointing at the same document is a
    // section of it, not a better name for it.
    if (!labels.has(containerPath)) labels.set(containerPath, text);
  }
  return labels;
}

/**
 * Read one volume into the shape the merge works with.
 * Returns { name, root, title, creator, language, pageDirection, tocPath,
 *           chapters: [{ path, title }] }
 */
/**
 * Where the book keeps its cover image, if it declares one.
 *
 * A cover is not just a picture in the container: it is the manifest item a
 * reader is told to use for the shelf thumbnail. EPUB 2 says so with
 * <meta name="cover">, EPUB 3 with properties="cover-image". Carrying the file
 * across without carrying that declaration leaves the image sitting unused and
 * the book looking coverless, which is how a repaired library lost its covers.
 */
function findCoverImage($opf, manifest) {
  const declared = $opf('metadata > meta[name="cover"]').attr('content');
  if (declared && manifest.has(declared)) return manifest.get(declared).path;

  for (const [, item] of manifest) {
    if ((item.properties || '').split(/\s+/).includes('cover-image')) return item.path;
  }
  return '';
}

function readVolume(epubPath, volumeRoot, options = {}) {
  // Merging drops each volume's own table of contents, because the merged book
  // writes one of its own. Healing a single book keeps every spine document:
  // there is no new table of contents to replace it with, and silently losing a
  // document is not a repair.
  const dropTableOfContents = options.dropTableOfContents !== false;
  const name = path.basename(epubPath);
  unpackVolume(epubPath, volumeRoot);

  const opfPath = readRootfilePath(volumeRoot, name);
  const opfDir = path.posix.dirname(opfPath);
  const $opf = loadXml(path.join(volumeRoot, opfPath), `${name} ${opfPath}`);

  const manifest = new Map();
  for (const el of $opf('manifest > item').toArray()) {
    const id = $opf(el).attr('id');
    const href = $opf(el).attr('href');
    if (!id || !href) fail(`${name} has a manifest <item> without an id or an href`);
    const what = `${name} manifest item "${id}" href="${href}"`;
    manifest.set(id, {
      path: resolveContainerPath(opfDir, decodeHref(href, what), what),
      mediaType: $opf(el).attr('media-type') || '',
      properties: $opf(el).attr('properties') || '',
    });
  }

  const spine = [];
  for (const el of $opf('spine > itemref').toArray()) {
    const idref = $opf(el).attr('idref');
    const item = manifest.get(idref);
    if (!item) fail(`${name} has a spine itemref "${idref}" that the manifest does not declare`);
    // An EPUB 3 navigation document is the book's table of contents, not a
    // chapter of it. The rebuild always writes a fresh one, so carrying the old
    // one through as content would file the table of contents inside the book —
    // and rebuilding an already-rebuilt book would do it again every time.
    if ((item.properties || '').split(/\s+/).includes('nav')) continue;
    spine.push(item.path);
  }
  if (dropTableOfContents && spine.length < 2) {
    fail(`${name} contributes no chapters: its spine holds ${spine.length} document(s), and the first is the volume's own table of contents`);
  }
  if (!dropTableOfContents && spine.length < 1) {
    fail(`${name} has an empty spine — there is no reading order to repair`);
  }

  const ncx = [...manifest.values()].find(item => item.mediaType === 'application/x-dtbncx+xml');
  const labels = ncx && fs.existsSync(path.join(volumeRoot, ncx.path))
    ? readNcxLabels(volumeRoot, ncx.path, name)
    : new Map();

  const readingOrder = dropTableOfContents ? spine.slice(1) : spine;

  return {
    name,
    root: volumeRoot,
    title: $opf('metadata > dc\\:title').first().text().trim(),
    creator: $opf('metadata > dc\\:creator').first().text().trim(),
    language: $opf('metadata > dc\\:language').first().text().trim(),
    pageDirection: $opf('spine').attr('page-progression-direction') || '',
    // What the source book claimed about itself, so a caller can report the
    // difference between what it was and what it became.
    version: $opf('package').attr('version') || '',
    identifier: $opf('metadata > dc\\:identifier').first().text().trim(),
    ncxPath: ncx ? ncx.path : '',
    coverImagePath: findCoverImage($opf, manifest),
    tocPath: dropTableOfContents ? spine[0] : '',
    chapters: readingOrder.map(containerPath => ({
      path: containerPath,
      title: labels.get(containerPath) || '',
    })),
  };
}

// ---------------------------------------------------------------------------
// carried resources
// ---------------------------------------------------------------------------

/**
 * Everything the merged book carries besides its chapters: the images the
 * chapters reference and the one stylesheet they share.
 *
 * Files are keyed by content, so the same picture reused across volumes is
 * stored once, and two different pictures that happen to share a filename
 * cannot overwrite each other. Names are reduced to characters that survive
 * both an OPF href and a rewritten reference untouched by percent-encoding.
 */
function createResourcePool() {
  const nameByDigest = new Map();
  const taken = new Set();
  const files = [];
  let stylesheet = null;
  let pageTemplate = null;

  function digestOf(absPath) {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  }

  function allocate(absPath) {
    const ext = path.extname(absPath).toLowerCase();
    const stem = path.basename(absPath, path.extname(absPath)).replace(/[^A-Za-z0-9_-]+/g, '-');
    const base = /[A-Za-z0-9]/.test(stem) ? stem.replace(/^-+|-+$/g, '') : 'image';
    let name = `${base}${ext}`;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}${ext}`;
    taken.add(name);
    return name;
  }

  return {
    /** Claim a filename the book writes itself, before any chapter can take it. */
    reserve(name) {
      taken.add(name);
      return name;
    },

    image(absPath) {
      const digest = digestOf(absPath);
      let name = nameByDigest.get(digest);
      if (!name) {
        name = allocate(absPath);
        nameByDigest.set(digest, name);
        files.push({ name, absPath });
      }
      return HREFS.imagesDir + name;
    },

    // Adobe's page template is an EPUB 2-era extension that only sets page
    // margins, and reading direction survives without it (the spine carries
    // page-progression-direction and the stylesheet carries writing-mode).
    // It is still carried rather than dropped: every volume reepub built
    // before EPUB 3 links to one, so refusing it would fail the merge on the
    // libraries this command exists to serve, and silently unlinking it would
    // change how someone's book looks without telling them.
    pageTemplate(absPath, what) {
      const digest = digestOf(absPath);
      if (!pageTemplate) {
        pageTemplate = { digest, what };
        files.push({ name: PAGE_TEMPLATE_HREF, absPath, root: true });
      } else if (pageTemplate.digest !== digest) {
        fail(`${what} is a second, different page template (the first came from ${pageTemplate.what}); the merged book carries one`);
      }
      return PAGE_TEMPLATE_HREF;
    },

    /** What binder must declare beyond chapters, images, CSS and the cover. */
    resources() {
      return pageTemplate ? [{ href: PAGE_TEMPLATE_HREF, mediaType: PAGE_TEMPLATE_MEDIA_TYPE }] : [];
    },

    // One stylesheet per book, because a package document may declare one and
    // a chapter relinked to the wrong one would be styled by someone else's
    // rules — silently, which is worse than the refusal.
    stylesheet(absPath, what) {
      const digest = digestOf(absPath);
      if (!stylesheet) {
        const { css, healed } = healStylesheet(fs.readFileSync(absPath, 'utf8'));
        stylesheet = { digest, what, healed };
        files.push({ name: CSS_HREF, content: css, root: true });
      } else if (stylesheet.digest !== digest) {
        fail(`${what} is a second, different stylesheet (the first came from ${stylesheet.what}); the merged book carries one`);
      }
      return CSS_HREF;
    },

    /** What healStylesheet removed, so the merge can report it. */
    healed() {
      return stylesheet ? stylesheet.healed : [];
    },

    /** Bare filenames under images/, as binder.js manifests them. */
    imageNames() {
      return files.filter(f => !f.root).map(f => f.name);
    },

    cssHref() {
      return stylesheet ? CSS_HREF : '';
    },

    writeTo(oebpsDir) {
      const imagesDir = path.join(oebpsDir, HREFS.imagesDir);
      for (const file of files) {
        const dest = file.root ? path.join(oebpsDir, file.name) : path.join(imagesDir, file.name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (file.content === undefined) {
          fs.copyFileSync(file.absPath, dest);
        } else {
          fs.writeFileSync(dest, file.content);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// chapter relocation
// ---------------------------------------------------------------------------

/**
 * Decide what the merged book does with one thing a chapter points at, and
 * return the href that means the same thing from OEBPS/.
 */
function carryReference(containerPath, volume, pool, what) {
  const chapterHref = volume.hrefByPath.get(containerPath);
  if (chapterHref) return chapterHref;

  // The volume's own table of contents is dropped, but the merged book has one
  // of its own, so a link back to it still means what it meant.
  if (containerPath === volume.tocPath) return HREFS.nav;

  const absPath = path.join(volume.root, containerPath);
  if (!fs.existsSync(absPath)) {
    fail(`${what} names "${containerPath}", which the volume does not contain`);
  }

  const ext = path.extname(containerPath).toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext)) return pool.image(absPath);
  if (ext === '.css') return pool.stylesheet(absPath, what);
  if (ext === PAGE_TEMPLATE_EXT) return pool.pageTemplate(absPath, what);

  fail(`${what} names "${containerPath}", which the merged book cannot carry — a merged chapter may reference other chapters, images (${IMAGE_EXTENSIONS.join(' ')}), one stylesheet and one ${PAGE_TEMPLATE_EXT} page template`);
}

// An EPUB 3 content document declares '<!DOCTYPE html>'; epubcheck rejects the
// XHTML 1.1 PUBLIC doctype with HTM-004. Every volume built before reepub moved
// to EPUB 3 carries that older doctype, and a merged series is assembled almost
// entirely out of such volumes, so the merged book has to be brought forward —
// otherwise the package says EPUB 3 while its chapters say XHTML 1.1 and the
// whole book fails validation for a header nobody wrote by hand.
const EPUB3_DOCTYPE = '<!DOCTYPE html>';
const DOCTYPE_PATTERN = /<!DOCTYPE\s[^>[]*(\[[^\]]*\])?[^>]*>/i;

// Dropping the XHTML 1.1 doctype also drops the entity declarations that came
// with it: '&nbsp;' is defined by that DTD, not by XML, so a chapter carrying
// one would stop parsing the moment the doctype is modernized. Named entities
// are therefore resolved to numeric references, which need no DTD at all.
// cheerio already owns the HTML entity table — hardcoding a second copy of it
// here is exactly the kind of drift this refactor exists to remove.
const numericEntityCache = new Map();

function toNumericEntity(name, what) {
  if (XML_ENTITIES[name] !== undefined) return `&${name};`;
  if (numericEntityCache.has(name)) return numericEntityCache.get(name);

  // HTML parsing is lenient enough to resolve a prefix and keep the rest
  // ('&notarealentity;' becomes '¬arealentity;'), which would silently corrupt
  // the text. A genuine entity decodes to a single character, or at least to
  // something that no longer contains the terminating semicolon.
  const decoded = cheerio.load(`<x>&${name};</x>`)('x').text();
  if (decoded.includes(';') && [...decoded].length !== 1) {
    return fail(`${what} uses the named entity "&${name};", which is not defined by XML and is not a known HTML entity`);
  }
  const numeric = [...decoded].map(ch => `&#${ch.codePointAt(0)};`).join('');
  numericEntityCache.set(name, numeric);
  return numeric;
}

/**
 * Bring one chapter's document header forward to EPUB 3 without touching its
 * text: named entities become numeric references, then the doctype is replaced
 * (or added, for a chapter that never declared one).
 */
function modernizeContentDocument(source, what) {
  const converted = source.replace(/&([A-Za-z][A-Za-z0-9]*);/g, (_match, name) => toNumericEntity(name, what));
  if (DOCTYPE_PATTERN.test(converted)) {
    return converted.replace(DOCTYPE_PATTERN, EPUB3_DOCTYPE);
  }
  const declaration = converted.match(/^\s*<\?xml[^>]*\?>\s*/);
  return declaration
    ? converted.slice(0, declaration[0].length) + EPUB3_DOCTYPE + '\n' + converted.slice(declaration[0].length)
    : EPUB3_DOCTYPE + '\n' + converted;
}

/**
 * Put a document's content back inside a <body>.
 *
 * A generator that assembles XHTML by concatenating strings can drop the body
 * tags and leave the content sitting directly under <html> — the document still
 * looks fine in a browser, which is forgiving, and fails every conformance
 * check, which is not. One book shipped this way with 45 epubcheck errors.
 *
 * The repair is unambiguous: everything that is not the <head> belongs in the
 * body, in the order it already appears.
 */
function repairMissingBody($) {
  const html = $('html').first();
  if (html.length === 0 || html.children('body').length > 0) return false;

  const strays = html.children().not('head');
  if (strays.length === 0) return false;

  const body = $('<body></body>');
  strays.each((_, el) => body.append($(el)));
  html.append(body);
  return true;
}

/**
 * Rewrite one chapter for its new home at OEBPS/<n>.xhtml.
 * Returns { title, content } — content is the modernized document when nothing
 * in it had to move.
 *
 * The parser is deliberately run with entity decoding off. Decoding turns
 * '&nbsp;' — undefined in XML, defined by the XHTML 1.1 doctype these chapters
 * carry — into '&amp;nbsp;' on the way out, and re-encodes every CJK character
 * as a numeric reference. Attribute values therefore arrive raw and go back
 * escaped by hand, through the same escapeAttr the rest of the project uses.
 */
function relocateChapter(chapter, volume, pool, options = {}) {
  const raw = fs.readFileSync(path.join(volume.root, chapter.path), 'utf8');
  // Decoded before parsing so a pictograph written as &#x1f9e0; — plain ASCII
  // on disk, invisible to any text-level check — is seen by the emoji handling
  // below exactly like one written as itself.
  const source = decodeNonAsciiRefs(
    modernizeContentDocument(raw, `${volume.name} → ${chapter.path}`));
  const $ = cheerio.load(source, { xmlMode: true, decodeEntities: false });
  const baseDir = path.posix.dirname(chapter.path);
  let rewritten = repairMissingBody($);
  const bodyRepaired = rewritten;

  for (const el of $('*').toArray()) {
    for (const attr of REFERENCE_ATTRIBUTES) {
      const raw = el.attribs ? el.attribs[attr] : undefined;
      if (raw === undefined) continue;
      const ref = decodeXmlEntities(raw).trim();

      // A fragment stays inside the document; a scheme-qualified or
      // protocol-relative reference leaves the book entirely. Neither names a
      // packaged file, so neither moves.
      if (!ref || ref.startsWith('#') || ref.startsWith('//')) continue;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) continue;

      const hash = ref.indexOf('#');
      const target = hash === -1 ? ref : ref.slice(0, hash);
      const fragment = hash === -1 ? '' : ref.slice(hash);
      if (!target) continue;

      const what = `${volume.name} → ${chapter.path}: ${attr}="${ref}"`;
      const containerPath = resolveContainerPath(baseDir, decodeHref(target, what), what);
      const value = escapeAttr(carryReference(containerPath, volume, pool, what) + fragment);
      if (value === raw) continue;
      $(el).attr(attr, value);
      rewritten = true;
    }
  }

  // Emoji cost a book its cover and its whole table of contents on a Kindle.
  // See stripPictographsFrom in epub-text.js for what was tested to land
  // here. Removal is the default; 'keep' is the caller's explicit choice to
  // leave the book alone, and a glyph mapping redraws each pictograph as a
  // monochrome image in place (emoji-glyphs.js). This runs after the
  // reference walk above: a glyph's src is already its final pooled home, and
  // the walk would otherwise refuse it as a file the source volume never had.
  let pictographsRemoved = 0;
  let pictographsInlined = 0;
  const emoji = options.emoji || 'strip';
  if (emoji === 'strip') {
    pictographsRemoved = stripPictographsFrom($);
    if (pictographsRemoved > 0) rewritten = true;
  } else if (emoji !== 'keep') {
    const { inlinePictographsIn } = require('./emoji-glyphs');
    pictographsInlined = inlinePictographsIn($, emoji);
    if (pictographsInlined > 0) rewritten = true;
  }

  return {
    title: chapter.title || decodeXmlEntities($('head > title').first().text()).trim()
      || path.posix.basename(chapter.path),
    content: rewritten ? serializeXml($) : source,
    bodyRepaired,
    pictographsRemoved,
    pictographsInlined,
  };
}

// ---------------------------------------------------------------------------
// EPUB assembly
// ---------------------------------------------------------------------------

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;


/**
 * Lay the merged book out in bookDir and zip it to outputPath.
 * book: { title, author, language, pageDirection, chapters, pool, coverImagePath }
 */
function writeEpub(outputPath, bookDir, book) {
  const oebps = path.join(bookDir, 'OEBPS');
  fs.mkdirSync(oebps, { recursive: true });
  fs.mkdirSync(path.join(bookDir, 'META-INF'), { recursive: true });

  fs.writeFileSync(path.join(bookDir, 'mimetype'), 'application/epub+zip');
  fs.writeFileSync(path.join(bookDir, 'META-INF', 'container.xml'), CONTAINER_XML);

  const uuid = newUuid();
  const chapters = book.chapters.map(ch => ({ href: ch.href, title: ch.title }));
  const cssHref = book.pool.cssHref();
  const coverImage = book.coverImagePath ? `${HREFS.imagesDir}${COVER_IMAGE}` : '';

  fs.writeFileSync(path.join(oebps, 'content.opf'), buildOpf({
    version: EPUB_VERSION,
    title: book.title,
    creator: book.author,
    translator: book.translator,
    language: book.language,
    uuid,
    chapters,
    images: book.pool.imageNames(),
    cssHref,
    coverImage,
    resources: book.pool.resources(),
    pageDirection: book.pageDirection,
  }));
  fs.writeFileSync(path.join(oebps, HREFS.ncx), buildNcx({ title: book.title, uuid, chapters }));
  fs.writeFileSync(path.join(oebps, HREFS.nav), buildNavDocument({
    title: book.title,
    chapters,
    language: book.language,
    cssHref,
  }));

  for (const ch of book.chapters) fs.writeFileSync(path.join(oebps, ch.href), ch.content);
  book.pool.writeTo(oebps);

  if (coverImage) {
    // One picture, two jobs: the raster the shelf shows is the page the
    // reader opens. Setting the type again here as live HTML would look better
    // in principle and worse in fact — a reader that converts EPUB to its own
    // format supports far less CSS than the browser the raster was drawn in,
    // so the page could break while the thumbnail beside it stayed perfect.
    fs.writeFileSync(path.join(oebps, HREFS.coverPage), buildCoverImagePage({
      imageHref: coverImage,
      title: book.title,
      language: book.language,
    }));
    fs.mkdirSync(path.join(oebps, HREFS.imagesDir), { recursive: true });
    fs.copyFileSync(book.coverImagePath, path.join(oebps, HREFS.imagesDir, COVER_IMAGE));
  }

  // mimetype first and uncompressed, everything else after it.
  fs.rmSync(outputPath, { force: true });
  execFileSync('zip', ['-0Xq', outputPath, 'mimetype'], { cwd: bookDir });
  execFileSync('zip', ['-ur9q', outputPath, 'META-INF', 'OEBPS'], { cwd: bookDir });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(args) {
  const options = { title: '', author: '', cover: false, validate: true, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--title' || arg === '--author') {
      if (i + 1 >= args.length) fail(`${arg} needs a value`);
      options[arg.slice(2)] = args[++i];
      continue;
    }
    if (arg === '--cover') { options.cover = true; continue; }
    if (arg === '--no-validate') { options.validate = false; continue; }
    // An unknown flag used to be taken for a filename and reported as a missing
    // file, which reads as "your book is gone" rather than "I misspelled it".
    if (arg.startsWith('-')) fail(`unknown option "${arg}" (see --help)`);
    options.positional.push(arg);
  }
  return options;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  const options = parseArgs(args);
  if (options.positional.length < 2) {
    fail('need an output path and at least one input EPUB (see --help)');
  }

  const outputPath = path.resolve(options.positional[0]);
  const inputPaths = options.positional.slice(1).map(p => path.resolve(p));
  if (!fs.existsSync(path.dirname(outputPath))) {
    fail(`the output directory does not exist: ${path.dirname(outputPath)}`);
  }
  for (const input of inputPaths) {
    if (!fs.existsSync(input)) fail(`file not found: ${input}`);
  }

  // Scratch space belongs in the system temp directory: the output directory is
  // the user's, may be read-only, and must never be left holding our leftovers.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'reepub-merge-'));
  try {
    console.log(`Merging ${inputPaths.length} volume(s) → ${path.basename(outputPath)}`);

    const volumes = inputPaths.map((input, i) =>
      readVolume(input, path.join(scratch, 'volumes', String(i + 1))));

    // Chapters are numbered across the whole book before any of them is
    // rewritten, so a link from one chapter to another survives the move.
    let number = 0;
    for (const volume of volumes) {
      volume.hrefByPath = new Map();
      for (const chapter of volume.chapters) {
        number++;
        volume.hrefByPath.set(chapter.path, `${number}.xhtml`);
      }
    }

    const first = volumes[0];
    const title = options.title
      || first.title.replace(/[一二三四五六七八九十\d]+$/, '').trim()
      || first.title;
    if (!title) fail(`${first.name} has no dc:title; pass --title`);
    const author = options.author || first.creator;
    const language = first.language || LANGUAGE_FALLBACK;

    const pool = createResourcePool();
    if (options.cover) pool.reserve(COVER_IMAGE);

    const chapters = [];
    for (const volume of volumes) {
      for (const chapter of volume.chapters) {
        const relocated = relocateChapter(chapter, volume, pool);
        chapters.push({
          href: volume.hrefByPath.get(chapter.path),
          title: relocated.title,
          content: relocated.content,
        });
      }
      console.log(`  ${volume.name}: ${volume.title || '(untitled)'} (${volume.chapters.length} chapters)`);
    }
    console.log(`  total: ${chapters.length} chapters, ${pool.imageNames().length} images`);
    for (const note of pool.healed()) {
      console.log(`  healed: dropped ${note}`);
    }

    let coverImagePath = null;
    let coverFit = {};
    if (options.cover) {
      console.log('  generating cover…');
      coverImagePath = path.join(scratch, COVER_IMAGE);
      coverFit = await generateCover(title, author, coverImagePath,
        { pageDirection: first.pageDirection });
    }

    writeEpub(outputPath, path.join(scratch, 'book'), {
      title, author, language, pageDirection: first.pageDirection, chapters, pool, coverImagePath,
      titleScale: coverFit.titleScale, singleLine: coverFit.singleLine,
      lines: coverFit.lines, lineScales: coverFit.lineScales, imprint: coverFit.imprint,
      coverDrawn: Boolean(options.cover),
    });

    const sizeKb = (fs.statSync(outputPath).size / 1024).toFixed(0);
    console.log(`  ✓ ${path.basename(outputPath)} (${sizeKb} KB)`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  if (options.validate) {
    console.log('  validating…');
    const result = validateEpub(outputPath);
    if (!result.success) fail(`the merged book did not validate — ${result.error}`);
    console.log('  ✓ EPUB valid');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err && err.message ? err.message : err);
    // Not process.exit(): forcing the process down here used to hide a cover
    // generator that never closed its browser, because the leaked handle never
    // got the chance to keep the process alive. A failure still exits non-zero.
    process.exitCode = 1;
  });
}

// This file is the engine that rebuilds a book out of existing EPUBs: it reads
// what a volume actually contains, relocates each chapter with its references
// intact, repairs what it can, and hands the result to binder.js. src/heal.js
// drives the same engine with a single input, so the repairs a merge performs
// and the repairs `reepub heal` performs cannot drift apart.
module.exports = {
  healStylesheet,
  modernizeContentDocument,
  readVolume,
  createResourcePool,
  relocateChapter,
  writeEpub,
  EPUB_VERSION,
  LANGUAGE_FALLBACK,
  COVER_IMAGE,
};
