// Draw a book's cover.
//
// The cover is typography, not a picture: one design is emitted twice, as the
// XHTML page the reader opens and as the raster the shelf shows, so the two can
// never disagree. Type is fitted to the canvas rather than set to a constant —
// a three-character title and a fifteen-character one both deserve to fill the
// cover, and no fixed font size gives them both that.
//
// Two things about the medium decide the rest:
//
//   · A Kindle pads a cover to its own aspect on the lock screen, so a fully
//     black ground bleeds into that padding and the cover fills the screen.
//     Black is not a mood here; it is what makes the image sit edge to edge.
//   · E-ink is reflective and greyscale. Gradients collapse, low opacities
//     disappear, and hairlines vanish at shelf-thumbnail size. Everything on
//     this cover is either white on black or it is not on the cover.
//
// And the shelf draws its own furniture on top: a progress badge at the top
// right, a selection tick at the bottom left, an overflow menu at the bottom
// right. The composition stays out of all three corners.

const { chromium } = require('playwright');
const sharp = require('sharp');
const { escapeXML, escapeAttr } = require('./epub-text');
const { setTitle } = require('./title-setting');

// The layouts the stylesheet below actually defines. Kept as an allowlist
// because `layout` lands in a class attribute: a value from outside this set is
// markup injection, not a styling mistake.
const LAYOUTS = ['vertical', 'horizontal'];

const CANVAS = { width: 1600, height: 2260 };

// The grey a reader pads a cover with.
//
// A cover is almost never the shape of the screen it lands on, so the reader
// fills the difference — on a Kindle lock screen, a band down each side of the
// cover. That fill is not pure black, so a black cover meets it with a visible
// seam, and the full-bleed lock screen a dark cover is drawn for does not
// happen.
//
// Amazon publishes cover sizes and says nothing about the fill, so it was
// measured off the device: scripts/calibrate-cover-ground.mjs builds a book
// whose cover is a ladder of labelled greys, and the band whose edge vanishes
// into the fill is the answer. Two people reading a Kindle lock screen agreed
// on #181818, in both the light and the dark theme. A photograph cannot settle
// it — JPEG, camera gamma and the room all exceed the difference being looked
// for — which is why the instrument reports to an eye rather than to a script.
//
// E-ink shows sixteen levels of grey, so this is not really a colour match: it
// is a match of the level the fill lands on, roughly one seventeenth of the
// range wide. That is why the neighbouring values in the ladder were hard to
// tell apart, and it is also why the exact hex matters less than it looks —
// anything inside that level renders as the same grey.
//
// Matching it here rather than matching the screen's shape is what keeps this
// independent of the cover's proportions: any aspect ratio bleeds into the
// fill, so the shape of a cover stays a design decision instead of becoming a
// device workaround.
const COVER_GROUND = '#181818';

// document.fonts.ready can never settle if a face fails to load, so the wait is
// raced against this ceiling — a missing font must degrade the cover, not hang
// the build.
const FONT_READY_TIMEOUT_MS = 3000;

// How much of the canvas the title is allowed to occupy. The rest is the
// margin the corners need, plus room for the credits.
// As a fraction of the stage, which is already inset from the shelf's corners.
const TITLE_BOX = {
  horizontal: { width: 1, height: 0.66 },
  vertical: { width: 0.62, height: 1 },
};

// Fitted sizes are searched between these, as a percentage of canvas width.
// The ceiling is generous on purpose: a two-character title should be allowed
// to be enormous. What stops it is the box, not a number chosen in advance.
const TITLE_SCALE = { min: 3.2, max: 34, tolerance: 0.05 };
const DEFAULT_TITLE_SCALE = 9;

// The binder's own mark. A tool that stamps every book it touches with one
// name is opinionated in someone else's library, so it is a setting; the
// default is simply what this project is called.
const DEFAULT_IMPRINT = 'Reepub Editions';

// A column of type one word per line is taller than any cover once each line
// is justified, so a title is merged back together until it fits.
const MAX_TITLE_LINES = 4;

// How much bigger wrapping must make the title before it is worth breaking a
// line at all.
const WRAP_MUST_DOUBLE = 2;

function assertLayout(layout) {
  if (!LAYOUTS.includes(layout)) {
    throw new TypeError(
      `Unknown cover layout ${JSON.stringify(layout)} (expected one of: ${LAYOUTS.join(', ')})`);
  }
}

/**
 * Which cover a book gets, decided by how it is read rather than by what it is
 * about. A right-to-left spine means a vertical cover; everything else gets the
 * horizontal one.
 *
 * The rule lives here, once, because it is a property of the edition: callers
 * that each re-derive it from their own idea of "is this a Chinese book" are how
 * two books in the same series end up with two different covers.
 */
