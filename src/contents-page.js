// Recognise a book's own table-of-contents page, and give it back its links.
//
// Ebooks routinely carry a contents page that is just text: a list of chapter
// titles with nothing to tap. The reader's own table of contents works, so
// nobody notices the page in the book is dead.
//
// Detecting one does not need a heuristic, because the book already declared
// the answer. Its navigation lists every chapter's label, so the question
// "is this page a table of contents?" becomes "are this page's lines the
// navigation's own labels?" — measured against the real thing rather than
// against an idea of what a contents page looks like. On a real library the
// two populations do not overlap: contents pages score 100%, chapters score
// 0–1%.
//
// And the same declaration that identifies the page also says where each title
// leads, so restoring the links is a lookup rather than a guess.

const cheerio = require('cheerio');

// A page has to be almost entirely navigation labels to count. The margin
// exists for the title line and the odd "附錄" the navigation omits — not to
// let a chapter that happens to quote a few headings through.
const LABEL_SHARE = 0.8;
// Below this there is not enough of a list to be sure of anything.
const MIN_LINES = 3;

/** The text of each line of a document, with <br> treated as the break it is. */
function linesOf($) {
  const body = $('body').length ? $('body') : $.root();
  body.find('br').replaceWith('\n');
  return body.text().split('\n').map(s => s.trim()).filter(Boolean);
}

function normalize(text) {
  return String(text).replace(/\s+/g, '');
}

/**
 * Score one document against the book's navigation.
 *
 * labels: Map of normalized label text -> href the navigation gives it.
 * Returns { isContents, lines, matched, share }.
 */
function inspect(source, labels) {
  const $ = cheerio.load(source, { xmlMode: true, decodeEntities: false });
  const lines = linesOf($);
  if (lines.length < MIN_LINES) {
    return { isContents: false, lines: lines.length, matched: 0, share: 0 };
  }
  const matched = lines.filter(line => labels.has(normalize(line))).length;
  const share = matched / lines.length;
  return { isContents: share >= LABEL_SHARE, lines: lines.length, matched, share };
}

/**
 * Wrap every line that names a chapter in a link to it.
 *
 * Lines the navigation does not know are left exactly as they were — a title,
 * a note, an appendix the book never listed. A line already inside a link is
 * left alone too: the page was not broken in the first place.
 *
 * Returns { xhtml, linked } — linked is how many titles became links.
 */
function relink(source, labels) {
  const $ = cheerio.load(source, { xmlMode: true, decodeEntities: false });
  let linked = 0;

  // Text nodes are the unit: a contents page separates its titles with <br/>,
  // so the titles are siblings inside one element rather than elements of
  // their own, and replacing whole elements would swallow the separators.
  const body = $('body').length ? $('body') : $.root();
  for (const node of body.find('*').addBack().contents().toArray()) {
    if (node.type !== 'text') continue;
    const text = node.data;
    if (!text || !normalize(text)) continue;
    const href = labels.get(normalize(text));
    if (!href) continue;
    if ($(node).parents('a').length) continue;

    const leading = text.match(/^\s*/)[0];
    const trailing = text.match(/\s*$/)[0];
    $(node).replaceWith(`${leading}<a href="${href}">${$('<x>').text(text.trim()).html()}</a>${trailing}`);
    linked++;
  }

  return { xhtml: linked ? $.xml() : source, linked };
}

module.exports = { inspect, relink, normalize, LABEL_SHARE };
