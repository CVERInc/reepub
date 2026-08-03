'use strict';

// CJK 排版標本 —— fixture 用的文字，永遠是標本，不是誰的書。
//
// Latin typography has lorem ipsum, whose job is to mean nothing so nobody
// reads it. This has a different job. A fixture that renders beautifully and
// never touches a boundary proves nothing when it passes; the text here is
// chosen to land on the places CJK layout is known to break, and every one of
// those places was found in this repository rather than looked up.
//
// It exists at all because a real book title in a fixture reads as a corpus —
// as a description of somebody's shelf — and a specimen does not.
//
// ── Two layers ───────────────────────────────────────────────────────────────
//
// SOURCE   Each script's own founding text. All three are public domain, all
//          three are documents *about their own writing system*, and all three
//          are what a type foundry already prints to show a typeface:
//
//            Han     千字文 (6C, 周興嗣) — a thousand characters, by design no
//                    two the same. A character inventory, which is exactly what
//                    a specimen wants.
//            Kana    いろは歌 — every kana exactly once, author unknown.
//            Hangul  훈민정음 (1443) — the proclamation that introduced the
//                    script. Note it carries word spaces, which Han and kana do
//                    not: that difference is itself worth having in a fixture.
//
// HAZARD   The layout failures this repository actually hit. Each entry says
//          what it is for, and where the evidence lives. A string with no
//          reason attached is a string the next reader deletes.
//
// ── Why the codepoints are spelled out ───────────────────────────────────────
//
// Extension B is absent from most fonts, so a maintainer reading this file may
// see a replacement glyph — not a neutral box, but the red diamond that means
// "invalid", which reads as a corrupt file rather than as a rare character.
// A specimen whose point is "this may not render" is useless as documentation
// if the note goes down with the glyph. So the rare ones are built from their
// codepoint and never pasted: the source stays legible in any terminal, and the
// character is still exercised at run time.

// ─────────────────────────────────────────────────────────── SOURCE

const HAN = {
  title: '千字文',
  author: '周興嗣',
  // Four-character phrases, paired as a couplet the way a chapter heading is.
  couplets: [
    '天地玄黃　宇宙洪荒',
    '日月盈昃　辰宿列張',
    '寒來暑往　秋收冬藏',
  ],
  prose: [
    '閏餘成歲，律呂調陽。',
    '雲騰致雨，露結為霜。',
    '金生麗水，玉出崑岡。',
  ],
};

const KANA = {
  title: 'いろは歌',
  author: '詠み人知らず',
  // No word spaces — which is the property the line-setting rule is tested on.
  text: 'いろはにほへとちりぬるを',
};

const HANGUL = {
  title: '훈민정음',
  author: '세종',
  // Modern spelling. The original orthography is a hazard, not a sample, and
  // lives below as `archaicHangul`.
  text: '나랏말싸미 듕귁에 달아',
};

// ─────────────────────────────────────────────────────────── HAZARD

const cp = (...points) => String.fromCodePoint(...points);

// `codepoint` names the characters that carry the hazard, which is not always
// every character in `char` — 「他說。」 is listed as its three marks, because
// the two words are only there to give them somewhere to sit. checkSpecimen()
// below asserts each declared codepoint really occurs, so the annotation is
// checked rather than believed.