function layoutForDirection(pageDirection) {
  return String(pageDirection || '').toLowerCase() === 'rtl' ? 'vertical' : 'horizontal';
}

/**
 * The design, as a stylesheet.
 *
 * Every length is in `em`, and one em is one percent of the canvas width — so
 * the same numbers describe the 1600px raster and a reader's page of whatever
 * size, and the fitted title scale means the same thing in both.
 */
function coverStyles(titleScale, singleLine, opticalShift) {
  const scale = Number.isFinite(titleScale) && titleScale > 0 ? titleScale : DEFAULT_TITLE_SCALE;
  return `
    .reepub-cover {
      /* One em = 1% of the canvas width, whatever the canvas turns out to be.
         min() keeps the canvas inside the page in both dimensions, so the
         design never spills off a viewport of a different shape. */
      font-size: 16px;
      font-size: calc(min(100vw, 100vh * ${CANVAS.width} / ${CANVAS.height}) / 100);
      width: ${CANVAS.width / 16}em;
      width: 100em;
      height: ${(CANVAS.height / CANVAS.width) * 100}em;
      position: relative;
      overflow: hidden;
      background: ${COVER_GROUND};
      color: #fff;
      /* One imprint, one voice, three scripts. A hand-written stack would set
         a Japanese title in Chinese letterforms, or send every CJK title
         through to whatever came next. The generic serif keyword is resolved
         per script by the platform — a Latin serif, a 宋體, a 明朝体 — so every
         book is set in the same typographic voice while each language keeps its
         own correct letterforms, and no missing font can change the look. */
      font-family: serif;
      font-weight: 700;
      -webkit-font-smoothing: antialiased;
    }
    /* The shelf draws a progress badge top right, a tick bottom left and a menu
       bottom right. Nothing that has to be read goes in those corners. */
    .reepub-cover .stage {
      position: absolute;
      top: 14em;
      bottom: 14em;
      left: 12em;
      right: 12em;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
    }
    .reepub-cover .title {
      font-size: ${scale}em;
      line-height: 1.12;
      margin: 0;
      /* Balanced lines rather than a long first line and a stray last word;
         strict line breaking keeps CJK closing punctuation off a line start;
         auto-phrase breaks Japanese at phrase boundaries instead of mid-word.
         text-wrap carries the wrap mode as well as the style, so a title that
         must stay on one line says so here — set anywhere earlier, this
         declaration would quietly turn wrapping back on. */
      text-wrap: ${singleLine ? 'nowrap' : 'balance'};
      line-break: strict;
      word-break: auto-phrase;
      overflow-wrap: break-word;
    }
    /* Latin display type on a cover is set in capitals, and not only by
       convention: capitals have no descenders and one cap height, so lines
       stack tight and a justified block squares up. CJK has no case, so this
       is simply inert there. */
    .reepub-cover .title { text-transform: uppercase; }
    .reepub-cover .title-justified {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      font-size: 1em;
    }
    .reepub-cover .title-justified .line {
      display: block;
      line-height: 1.02;
      white-space: nowrap;
    }
    /* The imprint sits at the foot, between the selection tick and the
       overflow menu — the one edge of the cover the shelf leaves alone. It is
       small rather than faint: a grey at a third opacity is simply absent on a
       reflective screen, which is how the last one disappeared. */
    .reepub-cover .imprint {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 5.5em;
      margin: 0;
      text-align: center;
      font-size: 1.5em;
      font-weight: 400;
      letter-spacing: 0.62em;
      text-indent: 0.62em;
      text-transform: uppercase;
    }
    .reepub-cover .imprint:empty { display: none; }
    .reepub-cover .credits {
      margin-top: 7em;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1.6em;
    }
    .reepub-cover .author {
      font-size: 3.4em;
      line-height: 1.2;
      letter-spacing: 0.14em;
      text-indent: 0.14em;
      font-weight: 400;
      margin: 0;
    }
    /* 原作者為主、譯者為輔 — smaller, and still solid white, because a faint
       grey is simply absent on a reflective screen. */
    .reepub-cover .translator {
      font-size: 2.2em;
      line-height: 1.2;
      letter-spacing: 0.12em;
      text-indent: 0.12em;
      font-weight: 400;
      margin: 0;
    }
    .reepub-cover .translator:empty { display: none; }

    /* The title block shrink-wraps the title, so centring the block centres
       the title itself. The credits hang off it without taking part in that
       centring. */
    .reepub-cover .title-block { position: relative; }

    /* VERTICAL — right-to-left books. The title takes the centre, and the
       credits the column immediately to its left, at the foot: columns advance
       leftwards, so that is the one read after it, and the foot is where a
       Chinese cover puts a name. Being positioned against the title rather
       than against the page, they follow it — a three-character title and an
       eight-character one both keep their credits at the same distance. */
    .reepub-cover.layout-vertical .stage {
      align-items: center;
      justify-content: center;
    }
    /* Optical centring. Every box in this layout is centred arithmetically —
       measured in the DOM, the stage, the block and the title all sit on the
       canvas centre to the pixel. The ink does not: a CJK glyph set upright in
       a vertical column is not centred inside its own em, so a title measured
       off the rendered image came out some twenty pixels right of centre while
       every rectangle around it was exactly where it should be. Type is judged
       by where the ink lands, so the ink is what gets centred, and the offset
       is measured from a render rather than derived from metrics no font is
       obliged to make honest. */
    .reepub-cover .title-block {
      transform: translateX(${Number.isFinite(opticalShift) ? -opticalShift : 0}em);
    }

    /* The block is as tall as the stage so the title has a height to wrap
       against — a shrink-wrapped parent gives "max-height: 100%" nothing to
       resolve to, and a title that should run down three columns comes out as
       one very small one. It still shrink-wraps horizontally, which is what
       keeps centring it the same as centring the title. */
    .reepub-cover.layout-vertical .title-block {
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .reepub-cover.layout-vertical .credits {
      position: absolute;
      right: 100%;
      bottom: 0;
      margin-right: 4.5em;
    }
    /* The imprint stays horizontal on a vertical cover: it is not part of the
       text of the book, it is the binder's mark at the foot. */
    .reepub-cover.layout-vertical .title,
    .reepub-cover.layout-vertical .credits,
    .reepub-cover.layout-vertical .author,
    .reepub-cover.layout-vertical .translator {
      writing-mode: vertical-rl;
      text-orientation: upright;
    }
    .reepub-cover.layout-vertical .title {
      letter-spacing: 0.06em;
      text-indent: 0.06em;
      max-height: 100%;
    }
    .reepub-cover.layout-vertical .credits {
      margin-top: 0;
      flex-direction: row-reverse;
      align-items: flex-start;
      gap: 2.4em;
    }
    .reepub-cover.layout-vertical .author { letter-spacing: 0.18em; text-indent: 0.18em; }
  `;
}

