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
        body {
          margin: 0;
          padding: 0;
          width: 1600px;
          height: 2260px;
          background: linear-gradient(135deg, #1c2331 0%, #11151c 100%);
          color: #e0e0e0;
          font-family: "Inter", "PingFang TC", "Helvetica Neue", sans-serif;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          box-sizing: border-box;
          position: relative;
        }
        .border {
          position: absolute;
          top: 80px;
          bottom: 80px;
          left: 80px;
          right: 80px;
          border: 2px solid rgba(255, 255, 255, 0.1);
          pointer-events: none;
        }
        .border-inner {
          position: absolute;
          top: 100px;
          bottom: 100px;
          left: 100px;
          right: 100px;
          border: 1px solid rgba(255, 255, 255, 0.05);
          pointer-events: none;
        }
        .layout-vertical .title {
          font-size: 200px;
          font-weight: normal;
          letter-spacing: 40px;
          writing-mode: vertical-rl;
          text-orientation: upright;
          text-shadow: 0 10px 30px rgba(0,0,0,0.5);
          height: 1400px;
          display: flex;
          align-items: center;
        }
        .layout-vertical .author-container {
          position: absolute;
          bottom: 200px;
          left: 200px;
        }
        .layout-vertical .author {
          font-size: 70px;
          letter-spacing: 20px;
          opacity: 0.6;
          writing-mode: vertical-rl;
          text-orientation: upright;
        }
        .layout-vertical .publisher {
          position: absolute;
          bottom: 200px;
          right: 200px;
          font-size: 40px;
          font-family: "PingFang SC", sans-serif;
          letter-spacing: 15px;
          opacity: 0.3;
          writing-mode: vertical-rl;
          text-orientation: upright;
        }

        /* HORIZONTAL LAYOUT */
        .layout-horizontal .border, .layout-horizontal .border-inner {
          display: none; /* Modern, borderless look */
        }
        .layout-horizontal .title {
          font-size: 140px;
          font-weight: 800;
          letter-spacing: -2px;
          line-height: 1.1;
          text-align: center;
          width: 80%;
          margin-bottom: 60px;
          text-shadow: 0 20px 40px rgba(0,0,0,0.4);
        }
        .layout-horizontal .author-container {
          position: absolute;
          bottom: 300px;
          width: 100%;
          text-align: center;
        }
        .layout-horizontal .author {
          font-size: 60px;
          font-weight: 600;
          letter-spacing: 8px;
          opacity: 0.8;
          text-transform: uppercase;
        }
        .layout-horizontal .publisher {
          position: absolute;
          bottom: 120px;
          width: 100%;
          text-align: center;
          font-size: 35px;
          letter-spacing: 12px;
          opacity: 0.3;
          text-transform: uppercase;
        }
      </style>
    </head>
    <body class="layout-${layout}">
      <div class="border"></div>
      <div class="border-inner"></div>
      <div class="title">${safeTitle}</div>
      <div class="author-container">
        <div class="author">${safeAuthor}</div>
      </div>
      <div class="publisher">REEPUB EDITIONS</div>
    </body>
    </html>
  `;
}

// Renders the cover to `outputPath` as JPEG. The browser is closed on every
// path: a leaked chromium keeps the caller's event loop alive forever, so a
// screenshot failure used to hang the whole process instead of rejecting.
async function generateCover(title, author, outputPath, layout = 'vertical') {
  const html = buildCoverHtml(title, author, layout);

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

module.exports = { buildCoverHtml, generateCover };
