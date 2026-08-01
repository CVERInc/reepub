// Emoji as engravings.
//
// A Kindle shows a book whose text carries pictographic emoji with no cover
// and no table of contents (see stripPictographs in epub-text.js for the
// evidence). Stripping them is safe and is the default; this module is the
// mode for books where the emoji ARE content — a legend, a rating, a bullet —
// and deleting them would delete meaning.
//
// Each distinct pictograph is drawn once with Noto Emoji's monochrome face —
// line art, not a colour bitmap flattened to sixteen grey levels — and set
// into the text as an image the height of the surrounding type:
//
//   🚀  →  <img class="reepub-emoji" src="images/emoji-1f680.png" alt="火箭"/>
//
// The alt text is the character's CLDR name in the book's language, so a
// screen reader still says rocket, search still finds it, and a reader that
// loses the image degrades to the name instead of to nothing. The pictograph
// itself never reaches the book: the codepoint is what kills the cover.
//
// Assets are pinned and fetched by scripts/fetch-emoji-assets.mjs; nothing
// here downloads. Rendering uses the same Playwright the cover generator
// already depends on. This module serves the heal path, whose documents are
// parsed with decodeEntities: false — text and attribute data pass through
// in serialized form, and everything inserted here follows that convention.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { PICTOGRAPH_RUN, countPictographs, escapeAttr } = require('./epub-text');

const ASSETS_DIR = path.join(os.homedir(), '.cache', 'reepub', 'emoji-glyphs-1');
const FONT_FILE = 'NotoEmoji.ttf';
const VARIATION_SELECTOR = /\uFE0F/g;

// CLDR locale for each language tag reepub supports; anything unrecognized
// falls back to English names rather than to no names.
function annotationLocale(language) {
  const lower = String(language || '').toLowerCase();
  if (lower.startsWith('ja')) return 'ja';
  if (lower.startsWith('zh')) return 'zh-Hant';
  return 'en';
}

function assetsPresent() {
  return [FONT_FILE, 'annotations-en.json', 'annotations-ja.json', 'annotations-zh-Hant.json']
    .every(name => fs.existsSync(path.join(ASSETS_DIR, name)));
}

/** The distinct pictographs in a text, FE0F selectors folded away. */
function collectPictographs(text, into = new Set()) {
  for (const match of String(text).matchAll(PICTOGRAPH_RUN)) {
    for (const ch of match[0].replace(VARIATION_SELECTOR, '')) {
      if (ch.codePointAt(0) >= 0x1F000) into.add(ch);
    }
  }
  return into;
}

/** The character's CLDR name in the book's language. Never empty: a glyph
 *  CLDR has no name for is named by its codepoint, which is still a name. */
function createNamer(language) {
  const locale = annotationLocale(language);
  const file = path.join(ASSETS_DIR, `annotations-${locale}.json`);
  const table = JSON.parse(fs.readFileSync(file, 'utf8')).annotations.annotations;
  return (char) => {
    const entry = table[char] || table[char + '\uFE0F'];
    const name = entry && entry.tts && entry.tts[0];
    return name || `U+${char.codePointAt(0).toString(16).toUpperCase()}`;
  };
}

/**
 * Draw each pictograph once as monochrome line art. Returns a Map from
 * character to the absolute path of a PNG on disk, in a temp directory the
 * caller hands to the resource pool (which content-addresses and dedups).
 *
 * 128px for a glyph displayed at 1em (~30px of device type) is ~4×
 * supersampling; the strokes stay crisp through the reader's own rescaling.
 */
