// Conformance spec tests: (1) the validator must actually be strict, and
// (2) the end-to-end web pipeline must produce an EPUB that passes the
// OFFICIAL epubcheck with zero errors.
//
// Background (audit 2026-07-31): the shipped "Built from Web" book reported
// "✓ EPUB valid" from src/validator.js yet scored 45 errors under epubcheck
// (every chapter was missing <body>); the "(optimized)" book scored 48 errors
// (toc.xhtml links broken by the chapters/ flattening). These tests make both
// failure classes impossible to ship silently again.
//
// TDD-style: red until the fixes land. Target contract:
//
//   src/validator.js  validateEpub(path) must ALSO reject:
//     - an XHTML spine document whose <html> has no <body> child
//     - an XHTML document whose internal references (<a href>, <img src>,
//       relative, non-fragment, non-external) point at files missing from
//       the EPUB
//
//   src/web-to-epub.js  exports { buildWebEpub }
//     buildWebEpub({
//       srcDir,        directory containing chapters/*.html and images/*
//       outputPath,    where to write the .epub
//       title, creator, translator, language,
//       classMap,      site class -> reepub class translation table
//       coverLayout,   'horizontal' | 'vertical'
//     }) -> Promise<{ outputPath }>
//     - rejects if srcDir does not exist
//     - chapters ordered by NUMERIC index (ch2 before ch10)
//     - every chapter wrapped in a real <body>, hostile titles escaped
//     - images capped at 1600px (dehydrated)
//     - only classes defined in src/styles/reepub-core.css survive
//     - rejects (throws) if the finished EPUB fails validation — never
//       "log and ship" a broken file
//
// The epubcheck jar is looked up via $REEPUB_EPUBCHECK_JAR, then
// ~/.cache/reepub/epubcheck-5.1.0/epubcheck.jar, then tools/epubcheck/.
// It is REQUIRED: a missing jar is a test failure, because a validation
// pipeline that silently skips real validation is exactly the bug this
// suite exists to prevent. (Cover generation needs playwright's chromium:
// npx playwright install chromium.)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { validateEpub } = require('./validator');

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

const XHTML_WITH_BODY = (title, bodyInner) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${title}</title></head>
<body>${bodyInner}</body>
</html>`;

// The shipped bug: content directly under <html>, no <body> at all.
const XHTML_WITHOUT_BODY = (title, bodyInner) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${title}</title></head>
${bodyInner}
</html>`;

