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
const { escapeXML, escapeAttr } = require('./epub-text');

// The layouts the stylesheet below actually defines. Kept as an allowlist
// because `layout` lands in a class attribute: a value from outside this set is
// markup injection, not a styling mistake.
const LAYOUTS = ['vertical', 'horizontal'];

const CANVAS = { width: 1600, height: 2260 };

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
function coverStyles(titleScale, singleLine) {
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
      background: #000;
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

    /* VERTICAL — right-to-left books. Columns advance leftwards, so the title
       takes the rightmost one and the credits the next along: the order on the
       cover is the order they are read in. The credits sit at the foot of their
       column, where a Chinese cover puts them — beside the title they read as an
       annotation to it. */
    .reepub-cover.layout-vertical .stage {
      flex-direction: row-reverse;
      align-items: center;
      justify-content: center;
      gap: 6em;
    }
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
      align-self: flex-end;
      flex-direction: row-reverse;
      align-items: flex-start;
      gap: 2.4em;
    }
    .reepub-cover.layout-vertical .author { letter-spacing: 0.18em; text-indent: 0.18em; }
  `;
}

function coverBody(title, author, translator) {
  return `<div class="stage">
    <h1 class="title">${escapeXML(title == null ? '' : title)}</h1>
    <div class="credits">
      <p class="author">${escapeXML(author == null ? '' : author)}</p>
      <p class="translator">${escapeXML(translator == null ? '' : translator)}</p>
    </div>
  </div>`;
}

/**
 * The design as a standalone HTML page, which is what gets rasterised.
 *
 * Pure (no I/O), so the escaping contract is testable without a browser.
 * title/author are untrusted text: raw interpolation let a title like
 * 'A <Book>' inject markup into the rendered cover.
 */
function buildCoverHtml(title, author, layout = 'vertical', translator = '', titleScale, singleLine = false) {
  assertLayout(layout);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: #000; }
  body { width: ${CANVAS.width}px; height: ${CANVAS.height}px; }
  .reepub-cover { font-size: ${CANVAS.width / 100}px; }
${coverStyles(titleScale, singleLine)}
</style>
</head>
<body>
<div class="reepub-cover layout-${layout}">${coverBody(title, author, translator)}</div>
</body>
</html>`;
}

/**
 * The same design as the XHTML page bound into the book — real type, so it
 * stays sharp at any size, can be selected, and costs a few hundred bytes.
 */
function buildCoverPage({ title, author, translator = '', layout = 'vertical', language = 'en', titleScale, singleLine = false } = {}) {
  assertLayout(layout);
  const lang = escapeAttr(language || 'en');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <title>${escapeXML(title == null ? '' : title)}</title>
  <style>
    html, body { margin: 0; padding: 0; background: #000; }
    body { display: flex; align-items: center; justify-content: center;
           min-height: 100vh; page-break-after: always; break-after: page; }
${coverStyles(titleScale, singleLine)}
  </style>
</head>
<body epub:type="cover">
  <div class="reepub-cover layout-${layout}">${coverBody(title, author, translator)}</div>
</body>
</html>`;
}

/**
 * The largest title that still fits its box.
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

    const { titleScale, singleLine } = await fitTitleScale(page, title, author, translator, resolved);

    await page.setContent(buildCoverHtml(title, author, resolved, translator, titleScale, singleLine));
    await page.evaluate(async (timeoutMs) => {
      await Promise.race([
        document.fonts.ready,
        new Promise(resolve => setTimeout(resolve, timeoutMs)),
      ]);
    }, FONT_READY_TIMEOUT_MS);

    await page.screenshot({ path: outputPath, type: 'jpeg', quality: 88 });
    return { titleScale, singleLine, layout: resolved };
  } finally {
    await browser.close();
  }
}

module.exports = {
  buildCoverHtml,
  buildCoverPage,
  generateCover,
  layoutForDirection,
  CANVAS,
};
