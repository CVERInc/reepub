// EPUB package assembly — the single place in this project where a <package>
// document, an NCX or an EPUB 3 navigation document is emitted.
//
// Three hand-rolled templates (builder.js, merge.js, scripts/build-elon-from-web.js)
// drifted apart into different EPUB versions, different escaping (one of them
// had none at all), invalid identifiers and an NCX whose dtb:uid was minted by
// a second randomUUID() call and so never matched the OPF. Callers now describe
// the book and this module writes every byte of XML, which is what makes that
// whole class of drift structurally impossible rather than repeatedly fixed.
//
// Path conventions the OPF encodes and every caller must honour when it writes
// files next to the OPF — exported as HREFS so nobody has to guess:
//
//   cover.xhtml   cover page (spine opens with it when coverImage is given)
//   nav.xhtml     EPUB 3 navigation document (buildNavDocument)
//   toc.ncx       NCX (buildNcx)
//   images/       every filename passed in opts.images
//
// chapters: [{ id?, href, title }] — href is the REAL filename relative to the
// OPF ('chapters/第1話 [修].xhtml'). Percent-encoding happens here, so a href
// that arrives pre-encoded is encoded twice; decode before handing it over.

const crypto = require('crypto');
const { escapeXML, escapeAttr } = require('./epub-text');

const HREFS = Object.freeze({
  coverPage: 'cover.xhtml',
  nav: 'nav.xhtml',
  ncx: 'toc.ncx',
  imagesDir: 'images/',
});

// The id attribute unique-identifier points at. Every EPUB this project has
// shipped names it BookID; changing it would orphan nothing, but re-using the
// name keeps diffs against older books readable.
const UNIQUE_ID = 'BookID';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPPORTED_VERSIONS = ['2.0', '3.0'];
const PAGE_DIRECTIONS = ['ltr', 'rtl', 'default'];

// Only the raster/vector types that are core media types in BOTH EPUB 2 and
// EPUB 3. Anything else (webp, avif, bmp…) needs a manifest fallback that no
// caller here can supply, so it is rejected instead of shipped mislabelled.
const IMAGE_MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

function fail(message) {
  throw new TypeError(`binder: ${message}`);
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

function requireVersion(value) {
  if (value === undefined || value === null || value === '') return '2.0';
  if (!SUPPORTED_VERSIONS.includes(value)) {
    fail(`version must be one of ${SUPPORTED_VERSIONS.join(' / ')} (got ${JSON.stringify(value)})`);
  }
  return value;
}

// A bare RFC-4122 UUID. The 'urn:uuid:' prefix belongs to the identifier this
// module writes, not to the input: 'urn:uuid:book-of-elon-web' shipped once and
// epubcheck rejected the book (OPF-085).
function requireUuid(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    fail(`uuid must be a bare RFC-4122 UUID without the "urn:uuid:" prefix — call newUuid() (got ${JSON.stringify(value)})`);
  }
  return value.toLowerCase();
}

// A container-relative path to a file that sits beside the OPF. Returns the
// percent-encoded form: each segment is encoded on its own so '/' survives and
// decodeURIComponent gives the real filename back.
function requireHref(value, what) {
  const raw = requireText(value, what);
  const segments = raw.split('/');
  if (segments.some(s => s === '' || s === '.' || s === '..')) {
    fail(`${what} must be a relative path inside the container with no empty, "." or ".." segments (got ${JSON.stringify(raw)})`);
  }
  return segments.map(encodeURIComponent).join('/');
}

