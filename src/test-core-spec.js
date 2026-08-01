// Spec tests for reepub's CORE paths: the validator, the merge CLI, EPUB
// package assembly, the image optimizer, cover generation and the Node/Swift
// behavioral contract.
//
// Written TDD-style from an adversarial audit (2026-07-31). Every assertion
// below encodes a defect that was confirmed by execution against the current
// tree, so the suite is expected to be RED until the fixes land.
//
// Target contracts:
//
//   src/validator.js
//     - accepts a well-formed OPF whose <manifest> carries attributes
//     - ignores XML comments when parsing the manifest
//     - REJECTS hrefs / container full-paths that escape the container (../)
//     - never throws: always returns {success, error?}, even when the EPUB's
//       parent directory is not writable
//     - uses a collision-proof temp directory (concurrent validations of two
//       EPUBs in one directory must not see each other's files)
//
//   src/merge.js
//     - XML-escapes title / author / labels everywhere it emits XML
//     - rewrites intra-chapter references when it flattens chapters into
//       OEBPS/, and carries the referenced resources across, so no reference
//       in the merged book dangles
//     - URL-decodes OPF hrefs and does not treat them as shell globs
//
//   src/binder.js  (the single EPUB-assembly module; see test-web-spec.js)
//     - buildOpf({version:'3.0'}) manifests exactly one properties="nav" item
//     - buildNavDocument() renders that navigation document
//     - the NCX dtb:uid always equals the OPF dc:identifier
//     - package documents are assembled HERE ONLY — builder.js / merge.js /
//       web-to-epub.js must not hand-roll their own <package> templates
//
//   scripts/optimize.js
//     - discovers the content root from META-INF/container.xml instead of
//       assuming OEBPS/, and never drops content it cannot find
//     - exits non-zero when the result fails validation
//
//   src/cover-generator.js
//     - closes the Playwright browser on the failure path (no leaked child,
//       no hung process)
//
//   src/epub-text.js  <-> macos/Sources/ReepubCore/EpubBuilder.swift
//     - the paragraph-break punctuation sets agree
//     - the heading length metric counts the same units on both sides

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { validateEpub } = require('./validator');

const REPO = path.resolve(__dirname, '..');

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    console.error(`  [FAIL] ${message}`);
    failures++;
  } else {
    console.log(`  [PASS] ${message}`);
  }
}
function section(name) {
  console.log(`\n=== ${name} ===`);
}

// --------------------------------------------------------------- fixtures

const NCX = (uid, entries) => `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${uid}"/></head>
  <docTitle><text>Volume</text></docTitle>
  <navMap>
${entries.map((e, i) => `    <navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${e.label}</text></navLabel><content src="${e.href}"/></navPoint>`).join('\n')}
  </navMap>
</ncx>`;

const XHTML = (title, body) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title>
<link rel="stylesheet" type="text/css" href="../style.css"/></head>
<body>${body}</body></html>`;

// Builds a volume EPUB shaped exactly like builder.js output: chapters under
// OEBPS/chapters/, CSS at OEBPS/style.css, images under OEBPS/images/.
// `chapterNames` lets a caller exercise hostile filenames.
function makeVolumeEpub(dir, epubPath, opts = {}) {
  const chapterNames = opts.chapterNames || ['ch01.xhtml', 'ch02.xhtml'];
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'META-INF'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'OEBPS', 'chapters'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'OEBPS', 'images'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'mimetype'), 'application/epub+zip');
  fs.writeFileSync(path.join(dir, 'META-INF', 'container.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);

  fs.writeFileSync(path.join(dir, 'OEBPS', 'style.css'), 'body { line-height: 1.7; }');
  // 1x1 PNG
  fs.writeFileSync(path.join(dir, 'OEBPS', 'images', 'pic.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'));

  // First spine entry is the per-volume TOC, which merge.js drops by design.
  fs.writeFileSync(path.join(dir, 'OEBPS', 'chapters', 'toc.xhtml'),
    XHTML('Volume TOC', '<p>volume toc</p>'));
  chapterNames.forEach((name, i) => {
    fs.writeFileSync(path.join(dir, 'OEBPS', 'chapters', name),
      XHTML(`Chapter ${i + 1}`, `<p>body ${i + 1}</p><p><img src="../images/pic.png" alt="pic"/></p>`));
  });

  const items = [
    '<item id="css" href="style.css" media-type="text/css"/>',
    '<item id="img" href="images/pic.png" media-type="image/png"/>',
    '<item id="vtoc" href="chapters/toc.xhtml" media-type="application/xhtml+xml"/>',
    ...chapterNames.map((n, i) => `<item id="c${i}" href="chapters/${encodeURIComponent(n)}" media-type="application/xhtml+xml"/>`),
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
  ];
  const spine = ['<itemref idref="vtoc"/>', ...chapterNames.map((_, i) => `<itemref idref="c${i}"/>`)];

  fs.writeFileSync(path.join(dir, 'OEBPS', 'content.opf'),
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Volume One</dc:title>
    <dc:language>zh-TW</dc:language>
    <dc:identifier id="BookID">urn:uuid:123e4567-e89b-42d3-a456-426614174000</dc:identifier>
  </metadata>
  <manifest>
${items.map(i => '    ' + i).join('\n')}
  </manifest>
  <spine toc="ncx">
${spine.map(s => '    ' + s).join('\n')}
  </spine>
</package>`);

  fs.writeFileSync(path.join(dir, 'OEBPS', 'toc.ncx'), NCX('urn:uuid:123e4567-e89b-42d3-a456-426614174000',
    [{ href: 'chapters/toc.xhtml', label: 'TOC' },
     ...chapterNames.map((n, i) => ({ href: `chapters/${encodeURIComponent(n)}`, label: `Chapter ${i + 1}` }))]));

  fs.rmSync(epubPath, { force: true });
  execFileSync('zip', ['-0Xq', epubPath, 'mimetype'], { cwd: dir });
  execFileSync('zip', ['-ur9q', epubPath, 'META-INF', 'OEBPS'], { cwd: dir });
  return epubPath;
}

function unzipTo(epubPath, dest) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('unzip', ['-qo', epubPath, '-d', dest]);
  return dest;
}

