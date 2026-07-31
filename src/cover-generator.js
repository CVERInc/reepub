const { chromium } = require('playwright');
const { escapeXML } = require('./epub-text');

// The layouts the stylesheet below actually defines. Kept as an allowlist
// because `layout` lands in a class attribute: a value from outside this set is
// markup injection, not a styling mistake.
const LAYOUTS = ['vertical', 'horizontal'];

// document.fonts.ready can never settle if a face fails to load, so the wait is
// raced against this ceiling — a missing font must degrade the cover, not hang
// the build.
const FONT_READY_TIMEOUT_MS = 3000;

// Pure (no I/O), so the escaping contract is testable without a browser.
// title/author are untrusted text and are escaped as HTML element content: raw
// interpolation let a title like 'A <Book>' inject markup into the rendered
// cover. An unrecognised layout is rejected rather than silently defaulted.
function buildCoverHtml(title, author, layout = 'vertical') {
  if (!LAYOUTS.includes(layout)) {
    throw new TypeError(
      `Unknown cover layout ${JSON.stringify(layout)} (expected one of: ${LAYOUTS.join(', ')})`);
  }
  const safeTitle = escapeXML(title == null ? '' : title);
  const safeAuthor = escapeXML(author == null ? '' : author);

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        /* One imprint, one voice, three scripts.
           The cover must not change typeface because of what the book is
           called, and it has to set English, Japanese and Traditional Chinese
           equally well. Those two goals rule out a hand-written stack: naming a
           Chinese face first means a Japanese title is drawn with Chinese kanji
           forms, and naming a Latin face first means every CJK title falls
           through to whatever happens to come next.
           The generic serif keyword is the one declaration that satisfies
           both. The platform resolves it per script — a Latin serif, a 宋體, a
           明朝体 — so every book is set in the same typographic voice while each
           language keeps its own correct letterforms. It is also the only
           choice that cannot break on a machine missing a particular font. */
        :root {
          --ink: #12161d;
          --ink-lift: #1c2331;
          --paper: #e8e6e1;
          --rule: rgba(232, 230, 225, 0.14);
          --rule-faint: rgba(232, 230, 225, 0.06);
          --imprint: serif;
        }
        body {
          margin: 0;
          padding: 0;
          width: 1600px;
          height: 2260px;
          background: linear-gradient(150deg, var(--ink-lift) 0%, var(--ink) 62%);
          color: var(--paper);
          font-family: var(--imprint);
          box-sizing: border-box;
          position: relative;
          overflow: hidden;
        }
        /* The frame belongs to both layouts. An imprint that drops its frame on
           half its catalogue is two imprints. */
        .frame {
          position: absolute;
          inset: 84px;
          border: 2px solid var(--rule);
          pointer-events: none;
        }
        .frame-inner {
          position: absolute;
          inset: 104px;
          border: 1px solid var(--rule-faint);
          pointer-events: none;
        }
        .publisher {
          position: absolute;
          bottom: 128px;
          left: 0;
          right: 0;
          text-align: center;
          font-size: 22px;
          letter-spacing: 14px;
          text-indent: 14px;
          opacity: 0.32;
          text-transform: uppercase;
        }

        /* VERTICAL — right-to-left books.
           A Chinese cover is read from the right, so the title starts at the
           right margin and runs down; the author sits at the foot on the left,
           where the reading ends. The old layout centred the title and gave the
           right-hand column to the publisher's name, which put the imprint
           where the title belongs. */
        .layout-vertical .title {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          right: 206px;
          max-height: 1580px;
          writing-mode: vertical-rl;
          text-orientation: upright;
          font-size: 204px;
          line-height: 1.06;
          letter-spacing: 18px;
          text-indent: 18px;
          text-shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
        }
        .layout-vertical .author {
          position: absolute;
          bottom: 232px;
          left: 214px;
          max-height: 900px;
          writing-mode: vertical-rl;
          text-orientation: upright;
          font-size: 54px;
          letter-spacing: 12px;
          text-indent: 12px;
          opacity: 0.62;
        }

        /* HORIZONTAL — left-to-right books.
           Title in the upper third, author down at the foot, and the space
           between them left empty on purpose. Stacking all three at the top
           leaves the lower half looking like a rendering accident; anchoring
           the foot makes the same emptiness read as margin. Both are pinned to
           the left rule, so a one-word title and a four-line one start on the
           same line instead of drifting apart. */
        /* The title block is the only positioned wrapper, and only in the
           horizontal layout. The author is a sibling of it, not a child:
           nested inside a wrapper of collapsed height, "anchor to the foot"
           measures from the wrapper and lands the author above the title. */
        .layout-horizontal .block {
          position: absolute;
          top: 440px;
          left: 206px;
          right: 206px;
        }
        .layout-horizontal .title {
          font-size: 136px;
          line-height: 1.14;
          letter-spacing: 1px;
          text-shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
        }
        .layout-horizontal .rule {
          width: 132px;
          height: 2px;
          background: var(--paper);
          opacity: 0.32;
          margin-top: 66px;
        }
        .layout-horizontal .author {
          position: absolute;
          bottom: 244px;
          left: 206px;
          right: 206px;
          font-size: 46px;
          letter-spacing: 8px;
          opacity: 0.62;
        }
        .layout-vertical .rule { display: none; }
      </style>
    </head>
    <body class="layout-${layout}">
      <div class="frame"></div>
      <div class="frame-inner"></div>
      <div class="block">
        <div class="title">${safeTitle}</div>
        <div class="rule"></div>
      </div>
      <div class="author">${safeAuthor}</div>
      <div class="publisher">Reepub Editions</div>
    </body>
    </html>
  `;
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

// Renders the cover to `outputPath` as JPEG. The browser is closed on every
// path: a leaked chromium keeps the caller's event loop alive forever, so a
// screenshot failure used to hang the whole process instead of rejecting.
//
// `layout` may be a layout name, or { pageDirection } to have it chosen.
async function generateCover(title, author, outputPath, layout = 'vertical') {
  const resolved = layout && typeof layout === 'object'
    ? layoutForDirection(layout.pageDirection)
    : layout;
  const html = buildCoverHtml(title, author, resolved);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 2260 },
      deviceScaleFactor: 1
    });

    await page.setContent(html);
    await page.evaluate(async (timeoutMs) => {
      await Promise.race([
        document.fonts.ready,
        new Promise(resolve => setTimeout(resolve, timeoutMs))
      ]);
    }, FONT_READY_TIMEOUT_MS);

    await page.screenshot({ path: outputPath, type: 'jpeg', quality: 85 });
  } finally {
    await browser.close();
  }
}

module.exports = { buildCoverHtml, generateCover, layoutForDirection };
