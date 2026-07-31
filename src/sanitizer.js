// Sanitizer: turn one chapter of a source website into an EPUB content
// document. A web page and a book share nothing but their text — menus,
// animation hooks and theme-specific inline styles have no meaning (and no
// stylesheet) inside an EPUB — so nothing survives here unless
// src/styles/reepub-core.css can actually render it.
//
// The whole transform happens on the parse tree and is serialized once, by
// cheerio's XML renderer. No regex ever touches the output. The previous
// pipeline (scripts/build-elon-from-web.js) did the opposite: it serialized a
// *selection* — which cheerio renders in HTML mode, leaving <br>, <hr> and
// <img> unclosed — then tried to repair the string with five regexes,
// including /<img([^>]+[^\/])>/ which mangles any tag whose attribute value
// contains '>'. It also stripped the <body> it had just serialized and never
// re-added it, shipping 15 chapters of content directly under <html>
// (45 epubcheck errors). Serializing the whole document instead makes both
// classes of defect impossible: the parser owns the structure, the serializer
// owns the syntax.

const path = require('path');
const cheerio = require('cheerio');

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

// EPUB 2.0.1 content documents are XHTML 1.1: epubcheck rejects any other
// DOCTYPE — including the HTML5 one and no DOCTYPE at all — with HTM-004.
// EPUB 3 demands exactly the opposite ("<!DOCTYPE html>"), so this constant
// tracks the package version src/binder.js writes; today that is 2.0.
const XHTML11_DOCTYPE =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">';

// Site furniture: menu, footer, behaviour, and the site's own chapter pager
// (whose links point at .html pages that do not exist inside the book).
const CHROME_SELECTOR = 'nav, footer, script, style, .ch-nav';

// XHTML 1.1 allows block-level children in <body> only, so a bare <img> or a
// loose sentence at the top level is a validation error (RSC-005) even though
// the HTML parser happily accepts it. Anything not listed here is wrapped.
const BODY_BLOCK_ELEMENTS = new Set([
  'address', 'blockquote', 'del', 'div', 'dl', 'fieldset', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'ins', 'noscript',
  'ol', 'p', 'pre', 'table', 'ul',
]);

// The Book of Elon web edition -> reepub. Every value here has a rule in
// src/styles/reepub-core.css; every site class missing from this table is
// dropped, which is how fade-up / accent / cyan / container / content-section
// stop shipping with no stylesheet behind them. Callers pass this in as
// opts.classMap — sanitizeChapter never applies it implicitly, because a
// chapter from some other site must not silently inherit this site's table.
const DEFAULT_CLASS_MAP = Object.freeze({
  'ch-badge': 'reepub-badge',
  'ch-oneliner': 'reepub-quote',
  'section-label': 'reepub-section-label',
  'story-block': 'reepub-section-quote',
  'key-points': 'reepub-key-points',
  'quote-block': 'reepub-quote-block',
  'quote-en': 'reepub-quote-en',
  'quote-zh': 'reepub-quote-zh',
  'diagram-container': 'reepub-diagram',
  'diagram-title': 'reepub-diagram-title',
  'fw-row': 'reepub-row',
  'fw-box': 'reepub-box',
  'fw-arrow': 'reepub-arrow',
  'fw-label': 'reepub-caption',
  'takeaway': 'reepub-highlight',
  'label': 'reepub-section-label',
});

// There is no safe default for these: a guessed language mislabels the whole
// book, a guessed stylesheet path ships it unstyled, and a guessed title lands
// in the table of contents. Fail at the boundary instead.
function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`sanitizeChapter: ${name} is required (got ${JSON.stringify(value)})`);
  }
  return value;
}

// Translate one element's class attribute. A class survives only as a
// classMap value or as an explicitly allowed class, so a chapter can never
// ship a hook with no CSS behind it.
function translateClasses($el, classMap, survivors) {
  const raw = $el.attr('class');
  if (raw === undefined) return;

  const kept = new Set();
  for (const cls of raw.split(/\s+/)) {
    if (!cls) continue;
    const mapped = classMap.get(cls);
    if (mapped !== undefined) kept.add(mapped);
    else if (survivors.has(cls)) kept.add(cls);
  }

  if (kept.size > 0) $el.attr('class', [...kept].join(' '));
  else $el.removeAttr('class');
}

// Group each run of loose (non-block) children of <body> into one <div>, so
// the document satisfies the XHTML 1.1 body content model whatever the site
// markup looked like.
function wrapLooseBodyContent($) {
  const $body = $('body');
  let $block = null;
  let $run = null;

  $body.contents().each((_, node) => {
    if (node.type === 'tag' && BODY_BLOCK_ELEMENTS.has(node.name)) {
      $block = $(node);
      $run = null;
      return;
    }
    // Whitespace between blocks is left where it is; whitespace inside a run
    // joins it, so inline neighbours keep their spacing.
    if (node.type === 'text' && !/\S/.test(node.data) && !$run) return;
    if (!$run) {
      // The wrapper is placed relative to the last block element, never
      // relative to the loose node itself: cheerio's .before() is a silent
      // no-op on a text node, which would orphan the whole run.
      $run = $('<div></div>');
      if ($block) $block.after($run);
      else $body.prepend($run);
    }
    $run.append(node);
  });
}

