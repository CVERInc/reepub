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