function mediaTypeOfImage(name, what) {
  const ext = (name.match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase();
  const mediaType = IMAGE_MEDIA_TYPES[ext];
  if (!mediaType) {
    fail(`${what} has no supported image extension (${Object.keys(IMAGE_MEDIA_TYPES).join(', ')}): ${JSON.stringify(name)}`);
  }
  return mediaType;
}

// dcterms:modified must be an exact 'YYYY-MM-DDTHH:MM:SSZ' — epubcheck rejects
// the milliseconds that toISOString() emits. Accepting anything Date understands
// and normalising here is what keeps a caller from inventing its own format.
function requireModified(value) {
  const when = (value === undefined || value === null || value === '') ? new Date() : new Date(value);
  if (Number.isNaN(when.getTime())) {
    fail(`modified must be a date (Date, ISO-8601 string or epoch ms); got ${JSON.stringify(value)}`);
  }
  return when.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function requireChapters(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('chapters must be a non-empty array of { id?, href, title } — a spine with no itemref is not a book');
  }
  return value.map((ch, i) => {
    if (!ch || typeof ch !== 'object') fail(`chapters[${i}] must be an object { id?, href, title }`);
    return {
      id: optionalText(ch.id, `chapters[${i}].id`) || `chap-${i + 1}`,
      href: requireHref(ch.href, `chapters[${i}].href`),
      title: requireText(ch.title, `chapters[${i}].title`),
    };
  });
}

function requireArray(value, what) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${what} must be an array (got ${JSON.stringify(value)})`);
  return value;
}

// Manifest ids are XML NCNames and must be unique across the whole document;
// hrefs must appear exactly once. Both invariants are enforced by the only
// functions that can hand out an id, so no template can reintroduce a
// collision — the old id derivation stripped every non-alphanumeric character
// and silently merged a_b.png with ab.png.
function createManifest() {
  const takenIds = new Set();
  const idByHref = new Map();
  const items = [];

  function uniqueId(hint) {
    let base = String(hint).replace(/[^A-Za-z0-9_.-]/g, '-');
    if (!/^[A-Za-z_]/.test(base)) base = `id-${base}`;
    let id = base;
    for (let n = 2; takenIds.has(id); n++) id = `${base}-${n}`;
    takenIds.add(id);
    return id;
  }

  return {
    // Claim an id used elsewhere in the package document (a refines target).
    // Reserving before the items are added is what keeps a chapter id from
    // taking a name the metadata already points at.
    reserve(idHint) {
      return uniqueId(idHint);
    },
    add(idHint, href, mediaType, properties) {
      if (idByHref.has(href)) {
        fail(`${href} is manifested twice (as ${idByHref.get(href)} and ${idHint}) — every resource may appear once`);
      }
      const id = uniqueId(idHint);
      idByHref.set(href, id);
      const props = properties ? ` properties="${escapeAttr(properties)}"` : '';
      items.push(`    <item id="${escapeAttr(id)}" href="${escapeAttr(href)}" media-type="${escapeAttr(mediaType)}"${props}/>`);
      return id;
    },
    render() {
      return items.join('\n');
    },
  };
}

/** A fresh RFC-4122 v4 UUID, bare: 'urn:uuid:' is added where an identifier is written. */
function newUuid() {
  return crypto.randomUUID();
}

/**
 * Build the OPF package document.
 *
 * opts: { version: '2.0' | '3.0' (default '2.0'), title, creator, translator,
 *         language, uuid, chapters, images, cssHref, coverImage,
 *         resources: [{ href, mediaType }], pageDirection, modified }
 *
 * title, language, uuid and chapters are required — an EPUB without them is
 * not valid and a default would only postpone the failure to the reader.
 */
function buildOpf(opts) {
  if (!opts || typeof opts !== 'object') fail('buildOpf(opts) needs an options object');

  const version = requireVersion(opts.version);
  const title = requireText(opts.title, 'title');
  const language = requireText(opts.language, 'language');
  const uuid = requireUuid(opts.uuid);
  const chapters = requireChapters(opts.chapters);
  const creator = optionalText(opts.creator, 'creator');
  const translator = optionalText(opts.translator, 'translator');
  const cssHref = opts.cssHref ? requireHref(opts.cssHref, 'cssHref') : '';
  const coverImage = opts.coverImage ? requireHref(opts.coverImage, 'coverImage') : '';
  const pageDirection = optionalText(opts.pageDirection, 'pageDirection');
  if (pageDirection && !PAGE_DIRECTIONS.includes(pageDirection)) {
    fail(`pageDirection must be one of ${PAGE_DIRECTIONS.join(' / ')} (got ${JSON.stringify(pageDirection)})`);
  }
  // page-progression-direction is an EPUB 3 spine attribute; epubcheck rejects
  // it on an EPUB 2 package (RSC-005). Dropping it silently would ship a book
  // that reads in the wrong direction, so the caller is told to pick a version
  // that can express what it asked for.
  if (pageDirection && version !== '3.0') {
    fail(`pageDirection requires version '3.0' — an EPUB ${version} spine cannot carry page-progression-direction`);
  }

  const manifest = createManifest();
  const spine = [];

  // Every id in the package document is drawn from one space, metadata first:
  // a chapter id of 'BookID' would otherwise duplicate the identifier's id and
  // break the document that points at it.
  const bookId = manifest.reserve(UNIQUE_ID);
  // EPUB 3 removed the opf:role attribute (epubcheck 5.1 rejects it as
  // RSC-005) and expresses the same MARC relator by refining the element that
  // carries the name.
  const creatorId = version === '3.0' && creator ? manifest.reserve('creator') : '';
  const translatorId = version === '3.0' && translator ? manifest.reserve('translator') : '';

  let coverImageId = '';
  if (coverImage) {
    const mediaType = mediaTypeOfImage(opts.coverImage, 'coverImage');
    // EPUB 3 marks the cover image in the manifest; EPUB 2 has only the legacy
    // <meta name="cover">, which is written below.
    coverImageId = manifest.add('cover-image', coverImage, mediaType,
      version === '3.0' ? 'cover-image' : '');
    spine.push(manifest.add('cover-xhtml', HREFS.coverPage, 'application/xhtml+xml'));
  }

  if (cssHref) manifest.add('css', cssHref, 'text/css');

  if (version === '3.0') {
    // Exactly one navigation document, in the spine so it is reachable content
    // rather than an orphan the reader can only get at through its own UI.
    spine.push(manifest.add('nav', HREFS.nav, 'application/xhtml+xml', 'nav'));
  }

  for (const ch of chapters) {
    spine.push(manifest.add(ch.id, ch.href, 'application/xhtml+xml'));
  }

  requireArray(opts.images, 'images').forEach((name, i) => {
    const what = `images[${i}]`;
    const raw = requireText(name, what);
    if (raw.includes('/')) {
      fail(`${what} must be a bare filename living under ${HREFS.imagesDir} (got ${JSON.stringify(raw)})`);
    }
    const href = requireHref(HREFS.imagesDir + raw, what);
    // The cover image is normally also on disk under images/; it is already
    // manifested above, and a resource may only be declared once.
    if (href === coverImage) return;
    const stem = raw.replace(/\.[A-Za-z0-9]+$/, '');
    const hint = /[A-Za-z0-9]/.test(stem) ? `img-${stem}` : `img-${i + 1}`;
    manifest.add(hint, href, mediaTypeOfImage(raw, what));
  });

  // Anything else a chapter points at and the caller chose to carry across —
  // an Adobe page template inherited from an EPUB 2 volume, say. The media type
  // is the caller's to state because only the caller knows what it copied;
  // binder's job is to make sure it is declared exactly once, in one place.
  requireArray(opts.resources, 'resources').forEach((resource, i) => {
    const what = `resources[${i}]`;
    if (!resource || typeof resource !== 'object') {
      fail(`${what} must be an object of the form { href, mediaType }`);
    }
    const href = requireHref(resource.href, `${what}.href`);
    const mediaType = requireText(resource.mediaType, `${what}.mediaType`);
    const stem = href.replace(/\.[A-Za-z0-9]+$/, '').replace(/^.*\//, '');
    manifest.add(/[A-Za-z0-9]/.test(stem) ? `res-${stem}` : `res-${i + 1}`, href, mediaType);
  });

  const ncxId = manifest.add('ncx', HREFS.ncx, 'application/x-dtbncx+xml');

  // 原作者為主、譯者為輔: the author is the creator, the translator a
  // contributor, and the relator is bound to the element that carries the
  // name — credits that live on separate elements can be read swapped.
  const credit = (element, name, role, id) => {
    if (!name) return '';
    if (version === '2.0') {
      return `    <${element} opf:role="${role}">${escapeXML(name)}</${element}>`;
    }
    return `    <${element} id="${escapeAttr(id)}">${escapeXML(name)}</${element}>\n`
         + `    <meta refines="#${escapeAttr(id)}" property="role" scheme="marc:relators">${role}</meta>`;
  };

  const metadata = [
    `    <dc:title>${escapeXML(title)}</dc:title>`,
    credit('dc:creator', creator, 'aut', creatorId),
    credit('dc:contributor', translator, 'trl', translatorId),
    `    <dc:language>${escapeXML(language)}</dc:language>`,
    `    <dc:identifier id="${escapeAttr(bookId)}">urn:uuid:${escapeXML(uuid)}</dc:identifier>`,
    version === '3.0' ? `    <meta property="dcterms:modified">${escapeXML(requireModified(opts.modified))}</meta>` : '',
    version === '2.0' && coverImageId ? `    <meta name="cover" content="${escapeAttr(coverImageId)}"/>` : '',
  ].filter(Boolean).join('\n');

  const dirAttr = pageDirection ? ` page-progression-direction="${escapeAttr(pageDirection)}"` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="${escapeAttr(bookId)}" version="${escapeAttr(version)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
${metadata}
  </metadata>
  <manifest>
${manifest.render()}
  </manifest>
  <spine toc="${escapeAttr(ncxId)}"${dirAttr}>
${spine.map(id => `    <itemref idref="${escapeAttr(id)}"/>`).join('\n')}
  </spine>
</package>`;
}