/**
 * The title, either as one wrapping run of text or as lines justified
 * individually to the same width.
 *
 * `lineScales` is what makes a block of type out of a ragged wrap: each line
 * gets the size that makes it exactly as wide as the others, so the shortest
 * line is the largest. Emphasis comes out of the structure — nobody decides
 * that ELON should be three times the size of THE BOOK OF; being four
 * characters against eleven decides it.
 */
function titleMarkup(title, lines, lineScales) {
  if (!lines || !lineScales) {
    return `<h1 class="title">${escapeXML(title == null ? '' : title)}</h1>`;
  }
  const set = lines.map((line, i) =>
    `<span class="line" style="font-size: ${lineScales[i]}em">${escapeXML(line)}</span>`).join('\n      ');
  return `<h1 class="title title-justified">\n      ${set}\n    </h1>`;
}

// The credits live inside the block that wraps the title, not beside it, so
// that they can be positioned against the title rather than against the page.
// Centred as a pair, the title is pushed off-centre by half the width of the
// credits — and on a Chinese cover the title is the thing that has to be in
// the middle.
function coverBody(title, author, translator, imprint, lines, lineScales) {
  return `<div class="stage">
    <div class="title-block">
      ${titleMarkup(title, lines, lineScales)}
      <div class="credits">
        <p class="author">${escapeXML(author == null ? '' : author)}</p>
        <p class="translator">${escapeXML(translator == null ? '' : translator)}</p>
      </div>
    </div>
  </div>
  <p class="imprint">${escapeXML(imprint == null ? '' : imprint)}</p>`;
}

/**
 * The design as a standalone HTML page, which is what gets rasterised.
 *
 * Pure (no I/O), so the escaping contract is testable without a browser.
 * title/author are untrusted text: raw interpolation let a title like
 * 'A <Book>' inject markup into the rendered cover.
 */
function buildCoverHtml(title, author, layout = 'vertical', translator = '', titleScale, singleLine = false, extra = {}) {
  const shift = extra.opticalShift;
  assertLayout(layout);
  const imprint = extra.imprint === undefined ? DEFAULT_IMPRINT : extra.imprint;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: ${COVER_GROUND}; }
  body { width: ${CANVAS.width}px; height: ${CANVAS.height}px; }
  .reepub-cover { font-size: ${CANVAS.width / 100}px; }
