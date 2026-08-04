// Break a title into the lines a cover would set it in.
//
// Not "where does it happen to fit" — where a typesetter would put the break.
// The rule is short enough to state, and it reproduces the covers of real
// books without knowing anything about what they mean:
//
//   Give every word its own line. Then any line made only of weak words —
//   articles, prepositions, conjunctions — is merged into its neighbour.
//
//   THE BOOK OF ELON   THE·BOOK·OF·ELON   →  THE BOOK OF / ELON
//   ZERO TO ONE        ZERO·TO·ONE        →  ZERO TO / ONE
//   BUY BACK YOUR TIME BUY·BACK·YOUR·TIME →  BUY / BACK / YOUR / TIME
//   THINKING FAST AND SLOW                →  THINKING / FAST AND / SLOW
//
// The last two are what settle the word list. "YOUR" keeps its own line
// because a possessive carries the message — "buy back YOUR time" — while
// "OF" never starts a line in English typography and never has. So the list
// holds articles, prepositions and conjunctions, and nothing else.
//
// Once each line is justified to the same width, emphasis falls out of the
// structure rather than being applied to it: the short line is the one that
// has to grow. THE BOOK OF is eleven characters and ELON is four, so ELON
// ends up three times the size without anyone deciding that it should.
//
// English only, deliberately. A French or Spanish list is a different set of
// words and belongs to whoever reads those covers.

const WEAK_WORDS = new Set([
  // articles
  'a', 'an', 'the',
  // prepositions
  'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'off', 'on', 'onto',
  'out', 'over', 'to', 'up', 'upon', 'with', 'within', 'without',
  // conjunctions
  'and', 'but', 'nor', 'or', 'so', 'yet',
]);

// A title with no spaces is set by character, not by word: Chinese and
// Japanese have no word gaps to break at, and a rule about articles has
// nothing to say about them.
function isWordBroken(title) {
  return /\s/.test(String(title).trim());
}

function stripped(word) {
  return word.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

function allWeak(line) {
  return line.every(word => WEAK_WORDS.has(stripped(word)));
}

/**
 * The lines of an English title.
 *
 * maxLines caps the result — a long title one word per line is a column of
 * type too tall for any cover, so lines are merged back together, always at
 * the join that leaves the most even pair, until it fits.
 */
function setEnglishTitle(title, maxLines = Infinity) {
  const words = String(title).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  let lines = words.map(word => [word]);

  // A line that is nothing but weak words has no anchor of its own. It joins
  // the line before it, or — having none — the line after.
  for (let i = 0; i < lines.length; i++) {
    if (lines.length === 1 || !allWeak(lines[i])) continue;
    if (i === 0) {
      lines[1] = lines[0].concat(lines[1]);
      lines.splice(0, 1);
      i = -1;
    } else {
      lines[i - 1] = lines[i - 1].concat(lines[i]);
      lines.splice(i, 1);
      i = -1;
    }
  }

  // Too many lines: merge the neighbours whose combined length is smallest,
  // which keeps the block as even as the words allow.
  while (lines.length > maxLines) {
    let best = 0;
    let bestLength = Infinity;
    for (let i = 0; i < lines.length - 1; i++) {
      const length = lines[i].join(' ').length + lines[i + 1].join(' ').length;
      if (length < bestLength) { bestLength = length; best = i; }
    }
    lines[best] = lines[best].concat(lines[best + 1]);
    lines.splice(best + 1, 1);
  }

  return lines.map(line => line.join(' '));
}

// The one place a CJK title has a break in it.
//
// A full-width colon or an em-dash pair does not join two halves of a phrase —
// it separates a title from its subtitle, and that is where every printed cover
// breaks. Everything else in Chinese and Japanese runs without gaps.
const CJK_SUBTITLE_SEPARATOR = /^(.+?)\s*(?:：|——)\s*(.+)$/;

/**
 * A CJK title split into title and subtitle, or null if it is one phrase.
 */
function splitCJKSubtitle(title) {
  const m = CJK_SUBTITLE_SEPARATOR.exec(String(title).trim());
  if (!m) return null;
  const head = m[1].trim();
  const tail = m[2].trim();
  return head && tail ? [head, tail] : null;
}

/**
 * How a title should be set, or nothing.
 *
 * Returns the lines for an English title, and null for a CJK title that is one
 * phrase. That null is the point: justifying each line to the same width means
 * scaling the lines differently from one another, and Chinese and Japanese type
 * does not want that — every glyph is one em wide, so a block of it is already
 * square, and setting one line larger than the next would look like a mistake
 * rather than a decision. Such a title is left to wrap where the renderer wraps
 * it, at one size throughout.
 *
 * A title and a subtitle are the exception, and they are not a counter-example
 * to that rule — they are a different thing being set. `納瓦爾年鑑：財富與快樂指南`
 * wrapped by measure alone breaks as `年鑑：財 / 富與快 / 樂指南`: the colon
 * lands at a line end and `財富` and `快樂` are each split down the middle.
 * Splitting at the separator instead gives two lines that mean something, and
 * the size difference that falls out of justifying them is the hierarchy a
 * cover wants rather than an accident — a five-character title over a
 * seven-character subtitle sets the title larger, which is what it is.
 */
function setTitle(title, { maxLines = Infinity } = {}) {
  if (isWordBroken(title)) return setEnglishTitle(title, maxLines);
  return splitCJKSubtitle(title);
}

module.exports = { setTitle, setEnglishTitle, splitCJKSubtitle, isWordBroken, WEAK_WORDS };
