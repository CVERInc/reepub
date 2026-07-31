// sync-marker: v1
// Merge multiple EPUB files from the same series into a single EPUB.
//
// Usage:
//   node src/merge.js <output.epub> <input1.epub> <input2.epub> [...]
//
// Merges volumes in the order given. Each volume's chapters (XHTML files listed
// in the OPF spine) are renumbered sequentially into the combined book.
// Shared resources (CSS, page templates) are taken from the first volume.
//
// Limitations:
//   - Assumes all volumes share the same CSS/page-template structure.
//   - Does not merge embedded fonts or images (text-only EPUBs).
//   - EPUB2 only (content.opf + toc.ncx). EPUB3 nav.xhtml not generated.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { validateEpub } = require('./validator');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Run unzip -p to extract a single file from an epub. */
function extractFile(epubPath, innerPath) {
  return execFileSync('unzip', ['-p', epubPath, innerPath]);
}

/** List all entries in an epub zip. */
function listEntries(epubPath) {
  const out = execFileSync('unzip', ['-l', epubPath], { encoding: 'utf8' });
  const entries = [];
  for (const line of out.split('\n')) {
    const m = line.match(/\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s+(.+)$/);
    if (m) entries.push(m[1].trim());
  }
  return entries;
}

/** Parse OPF XML naively (stdlib only — no xml2js dependency). */
function parseSpineHrefs(opfXml) {
  // manifest: id → href
  const manifest = new Map();
  const itemRe = /<item\s[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*/g;
  let m;
  while ((m = itemRe.exec(opfXml)) !== null) manifest.set(m[1], m[2]);

  // spine order
  const spineRe = /<itemref\s[^>]*idref="([^"]+)"/g;
  const hrefs = [];
  while ((m = spineRe.exec(opfXml)) !== null) {
    const href = manifest.get(m[1]);
    if (href) hrefs.push(href);
  }
  return hrefs;
}

/** Parse toc.ncx for labels: src → text. */
function parseTocLabels(ncxXml) {
  const labels = new Map();
  const re = /<text>(.*?)<\/text>.*?<content\s+src="([^"]+)"/gs;
  let m;
  while ((m = re.exec(ncxXml)) !== null) labels.set(m[2], m[1]);
  return labels;
}

/** Extract dc:title from OPF. */
function parseTitle(opfXml) {
  const m = opfXml.match(/<dc:title>(.*?)<\/dc:title>/);
  return m ? m[1] : '';
}

/** Extract page-progression-direction from OPF spine (e.g. "rtl"). */
function parsePageDirection(opfXml) {
  const m = opfXml.match(/page-progression-direction="([^"]+)"/);
  return m ? m[1] : '';
}

/** Resolve OPF rootfile path from container.xml. */
function resolveOpfPath(epubPath) {
  const container = extractFile(epubPath, 'META-INF/container.xml').toString('utf8');
  const m = container.match(/full-path="([^"]+)"/);
  return m ? m[1] : 'OEBPS/content.opf';
}

// ---------------------------------------------------------------------------
// volume extraction
// ---------------------------------------------------------------------------

/**
 * Extract chapter data from one EPUB volume.
 * Returns { chapters: [{href, content, label}], css, xpgt, opfDir, pageDirection }
 */
function extractVolume(epubPath) {
  const opfPath = resolveOpfPath(epubPath);
  const opfDir = path.dirname(opfPath);
  const opfXml = extractFile(epubPath, opfPath).toString('utf8');
  const title = parseTitle(opfXml);
  const pageDirection = parsePageDirection(opfXml);

  // spine hrefs (relative to opfDir)
  const spineHrefs = parseSpineHrefs(opfXml);

  // toc labels
  let tocLabels = new Map();
  const entries = listEntries(epubPath);
  const ncxEntry = entries.find(e => e.endsWith('.ncx'));
  if (ncxEntry) {
    const ncxXml = extractFile(epubPath, ncxEntry).toString('utf8');
    tocLabels = parseTocLabels(ncxXml);
  }

  // identify first spine entry as volume TOC (skip it)
  const chapterHrefs = spineHrefs.slice(1);

  const chapters = [];
  for (const href of chapterHrefs) {
    const fullPath = opfDir ? `${opfDir}/${href}` : href;
    const content = extractFile(epubPath, fullPath);
    const label = tocLabels.get(href) || href;
    chapters.push({ href, content, label });
  }

  // shared resources
  let css = null;
  let xpgt = null;
  const cssEntry = entries.find(e => e.endsWith('.css'));
  if (cssEntry) css = extractFile(epubPath, cssEntry);
  const xpgtEntry = entries.find(e => e.endsWith('.xpgt'));
  if (xpgtEntry) xpgt = extractFile(epubPath, xpgtEntry);

  return { title, chapters, css, xpgt, opfDir, pageDirection };
}

