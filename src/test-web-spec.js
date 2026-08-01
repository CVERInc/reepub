// Spec tests (unit level) for the web-to-epub pipeline modules.
//
// These are written TDD-style: they define the contracts the pipeline SHOULD
// have. Until the modules below are implemented, sections report FAIL — that
// is the expected red state. Target module layout:
//
//   src/sanitizer.js       exports { sanitizeChapter, sortChapterFiles }
//     sanitizeChapter(rawHtml, opts) -> { xhtml, title }
//       opts: {
//         lang            e.g. 'zh-TW'            (xml:lang on <html>)
//         cssHref         e.g. 'css/reepub-core.css'
//         classMap        { 'fw-box': 'reepub-box', ... }  site class -> reepub class
//         allowedClasses  ['reepub-box', ...]      classes permitted to survive;
//                         any class not in classMap values nor allowedClasses is STRIPPED
//         imagePathRewrites { '../images/': 'images/' }
//         fallbackTitle   used when the chapter has no <h1>
//       }
//     sortChapterFiles(names) -> names sorted by their NUMERIC chapter index
//       ('ch2.html' before 'ch10.html' — lexicographic sort is the bug)
//
//   src/binder.js          exports { buildOpf, buildNcx, newUuid }
//     newUuid() -> RFC-4122 UUID string (bare, no 'urn:uuid:' prefix)
//     buildOpf({ title, creator, translator, language, uuid,
//                chapters: [{id, href, title}], images: ['a.png', ...],
//                cssHref, coverImage }) -> OPF XML string
//     buildNcx({ title, uuid, chapters: [{href, title}] }) -> NCX XML string
//
//   src/dehydrator.js      exports { dehydrateImage }
//     dehydrateImage(inputPath, outputPath, opts?) -> Promise<{originalSize, newSize} | null>
//       - caps the longest side at opts.maxDim (default 1600), never enlarges
//       - keeps the format (png stays png, jpeg stays jpeg)
//       - NEVER writes an output larger than the input: if the re-encode grows
//         the file, fall back to copying the original bytes through
//       - never throws on a corrupt input: copies the original bytes through
//
//   src/cover-generator.js additionally exports { buildCoverHtml }
//     buildCoverHtml(title, author, layout) -> HTML string with title/author
//     HTML-escaped (regression: raw interpolation allowed markup injection)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

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
function tryRequire(rel, hint) {
  try {
    return require(rel);
  } catch (err) {
    assert(false, `${rel}.js is implemented and loadable (${hint}) — ${err.code || err.message}`);
    return null;
  }
}