// sanitizeChapter(rawHtml, opts) -> { xhtml, title }
//   lang               xml:lang / lang for the document        (required)
//   cssHref            stylesheet href, relative to the doc    (required)
//   fallbackTitle      title for a chapter with no <h1>        (required)
//   classMap           { siteClass: reepubClass } translation table
//   allowedClasses     classes permitted to survive untranslated
//   imagePathRewrites  { fromPrefix: toPrefix } for <img src>
// Anything omitted from classMap/allowedClasses is stripped, and anything
// omitted from imagePathRewrites is left alone: the defaults remove, never add.
function sanitizeChapter(rawHtml, opts) {
  if (typeof rawHtml !== 'string') {
    throw new TypeError(`sanitizeChapter: rawHtml must be a string (got ${typeof rawHtml})`);
  }
  const o = opts || {};
  const lang = requiredString(o.lang, 'opts.lang');
  const cssHref = requiredString(o.cssHref, 'opts.cssHref');
  const fallbackTitle = requiredString(o.fallbackTitle, 'opts.fallbackTitle');
  // Map/Set rather than the caller's raw objects: a site class named
  // 'constructor' or '__proto__' must not inherit a value from Object.prototype.
  const classMap = new Map(Object.entries(o.classMap || {}));
  const survivors = new Set([...classMap.values(), ...(o.allowedClasses || [])]);
  // Longest prefix first, so overlapping rewrites ('../images/' and '../') are
  // decided by specificity rather than by object key order.
  const imageRewrites = Object.entries(o.imagePathRewrites || {})
    .sort((a, b) => b[0].length - a[0].length);

  const $ = cheerio.load(rawHtml);

  $(CHROME_SELECTOR).remove();

  // The chapter title comes from the content, never from the site's <title>
  // (which carries the site name). .text() decodes entities and the serializer
  // re-escapes them on the way out, so the title is never spliced into markup
  // by hand — the regression that let a raw '<' in an <h1> break the document.
  const title = $('h1').first().text().trim() || fallbackTitle;

  // Comments carry no book content and one containing '--' is illegal XML;
  // the source DOCTYPE is replaced by ours below.
  const isNoise = (_, node) => node.type === 'comment' || node.type === 'directive';
  $.root().contents().filter(isNoise).remove();
  $('*').contents().filter(isNoise).remove();

  $('*').each((_, el) => {
    const $el = $(el);
    translateClasses($el, classMap, survivors);
    // Inline styles are written for the site's own dark theme: custom
    // properties that do not exist in the book, flex gaps that do nothing once
    // .reepub-row stacks, and min-widths that overflow an e-ink page. Event
    // handlers cannot run in a reader and would make the document scripted.
    for (const name of Object.keys(el.attribs || {})) {
      if (name === 'style' || name.startsWith('on')) $el.removeAttr(name);
    }
  });

  $('img[src]').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src');
    for (const [from, to] of imageRewrites) {
      if (src.startsWith(from)) {
        $el.attr('src', to + src.slice(from.length));
        break;
      }
    }
  });

  wrapLooseBodyContent($);

  // Every child of <body> is now block-level; XHTML 1.1 also wants at least
  // one of them. An empty body is "element body incomplete" to epubcheck —
  // the same defect class as the missing <body> this module exists to
  // prevent — so a chapter that sanitized down to nothing is refused here,
  // where the cause is still known, instead of at packaging time.
  if ($('body').children().length === 0) {
    throw new Error('sanitizeChapter: nothing survived sanitization — the chapter has no content');
  }

  // <html>, <head> and <body> exist because the HTML parser guarantees them —
  // exactly one of each, whatever the source did.
  $('html').attr('xmlns', XHTML_NS).attr('xml:lang', lang).attr('lang', lang);

  // The head is rebuilt, not edited: the site's title, stylesheets and meta are
  // all chrome. Values go in through .text()/.attr(), so escaping stays the
  // serializer's job.
  const $head = $('head').empty();
  $head.append('<title></title>').append('<link rel="stylesheet" type="text/css"/>');
  $head.find('title').text(title);
  $head.find('link').attr('href', cssHref);

  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>\n${XHTML11_DOCTYPE}\n${$.xml()}\n`;
  return { xhtml, title };
}

// sortChapterFiles(names) -> a new array ordered by the number in each name.
// Plain .sort() is lexicographic, so 'ch10.html' lands before 'ch2.html' and a
// book silently ships out of order; the shipped build only survived because its
// filenames happened to be zero-padded. A name with no number is refused rather
// than parked at an arbitrary position.
function sortChapterFiles(names) {
  if (!Array.isArray(names)) {
    throw new TypeError(`sortChapterFiles: names must be an array (got ${typeof names})`);
  }

  const indexed = names.map(name => {
    const found = /(\d+)/.exec(path.basename(String(name)));
    if (!found) {
      throw new Error(`sortChapterFiles: ${JSON.stringify(name)} carries no chapter index`);
    }
    return { name, index: Number(found[1]) };
  });

  // Equal indices ('ch1.html' and 'ch01.html') keep a deterministic order
  // instead of depending on the platform's sort stability.
  indexed.sort((a, b) => a.index - b.index || String(a.name).localeCompare(String(b.name)));
  return indexed.map(entry => entry.name);
}

module.exports = { sanitizeChapter, sortChapterFiles, DEFAULT_CLASS_MAP };
