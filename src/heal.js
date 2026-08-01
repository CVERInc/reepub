// Repair one EPUB.
//
// Usage:
//   node src/heal.js [options] <input.epub> <output.epub>
//
// Ebooks in the wild are broken in ways their owners never see: a reader that
// tolerates the damage shows the book anyway, so the rot only surfaces when
// something strict — another reader, a store, a validator — refuses it. Every
// volume of a real Traditional-Chinese library we tested carries four epubcheck
// errors of its own.
//
// This command repairs what it can recognize and says exactly what it changed.
// It never edits in place: the input is read, the repaired book is written
// somewhere new, and a repair that cannot be verified is not shipped.
//
// It is deliberately the same engine as src/merge.js rather than a second
// implementation of the same repairs — see that file's exports.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cheerio = require('cheerio');
const {
  readVolume,
  createResourcePool,
  relocateChapter,
  writeEpub,
  EPUB_VERSION,
  LANGUAGE_FALLBACK,
  COVER_IMAGE,
} = require('./merge');
const { validateEpub } = require('./validator');
const { generateCover, layoutForDirection } = require('./cover-generator');
const contentsPage = require('./contents-page');

const HELP = `reepub heal — repair a broken EPUB.

Usage:
  node src/heal.js [options] <input.epub> <output.epub>

Options:
  --title <title>     Override the title (default: the book's own)
  --author <author>   Override the author (default: the book's own)
  --translator <name> Credit a translator. The original author leads and the
                      translator follows: dc:creator with the aut relator and
                      dc:contributor with trl, and on the cover a smaller line
                      under the author.
  --cover             Draw a new cover, replacing whatever the book had.
                      The layout follows the book's reading direction:
                      right-to-left gets the vertical cover, everything else
                      the horizontal one. Without this flag the book keeps the
                      cover it came with.
  --no-validate       Skip validation of the repaired book
  -h, --help          Show this help

What it repairs:
  · an EPUB 2 package whose spine carries page-progression-direction, which is
    an EPUB 3 attribute — the book is rebuilt as EPUB 3, so a vertical
    right-to-left series keeps its reading direction and becomes valid
  · a table of contents whose identifier disagrees with the package
  · chapters still declaring the XHTML 1.1 doctype, with the entities that
    doctype defined (&nbsp;, &mdash;) rewritten as numeric references
  · stylesheet rules resting on a resource that cannot load, such as an
    @font-face pointing into an Android device's font directory
  · references left dangling by the original packager, and files it declared
    but no chapter uses

Everything removed or rewritten is printed. Nothing is repaired by guessing:
an entity or a reference reepub cannot resolve stops the run.`;

function fail(message) {
  throw new Error(`heal: ${message}`);
}

function parseArgs(args) {
  const options = { title: '', author: '', translator: '', cover: false, validate: true, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--title' && i + 1 < args.length) { options.title = args[++i]; continue; }
    if (arg === '--author' && i + 1 < args.length) { options.author = args[++i]; continue; }
    if (arg === '--translator' && i + 1 < args.length) { options.translator = args[++i]; continue; }
    if (arg === '--cover') { options.cover = true; continue; }
    if (arg === '--no-validate') { options.validate = false; continue; }
    if (arg.startsWith('-')) fail(`unknown option ${arg} (see --help)`);
    options.positional.push(arg);
  }
  return options;
}

const LEGACY_DOCTYPE = /<!DOCTYPE\s+html\s+PUBLIC/i;

/**
 * A cover page is furniture, not content: one <img> and nothing to read. The
 * repaired book writes a fresh one, so the original is taken out of the reading
 * order first — otherwise the book opens on two covers in a row.
 *
 * Only a document that shows the declared cover image and carries no text
 * qualifies. A first chapter that merely happens to open with a picture stays
 * exactly where it is.
 */