${coverStyles(titleScale, singleLine, shift)}
</style>
</head>
<body>
<div class="reepub-cover layout-${layout}">${coverBody(title, author, translator, imprint, extra.lines, extra.lineScales)}</div>
</body>
</html>`;
}

/**
 * How far the title's ink sits from the centre of the canvas, in the same em
 * the stylesheet uses. Measured from a render with everything but the title
 * hidden, because the question is where the ink is, and only a render knows.
 */
async function measureOpticalShift(page) {
  await page.addStyleTag({ content: '.credits, .imprint { visibility: hidden !important; }' });
  const shot = await page.screenshot({ type: 'png' });
  const { data, info } = await sharp(shot).greyscale().raw().toBuffer({ resolveWithObject: true });

  let min = Infinity;
  let max = -1;
  for (let y = 0; y < info.height; y++) {
    const row = y * info.width;
    for (let x = 0; x < info.width; x++) {
      if (data[row + x] > 110) {
        if (x < min) min = x;
        if (x > max) max = x;
      }
    }
  }
  if (max < 0) return 0;

  const offsetPx = (min + max) / 2 - info.width / 2;
  // One em is one percent of the canvas width, which is what the stylesheet
  // was written in.
  return Number((offsetPx / (CANVAS.width / 100)).toFixed(3));
}

/**
 * The cover page bound into the book: the cover image, shown.
 *
 * The design is typography, but it is rasterised once and that raster serves
 * both the shelf thumbnail and this page — one picture, two jobs. Setting the
 * type again here as live HTML would look better in principle and worse in
 * fact: a reader that converts EPUB to its own format supports far less CSS
 * than the browser the raster was drawn in, so the page could break while the
 * thumbnail beside it stayed perfect. And a preserved cover must be shown as
 * the picture it is anyway — re-setting a scanned dust jacket as a title is
 * drawing a new cover, which nobody asked for.
 */
function buildCoverImagePage({ imageHref, title = '', language = 'en' } = {}) {
  const lang = escapeAttr(language || 'en');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <title>${escapeXML(title)}</title>
  <style>
    html, body { margin: 0; padding: 0; background: ${COVER_GROUND}; }
    body { text-align: center; page-break-after: always; break-after: page; }
    img { width: 100%; height: auto; display: block; margin: 0 auto; }
  </style>
</head>
<body epub:type="cover">
  <img src="${escapeAttr(imageHref)}" alt="${escapeAttr(title)}" />
</body>
</html>`;
}

/**
 * Set an English title as a justified block: every line the same width, each
 * at whatever size that takes.
 *
 * The per-line sizes are a measurement, not a search — a line's width is
 * linear in its font size, so one pass at a reference size gives the size that
 * makes it fill the measure exactly. Only the height of the finished block is
 * unknown, and that is one uniform scale away from fitting.
 */
async function fitJustifiedTitle(page, title, author, translator, layout, lines) {
  const REFERENCE = 10;
  const box = TITLE_BOX[layout];

  await page.setContent(buildCoverHtml(title, author, layout, translator, REFERENCE, false,
    { lines, lineScales: lines.map(() => REFERENCE) }));

  const measured = await page.evaluate(({ w, h }) => {
    const stage = document.querySelector('.stage').getBoundingClientRect();
    const widths = [...document.querySelectorAll('.title .line')].map((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().width;
    });
    return { widths, measure: stage.width * w, room: stage.height * h };
  }, { w: box.width, h: box.height });

  if (measured.widths.some(width => !(width > 0))) return null;

  // Each line grows or shrinks until it is exactly as wide as the measure.
  const scales = measured.widths.map(width => REFERENCE * (measured.measure / width));
  const height = scales.reduce((total, scale) => total + scale * 1.02, 0);
  // One scale over the whole block brings its height inside the box, and
  // scaling every line by the same factor leaves them all still equal in width.
  const fit = Math.min(1, measured.room / (height * (CANVAS.width / 100)));

  return {
    lineScales: scales.map(scale => Number((scale * fit).toFixed(2))),
    titleScale: Number((Math.max(...scales) * fit).toFixed(2)),
  };
}

/**
 * The largest title that still fits its box, when it is set as one run of text
 * rather than justified line by line.
 *
 * Binary search rather than a formula: how much room a title needs depends on
 * where the text wraps, which depends on the size — the two cannot be solved
 * for directly, but they converge in a dozen measurements.
 */