function isWellFormed(xml) {
  const tmp = path.join(os.tmpdir(), `reepub-core-xml-${process.pid}-${Math.random().toString(36).slice(2)}.xml`);
  fs.writeFileSync(tmp, xml, 'utf8');
  try {
    execFileSync('xmllint', ['--noout', tmp], { stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    fs.statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

// Collect every relative, non-fragment, non-external reference in an XHTML
// document and report the ones that do not resolve inside the container.
function danglingRefs(root) {
  const bad = [];
  for (const file of walk(root).filter(f => /\.(xhtml|html)$/i.test(f))) {
    const content = fs.readFileSync(file, 'utf8');
    for (const m of content.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const ref = m[1];
      if (/^(https?:|data:|mailto:|#)/i.test(ref)) continue;
      const clean = decodeURIComponent(ref.split('#')[0]);
      if (!clean) continue;
      const resolved = path.resolve(path.dirname(file), clean);
      if (!fs.existsSync(resolved)) {
        bad.push(`${path.relative(root, file)} -> ${ref}`);
      }
    }
  }
  return bad;
}

function makeMinimalEpubDir(dir, { manifestTag = '<manifest>', extraManifest = '', contentRoot = 'OEBPS' } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'META-INF'), { recursive: true });
  fs.mkdirSync(path.join(dir, contentRoot), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mimetype'), 'application/epub+zip');
  fs.writeFileSync(path.join(dir, 'META-INF', 'container.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="${contentRoot}/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  fs.writeFileSync(path.join(dir, contentRoot, 'index.xhtml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><p>hi</p></body></html>`);
  fs.writeFileSync(path.join(dir, contentRoot, 'toc.ncx'),
    NCX('urn:uuid:123e4567-e89b-42d3-a456-426614174000', [{ href: 'index.xhtml', label: 'C1' }]));
  fs.writeFileSync(path.join(dir, contentRoot, 'content.opf'),
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Minimal</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="BookID">urn:uuid:123e4567-e89b-42d3-a456-426614174000</dc:identifier>
  </metadata>
  ${manifestTag}
    <item id="index" href="index.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
${extraManifest}
  </manifest>
  <spine toc="ncx"><itemref idref="index"/></spine>
</package>`);
  return dir;
}

function zipDir(dir, epubPath) {
  fs.rmSync(epubPath, { force: true });
  execFileSync('zip', ['-0Xq', epubPath, 'mimetype'], { cwd: dir });
  const rest = fs.readdirSync(dir).filter(f => f !== 'mimetype');
  execFileSync('zip', ['-ur9q', epubPath, ...rest], { cwd: dir });
  return epubPath;
}

async function main() {
  console.log('Starting core spec tests...');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'reepub-core-spec-'));

  try {
    // ------------------------------------------------- validator: false rejects
    section('Validator: must not reject valid books');

    const attrManifest = makeMinimalEpubDir(path.join(work, 'attr-manifest'),
      { manifestTag: '<manifest id="manifest">' });
    assert(validateEpub(attrManifest).success === true,
      'an OPF whose <manifest> carries attributes is accepted (attributes are legal per OPF)');

    const commented = makeMinimalEpubDir(path.join(work, 'commented'),
      { extraManifest: '    <!-- <item id="old" href="deleted-chapter.xhtml" media-type="application/xhtml+xml"/> -->' });
    assert(validateEpub(commented).success === true,
      'a commented-out <item> in the manifest is ignored, not parsed as a live item');

    // ------------------------------------------------- validator: containment
    section('Validator: container escape');

    const traversal = makeMinimalEpubDir(path.join(work, 'traversal'));
    // A host file that exists outside the book. A manifest href pointing at it
    // must never satisfy the existence check.
    const hostFile = path.join(work, 'outside-secret.txt');
    fs.writeFileSync(hostFile, 'not part of any book');
    let opf = fs.readFileSync(path.join(traversal, 'OEBPS', 'content.opf'), 'utf8');
    opf = opf.replace('</manifest>',
      '  <item id="leak" href="../../outside-secret.txt" media-type="text/plain"/>\n  </manifest>');
    fs.writeFileSync(path.join(traversal, 'OEBPS', 'content.opf'), opf);
    assert(validateEpub(traversal).success === false,
      'a manifest href escaping the container with ../ is REJECTED (must not be satisfied by a host file)');

    // ------------------------------------------------- validator: API contract
    section('Validator: error contract and temp-dir isolation');

    const roParent = path.join(work, 'readonly-parent');
    fs.mkdirSync(roParent, { recursive: true });
    const roEpubSrc = makeMinimalEpubDir(path.join(work, 'ro-src'));
    const roEpub = path.join(roParent, 'book.epub');
    zipDir(roEpubSrc, roEpub);
    fs.chmodSync(roParent, 0o555);
    // A read-only parent is the deterministic proof of both properties at once:
    // scratch space must live in the system temp dir (not beside the EPUB), and
    // validateEpub must honour its {success, error} contract rather than
    // throwing an EACCES straight through its callers.
    let contractHeld = true;
    let roResult = null;
    try {
      roResult = validateEpub(roEpub);
    } catch (_) {
      contractHeld = false;
    } finally {
      fs.chmodSync(roParent, 0o755);
    }
    assert(contractHeld,
      'validateEpub never throws — it returns {success, error} even when the EPUB sits in a read-only directory');
    assert(contractHeld && roResult && roResult.success === true,
      `a valid EPUB in a read-only directory validates successfully (scratch space belongs in os.tmpdir) — ${roResult ? roResult.error || 'ok' : 'threw'}`);
    const strays = fs.readdirSync(roParent).filter(f => f.startsWith('temp-epub-val-'));
    assert(strays.length === 0,
      `no scratch directory is left behind next to the EPUB (found ${JSON.stringify(strays)})`);

    // Scratch directory names must be collision-proof: a millisecond-resolution
    // name lets two validations started in the same tick share one directory
    // and delete it out from under each other.
    const validatorSrc = fs.readFileSync(path.join(__dirname, 'validator.js'), 'utf8');
    const tempNaming = validatorSrc.match(/temp-epub-val-[^`'"]*/);
    assert(!tempNaming || !/^temp-epub-val-\$\{Date\.now\(\)\}$/.test(tempNaming[0]),
      'the scratch directory name is not Date.now() alone (two validations in one millisecond would collide)');

    // ----------------------------------------------------------- merge.js
    section('Merge: XML escaping');

    const volDir = path.join(work, 'vol1');
    const vol1 = makeVolumeEpub(volDir, path.join(work, 'vol1.epub'));
    const vol2 = makeVolumeEpub(path.join(work, 'vol2'), path.join(work, 'vol2.epub'));

    const hostileOut = path.join(work, 'hostile.epub');
    const hostile = spawnSync(process.execPath,
      [path.join(__dirname, 'merge.js'),
       '--title', 'AT&T 傳 <卷一>', '--author', 'Simon & Schuster',
       hostileOut, vol1, vol2],
      { encoding: 'utf8' });
    assert(hostile.status === 0,
      `merging with an ampersand in the title succeeds (exit ${hostile.status})`);
    if (fs.existsSync(hostileOut)) {
      const hx = unzipTo(hostileOut, path.join(work, 'hostile-x'));
      const xmlFiles = walk(hx).filter(f => /\.(opf|ncx|xhtml)$/i.test(f));
      const malformed = xmlFiles.filter(f => {
        try { execFileSync('xmllint', ['--noout', f], { stdio: 'pipe' }); return false; }
        catch (_) { return true; }
      });
      assert(malformed.length === 0,
        `every XML document in the merged book is well-formed (malformed: ${JSON.stringify(malformed.map(f => path.basename(f)))})`);
      const opfOut = walk(hx).find(f => f.endsWith('.opf'));
      const opfTxt = opfOut ? fs.readFileSync(opfOut, 'utf8') : '';
      assert(opfTxt.includes('AT&amp;T') && !/AT&T(?!;)/.test(opfTxt),
        'the ampersand in the title is escaped in the OPF');
    }

    section('Merge: no dangling references after flattening');

    const flatOut = path.join(work, 'flat.epub');
    const flat = spawnSync(process.execPath,
      [path.join(__dirname, 'merge.js'), '--title', 'Flat', flatOut, vol1, vol2],
      { encoding: 'utf8' });
    assert(flat.status === 0, `a plain merge succeeds (exit ${flat.status})`);
    if (fs.existsSync(flatOut)) {
      const fx = unzipTo(flatOut, path.join(work, 'flat-x'));
      const dangling = danglingRefs(fx);
      assert(dangling.length === 0,
        `no chapter reference dangles after chapters are flattened into OEBPS/ (dangling: ${JSON.stringify(dangling.slice(0, 4))})`);
    }

    section('Merge: URL-encoded and glob-metacharacter hrefs');

    const oddVol = makeVolumeEpub(path.join(work, 'vol-odd'), path.join(work, 'vol-odd.epub'),
      { chapterNames: ['第1話 [修].xhtml', '第2話.xhtml'] });
    const oddOut = path.join(work, 'odd.epub');
    const odd = spawnSync(process.execPath,
      [path.join(__dirname, 'merge.js'), '--title', 'Odd', oddOut, oddVol],
      { encoding: 'utf8' });
    assert(odd.status === 0,
      `a volume whose chapter filename contains a space and [brackets] merges (exit ${odd.status}; stderr: ${(odd.stderr || '').trim().split('\n')[0] || 'none'})`);

    // ------------------------------------------------- merge: healing rot
    // Ebooks in the wild arrive broken. Every volume of the maintainer's real
    // Jinyong library scores 4 epubcheck errors on its own; merging them must
    // produce a book that is healthier than its parts, not one that inherits
    // the rot faithfully.
    section('Merge: heals what it inherits');

    const { healStylesheet, modernizeContentDocument } = require('./merge');

    const androidFont = `@font-face {
   font-family: "DroidFont", serif, sans-serif;
   src: url(res:///system/fonts/DroidSansFallback.ttf);
   }

body { -epub-writing-mode: vertical-rl; }`;
    const androidHealed = healStylesheet(androidFont);
    assert(!/@font-face/.test(androidHealed.css),
      'an @font-face whose only source is an Android system font is dropped (RSC-006 / OPF-014)');
    assert(/-epub-writing-mode:\s*vertical-rl/.test(androidHealed.css),
      'healing removes only the dead rule — vertical writing mode survives untouched');
    assert(androidHealed.healed.length === 1 && /DroidSansFallback/.test(androidHealed.healed[0]),
      `the heal is reported rather than applied silently (got ${JSON.stringify(androidHealed.healed)})`);

    const keepable = `@font-face { font-family: "Local"; src: url(fonts/local.otf); }
@font-face { font-family: "Inline"; src: url(data:font/otf;base64,AAAA); }
p { background: url(images/tile.png); }`;
    const keptResult = healStylesheet(keepable);
    assert(keptResult.healed.length === 0 && keptResult.css === keepable,
      `a stylesheet whose urls are packaged files or data: URIs is returned byte-identical (healed: ${JSON.stringify(keptResult.healed)})`);

    const remoteBg = healStylesheet('p { background: url(https://cdn.example.com/x.png); color: #000; }');
    assert(!/https:\/\/cdn/.test(remoteBg.css) && /color:\s*#000/.test(remoteBg.css),
      'a declaration resting on a remote url is dropped while the rest of the rule stays');

    // EPUB 3 content documents declare <!DOCTYPE html>; every volume reepub
    // built before the move to EPUB 3 carries the XHTML 1.1 PUBLIC doctype,
    // which epubcheck rejects with HTM-004.
    const legacyChapter = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><p>a&nbsp;b&mdash;c</p></body></html>`;
    const modernized = modernizeContentDocument(legacyChapter, 'fixture');
    assert(modernized.includes('<!DOCTYPE html>') && !/XHTML 1\.1/.test(modernized),
      'the XHTML 1.1 doctype is brought forward to <!DOCTYPE html>');
    assert(modernized.includes('&#160;') && modernized.includes('&#8212;') && !/&nbsp;|&mdash;/.test(modernized),
      'entities the dropped DTD used to define become numeric references, so the document still parses');
    assert(isWellFormed(modernized),
      'the modernized chapter is well-formed XML without any DTD to lean on');
    let mangled = false;
    try {
      modernizeContentDocument('<p>&notarealentity;</p>', 'fixture');
    } catch (_) {
      mangled = true;
    }
    assert(mangled,
      'an unknown named entity fails loudly instead of being silently mangled (HTML parsing would turn &notarealentity; into ¬arealentity;)');

    // ------------------------------------------ the cover, as the shelf shows it
    // A cover approved at 1600px on a backlit display is not the cover anyone
    // sees. The shelf renders it greyscale at about 230px, which is where a
    // deep navy became flat grey, a 0.3-alpha imprint line vanished and the
    // author ended up under the selection tick. Judged here instead.
    section('Cover: survives the shelf');

    const { generateCover } = require('./cover-generator');
    const sharpLib = require('sharp');
    const shelfCover = path.join(work, 'shelf-cover.jpeg');
    const shelfFit = await generateCover('鹿鼎記', '金庸', shelfCover, { pageDirection: 'rtl' });

    const tile = await sharpLib(shelfCover).greyscale().resize({ width: 230 }).toBuffer();
    const tone = (await sharpLib(tile).stats()).channels[0];
    assert((tone.max - tone.min) / 255 > 0.9,
      `the thumbnail keeps near-full ink contrast in greyscale (${Math.round((tone.max - tone.min) / 255 * 100)}%)`);

    // The title has to be a shape you can recognise across a grid, not a
    // caption. Measured as the share of the tile the ink actually covers.
    const { data, info } = await sharpLib(tile).raw().toBuffer({ resolveWithObject: true });
    let lit = 0;
    for (let i = 0; i < data.length; i += info.channels) if (data[i] > 128) lit++;
    const inkShare = lit / (info.width * info.height);
    assert(inkShare > 0.03,
      `the title still carries the tile at thumbnail size (${(inkShare * 100).toFixed(1)}% of it is ink)`);

    assert(shelfFit.titleScale >= 8,
      `type is fitted to the canvas rather than left at a caption size (${shelfFit.titleScale}% of canvas width)`);

    // The shelf paints a progress badge, a selection tick and an overflow menu
    // over three corners. Anything that has to be read stays out of them.
    const corners = await Promise.all(
      [[0, 0], [1, 0], [0, 1], [1, 1]].map(async ([cx, cy]) => {
        const side = Math.round(info.width * 0.17);
        const region = await sharpLib(tile)
          .extract({
            left: cx ? info.width - side : 0,
            top: cy ? Math.round(info.height - side * 1.4) : 0,
            width: side,
            height: Math.round(side * 1.4),
          })
          .raw().toBuffer({ resolveWithObject: true });
        let bright = 0;
        for (let i = 0; i < region.data.length; i += region.info.channels) {
          if (region.data[i] > 128) bright++;
        }
        return bright / (region.info.width * region.info.height);
      }));
    const [, topRight, bottomLeft, bottomRight] = corners;
    assert(topRight < 0.02 && bottomLeft < 0.02 && bottomRight < 0.02,
      `nothing is drawn where the shelf paints its own furniture (top-right ${(topRight * 100).toFixed(1)}%, bottom-left ${(bottomLeft * 100).toFixed(1)}%, bottom-right ${(bottomRight * 100).toFixed(1)}%)`);

    // ------------------------------------- recognising a contents page
    // Whether a page is a table of contents is not a matter of opinion: the
    // book's navigation already lists every chapter's label, so the question
    // is whether this page's lines ARE those labels. On a real library the two
    // populations do not overlap — contents pages score 100%, chapters 0–1%.
    section('Contents page: recognised from the book\'s own navigation');

    const { inspect, relink, normalize } = require('./contents-page');
    const navLabels = new Map([
      ['第一回縱橫鉤黨清流禍', '3.xhtml'],
      ['第二回絕世奇事傳聞裏', '4.xhtml'],
      ['第三回符來袖裏圍方解', '5.xhtml'],
      ['後記', '6.xhtml'],
    ]);
    const tocDoc = XHTML('鹿鼎記',
      '<div>鹿鼎記<br/>第一回　縱橫鉤黨清流禍<br/>第二回　絕世奇事傳聞裏<br/>第三回　符來袖裏圍方解<br/>後記</div>');
    const chapterDoc = XHTML('第一回',
      '<p>第一回　縱橫鉤黨清流禍</p><p>北風如刀，滿地冰霜。</p><p>江南近海濱的一條大路上。</p><p>兩排嶙峋的樹木。</p>');

    const tocVerdict = inspect(tocDoc, navLabels);
    const chapterVerdict = inspect(chapterDoc, navLabels);
    assert(tocVerdict.isContents,
      `a page whose lines are the navigation's own labels is a contents page (${Math.round(tocVerdict.share * 100)}% matched)`);
    assert(!chapterVerdict.isContents,
      `a chapter that opens with its own heading is NOT a contents page (${Math.round(chapterVerdict.share * 100)}% matched)`);

    const relinked = relink(tocDoc, navLabels);
    assert(relinked.linked === 4,
      `every line the navigation knows becomes a link (linked ${relinked.linked})`);
    assert(/<a href="3\.xhtml">第一回　縱橫鉤黨清流禍<\/a>/.test(relinked.xhtml),
      'a chapter title links to the chapter the navigation gives it');
    assert(!/<a[^>]*>鹿鼎記</.test(relinked.xhtml),
      'a line the navigation does not list is left exactly as it was');
    assert(isWellFormed(relinked.xhtml), 'the relinked page is still well-formed XML');

    const already = relink(relinked.xhtml, navLabels);
    assert(already.linked === 0,
      'a contents page that already has links is left alone rather than nested inside itself');

    // ------------------------------------------------------ heal: one book
    // `reepub heal` repairs a single EPUB. It shares merge's engine, so the
    // repairs cannot drift apart, but it must NOT inherit merge's habit of
    // dropping the first spine document — that is a volume table of contents
    // only when there are other volumes to merge it with.
    section('Heal: repairs one book without losing any of it');

    const sick = path.join(work, 'sick');
    const sickEpub = makeVolumeEpub(sick, path.join(work, 'sick.epub'));
    // Give it the four diseases a real library book carries.
    let sickOpf = fs.readFileSync(path.join(sick, 'OEBPS', 'content.opf'), 'utf8');
    sickOpf = sickOpf.replace('<spine toc="ncx">', '<spine toc="ncx" page-progression-direction="rtl">');
    fs.writeFileSync(path.join(sick, 'OEBPS', 'content.opf'), sickOpf);
    fs.writeFileSync(path.join(sick, 'OEBPS', 'toc.ncx'),
      NCX('urn:uuid:99999999-9999-4999-8999-999999999999', [{ href: 'chapters/ch01.xhtml', label: 'C1' }]));
    fs.writeFileSync(path.join(sick, 'OEBPS', 'style.css'),
      `@font-face { font-family: "DroidFont"; src: url(res:///system/fonts/DroidSansFallback.ttf); }
body { -epub-writing-mode: vertical-rl; }`);
    // The doctype every EPUB 2-era chapter carries, which epubcheck rejects in
    // an EPUB 3 book (HTM-004), plus an entity only that doctype defines.
    for (const name of ['toc.xhtml', 'ch01.xhtml', 'ch02.xhtml']) {
      const chapterPath = path.join(sick, 'OEBPS', 'chapters', name);
      fs.writeFileSync(chapterPath, fs.readFileSync(chapterPath, 'utf8')
        .replace('<html xmlns',
          '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n<html xmlns')
        .replace('<body>', '<body><p>spacing&nbsp;survives</p>'));
    }
    fs.rmSync(sickEpub, { force: true });
    execFileSync('zip', ['-0Xq', sickEpub, 'mimetype'], { cwd: sick });
    execFileSync('zip', ['-ur9q', sickEpub, 'META-INF', 'OEBPS'], { cwd: sick });

    const healedEpub = path.join(work, 'healed.epub');
    const healRun = spawnSync(process.execPath, [path.join(__dirname, 'heal.js'), sickEpub, healedEpub],
      { encoding: 'utf8' });
    assert(healRun.status === 0,
      `heal succeeds on a book carrying all four diseases (exit ${healRun.status}; ${(healRun.stderr || '').trim().split('\n')[0] || 'no stderr'})`);

    const healLog = healRun.stdout || '';
    assert(/page-progression-direction.*EPUB 3\.0/.test(healLog),
      'an EPUB 2 spine carrying page-progression-direction is reported and rebuilt as EPUB 3');
    assert(/identifier disagreed/.test(healLog),
      'a table of contents identifier that disagrees with the package is reported');
    assert(/XHTML 1\.1 doctype/.test(healLog),
      'chapters still declaring the XHTML 1.1 doctype are reported');
    assert(/DroidSansFallback/.test(healLog),
      'an @font-face that cannot load is reported by name, not removed silently');

    if (fs.existsSync(healedEpub)) {
      assert(validateEpub(healedEpub).success === true, 'the healed book validates');
      const hx = unzipTo(healedEpub, path.join(work, 'healed-x'));
      const spineRefs = (fs.readFileSync(walk(hx).find(f => f.endsWith('.opf')), 'utf8')
        .match(/<itemref/g) || []).length;
      // Three spine documents in, three out: heal must not drop the first one
      // the way a merge does, and the nav document it adds is extra.
      assert(spineRefs >= 3,
        `every spine document survives the repair — none is mistaken for a discardable volume TOC (got ${spineRefs} itemrefs)`);
      const healedChapters = walk(hx).filter(f => /\d+\.xhtml$/.test(f));
      assert(healedChapters.length > 0 && healedChapters.every(f => {
        const c = fs.readFileSync(f, 'utf8');
        return c.includes('<!DOCTYPE html>') && !/XHTML 1\.1/.test(c);
      }), 'every repaired chapter carries the EPUB 3 doctype');
      assert(healedChapters.some(f => fs.readFileSync(f, 'utf8').includes('&#160;')),
        'an entity the dropped doctype used to define survives as a numeric reference');

      const healedCss = fs.readFileSync(walk(hx).find(f => f.endsWith('.css')), 'utf8');
      assert(/-epub-writing-mode:\s*vertical-rl/.test(healedCss) && !/@font-face/.test(healedCss),
        'the dead font rule is gone and the vertical writing mode survives');
      assert(/page-progression-direction="rtl"/.test(fs.readFileSync(walk(hx).find(f => f.endsWith('.opf')), 'utf8')),
        'the reading direction the book was rebuilt for is preserved');
    } else {
      assert(false, 'heal wrote the repaired book to the output path');
    }

    // The defect that started this whole audit: a generator that assembled
    // XHTML by concatenating strings dropped the <body> tags, so a shipped
    // 15-chapter book had every chapter floating directly under <html> — 45
    // epubcheck errors behind a build that printed "✓ EPUB valid".
    section('Heal: puts content back inside <body>');

    const bodyless = path.join(work, 'bodyless');
    const bodylessEpub = makeVolumeEpub(bodyless, path.join(work, 'bodyless.epub'));
    for (const name of ['ch01.xhtml', 'ch02.xhtml']) {
      const p = path.join(bodyless, 'OEBPS', 'chapters', name);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8')
        .replace('<body>', '').replace('</body>', ''));
    }
    fs.rmSync(bodylessEpub, { force: true });
    execFileSync('zip', ['-0Xq', bodylessEpub, 'mimetype'], { cwd: bodyless });
    execFileSync('zip', ['-ur9q', bodylessEpub, 'META-INF', 'OEBPS'], { cwd: bodyless });
    assert(validateEpub(bodylessEpub).success === false,
      'sanity: the fixture really is the broken shape (no <body>)');

    const bodyFixed = path.join(work, 'bodyless-healed.epub');
    const bodyRun = spawnSync(process.execPath,
      [path.join(__dirname, 'heal.js'), bodylessEpub, bodyFixed], { encoding: 'utf8' });
    assert(bodyRun.status === 0,
      `heal repairs documents whose content sits outside <body> (exit ${bodyRun.status})`);
    assert(/outside <body>/.test(bodyRun.stdout || ''),
      'the body repair is reported, with a count');
    if (fs.existsSync(bodyFixed)) {
      assert(validateEpub(bodyFixed).success === true, 'the repaired book validates');
      const bx = unzipTo(bodyFixed, path.join(work, 'bodyless-x'));
      const docs = walk(bx).filter(f => /\d+\.xhtml$/.test(f));
      assert(docs.length > 0 && docs.every(f => {
        const c = fs.readFileSync(f, 'utf8');
        return /<body[\s>]/.test(c) && c.includes('</body>');
      }), 'every repaired document now has a real <body>');
      assert(docs.some(f => /body 1/.test(fs.readFileSync(f, 'utf8'))),
        'the text that was floating outside <body> is still in the book');
    } else {
      assert(false, 'heal wrote the repaired body-less book');
    }

    // Regression: heal rebuilt the package without carrying the cover
    // DECLARATION across. The image and the cover page both survived, so the
    // book looked intact on disk while every reader showed it as blank on the
    // shelf — the declaration is what makes an image a cover.
    section('Heal: keeps the cover the book already has');

    const covered = path.join(work, 'covered');
    const coveredEpub = makeVolumeEpub(covered, path.join(work, 'covered.epub'));
    fs.writeFileSync(path.join(covered, 'OEBPS', 'images', 'cover.jpeg'),
      fs.readFileSync(path.join(covered, 'OEBPS', 'images', 'pic.png')));
    fs.writeFileSync(path.join(covered, 'OEBPS', 'chapters', 'cover.xhtml'),
      XHTML('Cover', '<div><img src="../images/cover.jpeg" alt="Cover"/></div>'));
    let coveredOpf = fs.readFileSync(path.join(covered, 'OEBPS', 'content.opf'), 'utf8');
    coveredOpf = coveredOpf
      .replace('</metadata>', '  <meta name="cover" content="cover-image"/>\n  </metadata>')
      .replace('</manifest>',
        '  <item id="cover-image" href="images/cover.jpeg" media-type="image/jpeg"/>\n'
        + '    <item id="cover-page" href="chapters/cover.xhtml" media-type="application/xhtml+xml"/>\n  </manifest>')
      .replace('<itemref idref="vtoc"/>', '<itemref idref="cover-page"/>\n    <itemref idref="vtoc"/>');
    fs.writeFileSync(path.join(covered, 'OEBPS', 'content.opf'), coveredOpf);
    fs.rmSync(coveredEpub, { force: true });
    execFileSync('zip', ['-0Xq', coveredEpub, 'mimetype'], { cwd: covered });
    execFileSync('zip', ['-ur9q', coveredEpub, 'META-INF', 'OEBPS'], { cwd: covered });

    const coveredOut = path.join(work, 'covered-healed.epub');
    const coveredRun = spawnSync(process.execPath,
      [path.join(__dirname, 'heal.js'), coveredEpub, coveredOut], { encoding: 'utf8' });
    assert(coveredRun.status === 0,
      `heal succeeds on a book that already has a cover (exit ${coveredRun.status})`);

    if (fs.existsSync(coveredOut)) {
      const cx = unzipTo(coveredOut, path.join(work, 'covered-x'));
      const cOpf = fs.readFileSync(walk(cx).find(f => f.endsWith('.opf')), 'utf8');
      assert(/properties="[^"]*\bcover-image\b/.test(cOpf) || /<meta\s+name="cover"/.test(cOpf),
        'the repaired book still DECLARES its cover image, not just contains it');
      const carried = walk(cx).find(f => /cover\.jpe?g$/i.test(f));
      assert(!!carried, 'the cover image itself is carried across');
      assert(carried && fs.readFileSync(carried)
        .equals(fs.readFileSync(path.join(covered, 'OEBPS', 'images', 'cover.jpeg'))),
        'the preserved cover image is byte-identical to the one the book arrived with');
      // Preserving a cover means preserving what the reader opens the book to,
      // not only the shelf thumbnail. Setting the title in type here would be
      // drawing a new cover over someone's scanned dust jacket — a different
      // request, and one nobody made.
      const coverPage = fs.readFileSync(walk(cx).find(f => /cover\.xhtml$/.test(f)), 'utf8');
      assert(/<img[^>]*src="[^"]*cover\.jpe?g"/.test(coverPage) && !/class="title"/.test(coverPage),
        'a preserved cover is shown as the picture it is, not re-set as type');
      // One cover page, not two: the original is furniture the rebuild replaces.
      const coverRefs = (cOpf.match(/<itemref[^>]*idref="cover-xhtml"/g) || []).length;
      assert(coverRefs === 1,
        `the reading order opens on exactly one cover page (got ${coverRefs})`);
      assert(validateEpub(coveredOut).success === true,
        'the book with its cover preserved still validates');
    } else {
      assert(false, 'heal wrote the book that already had a cover');
    }

    // --cover redraws instead of preserving. The layout is not the caller's
    // choice: a right-to-left book gets the vertical cover because of how it is
    // read, so a series cannot end up half vertical and half horizontal.
    const redrawn = path.join(work, 'covered-redrawn.epub');
    const redrawRun = spawnSync(process.execPath,
      [path.join(__dirname, 'heal.js'), '--cover', coveredEpub, redrawn], { encoding: 'utf8' });
    assert(redrawRun.status === 0,
      `heal --cover succeeds (exit ${redrawRun.status}; ${(redrawRun.stderr || '').trim().split('\n')[0] || 'no stderr'})`);
    if (fs.existsSync(redrawn)) {
      const rx = unzipTo(redrawn, path.join(work, 'redrawn-x'));
      const drawn = walk(rx).find(f => /cover\.jpe?g$/i.test(f));
      assert(!!drawn, 'a cover image is present after redrawing');
      const original = path.join(covered, 'OEBPS', 'images', 'cover.jpeg');
      assert(drawn && fs.statSync(drawn).size !== fs.statSync(original).size,
        'the cover was actually redrawn, not copied from the source book');
      assert(/drawing a new horizontal cover/.test(redrawRun.stdout || ''),
        'a book with no reading direction is reported as getting the horizontal cover');
      assert(validateEpub(redrawn).success === true, 'the redrawn book validates');
    } else {
      assert(false, 'heal --cover wrote the book');
    }

    // A book whose author and translator were conflated gets both credited, in
    // the roles a cataloguer reads: creator/aut leads, contributor/trl follows.
    const credited = path.join(work, 'credited.epub');
    const creditRun = spawnSync(process.execPath, [path.join(__dirname, 'heal.js'),
      '--cover', '--author', 'Eric Jorgenson', '--translator', 'Eugene',
      coveredEpub, credited], { encoding: 'utf8' });
    assert(creditRun.status === 0, `heal --translator succeeds (exit ${creditRun.status})`);
    if (fs.existsSync(credited)) {
      const cOpf = fs.readFileSync(
        walk(unzipTo(credited, path.join(work, 'credited-x'))).find(f => f.endsWith('.opf')), 'utf8');
      const creatorId = (cOpf.match(/<dc:creator[^>]*id="([^"]+)"[^>]*>\s*Eric Jorgenson\s*</) || [])[1];
      const translatorId = (cOpf.match(/<dc:contributor[^>]*id="([^"]+)"[^>]*>\s*Eugene\s*</) || [])[1];
      assert(!!creatorId && !!translatorId,
        'the author is the creator and the translator a contributor');
      assert(creatorId && new RegExp(`refines="#${creatorId}"[^>]*property="role"[^>]*>aut<`).test(cOpf),
        'the aut relator refines the element carrying the author');
      assert(translatorId && new RegExp(`refines="#${translatorId}"[^>]*property="role"[^>]*>trl<`).test(cOpf),
        'the trl relator refines the element carrying the translator');
      assert(validateEpub(credited).success === true, 'the credited book validates');
    } else {
      assert(false, 'heal --translator wrote the book');
    }

    // Healing twice must equal healing once. A rebuilt book carries an EPUB 3
    // navigation document in its spine; reading that back as a chapter files
    // the table of contents inside the book, and then writes a fresh nav next
    // to it — so every re-run grew the text by another copy of the contents.
    section('Heal: healing an already-healed book changes nothing');

    const once = path.join(work, 'idem-1.epub');
    const twice = path.join(work, 'idem-2.epub');
    const runOnce = spawnSync(process.execPath,
      [path.join(__dirname, 'heal.js'), coveredEpub, once], { encoding: 'utf8' });
    assert(runOnce.status === 0, `first heal succeeds (exit ${runOnce.status})`);
    const runTwice = spawnSync(process.execPath,
      [path.join(__dirname, 'heal.js'), once, twice], { encoding: 'utf8' });
    assert(runTwice.status === 0, `healing the healed book succeeds (exit ${runTwice.status})`);

    if (fs.existsSync(once) && fs.existsSync(twice)) {
      const readingText = (epub, into) => {
        const root = unzipTo(epub, into);
        const opfPath = walk(root).find(f => f.endsWith('.opf'));
        const opf = fs.readFileSync(opfPath, 'utf8');
        const manifest = new Map();
        for (const m of opf.matchAll(/<item\s[^>]*>/g)) {
          const id = (m[0].match(/\bid="([^"]+)"/) || [])[1];
          const href = (m[0].match(/\bhref="([^"]+)"/) || [])[1];
          const props = (m[0].match(/\bproperties="([^"]*)"/) || [, ''])[1];
          if (id && href) manifest.set(id, { href: decodeURIComponent(href), props });
        }
        let text = '';
        for (const m of opf.matchAll(/<itemref[^>]*idref="([^"]+)"/g)) {
          const item = manifest.get(m[1]);
          if (!item || item.props.split(/\s+/).includes('nav')) continue;
          const p = path.resolve(path.dirname(opfPath), item.href);
          if (!fs.existsSync(p)) continue;
          text += fs.readFileSync(p, 'utf8').replace(/<[^>]*>/g, '');
        }
        return text.replace(/\s+/g, '');
      };
      const t1 = readingText(once, path.join(work, 'idem-1-x'));
      const t2 = readingText(twice, path.join(work, 'idem-2-x'));
      assert(t1.length > 0 && t1 === t2,
        `the reading text is byte-identical after a second heal (${t1.length} vs ${t2.length} characters)`);

      const spineCount = f => (fs.readFileSync(walk(unzipTo(f, fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'))))
        .find(x => x.endsWith('.opf')), 'utf8').match(/<itemref/g) || []).length;
      assert(spineCount(once) === spineCount(twice),
        `the reading order does not grow on a second heal (${spineCount(once)} vs ${spineCount(twice)})`);
    } else {
      assert(false, 'both heal runs wrote their book');
    }

    const inPlace = spawnSync(process.execPath, [path.join(__dirname, 'heal.js'), sickEpub, sickEpub],
      { encoding: 'utf8' });
    assert(inPlace.status !== 0 && /in place/.test(inPlace.stderr || ''),
      'healing refuses to edit in place — the original is never the output');

    // A repair nobody can verify is not a repair: the artifact must not survive.
    const unhealable = path.join(work, 'unhealable.epub');
    const brokenSrc = path.join(work, 'broken-src');
    makeVolumeEpub(brokenSrc, path.join(work, 'broken.epub'));
    fs.writeFileSync(path.join(brokenSrc, 'OEBPS', 'chapters', 'ch01.xhtml'),
      XHTML('gone', '<p><img src="../images/not-here.png" alt="x"/></p>'));
    fs.rmSync(path.join(work, 'broken.epub'), { force: true });
    execFileSync('zip', ['-0Xq', path.join(work, 'broken.epub'), 'mimetype'], { cwd: brokenSrc });
    execFileSync('zip', ['-ur9q', path.join(work, 'broken.epub'), 'META-INF', 'OEBPS'], { cwd: brokenSrc });
    const brokenRun = spawnSync(process.execPath,
      [path.join(__dirname, 'heal.js'), path.join(work, 'broken.epub'), unhealable], { encoding: 'utf8' });
    assert(brokenRun.status !== 0,
      'a book whose damage cannot be repaired fails loudly instead of being passed off as healed');
    assert(!fs.existsSync(unhealable),
      'no unverifiable artifact is left at the output path after a failed repair');

    // ---------------------------------------------------------- binder: EPUB3
    section('Binder: EPUB 3 navigation document and uid consistency');

    let binder = null;
    try {
      binder = require('./binder');
    } catch (err) {
      assert(false, `src/binder.js is implemented (see test-web-spec.js) — ${err.code || err.message}`);
    }
    if (binder && binder.buildOpf) {
      const uuid = '123e4567-e89b-42d3-a456-426614174000';
      const args3 = {
        version: '3.0',
        title: 'Three',
        creator: 'A',
        language: 'zh-TW',
        uuid,
        chapters: [{ id: 'P1', href: '1.xhtml', title: 'One' }],
        images: [],
        cssHref: 'css/reepub-core.css',
        coverImage: 'images/cover.jpeg',
      };
      const opf3 = binder.buildOpf(args3);
      const navItems = [...opf3.matchAll(/<item\s[^>]*properties="[^"]*\bnav\b[^"]*"/g)];
      assert(navItems.length === 1,
        `an EPUB 3 package manifests exactly one properties="nav" item (got ${navItems.length})`);
      // The navigation document is the reader's table of contents, not a page
      // of the book. In the spine it becomes a second contents page for any
      // book that already has one; linear="no" only trades that for OPF-096,
      // because EPUB requires non-linear content to be linked from somewhere
      // linear. Manifested and out of the spine is the answer.
      const navId = (opf3.match(/<item\s[^>]*id="([^"]+)"[^>]*properties="[^"]*\bnav\b/) || [])[1]
        || (opf3.match(/<item\s[^>]*properties="[^"]*\bnav\b[^"]*"[^>]*id="([^"]+)"/) || [])[1];
      assert(!!navId && !new RegExp(`<itemref[^>]*idref="${navId}"`).test(opf3),
        'the navigation document is manifested but kept out of the reading order');
      assert(typeof binder.buildNavDocument === 'function',
        'buildNavDocument is exported so the declared nav document can actually be written');
      if (typeof binder.buildNavDocument === 'function') {
        const nav = binder.buildNavDocument({ title: 'Three', chapters: args3.chapters });
        assert(/epub:type="toc"/.test(nav) && /<nav[\s>]/.test(nav),
          'the nav document contains a nav element with epub:type="toc"');
      }

      const ncx3 = binder.buildNcx({ title: 'Three', uuid, chapters: args3.chapters });
      const opfId = (opf3.match(/urn:uuid:([0-9a-fA-F-]+)/) || [])[1];
      const ncxId = (ncx3.match(/urn:uuid:([0-9a-fA-F-]+)/) || [])[1];
      assert(opfId && ncxId && opfId === ncxId,
        `the NCX dtb:uid equals the OPF identifier (opf ${opfId}, ncx ${ncxId})`);
    }

    section('Binder: package assembly lives in one place');
    // Regression: three separate hand-rolled <package> templates drifted apart
    // (EPUB 2 vs 3, different escaping, different cover wiring).
    const assemblers = ['src/builder.js', 'src/merge.js', 'scripts/build-elon-from-web.js']
      .filter(rel => fs.existsSync(path.join(REPO, rel)))
      .filter(rel => /<package[\s>]/.test(fs.readFileSync(path.join(REPO, rel), 'utf8')));
    assert(assemblers.length === 0,
      `no module hand-rolls its own <package> template outside src/binder.js (offenders: ${JSON.stringify(assemblers)})`);

    // -------------------------------------------------------- optimize.js
    section('Optimizer: content root discovery');

    const pandocDir = makeMinimalEpubDir(path.join(work, 'pandoc'), { contentRoot: 'EPUB' });
    const pandocEpub = zipDir(pandocDir, path.join(work, 'pandoc.epub'));
    const pandocOut = path.join(work, 'pandoc-opt.epub');
    const opt = spawnSync(process.execPath,
      [path.join(REPO, 'scripts', 'optimize.js'), pandocEpub, pandocOut],
      { encoding: 'utf8' });

    if (fs.existsSync(pandocOut)) {
      const px = unzipTo(pandocOut, path.join(work, 'pandoc-x'));
      const kept = walk(px).map(f => path.relative(px, f));
      assert(kept.some(f => f.endsWith('content.opf')) && kept.some(f => f.endsWith('index.xhtml')),
        `an EPUB whose content root is EPUB/ keeps its OPF and content (kept: ${JSON.stringify(kept)})`);
      assert(validateEpub(pandocOut).success === true,
        'the optimized non-OEBPS EPUB is still valid');
    } else {
      assert(opt.status !== 0,
        'if the optimizer cannot handle the layout it fails loudly instead of writing nothing');
    }
    assert(!(fs.existsSync(pandocOut) && validateEpub(pandocOut).success === false && opt.status === 0),
      'the optimizer never exits 0 after producing an EPUB that fails validation');

    const strayOptDirs = fs.readdirSync(work).filter(f => f.startsWith('.reepub-opt-'));
    assert(strayOptDirs.length === 0,
      `the optimizer leaves no scratch directory behind (found ${JSON.stringify(strayOptDirs)})`);

    // --------------------------------------------------- cover-generator
    section('Cover generator: no leaked browser on failure');

    const hangProbe = path.join(work, 'hang-probe.js');
    fs.writeFileSync(hangProbe, `
const { generateCover } = require(${JSON.stringify(path.join(__dirname, 'cover-generator.js'))});
generateCover('T', 'A', '/System/definitely-not-writable/cover.jpeg', 'horizontal')
  .then(() => console.log('RESOLVED'))
  .catch(() => console.log('REJECTED'));
`);
    // A correctly-cleaned-up failure path exits in ~1.5s; anything near this
    // ceiling is a leaked browser holding the event loop open.
    const PROBE_TIMEOUT_MS = 20000;
    const probeStart = Date.now();
    const probe = spawnSync(process.execPath, [hangProbe], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    const probeMs = Date.now() - probeStart;
    // A killed-on-timeout child still reports status 0 / signal null on macOS;
    // the only reliable hang signal is spawnSync's own ETIMEDOUT error.
    assert(!probe.error,
      `the process exits on its own after a cover failure instead of hanging on a leaked browser (took ${probeMs}ms; ${probe.error ? probe.error.code : 'clean exit'})`);
    assert(/REJECTED/.test(probe.stdout || ''),
      'the cover failure surfaces as a rejected promise (sanity: the probe reached the failure path)');

    // ----------------------------------------------- Node <-> Swift sync
    section('Node/Swift behavioral sync');

    const swiftPath = path.join(REPO, 'macos', 'Sources', 'ReepubCore', 'EpubBuilder.swift');
    if (fs.existsSync(swiftPath)) {
      const swift = fs.readFileSync(swiftPath, 'utf8');
      const jsSrc = fs.readFileSync(path.join(__dirname, 'epub-text.js'), 'utf8');

      const setMatch = swift.match(/breakPunct:\s*Set<Character>\s*=\s*\[([^\]]+)\]/);
      assert(!!setMatch, 'the Swift break-punctuation set is locatable');
      if (setMatch) {
        const swiftChars = [...setMatch[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
        const jsReMatch = jsSrc.match(/\/\[([^\]]+)\]\$\/\.test\(prevLine\.text\.trim\(\)\)/);
        assert(!!jsReMatch, 'the JS break-punctuation character class is locatable');
        if (jsReMatch) {
          const jsRe = new RegExp(`[${jsReMatch[1]}]$`);
          const missing = swiftChars.filter(c => !jsRe.test(c));
          assert(missing.length === 0,
            `every character that breaks a paragraph in Swift also breaks it in JS (missing: ${JSON.stringify(missing)})`);
        }
      }

      const jsUsesCodeUnits = /text\.length\s*<\s*40/.test(jsSrc);
      const swiftUsesGraphemes = /text\.count\s*<\s*40/.test(swift);
      assert(!(jsUsesCodeUnits && swiftUsesGraphemes),
        'the heading length metric counts the same units on both sides (JS text.length counts UTF-16 units, Swift text.count counts graphemes — a 25-char astral title measures 50 vs 25)');
    } else {
      assert(false, `the Swift source is present at ${path.relative(REPO, swiftPath)}`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  if (failures === 0) {
    console.log('\n[SUCCESS] All core spec tests passed!');
    process.exit(0);
  } else {
    console.error(`\n[FAILURE] ${failures} core spec test(s) failed.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected test-runner error:', err);
  process.exit(1);
});