const HAZARD = {
  extensionB: {
    char: cp(0x21489),
    codepoint: 'U+21489',
    why: 'CJK Extension B. Two defects at once. (1) It is why pictograph '
       + 'stripping stops short of U+20000: this character displayed perfectly '
       + 'on the device, so "the astral plane is the problem" was the wrong '
       + 'hypothesis. (2) It is a UTF-16 surrogate pair, so JS String#length '
       + 'counts 2 where Swift String.count counts 1 — the exact disagreement '
       + 'check-sync-markers exists to catch.',
    evidence: 'src/epub-text.js, docs/kindle-silent-failures.md, PRINCIPLES §6',
    mustSurvive: true,
  },

  pictograph: {
    char: cp(0x1F9E0),
    codepoint: 'U+1F9E0',
    why: 'A pictographic emoji anywhere in the text makes a Kindle hide the '
       + 'cover AND the table of contents of the whole book, while the file '
       + 'passes epubcheck with zero errors.',
    evidence: 'PRINCIPLES §7, docs/kindle-silent-failures.md',
    mustSurvive: false,
  },

  variationSelector: {
    char: cp(0x1F441, 0xFE0F),
    codepoint: 'U+1F441 U+FE0F',
    why: 'The same pictograph rule has to fold away a variation selector, or '
       + 'one emoji is collected twice and counted as two distinct glyphs.',
    evidence: 'src/emoji-glyphs.js',
    mustSurvive: false,
  },

  arrow: {
    char: cp(0x2192),
    codepoint: 'U+2192',
    why: 'Must survive. A diagram built from boxes and arrows stops reading as '
       + 'one if the arrows go with the emoji — the rule has to cut narrowly.',
    evidence: 'src/epub-text.js',
    mustSurvive: true,
  },

  bullet: {
    char: cp(0x2022),
    codepoint: 'U+2022',
    why: 'Must survive, for the same reason as the arrow. One volume in the '
       + 'corpus carries 241 of them.',
    evidence: 'src/epub-text.js',
    mustSurvive: true,
  },

  latinInVertical: {
    char: '第一章 Chapter One',
    codepoint: null,
    why: 'In vertical text, text-orientation: upright stands each Latin letter '
       + 'on its own, turning a word into a column of single characters. Known '
       + 'and unfixed; a title of pure Han characters never shows it, which is '
       + 'how it stayed unnoticed.',
    evidence: 'docs/kindle-silent-failures.md — "Free finding"',
    mustSurvive: true,
  },

  closingPunctuation: {
    char: '「他說。」',
    codepoint: 'U+300C U+3002 U+300D',
    why: 'CJK closing punctuation may not begin a line. That is what '
       + 'line-break: strict is for, and a fixture without any closing mark '
       + 'never asks whether it was set.',
    evidence: 'src/cover-generator.js',
    mustSurvive: true,
  },

  smallKana: {
    char: 'きょっゃ',
    codepoint: 'U+3087 U+3063 U+3083',
    why: 'Small kana cannot begin a line either — the same rule as closing '
       + 'punctuation, in a script where a Han-only fixture cannot reach it.',
    evidence: 'kinsoku; untested against a device',
    mustSurvive: true,
  },

  archaicHangul: {
    char: cp(0x1109, 0x119E),
    codepoint: 'U+1109 U+119E',
    why: 'Old Hangul jamo, as the original 훈민정음 is written. Frequently '
       + 'absent from fonts, so it is a rendering hazard rather than a sample.',
    evidence: 'not observed on a device; carried for the layout path only',
    mustSurvive: true,
  },

  strokeExtremes: {
    char: '一鬱',
    codepoint: 'U+4E00 U+9B31',
    why: 'One stroke against twenty-nine. Ink coverage on a greyscale '
       + 'thumbnail is measured in percentages, and a fixture of evenly-dense '
       + 'characters can pass a threshold the real extremes would fail.',
    evidence: 'src/test-core-spec.js — "Cover: survives the shelf"',
    mustSurvive: true,
  },
};

// A line carrying the marks that must live through pictograph stripping and the
// one that must not. Fixtures kept reaching for a book title to build this; it
// belongs here, named, with its reason attached.
const MIXED_RUN = [
  HAZARD.pictograph.char, ' 概念 ',
  HAZARD.arrow.char, ' 圖解 ',
  HAZARD.bullet.char, ' ',
  HAZARD.extensionB.char,
].join('');

// Returns the problems with this file itself. A specimen whose annotations have
// drifted from its strings is worse than none: every fixture downstream would
// still pass, while the reason each string exists had quietly become fiction.
function checkSpecimen() {
  const problems = [];
  for (const [name, h] of Object.entries(HAZARD)) {
    if (!h.why) problems.push(`${name}: no reason — a string with no reason attached is one the next reader deletes`);
    if (!h.evidence) problems.push(`${name}: no evidence`);
    if (typeof h.mustSurvive !== 'boolean') problems.push(`${name}: does not say whether it must survive the pipeline`);
    if (!h.codepoint) continue;
    const present = new Set([...h.char].map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`));
    for (const declared of h.codepoint.split(/\s+/)) {
      if (!present.has(declared)) {
        problems.push(`${name}: declares ${declared}, which is not in its own string`);
      }
    }
  }
  if (MIXED_RUN.includes(HAZARD.extensionB.char) === false) {
    problems.push('MIXED_RUN no longer carries the Extension B character it exists to protect');
  }
  return problems;
}

module.exports = { HAN, KANA, HANGUL, HAZARD, MIXED_RUN, checkSpecimen };