function isCoverPage(book, chapter) {
  if (!book.coverImagePath) return false;
  const abs = path.join(book.root, chapter.path);
  if (!fs.existsSync(abs)) return false;

  const source = fs.readFileSync(abs, 'utf8');
  const $ = cheerio.load(source, { xmlMode: true, decodeEntities: false });
  if ($('body').text().replace(/\s+/g, '') !== '') return false;

  const coverName = path.posix.basename(book.coverImagePath);
  return $('img, image').toArray().some(el => {
    const ref = $(el).attr('src') || $(el).attr('xlink:href') || '';
    return path.posix.basename(decodeURIComponent(ref)) === coverName;
  });
}

/**
 * What is wrong with this book, stated in terms of what the repair will do.
 * Diagnosis is separate from repair so the report describes the book the user
 * handed over, not the one that came back.
 */
function diagnose(book) {
  const findings = [];

  if (book.version && book.version !== EPUB_VERSION && book.pageDirection) {
    findings.push(`EPUB ${book.version} spine carried page-progression-direction → rebuilt as EPUB ${EPUB_VERSION}`);
  }

  if (book.ncxPath) {
    const ncxPath = path.join(book.root, book.ncxPath);
    if (fs.existsSync(ncxPath)) {
      const uid = (fs.readFileSync(ncxPath, 'utf8')
        .match(/<meta\s[^>]*name="dtb:uid"[^>]*content="([^"]*)"/i) || [, ''])[1].trim();
      if (uid && book.identifier && uid !== book.identifier) {
        findings.push('table of contents identifier disagreed with the package → unified');
      }
    }
  }

  const legacy = book.chapters.filter(ch => {
    const abs = path.join(book.root, ch.path);
    return fs.existsSync(abs) && LEGACY_DOCTYPE.test(fs.readFileSync(abs, 'utf8'));
  }).length;
  if (legacy > 0) {
    findings.push(`${legacy} chapter${legacy === 1 ? '' : 's'} declared the XHTML 1.1 doctype → <!DOCTYPE html>`);
  }

  return findings;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  const options = parseArgs(args);
  if (options.positional.length !== 2) {
    fail('need exactly one input EPUB and one output path (see --help)');
  }

  const inputPath = path.resolve(options.positional[0]);
  const outputPath = path.resolve(options.positional[1]);
  if (!fs.existsSync(inputPath)) fail(`file not found: ${inputPath}`);
  if (!fs.existsSync(path.dirname(outputPath))) {
    fail(`the output directory does not exist: ${path.dirname(outputPath)}`);
  }
  if (path.resolve(inputPath) === path.resolve(outputPath)) {
    fail('healing never edits in place — give the repaired book its own path');
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'reepub-heal-'));
  try {
    console.log(`Healing ${path.basename(inputPath)} → ${path.basename(outputPath)}`);

    const book = readVolume(inputPath, path.join(scratch, 'book-in'), { dropTableOfContents: false });
    console.log(`  ${book.title || '(untitled)'} — ${book.chapters.length} documents`);

    const findings = diagnose(book);

    // The cover the book already has is kept. Losing the declaration that says
    // "this image is the cover" leaves the file in the container and the book
    // blank on the shelf, which is a repair nobody asked for.
    let coverImagePath = book.coverImagePath
      ? path.join(book.root, book.coverImagePath)
      : null;
    if (coverImagePath && !fs.existsSync(coverImagePath)) {
      findings.push(`the declared cover image is missing from the book (${book.coverImagePath}) → dropped the declaration`);
      coverImagePath = null;
    }
    // The cover page the book arrived with is furniture the rebuild replaces,
    // whether the image is being kept or redrawn.
    const coverPage = coverImagePath && book.chapters.find(ch => isCoverPage(book, ch));
    if (coverPage) book.chapters = book.chapters.filter(ch => ch !== coverPage);

    const coverTitle = options.title || book.title || path.basename(inputPath, '.epub');
    const coverAuthor = options.author || book.creator;
    if (options.cover) {
      const layout = layoutForDirection(book.pageDirection);
      console.log(`  drawing a new ${layout} cover…`);
      coverImagePath = path.join(scratch, COVER_IMAGE);
      await generateCover(coverTitle, coverAuthor, coverImagePath,
        { pageDirection: book.pageDirection, translator: options.translator });
    }

    book.hrefByPath = new Map();
    book.chapters.forEach((chapter, i) => {
      book.hrefByPath.set(chapter.path, `${i + 1}.xhtml`);
    });

    const pool = createResourcePool();
    // The repaired book writes its cover to images/cover.jpeg, so that name is
    // claimed before any chapter image can be allocated it.
    if (coverImagePath) pool.reserve(COVER_IMAGE);
    // Where each chapter title leads, in the repaired book. The same table
    // identifies a contents page and gives its lines their links back.
    //
    // A title the navigation gives to two different documents cannot be
    // resolved — this library has volumes whose navigation labels two separate
    // pages with the book's own name — so it is dropped rather than linked to
    // whichever one happened to be read last.
    const labels = new Map();
    const ambiguous = new Set();
    for (const chapter of book.chapters) {
      const href = book.hrefByPath.get(chapter.path);
      if (!chapter.title || !href) continue;
      const key = contentsPage.normalize(chapter.title);
      if (labels.has(key) && labels.get(key) !== href) ambiguous.add(key);
      labels.set(key, href);
    }
    for (const key of ambiguous) labels.delete(key);

    let bodiesRepaired = 0;
    let contentsPages = 0;
    let linksRestored = 0;
    const chapters = book.chapters.map(chapter => {
      const relocated = relocateChapter(chapter, book, pool);
      if (relocated.bodyRepaired) bodiesRepaired++;

      let content = relocated.content;
      if (contentsPage.inspect(content, labels).isContents) {
        contentsPages++;
        const restored = contentsPage.relink(content, labels);
        content = restored.xhtml;
        linksRestored += restored.linked;
      }

      return {
        href: book.hrefByPath.get(chapter.path),
        title: relocated.title,
        content,
      };
    });
    if (bodiesRepaired > 0) {
      findings.push(`${bodiesRepaired} document${bodiesRepaired === 1 ? '' : 's'} had content sitting outside <body> → wrapped`);
    }
    if (linksRestored > 0) {
      findings.push(`the book's own contents page listed ${linksRestored} chapters with nothing to tap → linked`);
    }
    // Reported, not removed. A second contents page is the publisher's
    // duplicate, and deleting a page of someone's book is their call.
    if (contentsPages > 1) {
      findings.push(`note: this book carries ${contentsPages} contents pages of its own — left as they are`);
    }

    for (const note of findings) console.log(`  healed: ${note}`);
    for (const note of pool.healed()) console.log(`  healed: dropped ${note}`);
    if (findings.length === 0 && pool.healed().length === 0) {
      console.log('  nothing to heal — the book was already sound');
    }

    writeEpub(outputPath, path.join(scratch, 'book-out'), {
      title: coverTitle,
      author: coverAuthor,
      translator: options.translator,
      language: book.language || LANGUAGE_FALLBACK,
      pageDirection: book.pageDirection,
      chapters,
      pool,
      coverImagePath,
    });

    const sizeKb = (fs.statSync(outputPath).size / 1024).toFixed(0);
    console.log(`  ✓ ${path.basename(outputPath)} (${sizeKb} KB)`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  if (options.validate) {
    const result = validateEpub(outputPath);
    if (!result.success) {
      // A repair that cannot be verified is not a repair. The unverifiable
      // artifact goes, so nothing downstream mistakes it for a healed book.
      fs.rmSync(outputPath, { force: true });
      fail(`the repaired book did not validate — ${result.error}`);
    }
    console.log('  ✓ EPUB valid');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

module.exports = { diagnose };
