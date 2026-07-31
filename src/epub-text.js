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

module.exports = { escapeXML, escapeAttr, joinText, processPage };