async function fitTitleScale(page, title, author, translator, layout) {
  const box = TITLE_BOX[layout];

  const largestThatFits = async (singleLine) => {
    let low = TITLE_SCALE.min;
    let high = TITLE_SCALE.max;
    if (!(await fitsAt(low, singleLine))) return low;
    while (high - low > TITLE_SCALE.tolerance) {
      const mid = (low + high) / 2;
      if (await fitsAt(mid, singleLine)) low = mid; else high = mid;
    }
    return Number(low.toFixed(2));
  };

  const fitsAt = async (scale, singleLine) => {
    await page.setContent(buildCoverHtml(title, author, layout, translator, scale, singleLine));
    return page.evaluate(({ w, h }) => {
      const title = document.querySelector('.title');
      const stage = document.querySelector('.stage');
      // The text itself, not its box. A flex item that may not wrap is
      // squeezed by its container while the ink spills out of it, so the box
      // and scrollWidth both stay obediently inside the stage and report a fit
      // that is not there. A Range over the contents measures what is drawn.
      const range = document.createRange();
      range.selectNodeContents(title);
      const t = range.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      // Both dimensions, because a vertical title grows across the page as it
      // gains columns and a horizontal one grows down the page as it wraps.
      return t.width <= s.width * w && t.height <= s.height * h;
    }, { w: box.width, h: box.height });
  };

  const wrapped = await largestThatFits(false);
  const single = await largestThatFits(true);

  // Wrapping a title costs something: it splits a name across lines, and no
  // tool without a dictionary knows where a name ends. So it has to earn its
  // keep — the rule is that wrapping must make the type at least twice as
  // large, otherwise the title stays on one line at whatever size that allows.
  const singleLine = wrapped < single * WRAP_MUST_DOUBLE;
  return { titleScale: singleLine ? single : wrapped, singleLine };
}

// Renders the cover to `outputPath` as JPEG, and reports the fitted title scale
// so the XHTML page bound into the book is set from the same measurement.
// The browser is closed on every path: a leaked chromium keeps the caller's
// event loop alive forever, so a screenshot failure used to hang the whole
// process instead of rejecting.
//
// `layout` may be a layout name, or { pageDirection, translator } to have the
// layout chosen from how the book is read.
async function generateCover(title, author, outputPath, layout = 'vertical') {
  const options = layout && typeof layout === 'object' ? layout : {};
  const resolved = layout && typeof layout === 'object'
    ? layoutForDirection(layout.pageDirection)
    : layout;
  assertLayout(resolved);
  const translator = options.translator || '';

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: CANVAS.width, height: CANVAS.height },
      deviceScaleFactor: 1,
    });

    // An English title is set as a justified block; a CJK one wraps at one
    // size, because equal-width lines would mean unequal glyphs.
    const lines = setTitle(title, { maxLines: MAX_TITLE_LINES });
    const justified = lines && lines.length > 1
      ? await fitJustifiedTitle(page, title, author, translator, resolved, lines)
      : null;

    const fitted = justified
      ? { titleScale: justified.titleScale, singleLine: false }
      : await fitTitleScale(page, title, author, translator, resolved);
    const { titleScale, singleLine } = fitted;
    const extra = justified
      ? { imprint: options.imprint, lines, lineScales: justified.lineScales }
      : { imprint: options.imprint };

    await page.setContent(buildCoverHtml(title, author, resolved, translator, titleScale, singleLine, extra));
    await page.evaluate(async (timeoutMs) => {
      await Promise.race([
        document.fonts.ready,
        new Promise(resolve => setTimeout(resolve, timeoutMs)),
      ]);
    }, FONT_READY_TIMEOUT_MS);

    // Centre the ink, then draw for real.
    const opticalShift = await measureOpticalShift(page);
    await page.setContent(buildCoverHtml(title, author, resolved, translator, titleScale, singleLine,
      { ...extra, opticalShift }));
    await page.evaluate(async (timeoutMs) => {
      await Promise.race([
        document.fonts.ready,
        new Promise(resolve => setTimeout(resolve, timeoutMs)),
      ]);
    }, FONT_READY_TIMEOUT_MS);

    await page.screenshot({ path: outputPath, type: 'jpeg', quality: 88 });
    return {
      titleScale,
      singleLine,
      layout: resolved,
      opticalShift,
      lines: justified ? lines : null,
      lineScales: justified ? justified.lineScales : null,
      imprint: options.imprint === undefined ? DEFAULT_IMPRINT : options.imprint,
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
  COVER_GROUND,
  DEFAULT_IMPRINT,
  buildCoverHtml,
  buildCoverImagePage,
  generateCover,
  layoutForDirection,
  CANVAS,
};
