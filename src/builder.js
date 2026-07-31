// sync-marker: v1
// reepub's scanned-PDF -> EPUB 3 command line: native macOS Vision OCR in, a
// validated book out.
//
// Only what a scanned PDF needs lives here — driving bin/scan-ocr, cutting its
// pages into chapters (structureChapters, ported to
// macos/Sources/ReepubCore/EpubBuilder.swift), and rendering those chapters as
// content documents. The paragraph and heading heuristics belong to
// ./epub-text; every byte of the package document, the NCX and the navigation
// document belongs to ./binder. Hand-rolling them here is what shipped a
// version="3.0" book with no navigation document at all, and an NCX whose
// dtb:uid was one Date.now() tick away from the identifier it has to match.
// The templates are gone, so neither defect has anywhere left to live.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { validateEpub } = require('./validator');
const { escapeXML, escapeAttr, processPage } = require('./epub-text');
const { newUuid, buildOpf, buildNcx, buildNavDocument, HREFS } = require('./binder');

// Vision is asked for zh-Hant + en-US and the stylesheet indents paragraphs the
// Chinese way, so every book this CLI produces is Traditional Chinese.
const LANGUAGE = 'zh-Hant';

// Hrefs relative to the OPF. containerPath() turns each into the file on disk,
// so what the manifest declares and what is written can never drift apart.
const OPF_HREF = 'content.opf';
const CSS_HREF = 'style.css';
const CHAPTERS_HREF = 'chapters';
const COVER_IMAGE_HREF = `${HREFS.imagesDir}cover.jpeg`;

// The navigation document is the reader's table of contents, so it is titled as
// one rather than after the book it already sits inside.
const NAV_TITLE = '目錄';

// Where a run of paragraphs is cut when no chapter heading has turned up: a
// whole scanned volume in one content document stalls e-readers.
const SECTION_PARAGRAPH_LIMIT = 90;

// scan-ocr names its plates page_N.jpeg. Nothing outside this set is accepted,
// because a name needing percent-encoding would be spelled one way in the
// manifest binder writes and another in the <img src> written here.
const PLATE_NAME = /^[A-Za-z0-9._-]+$/;

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/${OPF_HREF}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const STYLE_CSS = `/* Stylesheet for scanned EPUB */
body {
  font-family: serif;
  line-height: 1.6;
  margin: 0;
  padding: 10px;
}
h1, h2, h3 {
  font-family: sans-serif;
  text-align: center;
  margin-top: 1.2em;
  margin-bottom: 0.6em;
}
h2 {
  font-size: 1.4em;
  border-bottom: 1px solid #e2e8f0;
  padding-bottom: 5px;
}
p {
  margin-bottom: 1.2em;
  text-indent: 2em; /* Chinese paragraph indentation */
}
p.heading-p {
  text-indent: 0;
  text-align: center;
  font-weight: bold;
}
img.cover {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 0 auto;
}
`;

// The `oeb-page-*-margin` resets are not CSS3 — they are the OEB properties
// Kindle's converter honours, and without them a full-bleed plate is inset by
// the device's default page margins. Other readers ignore the unknown
// properties, so they cost nothing. Keep them identical to
// EpubBuilder.fullBleedBodyStyle in the native app.
const FULL_BLEED_BODY_STYLE = 'margin: 0; padding: 0; text-align: center; background-color: #ffffff; '
  + 'oeb-page-head-margin: 0 !important; oeb-page-foot-margin: 0 !important; '
  + 'oeb-page-left-margin: 0 !important; oeb-page-right-margin: 0 !important;';

/** An OPF-relative href as an absolute path inside the container at `dir`. */
function containerPath(dir, href) {
  return path.join(dir, 'OEBPS', ...href.split('/').filter(Boolean));
}