function isWellFormed(xml) {
  const tmp = path.join(os.tmpdir(), `reepub-spec-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`);
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  console.log('Starting web-pipeline spec tests...');

  // ---------------------------------------------------------------- Sanitizer
  section('Sanitizer: sanitizeChapter');
  const sanitizer = tryRequire('./sanitizer', 'sanitizeChapter, sortChapterFiles');
  if (sanitizer && sanitizer.sanitizeChapter) {
    const rawHtml = `<!DOCTYPE html>
<html>
<head><title>site chrome title</title><script src="app.js"></script><style>.x{color:red}</style></head>
<body>
<nav class="topnav">SITE MENU</nav>
<div class="ch-hero">
  <h1>AT&T 與 &lt;火箭&gt; 的一課</h1>
  <p class="fw-box accent">重點框<br>第二行</p>
  <img src="../images/big.png" alt="diagram">
  <hr>
</div>
<footer>site footer</footer>
</body>
</html>`;
    const opts = {
      lang: 'zh-TW',
      cssHref: 'css/reepub-core.css',
      classMap: { 'fw-box': 'reepub-box' },
      allowedClasses: ['reepub-box'],
      imagePathRewrites: { '../images/': 'images/' },
      fallbackTitle: 'Chapter 1',
    };
    const out = sanitizer.sanitizeChapter(rawHtml, opts);

    assert(out && typeof out.xhtml === 'string' && typeof out.title === 'string',
      'sanitizeChapter returns { xhtml, title }');
    const xhtml = (out && out.xhtml) || '';

    assert(out && out.title === 'AT&T 與 <火箭> 的一課',
      `title is the decoded first <h1> text (got ${JSON.stringify(out && out.title)})`);
    assert(isWellFormed(xhtml),
      'output XHTML is well-formed XML (hostile & / < in the h1 must be re-escaped)');

    // Regression: build-elon-from-web.js stripped <body> and never re-added it,
    // producing "element html incomplete; missing required element body"
    // (45 epubcheck errors across the shipped book).
    const bodyOpens = (xhtml.match(/<body[\s>]/g) || []).length;
    assert(bodyOpens === 1 && xhtml.includes('</body>'),
      `output has exactly one <body>…</body> (got ${bodyOpens} opening tag(s))`);
    const bodyPos = xhtml.indexOf('<body');
    const contentPos = xhtml.indexOf('reepub-box');
    assert(bodyPos !== -1 && contentPos > bodyPos && xhtml.indexOf('</body>') > contentPos,
      'chapter content sits inside <body>, not directly under <html>');

    assert(xhtml.includes('xmlns="http://www.w3.org/1999/xhtml"'),
      'html element carries the XHTML namespace');
    assert(/xml:lang="zh-TW"/.test(xhtml), 'xml:lang comes from opts.lang');
    assert(xhtml.includes('css/reepub-core.css'), 'stylesheet link uses opts.cssHref');

    assert(!/SITE MENU/.test(xhtml) && !/<nav[\s>]/.test(xhtml), 'nav is removed');
    assert(!/site footer/.test(xhtml) && !/<footer[\s>]/.test(xhtml), 'footer is removed');
    assert(!/<script[\s>]/.test(xhtml), 'script is removed');
    assert(!/<style[\s>]/.test(xhtml), 'style is removed');

    // Class translation and dead-class stripping. Regression: only 9 classes
    // were mapped and ~15 site classes (fade-up, accent, cyan, quote-en, ...)
    // shipped with no CSS behind them.
    assert(xhtml.includes('reepub-box'), 'classMap translates fw-box -> reepub-box');
    assert(!/fw-box/.test(xhtml), 'no classMap key survives in the output');
    assert(!/\baccent\b/.test(xhtml),
      'classes not in classMap values nor allowedClasses are stripped (no dead classes ship)');

    assert(/src="images\/big\.png"/.test(xhtml), 'image path ../images/ is rewritten to images/');
    assert(!/<br>(?!<)/.test(xhtml) && !/<hr>(?!<)/.test(xhtml),
      'void elements are self-closed (no raw <br> / <hr>)');

    const noH1 = sanitizer.sanitizeChapter('<html><body><p>no heading</p></body></html>', opts);
    assert(noH1 && noH1.title === 'Chapter 1', 'falls back to opts.fallbackTitle when no <h1>');
  }

  section('Sanitizer: sortChapterFiles');
  if (sanitizer && sanitizer.sortChapterFiles) {
    // Regression: Array.prototype.sort() is lexicographic, so ch10 sorted
    // before ch2; the shipped book only survived because filenames were
    // zero-padded.
    const sorted = sanitizer.sortChapterFiles(['ch10.html', 'ch2.html', 'ch1.html']);
    assert(JSON.stringify(sorted) === JSON.stringify(['ch1.html', 'ch2.html', 'ch10.html']),
      `chapters sort numerically, not lexicographically (got ${JSON.stringify(sorted)})`);
    const mixed = sanitizer.sortChapterFiles(['ch02.html', 'ch1.html', 'ch10.html']);
    assert(JSON.stringify(mixed) === JSON.stringify(['ch1.html', 'ch02.html', 'ch10.html']),
      `zero-padded and bare indices sort together numerically (got ${JSON.stringify(mixed)})`);
  } else if (sanitizer) {
    assert(false, 'sortChapterFiles is exported from src/sanitizer.js');
  }

  // ------------------------------------------------------------------- Binder
  section('Binder: buildOpf / buildNcx / newUuid');
  const binder = tryRequire('./binder', 'buildOpf, buildNcx, newUuid');
  if (binder && binder.newUuid) {
    const u1 = binder.newUuid();
    const u2 = binder.newUuid();
    // Regression: the shipped identifier was urn:uuid:book-of-elon-web,
    // which epubcheck flags (OPF-085: invalid UUID).
    assert(UUID_RE.test(u1), `newUuid() returns a valid RFC-4122 UUID (got ${JSON.stringify(u1)})`);
    assert(u1 !== u2, 'newUuid() returns a fresh UUID per call');
  } else if (binder) {
    assert(false, 'newUuid is exported from src/binder.js');
  }

  if (binder && binder.buildOpf) {
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    const opf = binder.buildOpf({
      title: 'AT&T <Deal>',
      creator: 'Eric Jorgenson',
      translator: 'Eugene',
      language: 'zh-TW',
      uuid,
      chapters: [
        { id: 'P1', href: '1.xhtml', title: 'One & <Two>' },
        { id: 'P2', href: '2.xhtml', title: 'Three' },
      ],
      // Regression: ids were derived by stripping non-alphanumerics, so
      // a_b.png and ab.png collided into the same manifest id.
      images: ['a_b.png', 'ab.png', 'photo.jpeg'],
      cssHref: 'css/reepub-core.css',
      coverImage: 'images/cover.jpeg',
    });

    assert(isWellFormed(opf), 'OPF is well-formed XML with a hostile title');
    assert(opf.includes('AT&amp;T &lt;Deal&gt;'), 'dc:title is XML-escaped');
    assert(/<dc:creator[^>]*opf:role="aut"[^>]*>Eric Jorgenson<\/dc:creator>/.test(opf),
      'original author is dc:creator with opf:role="aut"');
    assert(/opf:role="trl"[^>]*>Eugene</.test(opf),
      'translator is credited with opf:role="trl" (原作者為主、譯者為輔)');
    assert(opf.includes(`urn:uuid:${uuid}`), 'dc:identifier uses urn:uuid:<the provided uuid>');
    assert(/<meta name="cover" content="/.test(opf), 'legacy cover meta is present');

    const manifestXml = (opf.match(/<manifest>([\s\S]*?)<\/manifest>/) || [, ''])[1];
    const ids = [...manifestXml.matchAll(/<item\s[^>]*\bid="([^"]+)"/g)].map(m => m[1]);
    assert(ids.length > 0 && new Set(ids).size === ids.length,
      `manifest item ids are unique even for colliding image names (got ${ids.length} items, ${new Set(ids).size} unique)`);
    assert(/href="images\/a_b\.png"[^>]*media-type="image\/png"/.test(manifestXml)
        && /href="images\/photo\.jpeg"[^>]*media-type="image\/jpeg"/.test(manifestXml),
      'image manifest entries carry correct media-types');

    const spineXml = (opf.match(/<spine[^>]*>([\s\S]*?)<\/spine>/) || [, ''])[1];
    const idrefs = [...spineXml.matchAll(/idref="([^"]+)"/g)].map(m => m[1]);
    const firstHref = (manifestXml.match(new RegExp(`id="${idrefs[0]}"[^>]*href="([^"]+)"`)) ||
                       manifestXml.match(new RegExp(`href="([^"]+)"[^>]*id="${idrefs[0]}"`)) || [, ''])[1];
    assert(/cover/i.test(firstHref || idrefs[0] || ''),
      `spine opens with the cover page (first idref ${JSON.stringify(idrefs[0])})`);
  } else if (binder) {
    assert(false, 'buildOpf is exported from src/binder.js');
  }

  if (binder && binder.buildNcx) {
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    const ncx = binder.buildNcx({
      title: 'Spec & Book',
      uuid,
      chapters: [
        { href: '1.xhtml', title: 'One & <Two>' },
        { href: '2.xhtml', title: 'Three' },
      ],
    });
    assert(isWellFormed(ncx), 'NCX is well-formed XML with hostile chapter titles');
    assert(ncx.includes('One &amp; &lt;Two&gt;'),
      'navLabel text is XML-escaped (regression: raw ${ch.title} interpolation)');
    assert(ncx.includes(`urn:uuid:${uuid}`), 'dtb:uid matches the OPF identifier');
    const orders = [...ncx.matchAll(/playOrder="(\d+)"/g)].map(m => Number(m[1]));
    assert(JSON.stringify(orders) === JSON.stringify([1, 2]),
      `playOrder is sequential from 1 (got ${JSON.stringify(orders)})`);
  } else if (binder) {
    assert(false, 'buildNcx is exported from src/binder.js');
  }

  // --------------------------------------------------------------- Dehydrator
  section('Dehydrator: dehydrateImage');
  const dehydrator = tryRequire('./dehydrator', 'dehydrateImage');
  if (dehydrator && dehydrator.dehydrateImage) {
    const sharp = require('sharp');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reepub-dehydrate-'));
    try {
      // Deterministic photographic-ish noise. A regular gradient/stripe pattern
      // is NOT usable here: PNG row filters compress a constant-delta pattern
      // anomalously well, so downscaling it produces a *larger* file under the
      // default encoder and the shrink assertion below would fail an
      // implementation that honours the contract exactly.
      // xorshift32 (all-32-bit ops). A multiply-based LCG loses precision in JS
      // float math and degenerates into a compressible pattern, which would
      // defeat the point of using noise here.
      const w = 2400, h = 1200;
      const buf = Buffer.alloc(w * h * 3);
      let seed = 0x2f6e2b1;
      for (let i = 0; i < buf.length; i++) {
        seed ^= seed << 13; seed >>>= 0;
        seed ^= seed >>> 17;
        seed ^= seed << 5; seed >>>= 0;
        buf[i] = seed & 0xff;
      }
      const bigPng = path.join(tmpDir, 'big.png');
      await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(bigPng);
      const outPng = path.join(tmpDir, 'big.out.png');
      const result = await dehydrator.dehydrateImage(bigPng, outPng);

      const outMeta = await sharp(outPng).metadata();
      assert(outMeta.width <= 1600 && outMeta.height <= 1600,
        `oversized image is capped at 1600px on the longest side (got ${outMeta.width}x${outMeta.height})`);
      assert(outMeta.format === 'png', 'png input stays png');
      assert(result && result.newSize < result.originalSize,
        'reports {originalSize, newSize} and actually shrank the file');
      assert(fs.statSync(outPng).size < fs.statSync(bigPng).size,
        'output file on disk is smaller than the input');

      // Never-grow guarantee. Some inputs re-encode LARGER than the original
      // (a constant-row-delta pattern is the textbook case: 949KB in, 1.15MB
      // out under sharp's default PNG encoder even after a 2.25x pixel
      // reduction). Dehydration must never make a book heavier, so the
      // implementation has to compare and fall back to the original bytes.
      const w2 = 2400, h2 = 1200;
      const pattern = Buffer.alloc(w2 * h2 * 3);
      for (let y = 0; y < h2; y++) {
        for (let x = 0; x < w2; x++) {
          const i = (y * w2 + x) * 3;
          pattern[i] = (x * 7) % 256; pattern[i + 1] = (y * 5) % 256; pattern[i + 2] = (x + y) % 256;
        }
      }
      const patternPng = path.join(tmpDir, 'pattern.png');
      await sharp(pattern, { raw: { width: w2, height: h2, channels: 3 } }).png().toFile(patternPng);
      const patternOut = path.join(tmpDir, 'pattern.out.png');
      await dehydrator.dehydrateImage(patternPng, patternOut);
      assert(fs.statSync(patternOut).size <= fs.statSync(patternPng).size,
        `dehydration never produces a file larger than its input (got ${fs.statSync(patternOut).size} from ${fs.statSync(patternPng).size})`);

      const smallJpg = path.join(tmpDir, 'small.jpeg');
      await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 90, g: 120, b: 150 } } })
        .jpeg().toFile(smallJpg);
      const outJpg = path.join(tmpDir, 'small.out.jpeg');
      await dehydrator.dehydrateImage(smallJpg, outJpg);
      const smallMeta = await sharp(outJpg).metadata();
      assert(smallMeta.width === 800 && smallMeta.height === 600,
        `images already within bounds are never enlarged or resized (got ${smallMeta.width}x${smallMeta.height})`);
      assert(smallMeta.format === 'jpeg', 'jpeg input stays jpeg');

      const corrupt = path.join(tmpDir, 'corrupt.png');
      fs.writeFileSync(corrupt, 'this is not an image');
      const corruptOut = path.join(tmpDir, 'corrupt.out.png');
      let threw = false;
      try {
        await dehydrator.dehydrateImage(corrupt, corruptOut);
      } catch (_) {
        threw = true;
      }
      assert(!threw, 'a corrupt input never throws');
      assert(fs.existsSync(corruptOut) &&
             fs.readFileSync(corruptOut).equals(fs.readFileSync(corrupt)),
        'a corrupt input falls back to copying the original bytes through');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } else if (dehydrator) {
    assert(false, 'dehydrateImage is exported from src/dehydrator.js');
  }

  // -------------------------------------------------------------- Cover HTML
  section('Cover generator: buildCoverHtml escaping');
  const cover = tryRequire('./cover-generator', 'buildCoverHtml, generateCover');
  if (cover && cover.buildCoverHtml) {
    // Regression: title/author were interpolated raw into the cover HTML.
    const html = cover.buildCoverHtml('AT&T "The" <Book>', 'R&D <Team>', 'horizontal');
    assert(!html.includes('<Book>') && !html.includes('<Team>'),
      'hostile title/author cannot inject markup into the cover page');
    assert(html.includes('AT&amp;T'), 'ampersands in the title are HTML-escaped');
    assert(html.includes('layout-horizontal'), 'horizontal layout selects the horizontal cover');
    const v = cover.buildCoverHtml('書名', '作者', 'vertical');
    assert(v.includes('layout-vertical'), 'vertical layout selects the vertical cover');

    // The imprint is one imprint. A cover whose typeface is chosen by the
    // script its title happens to be written in gives the same series two
    // different looks; reepub sets English, Japanese and Traditional Chinese
    // in one voice and lets the platform supply each script's own letterforms.
    const faces = [
      cover.buildCoverHtml('The Book of Elon', 'Eric Jorgenson', 'horizontal'),
      cover.buildCoverHtml('鹿鼎記', '金庸', 'horizontal'),
      cover.buildCoverHtml('新刊が売り子のせいです', '道満晴明', 'horizontal'),
    ].map(html => (html.match(/font-family:\s*([^;]+);/) || [, ''])[1].trim());
    assert(faces.every(f => f && f === faces[0]),
      `the typeface is the same for en, ja and zh-TW titles (got ${JSON.stringify(faces)})`);
    assert(faces[0] === 'serif',
      `the imprint face is the generic serif, which resolves per script (got ${JSON.stringify(faces[0])})`);
    assert(!/PingFang|Inter|Helvetica|Songti|Hiragino/.test(v),
      'no named family is hardcoded, so a machine missing one cannot change the look');

    // The shelf renders the cover in greyscale at thumbnail size and draws its
    // own furniture over the corners. A gradient collapses, a faint grey is
    // simply absent, and a hairline is gone — so the ground is solid black and
    // the ink is solid white, with nothing else to lose.
    assert(/background:\s*#000\b/.test(v) && /color:\s*#fff\b/.test(v),
      'the cover is solid black and solid white, which is all that survives greyscale e-ink');
    assert(!/gradient|opacity:\s*0\.|rgba\(/.test(v),
      'no gradient, no partial opacity and no translucent ink — none of it reaches the device');

    // 原作者為主、譯者為輔, on the cover as well as in the metadata.
    const credited = cover.buildCoverHtml('鹿鼎記', '金庸', 'vertical', '某某 <譯>');
    assert(/class="translator"[^>]*>某某 &lt;譯&gt;</.test(credited),
      'a translator is credited on the cover, escaped like every other untrusted field');
    const sizeOf = (html, cls) => {
      const rule = html.match(new RegExp(`\\.reepub-cover \\.${cls}\\s*\\{[^}]*\\}`));
      return rule ? Number((rule[0].match(/font-size:\s*([\d.]+)em/) || [, 0])[1]) : 0;
    };
    assert(sizeOf(credited, 'translator') > 0 && sizeOf(credited, 'author') > 0
      && sizeOf(credited, 'translator') < sizeOf(credited, 'author'),
      `the translator is set smaller than the author (${sizeOf(credited, 'translator')}em vs ${sizeOf(credited, 'author')}em)`);
    const uncredited = cover.buildCoverHtml('鹿鼎記', '金庸', 'vertical');
    assert(/class="translator"><\/p>/.test(uncredited) && /\.translator:empty\s*\{[^}]*display:\s*none/.test(uncredited),
      'a book with no translator leaves no stray line on the cover');
  } else if (cover) {
    assert(false, 'buildCoverHtml is exported from src/cover-generator.js');
  }

  section('Cover generator: type is fitted, not fixed');
  if (cover && cover.buildCoverPage) {
    // The cover is HTML, so its type should behave like type: one size chosen
    // for the title it actually has. A constant makes a two-character title
    // small and a fifteen-character one overflow.
    const big = cover.buildCoverHtml('鹿鼎記', '金庸', 'vertical', '', 30);
    const small = cover.buildCoverHtml('鹿鼎記', '金庸', 'vertical', '', 8);
    const sizeIn = html => Number((html.match(/\.title\s*\{[^}]*font-size:\s*([\d.]+)em/) || [, 0])[1]);
    assert(sizeIn(big) === 30 && sizeIn(small) === 8,
      `the fitted scale reaches the stylesheet (got ${sizeIn(big)}em and ${sizeIn(small)}em)`);
    assert(/font-size:\s*calc\(min\(100vw/.test(big),
      'one em is a fraction of the canvas, so the same numbers describe a 1600px raster and a reader\'s page');

    // Wrapping splits a name across lines and no tool without a dictionary
    // knows where a name ends, so it has to earn its keep.
    assert(/text-wrap:\s*nowrap/.test(cover.buildCoverHtml('賈伯斯傳', '華特', 'horizontal', '', 19, true)),
      'a title kept on one line says so in the stylesheet');
    assert(/text-wrap:\s*balance/.test(cover.buildCoverHtml('The Book of Elon', 'Eric', 'horizontal', '', 22, false)),
      'a wrapping title asks for balanced lines rather than a stray last word');
    assert(/line-break:\s*strict/.test(big),
      'CJK closing punctuation is kept off the start of a line');

    // The page bound into the book is the same design as the raster beside it.
    const page = cover.buildCoverPage({
      title: '鹿鼎記', author: '金庸', layout: 'vertical', language: 'zh-TW', titleScale: 30,
    });
    assert(/^<\?xml/.test(page) && /xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/.test(page),
      'the cover page is an XHTML document the container can carry');
    assert(isWellFormed(page), 'the cover page is well-formed XML');
    assert(!/<img[\s>]/.test(page),
      'the cover page is type, not a picture of type — it stays sharp at any size');
    assert(sizeIn(page) === 30,
      'the page and the raster are set from the same fitted measurement');
    assert(/xml:lang="zh-TW"/.test(page), 'the cover page declares the book\'s language');
    const hostilePage = cover.buildCoverPage({ title: 'A <B> & "C"', author: 'X & Y', layout: 'horizontal' });
    assert(isWellFormed(hostilePage), 'a hostile title cannot break the cover page');
  } else if (cover) {
    assert(false, 'buildCoverPage is exported from src/cover-generator.js');
  }

  section('Cover generator: the layout follows the reading direction');
  if (cover && cover.layoutForDirection) {
    // Which cover a book gets is a property of how it is read, not of what a
    // caller guesses about its language. One rule, in one place.
    assert(cover.layoutForDirection('rtl') === 'vertical',
      'a right-to-left book gets the vertical cover');
    assert(cover.layoutForDirection('RTL') === 'vertical',
      'the direction is matched case-insensitively');
    assert(cover.layoutForDirection('ltr') === 'horizontal',
      'a left-to-right book gets the horizontal cover');
    assert(cover.layoutForDirection('') === 'horizontal'
      && cover.layoutForDirection(undefined) === 'horizontal',
      'a book that declares no direction gets the horizontal cover');
  } else if (cover) {
    assert(false, 'layoutForDirection is exported from src/cover-generator.js');
  }
  if (cover) {
    assert(typeof cover.generateCover === 'function', 'generateCover remains exported');
  }

  if (failures === 0) {
    console.log('\n[SUCCESS] All web-pipeline spec tests passed!');
    process.exit(0);
  } else {
    console.error(`\n[FAILURE] ${failures} spec test(s) failed.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected test-runner error:', err);
  process.exit(1);
});
