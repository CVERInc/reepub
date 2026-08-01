// sync-marker: v1
// Pure, side-effect-free text/EPUB helpers shared by the CLI builder and its
// unit tests. Kept behaviorally in sync with macos/Sources/ReepubCore/EpubBuilder.swift
// (joinText / processPage / XML escaping; structureChapters lives in builder.js).
// scripts/check-sync-markers.mjs re-derives the break-punctuation set, the heading
// length metric, the paragraph-geometry thresholds and the escape table from BOTH
// sources on every CI run, so a divergence fails the build instead of silently
// making one PDF produce two different books. No I/O here so the heuristics can be
// exercised headlessly.

// Escape text destined for XML/XHTML *element content*: &, <, > must all be
// encoded. Encoding only & (the previous behavior) left raw < / > in OCR'd
// headings and user-supplied titles, producing malformed XML that the validator
// then rejected — so a perfectly legitimate title like "A <B>" failed to build.
function escapeXML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Escape text destined for an XML *attribute value* (e.g. alt="..."). On top of
// element-content escaping, a double quote would close the attribute early, so
// it must be encoded too.
function escapeAttr(s) {
  return escapeXML(s).replace(/"/g, '&quot;');
}

// cheerio serialises every non-ASCII character as a numeric reference, so one
// Chinese character leaves as eight bytes of "&#x6d3b;" and a chapter comes out
// with not a single readable glyph in it. The file is well-formed and epubcheck
// is happy, which is exactly why this survived: it is only visible if you look
// at the bytes, and no EPUB that works on a device looks like this.
//
// Only the escapes cheerio added are undone — anything below U+0080 stays as it
// is, so &#38; and the five XML specials are never handed back their literal
// character and never break the markup they sit in.
function decodeNonAsciiRefs(xml) {
  return xml.replace(/&#(?:x([0-9a-fA-F]+)|([0-9]+));/g, (ref, hex, dec) => {
    const code = hex ? parseInt(hex, 16) : parseInt(dec, 10);
    if (!Number.isFinite(code) || code < 0x80 || code > 0x10ffff) return ref;
    return String.fromCodePoint(code);
  });
}

// The one way this codebase turns a cheerio document back into a file.
function serializeXml($) {
  return decodeNonAsciiRefs($.xml());
}

// A Kindle silently refuses to show the cover or the table of contents of a
// book whose text contains pictographic emoji. Not the chapter with the emoji
// in it — the whole book. It opens on page one with no cover and no way to
// navigate, and nothing anywhere says why: the file is valid EPUB 3, epubcheck
// passes it clean, and the reading text renders fine.
//
// This was found by bisection over 40-odd builds on the device. The evidence:
// the complete book with 222 emoji removed and nothing else changed shows its
// cover; the same book truncated to just before the first emoji shows its
// cover; every variant that kept the emoji — however the markup was flattened,
// whatever was stripped from the stylesheet, the images, the classes — did not.
//
// Only the pictographs go. The range stops short of U+20000, where CJK
// Extension B lives: 鹿鼎記 carries 𡒉 twelve times and displays perfectly, so
// "astral plane" is not the problem and a book must never lose a character of
// its own language to this. Arrows, bullets, ticks and dashes stay too —
// 賈伯斯傳 has 241 bullets and is fine — which matters because a diagram made
// of boxes and arrows still reads as a diagram once the decorative icon in its
// heading is gone.
const PICTOGRAPH = /[\u{1F000}-\u{1FAFF}]\u{FE0F}?/u;
const PICTOGRAPH_RUN = /\s*(?:[\u{1F000}-\u{1FAFF}]\u{FE0F}?)+\s*/gu;

function countPictographs(text) {
  return (String(text).match(new RegExp(PICTOGRAPH, 'gu')) || []).length;
}

// "🧠 概念圖解" becomes "概念圖解", not " 概念圖解": an icon at the head of a
// label takes its separating space with it. One that sat between words keeps a
// single space, so the words on either side do not run together.
function stripPictographs(text) {
  return String(text).replace(PICTOGRAPH_RUN, (run) => {
    const spaceBefore = /^\s/.test(run);
    const spaceAfter = /\s$/.test(run);
    return spaceBefore && spaceAfter ? ' ' : '';
  });
}