// One template for every full-bleed page — the cover and each scanned plate.
// `src` is relative to the document, `alt` is what a reader without images is
// told the page shows. No stylesheet is linked: the inline resets above are the
// whole point of these documents.
function imageDocument({ title, src, alt }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${LANGUAGE}" lang="${LANGUAGE}">
<head>
  <meta charset="UTF-8" />
  <title>${escapeXML(title)}</title>
</head>
<body style="${FULL_BLEED_BODY_STYLE}">
  <div class="cover-container" style="text-align: center; page-break-after: always; break-after: page; width: 100%; margin: 0; padding: 0;">
    <img class="cover-image" src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" style="width: 100%; height: auto; display: block; margin: 0 auto;" />
  </div>
</body>
</html>`;
}

// One reflowable chapter. `cssHref` is relative to the document.
function textDocument({ title, paragraphs, cssHref }) {
  const body = paragraphs
    .map(p => (p.isHeading ? `  <h2>${escapeXML(p.text)}</h2>` : `  <p>${escapeXML(p.text)}</p>`))
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${LANGUAGE}" lang="${LANGUAGE}">
<head>
  <meta charset="UTF-8" />
  <title>${escapeXML(title)}</title>
  <link rel="stylesheet" href="${escapeAttr(cssHref)}" type="text/css" />
</head>
<body>
  <h1>${escapeXML(title)}</h1>
  <hr />
${body}
</body>
</html>`;
}

// scan-ocr reports a plate as 'images/page_7.jpeg' relative to the OPF, and as
// null when it could not write one (it says why on stderr): that page has
// nothing to show, so it contributes no chapter. Any other shape is a defect in
// the OCR output, refused here rather than rendered as an <img> pointing at a
// file the book does not contain.
function plateName(imagePath, pageNumber) {
  if (imagePath === null || imagePath === undefined) return '';

  const name = typeof imagePath === 'string' && imagePath.startsWith(HREFS.imagesDir)
    ? imagePath.slice(HREFS.imagesDir.length)
    : '';
  if (!PLATE_NAME.test(name)) {
    throw new Error(`builder: page ${pageNumber} reports imagePath ${JSON.stringify(imagePath)}; `
      + `a plate must be "${HREFS.imagesDir}<name>" with a name matching ${PLATE_NAME}`);
  }
  return name;
}

/**
 * Cut scan-ocr's pages into chapters. Kept behaviorally identical to
 * EpubBuilder.structureChapters in the native app: the same headings start a
 * chapter and the same paragraph count ends one, or the two would turn one PDF
 * into two different books.
 *
 * Page 0 never becomes a chapter — it is the cover.
 *
 * @param {Array<{type: string, lines?: Array, imagePath?: string|null}>} pages scan-ocr JSON
 * @returns {Array<{type: 'text', title: string, paragraphs: Array}
 *                |{type: 'image', title: string, plate: string}>}
 *   `plate` is a bare filename under HREFS.imagesDir.
 */
function structureChapters(pages) {
  if (!Array.isArray(pages)) {
    throw new Error(`builder: scan-ocr must report an array of pages (got ${JSON.stringify(pages)})`);
  }

  const chapters = [];
  let current = { type: 'text', title: '前言 / 開始閱讀', paragraphs: [] };

  pages.forEach((page, idx) => {
    if (!page || typeof page !== 'object') {
      throw new Error(`builder: page ${idx + 1} of the scan-ocr output is not an object`);
    }

    if (page.type === 'image') {
      // The first page is the cover; it is shown by cover.xhtml, not twice.
      if (idx === 0) return;
      const plate = plateName(page.imagePath, idx + 1);
      if (!plate) return;

      if (current.paragraphs.length > 0) chapters.push(current);
      chapters.push({ type: 'image', title: `插圖 (頁 ${idx + 1})`, plate });
      current = {
        type: 'text',
        title: `第 ${chapters.length + 1} 部分 (頁 ${idx + 1})`,
        paragraphs: [],
      };
      return;
    }

    processPage(page).forEach(p => {
      const isChapterStart = p.isHeading && (
        p.text.includes('章') ||
        p.text.toLowerCase().includes('chapter') ||
        p.text.includes('第一') || p.text.includes('第二') || p.text.includes('第三') ||
        p.text.includes('第四') || p.text.includes('第五') || p.text.includes('第六')
      );

      if (isChapterStart && current.paragraphs.length > 0) {
        chapters.push(current);
        current = { type: 'text', title: p.text, paragraphs: [] };
      } else if (current.paragraphs.length > SECTION_PARAGRAPH_LIMIT) {
        chapters.push(current);
        current = {
          type: 'text',
          title: `第 ${chapters.length + 1} 部分 (頁 ${idx + 1})`,
          paragraphs: [],
        };
      }
      current.paragraphs.push(p);
    });
  });

  if (current.paragraphs.length > 0) chapters.push(current);
  return chapters;
}