/**
 * Build the NCX. opts: { title, uuid, chapters }
 *
 * The uuid is the one the OPF was given, so dtb:uid and dc:identifier cannot
 * disagree — they used to be two independent randomUUID() calls.
 */
function buildNcx(opts) {
  if (!opts || typeof opts !== 'object') fail('buildNcx(opts) needs an options object');

  const title = requireText(opts.title, 'title');
  const uuid = requireUuid(opts.uuid);
  const chapters = requireChapters(opts.chapters);

  const navPoints = chapters.map((ch, i) => `    <navPoint id="navPoint-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeXML(ch.title)}</text></navLabel>
      <content src="${escapeAttr(ch.href)}"/>
    </navPoint>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${escapeAttr(uuid)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle>
    <text>${escapeXML(title)}</text>
  </docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>`;
}

/**
 * Build the EPUB 3 navigation document declared by buildOpf({version:'3.0'}).
 * opts: { title, chapters, language?, cssHref? }
 *
 * language and cssHref are optional here because xml:lang and a stylesheet are
 * optional on a content document — unlike dc:language in the package.
 */
function buildNavDocument(opts) {
  if (!opts || typeof opts !== 'object') fail('buildNavDocument(opts) needs an options object');

  const title = requireText(opts.title, 'title');
  const chapters = requireChapters(opts.chapters);
  const language = optionalText(opts.language, 'language');
  const cssHref = opts.cssHref ? requireHref(opts.cssHref, 'cssHref') : '';

  const langAttrs = language ? ` xml:lang="${escapeAttr(language)}" lang="${escapeAttr(language)}"` : '';
  const styleLink = cssHref ? `\n  <link rel="stylesheet" type="text/css" href="${escapeAttr(cssHref)}"/>` : '';
  const entries = chapters.map(ch =>
    `      <li><a href="${escapeAttr(ch.href)}">${escapeXML(ch.title)}</a></li>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"${langAttrs}>
<head>
  <meta charset="UTF-8"/>
  <title>${escapeXML(title)}</title>${styleLink}
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>${escapeXML(title)}</h1>
    <ol>
${entries}
    </ol>
  </nav>
</body>
</html>`;
}

module.exports = { newUuid, buildOpf, buildNcx, buildNavDocument, HREFS };