// Take the pictographs out of a parsed document: every text node, plus the two
// attributes a reader can be shown. Parsing first is what makes this reliable —
// an emoji written as &#x1f9e0; is plain ASCII in the file and invisible to any
// search over the bytes, which is how this defect stayed hidden through a dozen
// rounds of testing.
function stripPictographsFrom($) {
  let removed = 0;
  for (const node of $('*').contents().toArray()) {
    if (node.type !== 'text' || !node.data) continue;
    const cleaned = stripPictographs(node.data);
    if (cleaned === node.data) continue;
    removed += countPictographs(node.data);
    node.data = cleaned;
  }
  for (const el of $('[alt], [title]').toArray()) {
    for (const attr of ['alt', 'title']) {
      const value = el.attribs ? el.attribs[attr] : undefined;
      if (value === undefined) continue;
      const cleaned = stripPictographs(value);
      if (cleaned === value) continue;
      removed += countPictographs(value);
      $(el).attr(attr, cleaned);
    }
  }
  return removed;
}

// Smart string joiner for mixed Chinese/English OCR lines: insert a space only
// when joining two Latin alphanumeric runs (CJK has no inter-word spaces).
function joinText(lines) {
  let result = '';
  for (let j = 0; j < lines.length; j++) {
    const text = (lines[j].text || '').trim();
    if (result === '') {
      result = text;
      continue;
    }
    if (text === '') continue;

    const lastChar = result.slice(-1);
    const firstChar = text.charAt(0);

    const lastIsLatin = /[a-zA-Z0-9]/.test(lastChar);
    const firstIsLatin = /[a-zA-Z0-9]/.test(firstChar);

    if (lastIsLatin && firstIsLatin) {
      result += ' ' + text;
    } else {
      result += text;
    }
  }
  return result;
}

// Swift's String.count counts extended grapheme clusters; JS's String#length
// counts UTF-16 code units, so a 25-character title of CJK Ext-B ideographs
// (U+20000+, ordinary in Traditional-Chinese proper names) measured 50 here and
// 25 there — the app emitted <h2> where the CLI emitted <p>. Intl.Segmenter is
// the only built-in that segments by the same UAX #29 rule Swift uses.
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemeLength(text) {
  let count = 0;
  for (const _segment of GRAPHEME_SEGMENTER.segment(String(text))) count++;
  return count;
}

// Reconstruct one OCR'd page into paragraphs using line geometry + punctuation.
// y is bottom-up normalized (0 = bottom, 1 = top); lines arrive top-to-bottom.
function processPage(page) {
  const lines = page.lines;
  if (!lines || lines.length === 0) return [];

  // Filter out headers (top-most) and footers (bottom-most page numbers).
  const filteredLines = lines.filter(line => {
    if (line.y > 0.94) return false; // top header
    if (line.y < 0.06) return false; // bottom footer/page number
    return true;
  });

  if (filteredLines.length === 0) return [];

  const avgHeight = filteredLines.reduce((sum, l) => sum + l.height, 0) / filteredLines.length;

  const paragraphs = [];
  let currentParaLines = [];

  for (let j = 0; j < filteredLines.length; j++) {
    const line = filteredLines[j];
    if (currentParaLines.length === 0) {
      currentParaLines.push(line);
      continue;
    }

    const prevLine = currentParaLines[currentParaLines.length - 1];
    const gap = prevLine.y - (line.y + line.height);

    let isBreak = false;

    // Break rules in priority order: a wide gap, sentence-final punctuation over a
    // normal-height gap, a fresh indent, or an outsized line. The punctuation class
    // must stay character-for-character identical to EpubBuilder.swift's
    // `breakPunct` — 「 and “ are *opening* quotes, and a line ending in one is
    // handing the next line over to a speaker, so it does start a new paragraph.
    if (gap > avgHeight * 1.8) {
      isBreak = true;
    } else if (/[。！？?」「”“.!]$/.test(prevLine.text.trim()) && gap > avgHeight * 0.95) {
      isBreak = true;
    } else if (line.x - prevLine.x > 0.05) {
      isBreak = true;
    } else if (prevLine.height > avgHeight * 1.45 || line.height > avgHeight * 1.45) {
      isBreak = true;
    }

    if (isBreak) {
      paragraphs.push(currentParaLines);
      currentParaLines = [line];
    } else {
      currentParaLines.push(line);
    }
  }
  if (currentParaLines.length > 0) {
    paragraphs.push(currentParaLines);
  }

  return paragraphs.map(pLines => {
    const text = joinText(pLines);
    const isHeading = pLines.length === 1 && pLines[0].height > avgHeight * 1.35 && graphemeLength(text) < 40;
    return { text, isHeading };
  });
}

module.exports = {
  escapeXML, escapeAttr, decodeNonAsciiRefs, serializeXml,
  PICTOGRAPH_RUN, countPictographs, stripPictographs, stripPictographsFrom,
  joinText, processPage,
};