/**
 * Create a fresh EPUB container tree at `dir`. Anything already there is
 * removed: a leftover from an earlier run would be zipped into the book and
 * rejected as a file no manifest declares.
 *
 * @param {string} dir absolute path of the container root
 * @returns {string} absolute path scan-ocr must write the cover image to — the
 *   only file in the tree another process produces.
 */
function prepareContainer(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'META-INF'), { recursive: true });
  fs.mkdirSync(containerPath(dir, CHAPTERS_HREF), { recursive: true });
  fs.mkdirSync(containerPath(dir, HREFS.imagesDir), { recursive: true });

  fs.writeFileSync(path.join(dir, 'mimetype'), 'application/epub+zip', 'utf8');
  fs.writeFileSync(path.join(dir, 'META-INF', 'container.xml'), CONTAINER_XML, 'utf8');

  return containerPath(dir, COVER_IMAGE_HREF);
}

/**
 * Write every document of the book into a container prepared by
 * prepareContainer: the stylesheet, one content document per chapter, and the
 * package / NCX / navigation trio binder assembles from a single identifier.
 *
 * The cover is whatever scan-ocr managed to write to the path prepareContainer
 * returned; when it is absent the book has no cover page at all. A cover.xhtml
 * written unconditionally is a file no manifest declares — the native app
 * writes it only when it has a cover, and so does this.
 *
 * @param {string} dir container root
 * @param {{title: string, creator?: string, pages: Array}} book
 * @returns {{chapters: number, hasCover: boolean}}
 */
function writeBook(dir, book) {
  const structured = structureChapters(book.pages);
  if (structured.length === 0) {
    throw new Error('builder: the OCR found no page to publish — no text to reflow and no plate to show');
  }

  fs.writeFileSync(containerPath(dir, CSS_HREF), STYLE_CSS, 'utf8');

  const chapters = structured.map((chapter, idx) => {
    const id = `ch${String(idx + 1).padStart(2, '0')}`;
    const href = `${CHAPTERS_HREF}/${id}.xhtml`;
    const xhtml = chapter.type === 'image'
      ? imageDocument({ title: chapter.title, src: `../${HREFS.imagesDir}${chapter.plate}`, alt: chapter.title })
      : textDocument({ title: chapter.title, paragraphs: chapter.paragraphs, cssHref: `../${CSS_HREF}` });

    fs.writeFileSync(containerPath(dir, href), xhtml, 'utf8');
    return { id, href, title: chapter.title };
  });

  const hasCover = fs.existsSync(containerPath(dir, COVER_IMAGE_HREF));
  if (hasCover) {
    fs.writeFileSync(containerPath(dir, HREFS.coverPage), imageDocument({
      title: 'Cover',
      src: COVER_IMAGE_HREF,
      alt: book.title,
    }), 'utf8');
  }

  // One identifier for the whole book: the package and the NCX each used to
  // mint their own, so a millisecond between two template strings was enough to
  // make them disagree.
  const uuid = newUuid();

  fs.writeFileSync(containerPath(dir, OPF_HREF), buildOpf({
    version: '3.0',
    title: book.title,
    creator: book.creator,
    language: LANGUAGE,
    uuid,
    chapters,
    images: structured.filter(chapter => chapter.type === 'image').map(chapter => chapter.plate),
    cssHref: CSS_HREF,
    coverImage: hasCover ? COVER_IMAGE_HREF : '',
  }), 'utf8');

  fs.writeFileSync(containerPath(dir, HREFS.ncx),
    buildNcx({ title: book.title, uuid, chapters }), 'utf8');

  fs.writeFileSync(containerPath(dir, HREFS.nav), buildNavDocument({
    title: NAV_TITLE,
    chapters,
    language: LANGUAGE,
    cssHref: CSS_HREF,
  }), 'utf8');

  return { chapters: chapters.length, hasCover };
}