async function renderGlyphs(chars, { size = 128 } = {}) {
  if (!assetsPresent()) {
    throw new Error(
      'glyph mode needs the monochrome emoji assets — run: node scripts/fetch-emoji-assets.mjs');
  }
  const list = [...chars];
  const rendered = new Map();
  if (list.length === 0) return rendered;

  const { chromium } = require('playwright');
  const sharp = require('sharp');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reepub-emoji-'));
  // Embedded, not linked: a page built with setContent has no origin, and
  // Chromium quietly refuses to load a file:// font into it — the spans then
  // render tofu and fonts.check() reports every glyph missing.
  const fontUrl = 'data:font/ttf;base64,'
    + fs.readFileSync(path.join(ASSETS_DIR, FONT_FILE)).toString('base64');

  // One page, every glyph in it, one screenshot each. The font is loaded
  // exclusively — no fallback family — so nothing can be quietly drawn by the
  // system's colour emoji font, which is the exact thing this mode promises
  // the book will not contain.
  const html = `<!DOCTYPE html><html><head><style>
    @font-face { font-family: "NotoEmojiMono"; src: url("${fontUrl}"); }
    body { margin: 0; background: transparent; }
    .glyph {
      font-family: "NotoEmojiMono";
      font-size: ${size}px;
      line-height: 1;
      color: #000;
      display: inline-block;
      padding: ${Math.round(size / 8)}px;
    }
  </style></head><body>${
    list.map((ch, i) => `<span class="glyph" id="g${i}">${ch}</span>`).join('<br/>')
  }</body></html>`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);

    // A codepoint the face cannot draw would come out as a tofu box — visible
    // pixels, so no image inspection catches it. The font API knows.
    const missing = await page.evaluate(([chars, px]) =>
      chars.filter(ch => !document.fonts.check(`${px}px "NotoEmojiMono"`, ch)),
      [list, size]);
    if (missing.length > 0) {
      const names = missing.map(ch => `${ch} (U+${ch.codePointAt(0).toString(16).toUpperCase()})`);
      throw new Error(
        `Noto Emoji cannot draw ${names.join(', ')} — refusing to let the colour font it exists to avoid stand in`);
    }

    for (let i = 0; i < list.length; i++) {
      const char = list[i];
      const png = await page.locator(`#g${i}`).screenshot({ omitBackground: true });
      const trimmed = await sharp(png).trim().png({ palette: true }).toBuffer();
      const file = path.join(outDir, `emoji-${char.codePointAt(0).toString(16)}.png`);
      fs.writeFileSync(file, trimmed);
      rendered.set(char, file);
    }
  } finally {
    await browser.close();
  }
  return rendered;
}

/**
 * Replace every pictograph in a parsed document with its engraved image.
 * `hrefFor(char)` returns the in-book href; `altFor(char)` its name. Walks
 * the same ground as stripPictographsFrom — text nodes plus alt/title
 * attributes — but where strip deletes, this preserves: text gets the image,
 * attributes get the name (an attribute cannot hold an image).
 *
 * The style is inline rather than a stylesheet rule so the glyph survives
 * any healing or merging that rewrites stylesheets: 1em tall, it scales with
 * the reader's chosen type size like the character it stands for.
 *
 * text-bottom, judged on the device against middle and a -0.125em offset:
 * a CJK character fills its em box, so a glyph flush with the box's bottom
 * stands shoulder to shoulder with the characters around it. It is also the
 * only one of the three that asks nothing of the renderer — no negative
 * length, no guess at an x-height Kindle may compute differently.
 */
const GLYPH_STYLE = 'height: 1em; vertical-align: text-bottom;';

function glyphMarkup(char, hrefFor, altFor) {
  return `<img class="reepub-emoji" src="${escapeAttr(hrefFor(char))}"`
    + ` alt="${escapeAttr(altFor(char))}" style="${GLYPH_STYLE}"/>`;
}

function inlinePictographsIn($, { hrefFor, altFor }) {
  let inlined = 0;

  for (const node of $('*').contents().toArray()) {
    if (node.type !== 'text' || !node.data) continue;
    if (countPictographs(node.data) === 0) continue;

    // The document is parsed with decodeEntities: false, so node.data is
    // already in serialized form and non-pictograph stretches can pass back
    // through verbatim. A glyph replaces its character in place; the
    // whitespace around it is content, not (as in stripping) a gap to close.
    let markup = '';
    for (const ch of node.data.replace(VARIATION_SELECTOR, '')) {
      const code = ch.codePointAt(0);
      if (code >= 0x1F000 && code <= 0x1FAFF) {
        markup += glyphMarkup(ch, hrefFor, altFor);
        inlined++;
      } else {
        markup += ch;
      }
    }
    $(node).replaceWith(markup);
  }

  for (const el of $('[alt], [title]').toArray()) {
    for (const attr of ['alt', 'title']) {
      const value = el.attribs ? el.attribs[attr] : undefined;
      if (value === undefined || countPictographs(value) === 0) continue;
      let renamed = value;
      for (const ch of collectPictographs(value)) {
        renamed = renamed.split(ch).join(altFor(ch));
      }
      $(el).attr(attr, renamed.replace(VARIATION_SELECTOR, ''));
    }
  }

  return inlined;
}

module.exports = {
  ASSETS_DIR,
  assetsPresent,
  annotationLocale,
  collectPictographs,
  createNamer,
  renderGlyphs,
  inlinePictographsIn,
  GLYPH_STYLE,
};