function writeEpubDir(dir, files) {
  fs.mkdirSync(path.join(dir, 'META-INF'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'OEBPS'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mimetype'), 'application/epub+zip');
  fs.writeFileSync(path.join(dir, 'META-INF', 'container.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);
  const manifest = Object.keys(files)
    .map((href, i) => `    <item id="f${i}" href="${href}" media-type="${href.endsWith('.xhtml') ? 'application/xhtml+xml' : 'text/plain'}"/>`)
    .join('\n');
  const spine = Object.keys(files).filter(h => h.endsWith('.xhtml'))
    .map((href) => `    <itemref idref="f${Object.keys(files).indexOf(href)}"/>`)
    .join('\n');
  fs.writeFileSync(path.join(dir, 'OEBPS', 'content.opf'),
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Strictness Fixture</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="BookID">urn:uuid:123e4567-e89b-42d3-a456-426614174000</dc:identifier>
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine>
${spine}
  </spine>
</package>`);
  for (const [href, content] of Object.entries(files)) {
    const p = path.join(dir, 'OEBPS', href);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function findEpubcheckJar() {
  const candidates = [
    process.env.REEPUB_EPUBCHECK_JAR,
    path.join(os.homedir(), '.cache', 'reepub', 'epubcheck-5.1.0', 'epubcheck.jar'),
    path.resolve(__dirname, '..', 'tools', 'epubcheck', 'epubcheck.jar'),
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || null;
}

// epubcheck localizes its summary line to the JVM default locale — a zh-TW JVM
// prints "訊息: 0 個致命錯誤 / 0 個錯誤 / …", which an English-only regex reads
// as "no counts found". Pin the locale so the summary is parseable everywhere,
// and report a parse failure (or a missing java) as such rather than letting it
// masquerade as a validation result.
function runEpubcheck(jar, epubPath) {
  let output = '';
  let spawnError = null;
  try {
    output = execFileSync('java', ['-Duser.language=en', '-Duser.country=US', '-jar', jar, epubPath],
      { stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    if (err.code === 'ENOENT') spawnError = 'java is not installed or not on PATH';
    output = `${err.stdout || ''}\n${err.stderr || ''}`;
  }
  const m = output.match(/Messages:\s*(\d+)\s*fatals?\s*\/\s*(\d+)\s*errors?\s*\/\s*(\d+)\s*warnings?/);
  if (!m) {
    return { parsed: false, problem: spawnError || 'could not parse epubcheck summary line', output };
  }
  return {
    parsed: true,
    fatals: Number(m[1]),
    errors: Number(m[2]),
    warnings: Number(m[3]),
    output,
  };
}

async function main() {
  console.log('Starting EPUB conformance spec tests...');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'reepub-conformance-'));

  try {
    // ------------------------------------------------- validator strictness
    section('Validator strictness');

    const goodDir = path.join(work, 'good');
    writeEpubDir(goodDir, {
      'index.xhtml': XHTML_WITH_BODY('ok', '<p>fine</p>'),
    });
    assert(validateEpub(goodDir).success === true,
      'sanity: a correct minimal EPUB directory still passes');

    const noBodyDir = path.join(work, 'no-body');
    writeEpubDir(noBodyDir, {
      'index.xhtml': XHTML_WITHOUT_BODY('broken', '<div><p>content floating under html</p></div>'),
    });
    const noBodyResult = validateEpub(noBodyDir);
    assert(noBodyResult.success === false,
      'an XHTML spine document with no <body> is REJECTED (shipped bug: 45 epubcheck errors passed as "valid")');

    const deadLinkDir = path.join(work, 'dead-link');
    writeEpubDir(deadLinkDir, {
      'toc.xhtml': XHTML_WITH_BODY('toc', '<p><a href="chapters/ch01.xhtml">Chapter 1</a></p>'),
    });
    assert(validateEpub(deadLinkDir).success === false,
      'an internal <a href> to a file missing from the EPUB is REJECTED (shipped bug: 15 dead TOC links passed as "valid")');

    const deadImgDir = path.join(work, 'dead-img');
    writeEpubDir(deadImgDir, {
      'index.xhtml': XHTML_WITH_BODY('img', '<p><img src="images/missing.png" alt="x"/></p>'),
    });
    assert(validateEpub(deadImgDir).success === false,
      'an internal <img src> to a missing file is REJECTED');

    const okLinkDir = path.join(work, 'ok-link');
    writeEpubDir(okLinkDir, {
      'toc.xhtml': XHTML_WITH_BODY('toc', '<p><a href="ch01.xhtml">Chapter 1</a> <a href="https://example.com/x">ext</a> <a href="#top">frag</a></p>'),
      'ch01.xhtml': XHTML_WITH_BODY('ch1', '<p>hi</p>'),
    });
    assert(validateEpub(okLinkDir).success === true,
      'resolvable relative links, external URLs and fragments are still accepted');

    // ------------------------------------------------- end-to-end pipeline
    section('End-to-end: buildWebEpub');

    let buildWebEpub = null;
    try {
      ({ buildWebEpub } = require('./web-to-epub'));
    } catch (err) {
      assert(false, `src/web-to-epub.js is implemented and exports buildWebEpub — ${err.code || err.message}`);
    }

    if (buildWebEpub) {
      const site = path.join(work, 'site');
      fs.mkdirSync(path.join(site, 'chapters'), { recursive: true });
      fs.mkdirSync(path.join(site, 'images'), { recursive: true });

      const chapterHtml = (h1, extra = '') => `<!DOCTYPE html>
<html><head><title>site</title><script src="app.js"></script></head>
<body>
<nav>MENU</nav>
<h1>${h1}</h1>
<p class="fw-box accent">card<br>line</p>
${extra}
<footer>footer</footer>
</body></html>`;

      // ch1 / ch2 / ch10: bare indices to force the numeric-ordering spec.
      fs.writeFileSync(path.join(site, 'chapters', 'ch1.html'),
        chapterHtml('Alpha &lt;一&gt; AT&T', '<img src="../images/big.png" alt="diagram">'));
      fs.writeFileSync(path.join(site, 'chapters', 'ch2.html'), chapterHtml('Beta'));
      fs.writeFileSync(path.join(site, 'chapters', 'ch10.html'), chapterHtml('Gamma'));

      const sharp = require('sharp');
      const w = 2400, h = 1200;
      const buf = Buffer.alloc(w * h * 3);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 3;
          buf[i] = (x * 3) % 256; buf[i + 1] = (y * 7) % 256; buf[i + 2] = (x ^ y) % 256;
        }
      }
      await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png()
        .toFile(path.join(site, 'images', 'big.png'));

      let missingRejected = false;
      try {
        await buildWebEpub({ srcDir: path.join(work, 'does-not-exist'), outputPath: path.join(work, 'x.epub'), title: 'x' });
      } catch (_) {
        missingRejected = true;
      }
      assert(missingRejected, 'a missing srcDir rejects instead of resolving');

      const outEpub = path.join(work, 'spec-book.epub');
      let built = false;
      try {
        await buildWebEpub({
          srcDir: site,
          outputPath: outEpub,
          title: 'Spec & Book',
          creator: 'Author A',
          translator: 'Translator B',
          language: 'zh-TW',
          classMap: { 'fw-box': 'reepub-box' },
          coverLayout: 'horizontal',
        });
        built = true;
      } catch (err) {
        assert(false, `buildWebEpub completes on the fixture site — ${err.message}`);
      }

      if (built) {
        assert(fs.existsSync(outEpub), 'the EPUB file is written to outputPath');
        assert(validateEpub(outEpub).success === true, 'the built EPUB passes the internal validator');

        const extracted = path.join(work, 'extracted');
        fs.mkdirSync(extracted);
        execFileSync('unzip', ['-q', outEpub, '-d', extracted]);

        const oebps = path.join(extracted, 'OEBPS');
        const allFiles = [];
        (function walk(d) {
          for (const f of fs.readdirSync(d)) {
            const p = path.join(d, f);
            fs.statSync(p).isDirectory() ? walk(p) : allFiles.push(p);
          }
        })(oebps);

        const ncxPath = allFiles.find(f => f.endsWith('.ncx'));
        const ncx = ncxPath ? fs.readFileSync(ncxPath, 'utf8') : '';
        const ai = ncx.indexOf('Alpha'), bi = ncx.indexOf('Beta'), gi = ncx.indexOf('Gamma');
        assert(ai !== -1 && bi !== -1 && gi !== -1 && ai < bi && bi < gi,
          `NCX lists chapters in numeric order ch1, ch2, ch10 (positions ${ai}, ${bi}, ${gi})`);
        assert(ncx.includes('AT&amp;T'), 'hostile chapter title is escaped in the NCX');

        const chapterXhtmls = allFiles.filter(f => f.endsWith('.xhtml') && !/cover/i.test(f));
        assert(chapterXhtmls.length >= 3, `found the chapter documents (got ${chapterXhtmls.length})`);
        const everyBody = chapterXhtmls.every(f => {
          const c = fs.readFileSync(f, 'utf8');
          return /<body[\s>]/.test(c) && c.includes('</body>');
        });
        assert(everyBody, 'every chapter document has a real <body> element');

        const bigOut = allFiles.find(f => f.endsWith('big.png'));
        if (bigOut) {
          const meta = await sharp(bigOut).metadata();
          assert(meta.width <= 1600 && meta.height <= 1600,
            `packaged images are dehydrated to <=1600px (got ${meta.width}x${meta.height})`);
        } else {
          assert(false, 'the chapter image big.png made it into the EPUB');
        }

        const coreCss = fs.readFileSync(path.resolve(__dirname, 'styles', 'reepub-core.css'), 'utf8');
        const defined = new Set([...coreCss.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));
        const used = new Set();
        for (const f of chapterXhtmls) {
          const c = fs.readFileSync(f, 'utf8');
          for (const m of c.matchAll(/class="([^"]*)"/g)) {
            m[1].split(/\s+/).filter(Boolean).forEach(cls => used.add(cls));
          }
        }
        const dead = [...used].filter(cls => !defined.has(cls));
        assert(dead.length === 0,
          `every class shipped in a chapter is defined in reepub-core.css (dead classes: ${JSON.stringify(dead)})`);

        const opfPath = allFiles.find(f => f.endsWith('content.opf'));
        const opf = opfPath ? fs.readFileSync(opfPath, 'utf8') : '';
        // The role must bind to the right NAME on the SAME element. Two
        // decoupled "appears somewhere in the file" checks would pass a build
        // that swapped the credits — the 原作者/譯者 inversion these assertions
        // exist to catch, and one epubcheck cannot see (any role is valid).
        assert(/opf:role="aut"[^>]*>\s*Author A\s*</.test(opf),
          'OPF credits the original author on an aut-role element');
        assert(/opf:role="trl"[^>]*>\s*Translator B\s*</.test(opf),
          'OPF credits the translator on a trl-role element');
        assert(!/opf:role="aut"[^>]*>\s*Translator B\s*</.test(opf) &&
               !/opf:role="trl"[^>]*>\s*Author A\s*</.test(opf),
          'author and translator credits are not swapped');
        const idMatch = opf.match(/urn:uuid:([0-9a-fA-F-]+)</);
        assert(idMatch && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idMatch[1]),
          'OPF identifier is a real UUID (regression: urn:uuid:book-of-elon-web)');

        // ------------------------------------------ the official verdict
        section('Official epubcheck');
        const jar = findEpubcheckJar();
        assert(!!jar,
          'epubcheck jar found ($REEPUB_EPUBCHECK_JAR, ~/.cache/reepub/epubcheck-5.1.0/, or tools/epubcheck/)');
        if (jar) {
          const res = runEpubcheck(jar, outEpub);
          assert(res.parsed === true,
            `epubcheck ran and its summary was parsed (${res.parsed ? 'ok' : res.problem})`);
          if (res.parsed) {
            assert(res.fatals === 0 && res.errors === 0,
              `epubcheck reports 0 fatals / 0 errors (got ${res.fatals} fatals / ${res.errors} errors)`);
            assert(res.warnings === 0,
              `epubcheck reports 0 warnings (got ${res.warnings})`);
            if (res.fatals !== 0 || res.errors !== 0 || res.warnings !== 0) {
              console.error('--- epubcheck output (truncated) ---');
              console.error(res.output.split('\n').slice(0, 25).join('\n'));
            }
          } else {
            console.error('--- epubcheck output (truncated) ---');
            console.error(res.output.split('\n').slice(0, 15).join('\n'));
          }
        }
      }

      // ------------------------------------------- never log-and-ship
      // The shipped bug was `buildFromWeb().catch(console.error)`: validation
      // failed, the message was logged, the broken file stayed on disk and the
      // process exited 0. A happy-path-only suite cannot catch that, so force
      // an invalid product and require a rejection.
      section('Failure path: never log-and-ship');
      const badSite = path.join(work, 'bad-site');
      fs.mkdirSync(path.join(badSite, 'chapters'), { recursive: true });
      fs.mkdirSync(path.join(badSite, 'images'), { recursive: true });
      // References an image that does not exist in srcDir/images: the finished
      // EPUB would carry a dead <img src>, which the stricter validator rejects.
      fs.writeFileSync(path.join(badSite, 'chapters', 'ch1.html'),
        `<!DOCTYPE html><html><head><title>s</title></head><body>
<h1>Broken</h1><p><img src="../images/nonexistent.png" alt="missing"></p>
</body></html>`);

      const badOut = path.join(work, 'bad-book.epub');
      let rejected = false;
      let rejectErr = null;
      try {
        await buildWebEpub({
          srcDir: badSite,
          outputPath: badOut,
          title: 'Broken Book',
          creator: 'Author A',
          language: 'zh-TW',
          classMap: {},
          coverLayout: 'horizontal',
        });
      } catch (err) {
        rejected = true;
        rejectErr = err;
      }
      assert(rejected,
        'buildWebEpub REJECTS when the finished EPUB fails validation (never logs and resolves)');
      assert(!rejected || !/^\s*$/.test(String(rejectErr && rejectErr.message || '')),
        'the rejection carries a diagnostic message');
      assert(!fs.existsSync(badOut),
        'no broken .epub is left behind at outputPath after a failed build');
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  if (failures === 0) {
    console.log('\n[SUCCESS] All conformance spec tests passed!');
    process.exit(0);
  } else {
    console.error(`\n[FAILURE] ${failures} conformance spec test(s) failed.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected test-runner error:', err);
  process.exit(1);
});