/**
 * Zip a container directory into `epubPath`, replacing whatever is there.
 * 'mimetype' goes in first and uncompressed — the one ordering rule the EPUB
 * container format has, and the reason this is not a plain `zip -r`.
 *
 * @param {string} dir container root
 * @param {string} epubPath absolute path (zip runs with `dir` as its cwd)
 */
function packageEpub(dir, epubPath) {
  fs.rmSync(epubPath, { force: true });
  execFileSync('zip', ['-0Xq', epubPath, 'mimetype'], { cwd: dir });
  execFileSync('zip', ['-ur9q', epubPath, 'META-INF', 'OEBPS'], { cwd: dir });
}

// Support CLI execution
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node src/builder.js <input.pdf> <output.epub> [book-title] [book-author]');
    process.exit(1);
  }

  const pdfPath = path.resolve(args[0]);
  const epubPath = path.resolve(args[1]);
  const bookTitle = args[2] || path.basename(pdfPath, path.extname(pdfPath));
  const bookAuthor = (args[3] || '').trim(); // optional: author / source, blank is fine

  const PROJECT_DIR = path.resolve(__dirname, '..');
  const TEMP_DIR = path.join(PROJECT_DIR, 'temp-epub-ocr');

  console.log(`Target PDF: ${pdfPath}`);
  console.log(`Output EPUB: ${epubPath}`);
  console.log(`Book Title: ${bookTitle}`);
  console.log(`Author / Source: ${bookAuthor || '(none)'}`);

  const coverFile = prepareContainer(TEMP_DIR);

  console.log('\n--- Step 1: Performing Native macOS OCR (Vision API) ---');
  const binOcr = path.join(PROJECT_DIR, 'bin', 'scan-ocr');
  if (!fs.existsSync(binOcr)) {
    console.error(`Error: Native binary scan-ocr not found at ${binOcr}. Please run 'make build' first.`);
    process.exit(1);
  }

  let ocrPages = [];
  try {
    // Pass input PDF and cover image path
    const stdout = execFileSync(binOcr, [pdfPath, coverFile], {
      maxBuffer: 1024 * 1024 * 50 // 50MB buffer to prevent overflow
    });
    ocrPages = JSON.parse(stdout.toString());
  } catch (error) {
    console.error('OCR Extraction failed:', error);
    process.exit(1);
  }

  console.log('\n--- Step 2: Processing OCR Layout and Reconstructing Text ---');
  let written;
  try {
    written = writeBook(TEMP_DIR, { title: bookTitle, creator: bookAuthor, pages: ocrPages });
  } catch (error) {
    console.error(`\n[Failure] Could not assemble the book:\n${error.message}`);
    process.exit(1);
  }
  console.log(`Reconstructed ${written.chapters} chapters/sections from ${ocrPages.length} PDF pages.`);
  console.log(`Cover: ${written.hasCover ? 'yes' : 'none (the PDF gave no cover image)'}`);

  console.log('\n--- Step 3: Packaging to EPUB Archive ---');
  try {
    packageEpub(TEMP_DIR, epubPath);
    console.log(`\nEPUB successfully generated: ${epubPath}`);
  } catch (error) {
    console.error('Packaging failed:', error);
    process.exit(1);
  }

  console.log('\n--- Step 4: Automating XML and Manifest Verification (EPUBCheck) ---');
  const validationResult = validateEpub(epubPath);

  // Clean up temp dir
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });

  if (!validationResult.success) {
    console.error(`\n[Failure] EPUB validation failed:\n${validationResult.error}`);
    fs.rmSync(epubPath, { force: true });
    process.exit(1);
  }

  console.log('\n[Success] EPUB validation passed! The generated EPUB has no XML or manifest errors.');
}

module.exports = { structureChapters, prepareContainer, writeBook, packageEpub };