// ---------------------------------------------------------------------------
// EPUB assembly
// ---------------------------------------------------------------------------

function buildTocXhtml(title, chapters) {
  const entries = chapters.map(c => c.label).join('<br />');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">',
    '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-TW">',
    '<head>',
    `<title>${title}</title>`,
    '<link href="stylesheet.css" type="text/css" rel="stylesheet" />',
    '</head>',
    '<body>',
    `<div>${entries}</div>`,
    '</body></html>',
  ].join('\r\n');
}

function buildContentOpf(title, author, chapters, hasCss, hasXpgt, pageDirection) {
  const uid = require('crypto').randomUUID();
  const items = ['    <item id="P0" href="0.xhtml" media-type="application/xhtml+xml"/>'];
  const spine = ['    <itemref idref="P0"/>'];

  for (let i = 0; i < chapters.length; i++) {
    const id = `P${i + 1}`;
    items.push(`    <item id="${id}" href="${i + 1}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`    <itemref idref="${id}"/>`);
  }
  items.push('    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
  if (hasCss) items.push('    <item id="css" href="stylesheet.css" media-type="text/css"/>');
  if (hasXpgt) items.push('    <item id="xpgt" href="page-template.xpgt" media-type="application/vnd.adobe-page-template+xml"/>');

  const dirAttr = pageDirection ? ` page-progression-direction="${pageDirection}"` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${title}</dc:title>
${author ? `    <dc:creator opf:role="aut">${author}</dc:creator>\n` : ''}\
    <dc:language>zh-TW</dc:language>
    <dc:identifier id="BookID">urn:uuid:${uid}</dc:identifier>
  </metadata>
  <manifest>
${items.join('\n')}
  </manifest>
  <spine${dirAttr} toc="ncx">
${spine.join('\n')}
  </spine>
</package>`;
}

function buildTocNcx(title, chapters) {
  const uid = require('crypto').randomUUID();
  const navPoints = [`    <navPoint id="nav0" playOrder="1">
      <navLabel><text>${title}</text></navLabel>
      <content src="0.xhtml"/>
    </navPoint>`];

  for (let i = 0; i < chapters.length; i++) {
    navPoints.push(`    <navPoint id="nav${i + 1}" playOrder="${i + 2}">
      <navLabel><text>${chapters[i].label}</text></navLabel>
      <content src="${i + 1}.xhtml"/>
    </navPoint>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${uid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${title}</text></docTitle>
  <navMap>
${navPoints.join('\n')}
  </navMap>
</ncx>`;
}

// ---------------------------------------------------------------------------
// zip helper (uses system zip, same as builder.js)
// ---------------------------------------------------------------------------

function writeEpub(outputPath, title, author, allChapters, css, xpgt, pageDirection) {
  const tmp = path.join(path.dirname(outputPath), `.reepub-merge-${Date.now()}`);
  const oebps = path.join(tmp, 'OEBPS');
  const meta = path.join(tmp, 'META-INF');
  fs.mkdirSync(oebps, { recursive: true });
  fs.mkdirSync(meta, { recursive: true });

  // mimetype (must be first, uncompressed — we'll zip with -0 for this)
  fs.writeFileSync(path.join(tmp, 'mimetype'), 'application/epub+zip');

  // container.xml
  fs.writeFileSync(path.join(meta, 'container.xml'), `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  // OEBPS files
  fs.writeFileSync(path.join(oebps, 'content.opf'), buildContentOpf(title, author, allChapters, !!css, !!xpgt, pageDirection));
  fs.writeFileSync(path.join(oebps, 'toc.ncx'), buildTocNcx(title, allChapters));
  fs.writeFileSync(path.join(oebps, '0.xhtml'), buildTocXhtml(title, allChapters));
  if (css) fs.writeFileSync(path.join(oebps, 'stylesheet.css'), css);
  if (xpgt) fs.writeFileSync(path.join(oebps, 'page-template.xpgt'), xpgt);

  for (let i = 0; i < allChapters.length; i++) {
    fs.writeFileSync(path.join(oebps, `${i + 1}.xhtml`), allChapters[i].content);
  }

  // zip: mimetype first, uncompressed; then everything else, compressed
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  const absOut = path.resolve(outputPath);
  execFileSync('zip', ['-0', '-X', absOut, 'mimetype'], { cwd: tmp });
  execFileSync('zip', ['-r', '-X', absOut, 'META-INF', 'OEBPS'], { cwd: tmp });

  // cleanup temp dir
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  if (args.length < 3 || args.includes('--help') || args.includes('-h')) {
    console.log(`reepub merge — combine multiple EPUBs from the same series into one.

Usage:
  node src/merge.js [options] <output.epub> <input1.epub> <input2.epub> [...]

Options:
  --title <title>     Book title (default: extracted from first volume)
  --author <author>   Book author (default: empty)
  --no-validate       Skip EPUB validation after merge
  -h, --help          Show this help

Volumes are merged in the order given. Each volume's first spine entry
(typically a per-volume table of contents) is skipped; all remaining
chapters are renumbered sequentially.

Limitations:
  - All volumes should share the same CSS/layout structure.
  - Text-only (no embedded images/fonts merge).
  - EPUB2 output (content.opf + toc.ncx).`);
    process.exit(0);
  }

  // parse options
  let title = '';
  let author = '';
  let skipValidate = false;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--title' && i + 1 < args.length) { title = args[++i]; continue; }
    if (args[i] === '--author' && i + 1 < args.length) { author = args[++i]; continue; }
    if (args[i] === '--no-validate') { skipValidate = true; continue; }
    positional.push(args[i]);
  }

  if (positional.length < 3) {
    console.error('Error: need at least an output path and two input EPUBs.');
    process.exit(1);
  }

  const outputPath = path.resolve(positional[0]);
  const inputPaths = positional.slice(1).map(p => path.resolve(p));

  // verify inputs exist
  for (const p of inputPaths) {
    if (!fs.existsSync(p)) {
      console.error(`Error: file not found: ${p}`);
      process.exit(1);
    }
  }

  console.log(`Merging ${inputPaths.length} volumes → ${path.basename(outputPath)}`);

  const allChapters = [];
  let css = null;
  let xpgt = null;
  let pageDirection = '';

  for (let v = 0; v < inputPaths.length; v++) {
    const vol = extractVolume(inputPaths[v]);
    if (v === 0) {
      if (!title) title = vol.title.replace(/[一二三四五六七八九十\d]+$/, '').trim() || vol.title;
      css = vol.css;
      xpgt = vol.xpgt;
      pageDirection = vol.pageDirection;
    }
    for (const ch of vol.chapters) allChapters.push(ch);
    console.log(`  vol ${v + 1}: ${vol.title} (${vol.chapters.length} chapters)`);
  }

  console.log(`  total: ${allChapters.length} chapters`);

  writeEpub(outputPath, title, author, allChapters, css, xpgt, pageDirection);

  const sizeKb = (fs.statSync(outputPath).size / 1024).toFixed(0);
  console.log(`  ✓ ${path.basename(outputPath)} (${sizeKb} KB)`);

  // validate
  if (!skipValidate) {
    console.log('  validating…');
    const result = validateEpub(outputPath);
    if (result.success) {
      console.log('  ✓ EPUB valid');
    } else {
      console.error('  ✗ validation errors:');
      const issues = result.issues || result.errors || [];
      for (const err of issues) console.error(`    - ${err}`);
      process.exit(1);
    }
  }
}

main();
